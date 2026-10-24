'use strict';
// Tokens and cursor helpers for the reflex grammar.
//
// A transcript is split into words. Each token keeps its raw text (casing is
// kept for text that gets typed), a lowercase `w` used for matching, and the
// sentence punctuation that trailed it.

/**
 * @typedef {Object} Token
 * @property {string} raw   the word as heard or typed
 * @property {string} w     lowercase, punctuation stripped, used to match
 * @property {string} punct trailing , ; . ! ? if any
 */

/** @param {string} text @returns {Token[]} */
function tokenize(text) {
  const clean = String(text || '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  return clean.split(' ').map((raw) => {
    const m = /^(.*?)([,;.!?]+)$/.exec(raw);
    const body = m ? m[1] : raw;
    return { raw, w: body.toLowerCase().replace(/^["(]+|[")]+$/g, ''), punct: m ? m[2] : '' };
  }).filter((t) => t.raw.length > 0);
}

/** Join tokens [a, b) back to text, keeping the original words. */
function join(tokens, a, b) {
  return tokens.slice(a, b).map((t) => t.raw).join(' ');
}

/** Lowercase words [a, b). */
function words(tokens, a, b) {
  return tokens.slice(a, b).map((t) => t.w);
}

// Words that carry no meaning at the front of a clause.
const FILLER_PHRASES = [
  ['go', 'ahead', 'and'], ['i', 'want', 'you', 'to'], ["i'd", 'like', 'you', 'to'], ['i', 'need', 'you', 'to'], ['i', 'want', 'to'],
  ['after', 'that'], ['and', 'then'], ['can', 'you'], ['could', 'you'], ['would', 'you'], ['will', 'you'], ['let', 'us'],
];
const FILLER_WORDS = new Set(['please', 'and', 'then', 'also', 'okay', 'ok', 'now', 'hey', 'uh', 'um', 'just', 'so', 'alright', "let's", 'lets', 'clippy']);

/** Index of the first token at or after `i` that is not filler. */
function skipFillers(tokens, i) {
  let k = i;
  for (;;) {
    let moved = false;
    for (const phrase of FILLER_PHRASES) {
      if (phrase.every((p, n) => tokens[k + n] && tokens[k + n].w === p)) { k += phrase.length; moved = true; break; }
    }
    if (moved) continue;
    if (k < tokens.length && FILLER_WORDS.has(tokens[k].w)) { k += 1; continue; }
    return k;
  }
}

const NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100 };

/** "10", "ten", "twenty five" -> number, with the words used; or null. */
function readNumber(ws, i) {
  const a = ws[i];
  if (a == null) return null;
  if (/^\d+$/.test(a)) return { n: Number(a), used: 1 };
  if (a in NUM) {
    const b = ws[i + 1];
    if (a in { twenty: 1, thirty: 1, forty: 1, fifty: 1, sixty: 1 } && b in NUM && NUM[b] < 10 && NUM[b] > 0) return { n: NUM[a] + NUM[b], used: 2 };
    return { n: NUM[a], used: 1 };
  }
  return null;
}

module.exports = { tokenize, join, words, skipFillers, readNumber };
