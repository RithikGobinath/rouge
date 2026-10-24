'use strict';
// Client for the on-device speech sidecar (speech.ps1). Keeps one recognizer
// loaded so holding the talk key starts listening at once, and turns its
// events into a small transcript model: words heard so far, committed phrases
// plus the phrase still being guessed.

const path = require('path');
const { createJsonlProcess } = require('../win/jsonl');

/**
 * @typedef {Object} Transcript
 * @property {string[]} finals  phrases the recognizer is sure of, in order
 * @property {string} partial   the phrase it is still guessing at
 * @property {string} text      finals plus partial, as one string
 */

function createSpeech(opts = {}) {
  const script = opts.script || path.join(__dirname, 'speech.ps1');
  const proc = createJsonlProcess({
    name: 'speech',
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    log: opts.log,
    spawn: opts.spawn,
    pingTimeoutMs: 30000,
    restartOnTimeout: true,
  });

  let recognizer = '';
  let initError = '';
  let listening = false;
  let initialization = null;
  /** @type {Transcript} */
  let t = { finals: [], partial: '', text: '' };
  const listeners = { update: [], level: [], done: [], error: [] };
  const emit = (k, v) => listeners[k].forEach((f) => { try { f(v); } catch (_) { /* a listener must not break the stream */ } });
  const rebuild = () => { t = { finals: t.finals, partial: t.partial, text: [...t.finals, t.partial].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() }; };

  proc.on('hyp', (m) => { t.partial = String(m.text || ''); rebuild(); emit('update', { ...t, kind: 'hyp' }); });
  proc.on('final', (m) => { t.finals = [...t.finals, String(m.text || '')]; t.partial = ''; rebuild(); emit('update', { ...t, kind: 'final', conf: m.conf }); });
  proc.on('rejected', (m) => { if (m.text && !t.partial) { t.partial = String(m.text); rebuild(); emit('update', { ...t, kind: 'hyp' }); } });
  proc.on('level', (m) => emit('level', Math.max(0, Math.min(100, Number(m.v) || 0)) / 100));
  proc.on('error', (m) => emit('error', new Error(String(m.message || 'speech error'))));
  proc.on('done', () => { listening = false; emit('done', { ...t }); });

  proc.on('availability', (available) => {
    if (available) { initialize(); return; }
    const wasListening = listening;
    recognizer = ''; initError = ''; listening = false; initialization = null;
    if (wasListening) emit('done', { ...t });
  });

  function initialize() {
    const generation = proc.status().generation;
    if (initialization && initialization.generation === generation) return initialization.promise;
    const current = { generation, promise: null };
    initialization = current;
    current.promise = (async () => {
      try {
        const r = await proc.request('init', { culture: opts.culture || 'en' }, 30000);
        if (proc.status().generation !== generation || !proc.available) return { ok: false, recognizer: '', error: 'Speech helper restarted.' };
        recognizer = String(r.recognizer || ''); initError = '';
      } catch (e) {
        if (proc.status().generation !== generation || !proc.available) return { ok: false, recognizer: '', error: 'Speech helper restarted.' };
        initError = e.message; recognizer = '';
      }
      return { ok: Boolean(recognizer), recognizer, error: initError };
    })();
    return current.promise;
  }

  async function init() {
    await proc.ready(40000);
    return initialize();
  }

  return {
    start: () => proc.start(),
    stop: () => proc.stop(),
    init,
    get available() { return proc.available && Boolean(recognizer); },
    get recognizer() { return recognizer; },
    get error() { return initError || proc.status().lastError; },
    get listening() { return listening; },
    /** Begin listening. `file` plays a WAV instead of the microphone (tests). */
    async listen(file) {
      const ready = await init();
      if (!ready.ok) throw new Error(ready.error || 'Speech recognition is not ready.');
      t = { finals: [], partial: '', text: '' };
      listening = true;
      try { await proc.request('start', file ? { file } : {}, 8000); } catch (e) { listening = false; throw e; }
    },
    /** Finish the phrase in progress and resolve with the whole transcript once the recognizer is done. */
    finish(timeoutMs = 2500) {
      return new Promise((resolve) => {
        if (!listening) return resolve({ ...t });
        const timer = setTimeout(() => { off(); listening = false; resolve({ ...t }); }, timeoutMs);
        const off = proc.on('done', () => { clearTimeout(timer); off(); resolve({ ...t }); });
        proc.request('stop', {}, 4000).catch(() => { clearTimeout(timer); off(); resolve({ ...t }); });
      });
    },
    async cancel() { listening = false; try { await proc.request('cancel', {}, 3000); } catch (_) { /* already stopped */ } },
    transcript: () => ({ ...t }),
    on(kind, fn) { listeners[kind].push(fn); return () => { listeners[kind] = listeners[kind].filter((f) => f !== fn); }; },
    status: () => ({ ...proc.status(), recognizer, error: initError }),
  };
}

module.exports = { createSpeech };
