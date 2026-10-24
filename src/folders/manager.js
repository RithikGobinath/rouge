'use strict';
// "Knows your stuff": folders of notes, docs and calendars the app can
// answer from. Add a folder, turn it off to stop using it. Up to 200 files per
// folder, 2 MB per file. Files are read here, on this PC; only the few short
// excerpts that help answer a question ever go to your AI provider.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { extract: defaultExtract, SUPPORTED, MAX_BYTES } = require('./extract');
const { Bm25, chunk } = require('./search');
const { upcoming, formatEvent } = require('./ics');

const MAX_FILES = 200;
const MAX_VISITED = 6000;
const MAX_DEPTH = 8;
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', 'appdata', '.git']);
const CACHE_VERSION = 2;
const DATE_WORDS = /\b(today|tomorrow|tonight|week|weekend|month|schedule|calendar|meeting|meetings|due|deadline|exam|midterm|final|class|classes|lecture|appointment|event|events|when|next|upcoming|free|busy|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const idOf = (p) => crypto.createHash('sha1').update(norm(p)).digest('hex').slice(0, 10);

/** Why a folder cannot be added, or null. Keeps a whole drive or the OS out of the index. */
function refuse(dirPath) {
  const abs = path.resolve(String(dirPath || ''));
  if (!path.isAbsolute(String(dirPath || ''))) return 'Choose a folder from the picker.';
  if (path.parse(abs).root.toLowerCase() === abs.toLowerCase() || path.parse(abs).root.toLowerCase() === abs.toLowerCase() + path.sep) return 'Pick a folder inside the drive, not the whole drive.';
  const win = (process.env.SystemRoot || 'C:\\Windows').toLowerCase();
  if (norm(abs) === norm(win) || norm(abs).startsWith(norm(win) + path.sep)) return 'That is a Windows system folder.';
  for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) if (pf && (norm(abs) === norm(pf) || norm(abs).startsWith(norm(pf) + path.sep))) return 'That folder holds installed programs, not notes.';
  return null;
}

