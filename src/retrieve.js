/**
 * FAQ parsing and BM25 retrieval. Zero dependencies; runs in Node and browsers.
 *
 * FAQ format (Markdown):
 *   ## Question text?
 *   Answer text, one or more paragraphs.
 */

const STOP = new Set('a an and are as at be but by can do does for from have how i if in is it me my of on or our please the to was we what when where which who why will with you your'.split(' '));

export function tokenize(text) {
  return (text.toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]+/gu) || [])
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

// Light English stemmer: enough to match "booking/booked/bookings" with "book".
function stem(t) {
  return t.replace(/(ing|ed|es|s)$/u, (m) => (t.length - m.length >= 3 ? '' : m));
}

export function parseFaqs(markdown) {
  const out = [];
  let cur = null;
  for (const line of markdown.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { if (cur) out.push(cur); cur = { question: h[1], answer: '' }; continue; }
    if (cur && !/^#\s/.test(line)) cur.answer += line + '\n';
  }
  if (cur) out.push(cur);
  return out.map((f, id) => ({ id, question: f.question, answer: f.answer.trim() })).filter((f) => f.answer);
}

/** Build a BM25 index over question (weighted x2) + answer. */
export function buildIndex(faqs, { k1 = 1.4, b = 0.75 } = {}) {
  const docs = faqs.map((f) => {
    const toks = [...tokenize(f.question), ...tokenize(f.question), ...tokenize(f.answer)];
    const tf = new Map();
    toks.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    return { faq: f, tf, len: toks.length };
  });
  const df = new Map();
  docs.forEach((d) => d.tf.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1)));
  const avg = docs.reduce((a, d) => a + d.len, 0) / (docs.length || 1);
  return { docs, df, avg, k1, b, n: docs.length };
}

/**
 * Rank FAQs for a query.
 * @returns [{ faq, score, coverage }] best first. `coverage` = share of query terms found (0..1).
 */
export function search(index, query, limit = 3) {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return [];
  const res = index.docs.map((d) => {
    let s = 0, hit = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      hit++;
      const idf = Math.log(1 + (index.n - index.df.get(t) + 0.5) / (index.df.get(t) + 0.5));
      s += idf * ((f * (index.k1 + 1)) / (f + index.k1 * (1 - index.b + (index.b * d.len) / index.avg)));
    }
    return { faq: d.faq, score: s, coverage: hit / q.length };
  });
  return res.filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}
