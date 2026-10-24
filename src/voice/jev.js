'use strict';
// Jev, the voice reflexes, over TypeSafe's System One API.
//
//   POST https://api.typesafe.ai/v1/systemone      Authorization: Bearer <key>
//
// Jev reads text and answers typed questions (choice, yes/no). It never
// writes: code builds the candidate values (apps, sites, spans of the
// transcript) and Jev SELECTS among them, so the answer is always something
// the executor already knows how to do. One request per spoken clause carries
// every question the executor might need; code reads only the answers that
// the chosen action uses and refuses to act below a confidence floor.
//
// The request and response shapes follow TypeSafe's published OpenAPI spec
// (https://api.typesafe.ai/openapi.json). The idea of one speculative
// fan-out per utterance is the one kevinbadi/jev-voice (MIT) demonstrates for
// macOS; this is an independent implementation for Windows.

const { SITES, SEARCH_URLS, SYSTEM_FOLDERS } = require('./vocab');
const { labelFor } = require('./keys');

const DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone';
const MIN_CONFIDENCE = 0.35;
const YES = 0.6;

const ACTIONS = {
  open_app: 'Launch, open or bring up an application program (for example Notepad, Chrome, Excel, Spotify, Calculator)',
  open_website: "Go to a website by name or domain, with no search query (for example 'go to youtube', 'open reddit')",
  web_search: 'Search for something on the web or on one site: google it, look it up, search YouTube for',
  type_text: 'Type, write, dictate or enter some text into whatever is focused',
  new_item: 'Create something new in the current app: a new note, document, file, tab, window, folder or email',
  shortcut: 'Press one key or keyboard shortcut: enter, escape, tab, copy, paste, undo, save, select all, refresh, go back, and similar',
  scroll: 'Scroll the page or document up or down, to the top or to the bottom',
  volume: 'Change the system volume: louder, quieter, mute',
  media: 'Control music or video: play, pause, resume, next track, previous track',
  screenshot: 'Take a screenshot of the screen',
  open_folder: 'Open a folder such as Downloads, Documents, Desktop, or one of the named folders',
  window: 'Minimize, maximize, restore or close the current window, or show the desktop',
  switch_to: 'Switch to an app or window that is already open',
  click: 'Click a button, link or control by its name on screen',
  compose_email: 'Start writing a new email',
  question: 'A question or request for an answer, writing or explanation, not a command for the computer',
  none: 'Not a command: conversation, thinking aloud, or unintelligible',
};

const SHORTCUT_CHOICES = {
  enter: ['enter'], escape: ['escape'], tab: ['tab'], space: ['space'], backspace: ['backspace'], delete: ['delete'],
  up: ['up'], down: ['down'], left: ['left'], right: ['right'], home: ['home'], end: ['end'], page_up: ['pageup'], page_down: ['pagedown'],
  select_all: ['ctrl', 'a'], copy: ['ctrl', 'c'], cut: ['ctrl', 'x'], paste: ['ctrl', 'v'], undo: ['ctrl', 'z'], redo: ['ctrl', 'y'],
  save: ['ctrl', 's'], find: ['ctrl', 'f'], print: ['ctrl', 'p'], refresh: ['f5'], back: ['alt', 'left'], forward: ['alt', 'right'],
  new_tab: ['ctrl', 't'], close_tab: ['ctrl', 'w'], reopen_tab: ['ctrl', 'shift', 't'], next_tab: ['ctrl', 'tab'], previous_tab: ['ctrl', 'shift', 'tab'],
  zoom_in: ['ctrl', '='], zoom_out: ['ctrl', '-'], fullscreen: ['f11'], address_bar: ['ctrl', 'l'], bold: ['ctrl', 'b'], italic: ['ctrl', 'i'],
  underline: ['ctrl', 'u'], switch_app: ['alt', 'tab'], task_view: ['win', 'tab'], show_desktop: ['win', 'd'], emoji_picker: ['win', '.'],
  clipboard_history: ['win', 'v'], windows_search: ['win', 's'], settings: ['win', 'i'],
};