/** @param {{dir:string, extract?:Function, log?:Function, now?:()=>number}} opts */
function createFolders(opts) {
  const dir = opts.dir;
  const extract = opts.extract || defaultExtract;
  const log = opts.log || (() => {});
  const emitter = new EventEmitter();
  const cfgFile = path.join(dir, 'folders.json');
  const cacheDir = path.join(dir, 'index');
  /** @type {Array<{id:string,path:string,name:string,enabled:boolean,addedAt:number}>} */
  let folders = [];
  const caches = new Map();      // id -> cache object
  const inflight = new Map();    // id -> promise of the refresh in progress
  const index = new Bm25();

  function saveConfig() { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(cfgFile, JSON.stringify({ version: 1, folders }, null, 2)); }
  function cachePath(id) { return path.join(cacheDir, `${id}.json`); }
  function saveCache(id) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cachePath(id), JSON.stringify(caches.get(id))); }
  function loadCache(id) {
    try { const c = JSON.parse(fs.readFileSync(cachePath(id), 'utf8')); if (c.version === CACHE_VERSION) return c; } catch (_) { /* no cache yet */ }
    return { version: CACHE_VERSION, files: {}, stats: { supported: 0, skipped: 0, tooBig: 0, errors: [] }, indexedAt: 0 };
  }

  function addToIndex(f) {
    index.removeWhere((_, meta) => meta.folderId === f.id);
    if (!f.enabled) return;
    const c = caches.get(f.id);
    for (const [rel, file] of Object.entries(c.files)) {
      (file.chunks || []).forEach((text, i) => index.add(`${f.id}:${rel}:${i}`, text, { folderId: f.id, folder: f.name, file: rel }));
    }
  }

  /** Walk a folder, newest files first, within the caps. */
  async function scan(root) {
    const found = [];
    let visited = 0; let tooBig = 0;
    const queue = [{ abs: root, depth: 0 }];
    while (queue.length && visited < MAX_VISITED) {
      const { abs, depth } = queue.shift();
      let entries;
      try { entries = await fs.promises.readdir(abs, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        visited += 1;
        if (e.isSymbolicLink()) continue;
        const full = path.join(abs, e.name);
        if (e.isDirectory()) {
          if (depth < MAX_DEPTH && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name.toLowerCase())) queue.push({ abs: full, depth: depth + 1 });
        } else if (e.isFile() && SUPPORTED.has(path.extname(e.name).toLowerCase())) {
          let st; try { st = await fs.promises.stat(full); } catch (_) { continue; }
          if (st.size > MAX_BYTES) { tooBig += 1; continue; }
          found.push({ abs: full, rel: path.relative(root, full).replace(/\\/g, '/'), size: st.size, mtime: Math.floor(st.mtimeMs) });
        }
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    return { files: found.slice(0, MAX_FILES), skipped: Math.max(0, found.length - MAX_FILES), tooBig };
  }

  /** Re-read one folder. Asking while a refresh is running joins it instead of starting another. */
  function refresh(id) {
    if (inflight.has(id)) return inflight.get(id);
    const f = folders.find((x) => x.id === id);
    if (!f) return Promise.resolve();
    const p = doRefresh(f).finally(() => { inflight.delete(id); emitter.emit('change'); });
    inflight.set(id, p);
    emitter.emit('change');
    return p;
  }

  async function doRefresh(f) {
    const id = f.id;
    try {
      const cache = caches.get(id) || loadCache(id);
      caches.set(id, cache);
      const { files, skipped, tooBig } = await scan(f.path);
      const keep = {};
      const errors = [];
      for (const file of files) {
        const old = cache.files[file.rel];
        if (old && old.mtime === file.mtime && old.size === file.size) { keep[file.rel] = old; continue; }
        try {
          const r = await extract(file.abs);
          keep[file.rel] = { mtime: file.mtime, size: file.size, kind: r.kind, chunks: chunk(r.text), events: r.events };
        } catch (e) {
          errors.push({ file: file.rel, error: String(e.message || e).slice(0, 120) });
          keep[file.rel] = { mtime: file.mtime, size: file.size, kind: 'error', chunks: [] };
        }
      }
      cache.files = keep;
      cache.stats = { supported: files.length, skipped, tooBig, errors };
      cache.indexedAt = Date.now();
      saveCache(id);
      addToIndex(f);
    } catch (e) {
      log(`folder ${id}: ${e.message}`);
      const cache = caches.get(id); if (cache) cache.stats.errors = [{ file: '', error: String(e.message || e) }];
    }
  }

  const api = {
    on: (ev, cb) => { emitter.on(ev, cb); return () => emitter.off(ev, cb); },

    /** Read the saved folders and their caches. Fast: nothing is rescanned. */
    load() {
      try { folders = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).folders || []; } catch (_) { folders = []; }
      folders = folders.filter((f) => f && f.id && f.path);
      for (const f of folders) { caches.set(f.id, loadCache(f.id)); addToIndex(f); }
      return api.list();
    },
    async refreshAll() { for (const f of folders.filter((x) => x.enabled)) await refresh(f.id); },
    refresh,

    list() {
      return folders.map((f) => {
        const c = caches.get(f.id);
        const s = c ? c.stats : { supported: 0, skipped: 0, tooBig: 0, errors: [] };
        let exists = true; try { exists = fs.statSync(f.path).isDirectory(); } catch (_) { exists = false; }
        return { id: f.id, name: f.name, path: f.path, enabled: f.enabled, files: s.supported, skipped: s.skipped, tooBig: s.tooBig, errors: s.errors.length, indexing: inflight.has(f.id), indexedAt: c ? c.indexedAt : 0, missing: !exists };
      });
    },

    /** @returns {{ok:boolean, error?:string, folder?:object}} */
    add(dirPath) {
      const why = refuse(dirPath);
      if (why) return { ok: false, error: why };
      let st; try { st = fs.statSync(dirPath); } catch (_) { return { ok: false, error: 'That folder is not there.' }; }
      if (!st.isDirectory()) return { ok: false, error: 'That is a file, not a folder.' };
      const id = idOf(dirPath);
      if (folders.some((f) => f.id === id)) return { ok: false, error: 'That folder is already added.' };
      const f = { id, path: path.resolve(dirPath), name: path.basename(path.resolve(dirPath)) || dirPath, enabled: true, addedAt: Date.now() };
      folders.push(f); caches.set(id, loadCache(id));
      saveConfig();
      refresh(id);
      return { ok: true, folder: { id, name: f.name } };
    },
    remove(id) {
      index.removeWhere((_, meta) => meta.folderId === id);
      folders = folders.filter((f) => f.id !== id); caches.delete(id);
      try { fs.rmSync(cachePath(id), { force: true }); } catch (_) { /* gone */ }
      saveConfig(); emitter.emit('change');
    },
    setEnabled(id, enabled) {
      const f = folders.find((x) => x.id === id);
      if (!f) return;
      f.enabled = Boolean(enabled); saveConfig(); addToIndex(f);
      if (f.enabled) refresh(id); else emitter.emit('change');
    },

    names: () => folders.filter((f) => f.enabled).map((f) => f.name),
    /** Path of an enabled folder by (case-insensitive) name, for "open my class notes folder". */
    resolve(name) { const n = String(name || '').trim().toLowerCase(); const f = folders.find((x) => x.name.toLowerCase() === n); return f ? f.path : null; },

    search: (q, k = 5) => index.search(q, k),

    upcomingEvents(now = Date.now(), days = 14, max = 20) {
      const events = [];
      for (const f of folders.filter((x) => x.enabled)) {
        const c = caches.get(f.id);
        for (const file of Object.values((c && c.files) || {})) if (file.events) events.push(...file.events);
      }
      return upcoming(events, now, days, max);
    },

    /**
     * Excerpts from the folders that bear on this question, formatted for a
     * model prompt, or empty when nothing helps. Only chunks that cover at
     * least half of the question's words are used; calendar entries ride along
     * when the question is about dates or plans.
     */
    context(question, { now = Date.now(), k = 4, maxChars = 3600 } = {}) {
      const parts = []; const sources = [];
      let used = 0;
      for (const hit of index.search(question, k * 2)) {
        if (hit.coverage < 0.5 || sources.length >= k) continue;
        const piece = `[${hit.meta.folder}/${hit.meta.file}]\n${hit.text}`;
        if (used + piece.length > maxChars) break;
        used += piece.length; parts.push(piece); sources.push({ folder: hit.meta.folder, file: hit.meta.file });
      }
      let text = parts.length ? `From the user's folders (use only if relevant, and say which file):\n\n${parts.join('\n\n')}` : '';
      if (DATE_WORDS.test(question)) {
        const evs = api.upcomingEvents(now);
        if (evs.length) text += `${text ? '\n\n' : ''}Upcoming events on the user's calendar:\n${evs.map(formatEvent).join('\n')}`;
      }
      return { text, sources };
    },
  };
  return api;
}

module.exports = { createFolders, refuse, MAX_FILES, MAX_BYTES };
