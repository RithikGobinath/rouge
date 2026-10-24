'use strict';
// The reflex grammar: a transcript in, an ordered list of clauses out. Each
// clause carries one action from the fixed set (rules.js), or null when no
// built-in rule matched and the words are a question or free-form request.
//
//   parse("open notepad new note type hello")
//     -> [open_app notepad] [press ctrl+n] [type_text hello]
//
// The transcript is re-parsed in full on every live update, so everything
// here is pure and cheap. Clause boundaries come from spoken delimiters
// ("then", "and then", "after that"), from punctuation followed by a new
// command, and from a bare command word after "and".

const { tokenize, join, words, skipFillers } = require('./tokens');
const { RULES } = require('./rules');
const { QUESTION_START } = require('./vocab');

/**
 * @typedef {Object} Clause
 * @property {string} text         the words this clause covers
 * @property {Object|null} action  one action from the fixed set, or null
 * @property {number} confidence   1 for a grammar match, 0 for no match
 */

function makeContext(tokens, opts) {
  const t = tokens;
  const ahead = (j) => words(t, j, j + 8).join(' ');
  const ctx = {
    t,
    opts: { folders: (opts.folders || []).map((f) => String(f).toLowerCase()) },
    W: (j) => (t[j] ? t[j].w : ''),
    // Is there a new command at `j`? The trailing "_" lets a verb that is still
    // waiting for its words ("... open notepad type") count as the start of one.
    startsCommand(j, strongOnly) {
      const a = ahead(j) + ' _';
      return RULES.some((r) => (!strongOnly || r.strong) && r.head.test(a));
    },
    isBoundary(j, bare) {
      const tk = t[j];
      if (!tk) return true;
      if (tk.w === 'then') return true;
      if (tk.w === 'after' && t[j + 1] && t[j + 1].w === 'that') return true;
      if (tk.w === 'and') {
        if (t[j + 1] && t[j + 1].w === 'then') return true;
        const k = skipFillers(t, j + 1);
        return k < t.length && ctx.startsCommand(k, true);
      }
      const prev = t[j - 1];
      if (prev && prev.punct && ctx.startsCommand(j, false)) return true;
      return Boolean(bare) && ctx.startsCommand(j, false);
    },
    /** End (exclusive) of the run of words that belong to the clause starting its payload at `from`. */
    runEnd(from, mode) {
      let j = from;
      const bare = mode === 'open';
      while (j < t.length) {
        if (j > from && ctx.isBoundary(j, bare)) break;
        if (j === from && ctx.isBoundary(j, false) && t[j].w === 'then') break;
        if (bare && j - from >= 5) break;
        j += 1;
      }
      return j;
    },
  };
  return ctx;
}

function matchRule(ctx, i) {
  const a = words(ctx.t, i, i + 8).join(' ');
  for (const rule of RULES) {
    if (!rule.head.test(a)) continue;
    const m = rule.match(ctx, i);
    if (m && m.action && m.end > i) return { action: m.action, end: Math.min(m.end, ctx.t.length), rule: rule.name };
  }
  return null;
}

// Slips a dictation recognizer makes on command words, repaired only where the
// next word makes the intent plain ("price control s" is "press control s").
const HEARD = [
  [/\b(?:price|prize|prez|pres|dress)\s+(?=(?:control|ctrl|alt|shift|windows|enter|return|escape|tab|space|delete|backspace|page|home|end|f\s?\d)\b)/gi, 'press '],
  [/\bnote\s+pad\b/gi, 'notepad'], [/\bword\s+pad\b/gi, 'wordpad'], [/\bpower\s+point\b/gi, 'powerpoint'], [/\bone\s+note\b/gi, 'onenote'],
  [/\bfile\s+explorer\b/gi, 'file explorer'], [/\bwind(?:ow)?s\s+explorer\b/gi, 'file explorer'], [/\bpaint\s+brush\b/gi, 'paint'],
  [/\be\s+mail\b/gi, 'email'], [/\bscreen\s+shot\b/gi, 'screenshot'], [/\bcontrol\s+(?:plus|and)\s+/gi, 'control '],
];
function fixHeard(text) {
  let s = String(text || '');
  for (const [re, rep] of HEARD) s = s.replace(re, rep);
  return s;
}

/**
 * @param {string} text
 * @param {{folders?: string[]}} [opts] names of the user's folders, so "open my class notes folder" resolves
 * @returns {Clause[]}
 */
function parse(text, opts = {}) {
  const tokens = tokenize(fixHeard(text));
  const ctx = makeContext(tokens, opts);
  const clauses = [];
  let i = skipFillers(tokens, 0);
  while (i < tokens.length) {
    i = skipFillers(tokens, i);
    if (i >= tokens.length) break;
    const m = matchRule(ctx, i);
    if (m) {
      clauses.push({ text: join(tokens, i, m.end), action: m.action, confidence: 1 });
      i = m.end;
      continue;
    }
    // A request that opens with a question word is one question, whatever
    // command words it mentions on the way ("what's the way to open a tab").
    if (clauses.length === 0 && QUESTION_START.test(tokens[i].w)) {
      clauses.push({ text: join(tokens, i, tokens.length), action: null, confidence: 0 });
      break;
    }
    let j = i + 1;
    while (j < tokens.length && !ctx.isBoundary(j, false)) j += 1;
    clauses.push({ text: join(tokens, i, j), action: null, confidence: 0 });
    i = j;
  }
  return clauses;
}

/** True when the first clause is an action the reflexes know. */
function isActionable(text, opts) {
  const c = parse(text, opts);
  return c.length > 0 && c.every((x) => x.action);
}

module.exports = { parse, isActionable };
