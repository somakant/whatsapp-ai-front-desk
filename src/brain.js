/**
 * Decides how to answer: FAQ match, AI answer grounded in FAQs, or hand-off to a person.
 * Works without an AI key (retrieval-only mode), so the bot is useful on day one.
 */
import { search } from './retrieve.js';

const HUMAN = /\b(human|person|agent|someone|staff|manager|call me|speak to|talk to|real person|representative)\b/i;
const URGENT = /\b(complain|complaint|refund|angry|lawyer|legal|police|emergency|urgent|cancel my|chargeback|fraud|harass)\w*/i;

export function needsHuman(text) {
  if (HUMAN.test(text)) return 'asked for a person';
  if (URGENT.test(text)) return 'sensitive or urgent topic';
  return null;
}

/**
 * @param ctx.index   FAQ index from buildIndex()
 * @param ctx.ai      optional async ({ system, messages }) => string
 * @param ctx.business { name, handoffMessage, fallbackMessage }
 * @param ctx.history previous turns [{ role: 'user'|'assistant', content }]
 * @returns { reply, mode: 'faq'|'ai'|'handoff', reason?, sources: [faqId] }
 */
export async function answer(text, { index, ai, business, history = [], minCoverage = 0.5 }) {
  const handoffMsg = business.handoffMessage || `Thanks — I'm passing this to a member of the ${business.name} team. They'll reply here shortly.`;
  const why = needsHuman(text);
  if (why) return { reply: handoffMsg, mode: 'handoff', reason: why, sources: [] };

  const hits = search(index, text, 3);
  const top = hits[0];

  if (!ai) {
    if (top && top.coverage >= minCoverage) return { reply: top.faq.answer, mode: 'faq', sources: [top.faq.id] };
    return { reply: handoffMsg, mode: 'handoff', reason: 'no matching FAQ', sources: [] };
  }

  const context = hits.map((h) => `Q: ${h.faq.question}\nA: ${h.faq.answer}`).join('\n\n') || '(no matching FAQ)';
  const system = [
    `You are the front desk assistant for ${business.name}, replying on WhatsApp.`,
    'Answer ONLY from the FAQ extracts below. Be warm, brief (under 80 words), plain text, no markdown.',
    'If the extracts do not contain the answer, reply exactly: HANDOFF',
    'Never invent prices, times, availability, medical, legal or financial advice. Never claim to be human; if asked, say you are a virtual assistant.',
    `FAQ extracts:\n${context}`,
  ].join('\n');
  const reply = (await ai({ system, messages: [...history.slice(-6), { role: 'user', content: text }] })).trim();
  if (!reply || /^HANDOFF\b/.test(reply)) return { reply: handoffMsg, mode: 'handoff', reason: 'answer not in FAQs', sources: hits.map((h) => h.faq.id) };
  return { reply, mode: 'ai', sources: hits.map((h) => h.faq.id) };
}
