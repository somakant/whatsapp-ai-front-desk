/**
 * WhatsApp AI Front Desk — server.
 * Routes:
 *   GET  /webhook   Meta webhook verification
 *   POST /webhook   incoming WhatsApp messages
 *   POST /api/chat  web chat: { sessionId, text } -> { reply, mode }
 *   GET  /health
 *   GET  /*         static files from ./public (web chat demo)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFaqs, buildIndex } from './retrieve.js';
import { answer } from './brain.js';
import { verifySignature, parseIncoming, whatsappClient, anthropicClient, notifyHandoff } from './adapters.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const env = process.env;
const config = {
  port: Number(env.PORT || 3000),
  business: { name: env.BUSINESS_NAME || 'Our business', handoffMessage: env.HANDOFF_MESSAGE },
  faqFile: env.FAQ_FILE || join(ROOT, 'data/faqs.md'),
  verifyToken: env.WHATSAPP_VERIFY_TOKEN,
  appSecret: env.WHATSAPP_APP_SECRET,
  handoffWebhook: env.HANDOFF_WEBHOOK_URL,
  muteMinutes: Number(env.HANDOFF_MUTE_MINUTES || 240),
};

const index = buildIndex(parseFaqs(await readFile(config.faqFile, 'utf8')));
const ai = env.ANTHROPIC_API_KEY ? anthropicClient({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || undefined }) : null;
const wa = env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID ? whatsappClient({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, apiVersion: env.WHATSAPP_API_VERSION }) : null;

const history = new Map();   // conversation key -> last turns
const mutedUntil = new Map(); // conversation key -> timestamp (a person has taken over)
const seen = new Set();       // WhatsApp message ids already handled (Meta retries)

async function handle(key, text, meta) {
  if ((mutedUntil.get(key) || 0) > Date.now()) return null; // a person is handling this chat
  const turns = history.get(key) || [];
  let res;
  try {
    res = await answer(text, { index, ai, business: config.business, history: turns });
  } catch (e) {
    console.error(e.message);
    res = { reply: config.business.handoffMessage || 'Sorry, something went wrong. A member of our team will reply shortly.', mode: 'handoff', reason: 'error' };
  }
  history.set(key, [...turns, { role: 'user', content: text }, { role: 'assistant', content: res.reply }].slice(-12));
  if (res.mode === 'handoff') {
    mutedUntil.set(key, Date.now() + config.muteMinutes * 60000);
    await notifyHandoff(config.handoffWebhook, { ...meta, text, reason: res.reason });
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), channel: meta.channel, mode: res.mode, reason: res.reason }));
  return res;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const body = (req) => new Promise((ok, no) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); req.on('error', no); });
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, faqs: index.n, ai: !!ai, whatsapp: !!wa });

    if (url.pathname === '/webhook' && req.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === config.verifyToken;
      res.writeHead(ok ? 200 : 403); return res.end(ok ? url.searchParams.get('hub.challenge') : 'forbidden');
    }

    if (url.pathname === '/webhook' && req.method === 'POST') {
      const raw = await body(req);
      if (!verifySignature(raw, req.headers['x-hub-signature-256'], config.appSecret)) { res.writeHead(401); return res.end(); }
      json(res, 200, { ok: true }); // acknowledge fast; Meta retries slow webhooks
      for (const m of parseIncoming(JSON.parse(raw.toString('utf8')))) {
        if (seen.has(m.id)) continue; seen.add(m.id); if (seen.size > 5000) seen.clear();
        const text = m.text || '';
        const r = text ? await handle('wa:' + m.from, text, { channel: 'whatsapp', from: m.from, name: m.name })
          : { reply: 'Thanks! I can read text messages — could you type your question?' };
        if (r && wa) await wa.sendText(m.from, r.reply).catch((e) => console.error(e.message));
      }
      return;
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const { sessionId = 'web', text = '' } = JSON.parse((await body(req)).toString('utf8') || '{}');
      if (!text.trim() || text.length > 1000) return json(res, 400, { error: 'text is required (max 1000 characters)' });
      const r = await handle('web:' + String(sessionId).slice(0, 64), text, { channel: 'web', from: sessionId });
      return json(res, 200, r ? { reply: r.reply, mode: r.mode } : { reply: null, mode: 'human' });
    }

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = normalize(join(ROOT, 'public', rel));
      if (!file.startsWith(join(ROOT, 'public'))) { res.writeHead(403); return res.end(); }
      const data = await readFile(file).catch(() => null);
      if (data) { res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }); return res.end(data); }
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    console.error(e); if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
}).listen(config.port, () => console.log(`Front desk on :${config.port} — ${index.n} FAQs, AI ${ai ? 'on' : 'off (FAQ-only mode)'}, WhatsApp ${wa ? 'on' : 'off'}`));
