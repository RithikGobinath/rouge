'use strict';
// The reflex rules: the fixed set of things a spoken clause can mean. This is
// the local stand-in for the "reflexes" model (see jev.js for the remote one):
// it picks ONE action from a closed set and never generates text of its own.
//
// Each rule has a cheap `head` (does a clause start like this?), a `strong`
// flag (safe to treat as the start of a new clause after a bare "and"), and a
// `match` that reads the whole clause and returns { action, end }.

const { join, words, readNumber } = require('./tokens');
const { parseChord, labelFor, SHORTCUTS } = require('./keys');
const { SITES, SEARCH_URLS, SYSTEM_FOLDERS } = require('./vocab');

const A = {
  openApp: (app) => ({ type: 'open_app', app }),
  openUrl: (url, label) => ({ type: 'open_url', url, label: label || url }),
  openFolder: (name) => ({ type: 'open_folder', name }),
  switchTo: (app) => ({ type: 'switch_to', app }),
  type: (text) => ({ type: 'type_text', text }),
  keys: (keys) => ({ type: 'press_keys', keys, label: labelFor(keys) }),
  windowOp: (op) => ({ type: 'window_op', op }),
  media: (op, times) => ({ type: 'media', op, times: times || 1 }),
  scroll: (dir, amount) => ({ type: 'scroll', dir, amount }),
  click: (name, kind) => ({ type: 'click', name, kind: kind || 'single' }),
};

const SPOKEN_PUNCT = [
  [/\s*\b(?:new paragraph)\b\s*/gi, '\n\n'], [/\s*\b(?:new line|next line)\b\s*/gi, '\n'],
  [/\s*\b(?:question mark)\b/gi, '?'], [/\s*\b(?:exclamation (?:point|mark))\b/gi, '!'],
  [/\s*\b(?:full stop|period)\b/gi, '.'], [/\s*\bcomma\b/gi, ','], [/\s*\bsemicolon\b/gi, ';'], [/\s*\bcolon\b/gi, ':'],
  [/\s*\bat sign\b\s*/gi, '@'],
];

/**
 * Payload text as spoken -> text to type. A transcript that ends a request
 * with a full stop it added itself ("Type hello.") loses that stop; a stop
 * the person spoke ("... notes period") is kept.
 */
function spokenToText(raw, atEnd) {
  let s = raw.trim();
  if (atEnd && /[^.]\.$/.test(s) && !/[.!?]\s+\S/.test(s)) s = s.slice(0, -1);
  for (const [re, rep] of SPOKEN_PUNCT) s = s.replace(re, rep);
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
}

const DOMAIN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/;

function siteOrDomain(name) {
  const n = name.replace(/\s+dot\s+/g, '.').replace(/\s+/g, ' ').trim();
  if (SITES[n]) return { url: SITES[n], label: n };
  const compact = n.replace(/ /g, '');
  if (DOMAIN.test(compact)) return { url: 'https://' + compact, label: compact };
  return null;
}

function openTarget(ws, ctx) {
  let w = ws.slice();
  while (w.length && ['the', 'my', 'a', 'an', 'up'].includes(w[0])) w.shift();
  while (w.length && ['app', 'application', 'program', 'please', 'for', 'me'].includes(w[w.length - 1])) w.pop();
  let folder = false; let web = false;
  if (w[w.length - 1] === 'folder') { folder = true; w.pop(); }
  else if (['website', 'site', 'page', 'homepage'].includes(w[w.length - 1])) { web = true; w.pop(); }
  const name = w.join(' ');
  if (!name) return null;
  if (folder || SYSTEM_FOLDERS.includes(name) || ctx.opts.folders.some((f) => f.toLowerCase() === name)) return A.openFolder(name);
  const site = siteOrDomain(name);
  if (site) return A.openUrl(site.url, site.label);
  if (web) return A.openUrl(`https://${name.replace(/ /g, '')}.com`, name);
  return A.openApp(name);
}