const NEW_KIND = { tab: ['ctrl', 't'], window: ['ctrl', 'n'], item: ['ctrl', 'n'], folder: ['ctrl', 'shift', 'n'] };
const WINDOW_OPS = { minimize: 'minimize', maximize: 'maximize', restore: 'restore', close: 'close', show_desktop: 'show_desktop' };
const MEDIA_OPS = { play_pause: 'play_pause', next: 'next', previous: 'prev' };
const VOLUME_OPS = { up: ['vol_up', 5], down: ['vol_down', 5], mute: ['mute', 1], unmute: ['mute', 1] };

const keysAction = (keys) => ({ type: 'press_keys', keys, label: labelFor(keys) });

const TEXT_PATTERNS = [
  /^(?:please\s+)?(?:can you\s+|could you\s+)?(?:type|write|enter|dictate|input|put|insert|say|paste)(?:\s+in|\s+out|\s+the\s+words?|\s+the\s+text|\s+this|\s+that)?[:,]?\s+(?<t>.+)$/i,
  /^(?:please\s+)?(?:can you\s+|could you\s+)?(?:search|google|look\s*up|find|look\s+for|show\s+me|pull\s+up)(?:\s+(?:on|in)\s+\w+(?:\s+\w+)?)?(?:\s+for)?[:,]?\s+(?<t>.+)$/i,
  /^(?:click|tap|press|choose|select)(?:\s+on)?\s+(?:the\s+)?(?<t>.+?)(?:\s+(?:button|link|icon))?$/i,
  /["“'](?<t>[^"”']+)["”']/,
];

