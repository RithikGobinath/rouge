'use strict';
// Settings, and the three AI keys. Keys are encrypted with the OS (Windows
// DPAPI, through Electron's safeStorage) and kept on this device only. The
// window that shows them never receives a saved key: it learns "set" or "not
// set" and nothing more. Only the main process can read one back.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const KEY_NAMES = ['typesafe', 'gemini', 'anthropic'];
const CORNERS = ['tl', 'tr', 'bl', 'br'];
const ACCEL = /^(?:(?:Control|Ctrl|Alt|Shift|Super|Meta|Command|CommandOrControl)\+)+(?:[A-Z0-9]|F\d{1,2}|Space|Enter|Return|Tab|Escape|Esc|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|Backspace)$/;
const MODEL = /^[A-Za-z0-9._:/-]{1,80}$/;
const MODEL_NAMES = ['gemini', 'anthropic', 'anthropicA', 'anthropicB', 'anthropicC'];
const CLAUDE_ROLES = new Set(['anthropicA', 'anthropicB', 'anthropicC']);

const DEFAULTS = Object.freeze({
  version: 1,
  onboarded: false,
  markCorner: 'br',
  markHidden: false,
  strip: false,
  speakReplies: false,
  startWithWindows: false,
  useClaudeCode: false,
  webAccess: true,
  hotkeys: { talk: 'Control+Alt+V', point: 'Control+Alt+L', hide: 'Control+Alt+H', panic: 'Control+Alt+X' },
  models: {
    gemini: 'gemini-3.6-flash', anthropic: 'claude-sonnet-5-5',
    anthropicA: 'claude-haiku-5-5', anthropicB: 'claude-sonnet-5-5', anthropicC: 'claude-opus-5-5',
  },
});

/** What a settings patch may contain, and how to check each field. */
const VALID = {
  onboarded: (v) => typeof v === 'boolean',
  markCorner: (v) => CORNERS.includes(v),
  markHidden: (v) => typeof v === 'boolean',
  strip: (v) => typeof v === 'boolean',
  speakReplies: (v) => typeof v === 'boolean',
  startWithWindows: (v) => typeof v === 'boolean',
  useClaudeCode: (v) => typeof v === 'boolean',
  webAccess: (v) => typeof v === 'boolean',
  hotkeys: (v) => v && typeof v === 'object' && Object.entries(v).every(([k, a]) => ['talk', 'point', 'hide', 'panic'].includes(k) && typeof a === 'string' && ACCEL.test(a)),
  models: (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v).every(([k, m]) => MODEL_NAMES.includes(k) && typeof m === 'string' && MODEL.test(m) && (!CLAUDE_ROLES.has(k) || m.startsWith('claude-'))),
};

/** A key as pasted: trimmed, one line, a sane length. */
function cleanKey(v) {
  const s = String(v == null ? '' : v).trim();
  if (s.length > 400 || /[\s\u0000-\u001f"']/.test(s)) return null;
  return s;
}

/**
 * @param {{dir:string, cipher:{available:()=>boolean|Promise<boolean>, encrypt:(s:string)=>Buffer|Promise<Buffer>, decrypt:(b:Buffer)=>string|Promise<string>}}} opts
 *        the cipher may be asynchronous (Electron's safeStorage now is)
 */
function createStore({ dir, cipher }) {
  const emitter = new EventEmitter();
  const settingsFile = path.join(dir, 'settings.json');
  const keysFile = path.join(dir, 'keys.json');
  let settings = structuredClone(DEFAULTS);
  let keys = {};      // name -> base64 ciphertext
  let plain = {};     // name -> the key itself, in memory only, filled by init()

  function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } }
  function writeJson(file, obj) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  }

  const saved = readJson(settingsFile, {});
  for (const [k, check] of Object.entries(VALID)) {
    if (saved[k] === undefined || !check(saved[k])) continue;
    settings[k] = (k === 'hotkeys' || k === 'models') ? { ...settings[k], ...saved[k] } : saved[k];
  }
  const rawKeys = readJson(keysFile, {});
  for (const n of KEY_NAMES) if (typeof rawKeys[n] === 'string' && rawKeys[n]) keys[n] = rawKeys[n];

  return {
    on: (ev, cb) => { emitter.on(ev, cb); return () => emitter.off(ev, cb); },
    defaults: () => structuredClone(DEFAULTS),
    settings: () => structuredClone(settings),

    /** @returns {{ok:boolean, error?:string}} */
    patch(p) {
      if (!p || typeof p !== 'object') return { ok: false, error: 'nothing to change' };
      const next = structuredClone(settings);
      for (const [k, v] of Object.entries(p)) {
        if (!(k in VALID)) return { ok: false, error: `unknown setting ${k}` };
        if (!VALID[k](v)) return { ok: false, error: `bad value for ${k}` };
        next[k] = (k === 'hotkeys' || k === 'models') ? { ...next[k], ...v } : v;
      }
      settings = next;
      writeJson(settingsFile, settings);
      emitter.emit('settings', structuredClone(settings), Object.keys(p));
      return { ok: true };
    },

    /** Which keys are saved, never what they are. */
    keyStatus() { return Object.fromEntries(KEY_NAMES.map((n) => [n, Boolean(keys[n])])); },

    /** Decrypt the saved keys once, at start. Anything that cannot be read counts as not set. */
    async init() {
      for (const n of KEY_NAMES) {
        if (!keys[n]) continue;
        try { plain[n] = await cipher.decrypt(Buffer.from(keys[n], 'base64')); } catch (_) { delete keys[n]; }
      }
    },

    /** Main process only. Returns '' when not set or unreadable. */
    getKey(name) { return KEY_NAMES.includes(name) && keys[name] ? (plain[name] || '') : ''; },

    /**
     * Save the keys given; an empty string clears one; an absent name is left alone.
     * @param {{typesafe?:string, gemini?:string, anthropic?:string}} given
     * @returns {Promise<{ok:boolean, error?:string, status?:Record<string,boolean>}>}
     */
    async setKeys(given) {
      if (!given || typeof given !== 'object') return { ok: false, error: 'no keys given' };
      if (!(await cipher.available())) return { ok: false, error: 'This PC cannot encrypt keys, so none were saved.' };
      const next = { ...keys }; const nextPlain = { ...plain };
      for (const [n, raw] of Object.entries(given)) {
        if (!KEY_NAMES.includes(n)) return { ok: false, error: `unknown key ${n}` };
        if (raw === undefined || raw === null) continue;
        const k = cleanKey(raw);
        if (k === null) return { ok: false, error: `That ${n} key has spaces or odd characters. Paste it again.` };
        if (k === '') { delete next[n]; delete nextPlain[n]; } else { next[n] = (await cipher.encrypt(k)).toString('base64'); nextPlain[n] = k; }
      }
      keys = next; plain = nextPlain;
      writeJson(keysFile, keys);
      emitter.emit('keys');
      return { ok: true, status: this.keyStatus() };
    },
  };
}

module.exports = { createStore, DEFAULTS, KEY_NAMES, ACCEL };
