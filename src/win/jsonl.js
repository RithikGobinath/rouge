'use strict';
// A helper program that stays running while the app does, spoken to in JSON
// lines: a request goes in as {"id":7,"op":"..."}, the answer comes back with
// the same id, and anything the helper wants to say on its own arrives as
// {"ev":"..."}. Both Windows helpers (controls and input, and speech) use it.
//
// The helper may be slow to start, may not start at all, and may die. So
// `available` says whether it answered its first ping and is still there, a
// dead helper is started again with a growing wait, and everything that calls
// it has to cope with it being unavailable: the app loses a feature, never
// the whole.

const childProcess = require('child_process');

/** Cuts a stream of text into whole lines, whatever size the pieces arrive in. */
function lineReader(onLine) {
  let rest = '';
  return (chunk) => {
    rest += chunk;
    for (let cut = rest.indexOf('\n'); cut !== -1; cut = rest.indexOf('\n')) {
      const line = rest.slice(0, cut).trim();
      rest = rest.slice(cut + 1);
      if (line) onLine(line);
    }
  };
}

/** Named subscriptions. Unlike an EventEmitter, a name like "error" is just a name. */
function switchboard(onFault) {
  const lists = new Map();
  return {
    on(name, fn) {
      if (!lists.has(name)) lists.set(name, new Set());
      lists.get(name).add(fn);
      return () => this.off(name, fn);
    },
    off(name, fn) { const set = lists.get(name); if (set) set.delete(fn); },
    send(name, data) {
      for (const fn of [...(lists.get(name) || [])]) {
        try { fn(data); } catch (e) { onFault(`a "${name}" listener threw: ${e.message}`); }       // one bad listener must not stop the rest
      }
    },
  };
}

/**
 * @param {{command:string, args:string[], name?:string, log?:(m:string)=>void, spawn?:typeof childProcess.spawn,
 *          pingTimeoutMs?:number, defaultTimeoutMs?:number, restartMinMs?:number, restartMaxMs?:number, restartOnTimeout?:boolean}} opts
 */
