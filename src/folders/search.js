'use strict';
// A small BM25 index over text chunks: what lets the app answer from
// your notes "when they help". Local, no embeddings, no key, nothing leaves
// the PC to build or query it.

const STOP = new Set(('a an and are as at be but by for from has have he her his how i if in into is it its me my of on or our she so than that the their them then there these they this to up us was we were what when where which who why will with you your about can could do does did not no yes just please tell give show find get got').split(' '));

/** Light stemmer: enough that "meetings" finds "meeting" and "studied" finds "study". */
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('sses')) return w.slice(0, -2);
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ied')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}

/** @param {string} text @returns {string[]} */
function terms(text) {
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

/**
 * Split text into overlapping chunks on paragraph and sentence boundaries.
 * @param {string} text @param {number} [size] @param {number} [overlap]
 */
function chunk(text, size = 900, overlap = 150) {
  const clean = String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const pieces = clean.split(/(?<=[.!?])\s+|\n{2,}/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length + 1 > size) {
      out.push(cur.trim());
      cur = cur.slice(Math.max(0, cur.length - overlap)).replace(/^\S*\s/, '') + ' ' + p;
    } else cur += (cur ? ' ' : '') + p;
    while (cur.length > size * 1.6) { out.push(cur.slice(0, size).trim()); cur = cur.slice(size - overlap); }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

class Bm25 {
  constructor({ k1 = 1.4, b = 0.75 } = {}) {
    this.k1 = k1; this.b = b;
    /** @type {Map<string, Map<string, number>>} */ this.post = new Map();
    /** @type {Map<string, {len:number, text:string, meta:any}>} */ this.docs = new Map();
    this.total = 0;
  }
  get size() { return this.docs.size; }
  add(id, text, meta) {
    if (this.docs.has(id)) this.remove(id);
    const ts = terms(text);
    const tf = new Map();
    for (const t of ts) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, n] of tf) { let m = this.post.get(t); if (!m) { m = new Map(); this.post.set(t, m); } m.set(id, n); }
    this.docs.set(id, { len: ts.length, text, meta });
    this.total += ts.length;
  }
  remove(id) {
    const d = this.docs.get(id);
    if (!d) return;
    for (const [t, m] of this.post) { if (m.delete(id) && m.size === 0) this.post.delete(t); }
    this.total -= d.len;
    this.docs.delete(id);
  }
  removeWhere(pred) { for (const [id, d] of [...this.docs]) if (pred(id, d.meta)) this.remove(id); }
  /**
   * @param {string} query @param {number} [k]
   * @returns {Array<{id:string, score:number, coverage:number, text:string, meta:any}>}
   */
  search(query, k = 5) {
    const q = [...new Set(terms(query))];
    const N = this.docs.size;
    if (!q.length || !N) return [];
    const avg = this.total / N || 1;
    const scores = new Map();
    const hits = new Map();
    for (const t of q) {
      const m = this.post.get(t);
      if (!m) continue;
      const idf = Math.log(1 + (N - m.size + 0.5) / (m.size + 0.5));
      for (const [id, f] of m) {
        const len = this.docs.get(id).len;
        scores.set(id, (scores.get(id) || 0) + idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * len) / avg))));
        hits.set(id, (hits.get(id) || 0) + 1);
      }
    }
    return [...scores].map(([id, score]) => ({ id, score, coverage: hits.get(id) / q.length, text: this.docs.get(id).text, meta: this.docs.get(id).meta }))
      .sort((a, b) => b.score - a.score).slice(0, k);
  }
}

module.exports = { Bm25, chunk, terms, stem, STOP };