/** @type {Array<{name:string, strong:boolean, head:RegExp, match:(ctx:any, i:number)=>({action:any,end:number}|null)}>} */
const RULES = [
  {
    name: 'run_routine', strong: true,
    head: /^(?:run|start|play|do|launch|execute|trigger|use)\s+(?:my\s+|the\s+)?(?:\S+\s+){0,3}(?:routine|shortcut)\b/,
    match(ctx, i) {
      const ws = words(ctx.t, i, i + 8);
      const r = Math.max(ws.indexOf('routine'), ws.indexOf('shortcut'));
      if (r < 1) return null;
      const name = ws.slice(1, r).filter((x) => !['my', 'the', 'a'].includes(x)).join(' ');
      return { action: { type: 'run_routine', name }, end: i + r + 1 };
    },
  },
  {
    name: 'save_routine', strong: true,
    head: /^(?:save|keep|remember|store|make)\s+(?:that|this|these|those|it)\s+(?:as\s+(?:a|my|the)\s+)?(?:routine|shortcut)\b/,
    match(ctx, i) {
      const end = ctx.runEnd(i + 1, 'payload');
      const text = join(ctx.t, i, end);
      const m = /\b(?:called|named)\s+(.+)$/i.exec(text);
      return { action: { type: 'save_routine', name: m ? m[1].trim() : '' }, end };
    },
  },
  {
    name: 'cancel', strong: true,
    head: /^(?:cancel|never\s*mind|forget\s+it|stop\s+(?:that|it|listening)|scratch\s+that)\b/,
    match(ctx, i) { return { action: { type: 'cancel' }, end: i + (ctx.W(i) === 'never' || ctx.W(i) === 'forget' || ctx.W(i) === 'stop' || ctx.W(i) === 'scratch' ? 2 : 1) }; },
  },
  {
    name: 'new', strong: true,
    head: /^(?:(?:create|make|open|start)\s+)?(?:an?\s+)?new\s+(?:note|notes|document|doc|file|text file|page|tab|window|folder|email|e-mail|mail|message|sheet|spreadsheet|slide|presentation|chat|project)\b/,
    match(ctx, i) {
      let j = i;
      while (['create', 'make', 'open', 'start', 'a', 'an'].includes(ctx.W(j))) j += 1;
      if (ctx.W(j) !== 'new') return null;
      let kind = ctx.W(j + 1);
      let end = j + 2;
      if (kind === 'text' && ctx.W(j + 2) === 'file') { kind = 'file'; end += 1; }
      if (kind === 'tab') return { action: A.keys(['ctrl', 't']), end };
      if (kind === 'window') return { action: A.keys(['ctrl', 'n']), end };
      if (kind === 'folder') return { action: A.keys(['ctrl', 'shift', 'n']), end };
      if (['email', 'e-mail', 'mail'].includes(kind)) return { action: { type: 'compose_email', to: '', subject: '', body: '' }, end };
      return { action: A.keys(['ctrl', 'n']), end };
    },
  },
  {
    name: 'compose_email', strong: false,
    head: /^(?:(?:compose|draft|write|send)\s+(?:an?\s+|the\s+)?e-?mail\b|e-?mail\s+\S+)/,
    match(ctx, i) {
      const end = ctx.runEnd(i + 1, 'payload');
      const text = join(ctx.t, i, end).replace(/[.]+$/, '');
      let rest = text.replace(/^(?:compose|draft|write|send)\s+(?:an?\s+|the\s+)?e-?mail\b\s*/i, '').replace(/^e-?mail\s+/i, '');
      let to = ''; let subject = ''; let body = '';
      const m = /^(?:to\s+)?(.+?)(?:\s+(?:about|regarding|re|saying|subject)\s+(.+))?$/i.exec(rest);
      if (m) { to = m[1].trim(); const tail = (m[2] || '').trim(); if (/\bsaying\b/i.test(text) && tail) body = tail; else subject = tail; }
      if (/^(?:about|saying|regarding)$/i.test(to)) { to = ''; }
      return { action: { type: 'compose_email', to, subject, body }, end };
    },
  },
  {
    name: 'press', strong: true,
    head: /^(?:press|hit|push|tap)\b/,
    match(ctx, i) {
      const ws = words(ctx.t, i + 1, i + 8);
      const chord = parseChord(ws);
      if (chord) return { action: A.keys(chord.keys), end: i + 1 + chord.used };
      const rest = ws.filter((x) => x !== 'the');
      const phrase = SHORTCUTS.find(([p]) => rest.join(' ').startsWith(p));
      if (phrase) return { action: A.keys(phrase[1]), end: i + 1 + ws.indexOf(phrase[0].split(' ').pop()) + 1 };
      const end = ctx.runEnd(i + 1, 'open');
      const name = words(ctx.t, i + 1, end).filter((x) => !['the', 'on', 'button', 'link'].includes(x)).join(' ');
      return name ? { action: A.click(name), end } : null;
    },
  },
  {
    name: 'type', strong: true,
    head: /^(?:type|dictate|write|enter|input|insert)\s+(?!me\b|an?\s+e-?mail|my\b|us\b)\S/,
    match(ctx, i) {
      let j = i + 1;
      if (['in', 'out'].includes(ctx.W(j))) j += 1;
      if (ctx.W(j) === 'the' && ['words', 'word', 'text'].includes(ctx.W(j + 1))) j += 2;
      const end = ctx.runEnd(j, 'payload');
      if (end <= j) return null;
      const text = spokenToText(join(ctx.t, j, end), end >= ctx.t.length);
      return text ? { action: A.type(text), end } : null;
    },
  },
  {
    name: 'window', strong: true,
    head: /^(?:minimi[sz]e|maximi[sz]e|restore|close\s+(?:this|that|the|it|window|app|program)|show\s+(?:the\s+)?desktop|switch\s+(?:windows?|apps?)|next\s+window|alt\s+tab|snap\b|move\s+(?:this\s+)?window)/,
    match(ctx, i) {
      const ws = words(ctx.t, i, i + 6);
      const first = ws[0];
      const swallow = (n) => { let k = n; while (['this', 'the', 'that', 'window', 'app', 'program', 'application', 'it'].includes(ws[k])) k += 1; return k; };
      if (/^minimi[sz]e$/.test(first)) return { action: A.windowOp('minimize'), end: i + swallow(1) };
      if (/^maximi[sz]e$/.test(first)) return { action: A.windowOp('maximize'), end: i + swallow(1) };
      if (first === 'restore') return { action: A.windowOp('restore'), end: i + swallow(1) };
      if (first === 'close') return { action: A.windowOp('close'), end: i + swallow(1) };
      if (first === 'show') return { action: A.windowOp('show_desktop'), end: i + 1 + (ws[1] === 'the' ? 1 : 0) + 1 };
      if (first === 'switch' || first === 'alt' || first === 'next') return { action: A.keys(['alt', 'tab']), end: i + (first === 'alt' ? 2 : 2) };
      const side = ws.includes('left') ? 'left' : ws.includes('right') ? 'right' : null;
      if (side) return { action: A.keys(['win', side]), end: i + ws.indexOf(side) + 1 };
      return null;
    },
  },
  {
    name: 'media', strong: true,
    head: /^(?:(?:volume|sound)\s+(?:up|down)|turn\s+(?:it|the\s+volume|the\s+sound|this)?\s*(?:up|down)|louder|quieter|softer|mute|unmute|play\b|pause|resume|next\s+(?:track|song|video)|skip\b|previous\s+(?:track|song|video)|last\s+song|set\s+(?:the\s+)?volume)/,
    match(ctx, i) {
      const ws = words(ctx.t, i, i + 8);
      const s = ws.join(' ');
      let m;
      if ((m = /^set (?:the )?volume to /.exec(s))) {
        const num = readNumber(ws, m[0].split(' ').length - 1);
        if (!num) return null;
        return { action: { type: 'media', op: 'volume_set', level: Math.max(0, Math.min(100, num.n)), times: 1 }, end: i + m[0].split(' ').length - 1 + num.used + (ws[m[0].split(' ').length - 1 + num.used] === 'percent' ? 1 : 0) };
      }
      if (/^(?:volume|sound) up|^turn (?:it |the volume |the sound |this )?up|^louder/.test(s)) return { action: A.media('vol_up', 5), end: i + (/^louder/.test(s) ? 1 : s.startsWith('turn') ? ws.indexOf('up') + 1 : 2) };
      if (/^(?:volume|sound) down|^turn (?:it |the volume |the sound |this )?down|^quieter|^softer/.test(s)) return { action: A.media('vol_down', 5), end: i + (/^(?:quieter|softer)/.test(s) ? 1 : s.startsWith('turn') ? ws.indexOf('down') + 1 : 2) };
      if (/^mute/.test(s)) return { action: A.media('mute'), end: i + 1 };
      if (/^unmute/.test(s)) return { action: A.media('mute'), end: i + 1 };
      if (/^(?:play|pause|resume)\b/.test(s)) {
        let k = 1;
        while (['the', 'my', 'music', 'song', 'video', 'playback', 'track', 'it', 'this'].includes(ws[k])) k += 1;
        return { action: A.media('play_pause'), end: i + k };
      }
      if (/^next (?:track|song|video)/.test(s)) return { action: A.media('next'), end: i + 2 };
      if (/^skip\b/.test(s)) { let k = 1; while (['this', 'the', 'track', 'song', 'one'].includes(ws[k])) k += 1; return { action: A.media('next'), end: i + k }; }
      if (/^(?:previous (?:track|song|video)|last song)/.test(s)) return { action: A.media('prev'), end: i + 2 };
      return null;
    },
  },
  {
    name: 'scroll', strong: true,
    head: /^(?:scroll\b|page\s+(?:up|down)\b|(?:go|jump)\s+to\s+the\s+(?:top|bottom)\b)/,
    match(ctx, i) {
      const ws = words(ctx.t, i, i + 8);
      if (ws[0] === 'page') return { action: A.scroll(ws[1], 'page'), end: i + 2 };
      if (ws[0] === 'go' || ws[0] === 'jump') return { action: A.scroll(ws[3] === 'top' ? 'up' : 'down', 'edge'), end: i + 4 };
      const dir = ws[1] === 'up' || ws[1] === 'down' ? ws[1] : ws[1] === 'to' ? null : null;
      if (!dir) {
        if (ws[1] === 'to' && ws[2] === 'the' && (ws[3] === 'top' || ws[3] === 'bottom')) return { action: A.scroll(ws[3] === 'top' ? 'up' : 'down', 'edge'), end: i + 4 };
        return null;
      }
      let k = 2; let amount = 'page';
      if (ws[k] === 'a' && (ws[k + 1] === 'little' || ws[k + 1] === 'bit')) { amount = 'little'; k += 2; if (ws[k] === 'bit') k += 1; }
      else if (ws[k] === 'a' && ws[k + 1] === 'lot') { amount = 'lot'; k += 2; }
      else if (ws[k] === 'to' && ws[k + 1] === 'the' && (ws[k + 2] === 'top' || ws[k + 2] === 'bottom')) { amount = 'edge'; k += 3; }
      return { action: A.scroll(dir, amount), end: i + k };
    },
  },
  {
    name: 'screenshot', strong: true,
    head: /^(?:(?:take|grab|capture|make)\s+(?:a\s+)?(?:screenshot|screen\s*shot|screen\s*capture|snip)|screenshot)\b/,
    match(ctx, i) {
      const ws = words(ctx.t, i, i + 5);
      const k = ws.findIndex((x) => /^(?:screenshot|screen|snip)$/.test(x));
      const consumed = k + 1 + (ws[k] === 'screen' ? 1 : 0);
      return { action: A.keys(['win', 'shift', 's']), end: i + consumed };
    },
  },
  {
    name: 'search', strong: true,
    head: /^(?:search|google|bing|look\s+up)\b/,
    match(ctx, i) {
      let j = i + 1; let engine = 'google';
      if (ctx.W(i) === 'look' && ctx.W(j) === 'up') j += 1;
      if (ctx.W(i) === 'bing') engine = 'bing';
      const two = `${ctx.W(j)} ${ctx.W(j + 1)}`;
      if (two === 'google maps') { engine = 'google maps'; j += 2; } else if (SEARCH_URLS[ctx.W(j)] && ctx.W(j + 1) === 'for') { engine = ctx.W(j); j += 1; }
      else if (SEARCH_URLS[ctx.W(j)] && ctx.W(i) === 'search' && ctx.W(j + 1) !== 'for' && ['youtube', 'amazon', 'wikipedia', 'github', 'reddit'].includes(ctx.W(j))) { engine = ctx.W(j); j += 1; }
      if (ctx.W(j) === 'for') j += 1;
      const end = ctx.runEnd(j, 'payload');
      if (end <= j) return null;
      let q = join(ctx.t, j, end).replace(/[.!?]+$/, '');
      const on = /\s+(?:on|in|at)\s+(youtube|amazon|wikipedia|github|reddit|bing|google|maps|duckduckgo)$/i.exec(q);
      if (on) { engine = on[1].toLowerCase(); q = q.slice(0, on.index); }
      if (!q.trim()) return null;
      return { action: A.openUrl(SEARCH_URLS[engine].replace('%s', encodeURIComponent(q.trim())), `${engine}: ${q.trim()}`), end };
    },
  },
  {
    name: 'goto', strong: true,
    head: /^(?:go\s+to|visit|navigate\s+to|browse\s+to|take\s+me\s+to)\b/,
    match(ctx, i) {
      let j = i + 1;
      if (ctx.W(i) === 'go' || ctx.W(i) === 'take') j += 1;
      if (ctx.W(i) === 'take') j += 1;
      if (ctx.W(j) === 'to') j += 1;
      const end = ctx.runEnd(j, 'open');
      if (end <= j) return null;
      let ws = words(ctx.t, j, end).filter((x, n) => !(n === 0 && ['the', 'my', 'a'].includes(x)));
      while (ws.length && ['website', 'site', 'page', 'homepage', 'please'].includes(ws[ws.length - 1])) ws.pop();
      const name = ws.join(' ');
      if (!name) return null;
      const site = siteOrDomain(name);
      if (site) return { action: A.openUrl(site.url, site.label), end };
      if (SYSTEM_FOLDERS.includes(name)) return { action: A.openFolder(name), end };
      return { action: A.switchTo(name), end };
    },
  },
  {
    name: 'switch_to', strong: true,
    head: /^(?:switch|jump|change)\s+to\b/,
    match(ctx, i) {
      const end = ctx.runEnd(i + 2, 'open');
      const ws = words(ctx.t, i + 2, end).filter((x, n) => !(n === 0 && ['the', 'my'].includes(x)));
      const name = ws.join(' ');
      return name ? { action: A.switchTo(name), end } : null;
    },
  },
  {
    name: 'open', strong: true,
    head: /^(?:(?:open|launch)\b|(?:bring|fire|pull)\s+up\b|(?:start|run)\s+(?!my\b)\S)/,
    match(ctx, i) {
      let j = i + 1;
      if (['bring', 'fire', 'pull'].includes(ctx.W(i))) j += 1;
      const end = ctx.runEnd(j, 'open');
      if (end <= j) return null;
      const action = openTarget(words(ctx.t, j, end), ctx);
      return action ? { action, end } : null;
    },
  },
  {
    name: 'click', strong: true,
    head: /^(?:click|tap|double\s+click|right\s+click|choose)\b/,
    match(ctx, i) {
      let j = i + 1; let kind = 'single';
      if (ctx.W(i) === 'double') { kind = 'double'; j += 1; } else if (ctx.W(i) === 'right') { kind = 'right'; j += 1; }
      if (ctx.W(j) === 'on') j += 1;
      const end = ctx.runEnd(j, 'open');
      const name = words(ctx.t, j, end).filter((x) => !['the', 'a', 'button', 'link', 'icon', 'option'].includes(x)).join(' ');
      return name ? { action: A.click(name, kind), end } : null;
    },
  },
  {
    name: 'wait', strong: false,
    head: /^wait\b/,
    match(ctx, i) {
      const ws = words(ctx.t, i + 1, i + 6);
      let k = 0;
      if (ws[k] === 'for') k += 1;
      let seconds = 1;
      const num = readNumber(ws, k);
      if (num) { seconds = num.n; k += num.used; } else if (ws[k] === 'a') k += 1;
      if (/^(?:seconds?|secs?|moment|minutes?)$/.test(ws[k] || '')) { if (/^minutes?$/.test(ws[k])) seconds *= 60; k += 1; } else if (!num) return null;
      return { action: { type: 'wait', ms: Math.min(seconds, 30) * 1000 }, end: i + 1 + k };
    },
  },
  {
    // "save", "copy", "select all": only when that is the whole clause, so a
    // sentence that merely starts with "copy" is left for the answer path.
    name: 'shortcut', strong: false,
    head: new RegExp('^(?:' + SHORTCUTS.map(([p]) => p.replace(/ /g, '\\s+')).join('|') + ')\\b'),
    match(ctx, i) {
      const s = words(ctx.t, i, i + 4).join(' ');
      const hit = SHORTCUTS.filter(([p]) => s === p || s.startsWith(p + ' ')).sort((a, b) => b[0].length - a[0].length)[0];
      if (!hit) return null;
      let k = i + hit[0].split(' ').length;
      while (['it', 'this', 'that', 'file', 'document', 'page', 'text', 'selection', 'the', 'everything'].includes(ctx.W(k))) k += 1;
      const atBoundary = k >= ctx.t.length || ctx.isBoundary(k, true);
      return atBoundary ? { action: A.keys(hit[1]), end: k } : null;
    },
  },
];

module.exports = { RULES, A, spokenToText, openTarget, siteOrDomain };