function createJsonlProcess(opts) {
  const name = opts.name || 'helper';
  const log = opts.log || (() => {});
  const spawnChild = opts.spawn || childProcess.spawn;
  const pingMs = opts.pingTimeoutMs || 20000;
  const answerMs = opts.defaultTimeoutMs || 4000;
  const waitMin = opts.restartMinMs || 1000;
  const waitMax = opts.restartMaxMs || 30000;
  const bus = switchboard((m) => log(`${name}: ${m}`));

  let child = null;
  let wanted = false;                  // has anyone asked for it to be running
  let alive = false;                   // answered its ping
  let pid = 0; let restarts = 0; let lastError = '';
  let waitNext = waitMin;
  let comeBack = null; let giveUp = null;
  let serial = 0;
  let generation = 0; let failures = 0; let aliveAt = 0;
  const unanswered = new Map();        // id -> { resolve, reject, timer }

  const clearTimers = () => { clearTimeout(comeBack); clearTimeout(giveUp); comeBack = null; giveUp = null; };
  function refuseAll(why) {
    for (const [id, q] of unanswered) { clearTimeout(q.timer); unanswered.delete(id); q.reject(new Error(why)); }
  }
  function setAlive(yes) { if (alive !== yes) { alive = yes; bus.send('availability', yes); } }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { log(`${name}: not JSON: ${line.slice(0, 120)}`); return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.ev) {
      if (msg.ev === 'ready') pid = Number(msg.pid) || pid;
      bus.send('event', msg);
      bus.send(msg.ev, msg);
      return;
    }
    const q = msg.id != null ? unanswered.get(msg.id) : null;
    if (!q) return;
    unanswered.delete(msg.id);
    clearTimeout(q.timer);
    if (msg.error) q.reject(new Error(String(msg.error))); else q.resolve(msg);
  }

  function retire(mine, reason, retry = true, kill = false) {
    if (mine && child !== mine) return;
    const was = alive;
    if (was && Date.now() - aliveAt >= 30000) { failures = 0; waitNext = waitMin; }
    child = null;
    pid = 0;
    clearTimeout(giveUp); giveUp = null;
    setAlive(false);
    refuseAll(reason);
    if (kill && mine) {
      try { mine.stdin.end(); } catch (_) { /* already closed */ }
      try { mine.kill(); } catch (_) { wanted = false; log(`${name}: could not end the failed helper`); }
    }
    if (!retry || !wanted) return;
    failures += 1;
    if (failures >= 5) { wanted = false; log(`${name}: repeated failures, giving up`); return; }
    log(`${name}: helper lost${was ? ', starting it again' : ''}`);
    restarts += 1;
    const retryTimer = setTimeout(() => { if (comeBack !== retryTimer) return; comeBack = null; launch(); }, waitNext);
    comeBack = retryTimer;
    if (comeBack.unref) comeBack.unref();
    waitNext = Math.min(waitMax, waitNext * 2);
  }

  function launch() {
    if (child || !wanted) return;
    try {
      child = spawnChild(opts.command, opts.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      lastError = `could not start: ${e.message}`;
      log(`${name}: ${lastError}`);
      child = null;
      retire(null, `${name} could not start`);
      return;
    }
    const mine = child;
    generation += 1;
    mine.stdout.setEncoding('utf8');
    mine.stdout.on('data', lineReader((line) => { if (child === mine && wanted) onLine(line); }));
    if (mine.stderr) {
      mine.stderr.setEncoding('utf8');
      mine.stderr.on('data', (d) => { if (child !== mine || !wanted) return; const text = String(d).trim(); if (text) { lastError = text.slice(0, 300); log(`${name} stderr: ${lastError}`); } });
    }
    const fault = (e) => { if (child !== mine) return; lastError = e.message; log(`${name}: helper connection failed`); retire(mine, `${name} connection failed`, true, true); };
    mine.on('error', fault);
    mine.stdin.on('error', fault);
    mine.on('exit', () => { if (child === mine) retire(mine, `${name} exited`); });

    // It has pingMs to answer a ping; if it cannot, it is not coming up, and trying again would only repeat that.
    giveUp = setTimeout(() => {
      if (child !== mine || !wanted) return;
      giveUp = null;
      if (!alive) { log(`${name}: no answer to its ping, giving up`); wanted = false; retire(mine, `${name} did not answer its ping`, false, true); }
    }, pingMs);
    if (giveUp.unref) giveUp.unref();
    ask('ping', {}, pingMs).then((r) => {
      if (child !== mine || !wanted) return;
      clearTimeout(giveUp); giveUp = null;
      pid = Number(r.pid) || pid;
      aliveAt = Date.now();
      log(`${name} is up (pid ${pid})`);
      setAlive(true);
    }, (e) => { if (child === mine) lastError = `ping: ${e.message}`; });
  }

  function ask(op, params = {}, timeoutMs = answerMs) {
    return new Promise((resolve, reject) => {
      if (!child || !child.stdin || child.stdin.destroyed) { reject(new Error(`${name} is not running`)); return; }
      const mine = child;
      serial += 1;
      const id = serial;
      // Keep request timers referenced so a short timeout still fires when the
      // helper is idle (unref would let the event loop drain before it runs).
      const timer = setTimeout(() => {
        if (!unanswered.delete(id)) return;
        const message = `${op} timed out after ${timeoutMs}ms`;
        reject(new Error(message));
        if (opts.restartOnTimeout && op !== 'ping' && child === mine) {
          lastError = message;
          retire(mine, `${name} stopped after an operation timed out`, true, true);
        }
      }, timeoutMs);
      unanswered.set(id, { resolve, reject, timer });
      try {
        mine.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
      } catch (e) {
        unanswered.delete(id); clearTimeout(timer); reject(e);
      }
    });
  }

  return {
    get available() { return alive; },
    status: () => ({ available: alive, pid, generation, restarts, lastError }),
    start() { if (wanted) return; wanted = true; failures = 0; waitNext = waitMin; launch(); },
    stop() {
      wanted = false;
      clearTimers();
      retire(child, `${name} stopped`, false, true);
    },
    request: ask,
    /** Resolves once the helper has answered its ping, or rejects after `ms`. */
    ready(ms = 20000) {
      if (alive) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error(`${name} did not become ready`)); }, ms);
        const off = bus.on('availability', (yes) => { if (yes) { clearTimeout(timer); off(); resolve(); } });
      });
    },
    on: (event, fn) => bus.on(event, fn),
    off: (event, fn) => bus.off(event, fn),
  };
}

module.exports = { createJsonlProcess };
