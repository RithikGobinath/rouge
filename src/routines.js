'use strict';
// Routines: say a few actions in a row, keep them, then say "run my routine".
// A routine is just the validated actions it ran, in order. They live in one
// small file on this PC.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { validateAll } = require('./actions/schema');
const { describe, clip } = require('./actions/describe');

const MAX_ROUTINES = 50;
const MAX_STEPS = 25;

/** "Open Notepad, type hello": a name from what the routine does. */
function autoName(actions) {
  const picks = actions.filter((a) => ['open_app', 'open_url', 'open_folder', 'type_text', 'switch_to', 'compose_email'].includes(a.type));
  const src = picks.length ? picks : actions;
  const parts = src.slice(0, 2).map((a) => describe(a).present.replace(/^(\w)/, (c) => c.toUpperCase()));
  const base = parts.join(', ') || 'My routine';
  return clip(base, 48);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** @param {{file:string}} opts */
function createRoutines({ file }) {
  const emitter = new EventEmitter();
  /** @type {Array<{id:string,name:string,actions:object[],createdAt:number,lastRunAt:number,runs:number}>} */
  let items = [];
  try { items = (JSON.parse(fs.readFileSync(file, 'utf8')).routines || []).filter((r) => r && r.id && Array.isArray(r.actions)); } catch (_) { items = []; }
  items = items.map((r) => ({ ...r, actions: validateAll(r.actions, MAX_STEPS).actions })).filter((r) => r.actions.length);

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, routines: items }, null, 2));
    fs.renameSync(tmp, file);
    emitter.emit('change');
  }

  const api = {
    on: (ev, cb) => { emitter.on(ev, cb); return () => emitter.off(ev, cb); },
    list: () => items.map((r) => ({ ...r, steps: r.actions.map((a) => describe(a).present) })).sort((a, b) => b.createdAt - a.createdAt),
    get: (id) => items.find((r) => r.id === id) || null,
    autoName,

    /** @returns {{ok:boolean, error?:string, routine?:object}} */
    save({ name, actions }) {
      const v = validateAll(actions, MAX_STEPS);
      const runnable = v.actions.filter((a) => !['cancel', 'save_routine', 'run_routine'].includes(a.type));
      if (!runnable.some((a) => a.type !== 'wait')) return { ok: false, error: 'There is nothing to keep yet.' };
      if (items.length >= MAX_ROUTINES) return { ok: false, error: `You can keep ${MAX_ROUTINES} routines. Delete one first.` };
      const clean = clip(String(name || '').trim() || autoName(runnable), 60);
      const dup = items.find((r) => norm(r.name) === norm(clean));
      const routine = { id: crypto.randomBytes(5).toString('hex'), name: clean, actions: runnable, createdAt: Date.now(), lastRunAt: 0, runs: 0 };
      if (dup) { routine.name = clip(`${clean} ${items.filter((r) => norm(r.name).startsWith(norm(clean))).length + 1}`, 60); }
      items.push(routine);
      persist();
      return { ok: true, routine };
    },
    rename(id, name) {
      const r = items.find((x) => x.id === id);
      const clean = clip(String(name || '').trim(), 60);
      if (!r || !clean) return { ok: false, error: 'Give it a name.' };
      r.name = clean; persist();
      return { ok: true };
    },
    remove(id) { const n = items.length; items = items.filter((r) => r.id !== id); if (items.length !== n) persist(); },
    touch(id) { const r = items.find((x) => x.id === id); if (r) { r.lastRunAt = Date.now(); r.runs += 1; persist(); } },

    /**
     * "run my routine" -> the newest; "run my morning routine" -> the best
     * name match. Returns null when nothing fits.
     */
    match(name) {
      if (!items.length) return null;
      const want = norm(name);
      // Same-millisecond saves: prefer the later list entry so "newest" is stable.
      const newest = [...items].sort((a, b) => (b.createdAt - a.createdAt) || (items.indexOf(b) - items.indexOf(a)))[0];
      if (!want) return newest;
      const words = want.split(' ');
      let best = null; let bestScore = 0;
      for (const r of items) {
        const n = norm(r.name);
        let score = 0;
        if (n === want) score = 100;
        else if (n.includes(want)) score = 60 + want.length;
        else score = words.filter((w) => w.length > 2 && n.split(' ').some((x) => x === w || x.startsWith(w))).length * 10;
        if (score > bestScore) { best = r; bestScore = score; }
      }
      return bestScore >= 10 ? best : null;
    },
  };
  return api;
}

module.exports = { createRoutines, autoName, MAX_ROUTINES, MAX_STEPS };