function clean(s) {
  return String(s || '').trim().replace(/^["“'”]+|["“'”]+$/g, '').replace(/[\s,]*(?:and|then)?\s*(?:hit|press)\s+(?:enter|return)\s*[.!]?$/i, '').replace(/[ .]+$/, '').trim();
}

/** Spans of the clause that might be the payload text. Jev picks one; code never guesses. */
function textCandidates(utterance) {
  const found = [];
  const add = (t) => { const c = clean(t); if (c && !found.includes(c)) found.push(c); };
  for (const re of TEXT_PATTERNS) { const m = re.exec(utterance); if (m && m.groups) add(m.groups.t); }
  add(utterance);
  const out = {};
  found.slice(0, 6).forEach((c, i) => { out[`c${i}`] = c; });
  return out;
}

function domainGuess(utterance) {
  const m = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i.exec(utterance);
  if (m) return m[1].toLowerCase();
  const w = /\b(?:go to|open|visit|pull up|navigate to|take me to)\s+(?:the\s+)?(?:website\s+|site\s+)?([a-z0-9][a-z0-9 .-]*?)\s*[.!?]?$/i.exec(utterance);
  if (w) { const v = w[1].trim().toLowerCase().replace(/ dot /g, '.').replace(/ /g, ''); if (v && !['it', 'that', 'this'].includes(v)) return v.includes('.') ? v : `${v}.com`; }
  return null;
}

const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
const noul = (instructions, t, f) => ({ type: 'noul', instructions, criteria: { true: t, false: f } });

/** The one request for one clause. Exported for tests. */
function buildRequest(utterance, ctx = {}, model = 'jev-latest') {
  const apps = [...new Set((ctx.apps || []).map(String))].slice(0, 240);
  const folders = [...new Set([...(ctx.folders || []), ...SYSTEM_FOLDERS])].slice(0, 100);
  const cands = textCandidates(utterance);
  const appCriteria = { none: 'No listed application matches what the user said' };
  for (const a of apps) appCriteria[a] = null;
  const folderCriteria = {};
  for (const f of folders) folderCriteria[f] = null;
  const state = { utterance, frontmost_window: ctx.front || '', apps, folders, candidates: cands };
  const questions = {
    action: choice('The user is speaking one voice command to their Windows computer. `utterance` is the transcript. Which single kind of action are they asking for right now?', ACTIONS),
    app: choice("Assume the user wants to open or switch to an application. Which application in `apps` do they mean? Match on meaning: 'word' is Microsoft Word, 'browser' is the default browser, 'settings' is Settings. Choose none if nothing matches.", appCriteria),
    site: choice('Assume the user wants to open a website. Which site? Choose other if it is not listed.', { ...Object.fromEntries(Object.keys(SITES).map((s) => [s, null])), other: 'A site that is not listed' }),
    engine: choice('Assume the user wants to search. Which search engine or site should it run on? If none is named, choose google.', Object.fromEntries(Object.keys(SEARCH_URLS).map((s) => [s, null]))),
    text: choice('Assume the user wants some text typed, searched for, or a control clicked by name. `candidates` holds spans cut from the utterance. Which is exactly the payload, with no command words and no trailing "and press enter"?', cands),
    submit: noul('After typing the text, does the user also want the Enter key pressed (they say "and hit enter", "and send it", "and search")?', 'They explicitly ask to press Enter or submit afterwards', 'They only want the text typed'),
    shortcut: choice('Assume the user wants one key or keyboard shortcut pressed. Which one?', Object.fromEntries(Object.keys(SHORTCUT_CHOICES).map((k) => [k, null]))),
    new_kind: choice('Assume the user wants to create something new. What kind?', { tab: 'a new browser tab', window: 'a new window', item: 'a new note, document, file, page or anything made with the app\'s New command', folder: 'a new folder' }),
    scroll_dir: choice('Assume the user wants to scroll. Which way?', { down: 'scroll down', up: 'scroll up', top: 'jump to the very top', bottom: 'jump to the very bottom' }),
    scroll_amount: choice('Assume the user wants to scroll. How far?', { little: 'a little / a bit', page: 'about one screen (the default)', a_lot: 'a lot / far' }),
    volume_op: choice('Assume the user wants to change the volume. How?', { up: 'louder', down: 'quieter', mute: 'mute', unmute: 'unmute' }),
    media_op: choice('Assume the user wants to control playback. What?', { play_pause: 'play, pause or resume', next: 'next track or skip', previous: 'previous track' }),
    window_op: choice('Assume the user wants to change the current window. How?', { minimize: 'minimize it', maximize: 'maximize it', restore: 'restore it', close: 'close it', show_desktop: 'show the desktop' }),
    folder: choice('Assume the user wants to open a folder. Which one?', folderCriteria),
  };
  return { model, state, questions, candidates: cands };
}

/**
 * Turn Jev's answers into actions. Returns { actions, confidence }, with
 * actions empty when Jev says it is a question, not a command, or is unsure.
 */
function toActions(answers, req, utterance, min = MIN_CONFIDENCE) {
  const A = answers || {};
  const pick = (k) => (A[k] && A[k].type === 'choice' ? { v: A[k].choice, c: Number(A[k].confidence) || 0 } : { v: null, c: 0 });
  const yes = (k) => (A[k] && A[k].type === 'noul' ? Number(A[k].noul) : 0);
  const act = pick('action');
  let conf = act.c;
  const out = [];
  const need = (k) => { const p = pick(k); conf = Math.min(conf, p.c); return p.v; };
  switch (act.v) {
    case 'open_app': { const app = need('app'); if (app && app !== 'none') out.push({ type: 'open_app', app }); break; }
    case 'switch_to': { const app = need('app'); if (app && app !== 'none') out.push({ type: 'switch_to', app }); break; }
    case 'open_website': {
      const site = need('site');
      if (site && site !== 'other' && SITES[site]) out.push({ type: 'open_url', url: SITES[site], label: site });
      else { const d = domainGuess(utterance); if (d) out.push({ type: 'open_url', url: `https://${d}`, label: d }); }
      break;
    }
    case 'web_search': {
      const engine = need('engine'); const t = need('text');
      const q = req.candidates[t] || utterance;
      const url = (SEARCH_URLS[engine] || SEARCH_URLS.google).replace('%s', encodeURIComponent(q));
      out.push({ type: 'open_url', url, label: `${engine || 'google'}: ${q}` });
      break;
    }
    case 'type_text': {
      const t = need('text'); const text = req.candidates[t];
      if (text) { out.push({ type: 'type_text', text }); if (yes('submit') > YES) out.push(keysAction(['enter'])); }
      break;
    }
    case 'new_item': { const kind = need('new_kind'); if (kind === 'item' && /e-?mail|mail/i.test(utterance)) out.push({ type: 'compose_email', to: '', subject: '', body: '' }); else if (NEW_KIND[kind]) out.push(keysAction(NEW_KIND[kind])); break; }
    case 'shortcut': { const s = need('shortcut'); if (SHORTCUT_CHOICES[s]) out.push(keysAction(SHORTCUT_CHOICES[s])); break; }
    case 'scroll': {
      const d = need('scroll_dir'); const amt = pick('scroll_amount').v;
      if (d === 'top' || d === 'bottom') out.push({ type: 'scroll', dir: d === 'top' ? 'up' : 'down', amount: 'edge' });
      else if (d) out.push({ type: 'scroll', dir: d, amount: amt === 'a_lot' ? 'lot' : amt === 'little' ? 'little' : 'page' });
      break;
    }
    case 'volume': { const op = need('volume_op'); if (VOLUME_OPS[op]) out.push({ type: 'media', op: VOLUME_OPS[op][0], times: VOLUME_OPS[op][1] }); break; }
    case 'media': { const op = need('media_op'); if (MEDIA_OPS[op]) out.push({ type: 'media', op: MEDIA_OPS[op], times: 1 }); break; }
    case 'screenshot': out.push(keysAction(['win', 'shift', 's'])); break;
    case 'open_folder': { const f = need('folder'); if (f) out.push({ type: 'open_folder', name: f }); break; }
    case 'window': { const op = need('window_op'); if (WINDOW_OPS[op]) out.push({ type: 'window_op', op: WINDOW_OPS[op] }); break; }
    case 'click': { const t = need('text'); const name = req.candidates[t]; if (name) out.push({ type: 'click', name, kind: 'single' }); break; }
    case 'compose_email': out.push({ type: 'compose_email', to: '', subject: '', body: '' }); break;
    default: break;
  }
  if (conf < min) return { actions: [], confidence: conf, kind: act.v };
  return { actions: out, confidence: conf, kind: act.v };
}

/**
 * @param {{apiKey: string, url?: string, model?: string, minConfidence?: number, fetch?: typeof fetch, timeoutMs?: number}} cfg
 */
function createJev(cfg) {
  const url = cfg.url || process.env.CLIPPY_JEV_URL || DEFAULT_URL;
  const model = cfg.model || 'jev-latest';
  const doFetch = cfg.fetch || fetch;
  return {
    /** @returns {Promise<{actions: object[], confidence: number, kind: string|null, ms: number}>} */
    async plan(utterance, ctx = {}) {
      if (!cfg.apiKey) throw new Error('no TypeSafe key');
      const req = buildRequest(utterance, ctx, model);
      const t0 = Date.now();
      const res = await doFetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: req.model, state: req.state, questions: req.questions }),
        signal: AbortSignal.timeout(cfg.timeoutMs || 6000),
      });
      if (!res.ok) {
        const err = new Error(`Jev answered ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const plan = toActions(data.answers, req, utterance, cfg.minConfidence == null ? MIN_CONFIDENCE : cfg.minConfidence);
      return { ...plan, ms: Date.now() - t0 };
    },
  };
}

module.exports = { createJev, buildRequest, toActions, textCandidates, domainGuess, ACTIONS, SHORTCUT_CHOICES, MIN_CONFIDENCE };
