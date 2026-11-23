/**
 * Thin adapters: WhatsApp Cloud API (Meta) and the Anthropic Messages API.
 * Node 18+ (uses global fetch and node:crypto).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Verify Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return true; // signature checks disabled (development only)
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex'));
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Extract incoming text messages from a WhatsApp webhook payload. */
export function parseIncoming(payload) {
  const out = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const names = Object.fromEntries((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages ?? []) {
        const text = m.type === 'text' ? m.text?.body
          : m.type === 'interactive' ? (m.interactive?.button_reply?.title || m.interactive?.list_reply?.title)
          : m.type === 'button' ? m.button?.text : null;
        out.push({ id: m.id, from: m.from, name: names[m.from] || null, type: m.type, text, phoneNumberId: v.metadata?.phone_number_id });
      }
    }
  }
  return out;
}

export function whatsappClient({ token, phoneNumberId, apiVersion = 'v21.0', fetchImpl = fetch }) {
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  return {
    async sendText(to, body) {
      const r = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: false, body } }),
      });
      if (!r.ok) throw new Error(`WhatsApp send failed: ${r.status} ${await r.text()}`);
      return r.json();
    },
  };
}

export function anthropicClient({ apiKey, model = 'claude-haiku-5-5', maxTokens = 300, fetchImpl = fetch }) {
  return async ({ system, messages }) => {
    const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
    });
    if (!r.ok) throw new Error(`AI request failed: ${r.status} ${await r.text()}`);
    const data = await r.json();
    return (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  };
}

/** Post a hand-off alert to any webhook (Slack, Teams, Discord, Zapier, n8n...). */
export async function notifyHandoff(url, event, fetchImpl = fetch) {
  if (!url) return;
  const text = `🙋 Hand-off: ${event.name || event.from} (${event.channel}) — ${event.reason}\n"${event.text}"`;
  await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, ...event }) }).catch(() => {});
}
