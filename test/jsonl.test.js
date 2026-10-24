'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createJsonlProcess } = require('../src/win/jsonl');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(5); } }

/** A stand-in helper process: what it is sent is written down, and the test says what it answers. */
function rig(over = {}) {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.sent = [];
    let rest = '';
    child.stdin.on('data', (d) => { rest += d; let cut; while ((cut = rest.indexOf('\n')) >= 0) { child.sent.push(JSON.parse(rest.slice(0, cut))); rest = rest.slice(cut + 1); } });
    child.says = (obj) => child.stdout.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null, 'SIGTERM')); };
    child.dies = (code = 1) => child.emit('exit', code, null);
    children.push(child);
    if (over.autoPing !== false) setImmediate(() => { child.on('exit', () => {}); });
    return child;
  };
  const logs = [];
  const proc = createJsonlProcess({ command: 'helper', args: [], name: 'test-helper', spawn, log: (m) => logs.push(m), pingTimeoutMs: 300, restartMinMs: 20, restartMaxMs: 80, ...over.opts });
  /** Answer the ping the way a healthy helper does. */
  const bringUp = async (n = 0) => { await until(() => children[n] && children[n].sent.length); children[n].says({ id: children[n].sent[0].id, pid: 4242 + n }); await proc.ready(1000); };
  return { proc, children, logs, bringUp };
}

test('it is available once the helper answers its ping, and not before', async () => {
  const { proc, children, bringUp } = rig();
  const seen = [];
  proc.on('availability', (v) => seen.push(v));
  assert.equal(proc.available, false);
  proc.start();
  await until(() => children[0] && children[0].sent.length);
  assert.equal(children[0].sent[0].op, 'ping');
  assert.equal(proc.available, false, 'it has not answered yet');
  await bringUp();
  assert.equal(proc.available, true);
  assert.deepEqual(seen, [true]);
  assert.equal(proc.status().pid, 4242);
  proc.stop();
});

test('answers find their requests by id, in any order, and an error reply rejects', async () => {
  const { proc, children, bringUp } = rig();
  proc.start(); await bringUp();
  const a = proc.request('one', { x: 1 });
  const b = proc.request('two');
  const c = proc.request('three');
  await until(() => children[0].sent.length === 4);
  const [, one, two, three] = children[0].sent;
  assert.deepEqual([one.op, one.x, two.op, three.op], ['one', 1, 'two', 'three']);
  children[0].says({ id: three.id, v: 3 });
  children[0].says({ id: one.id, v: 1 });
  children[0].says({ id: two.id, error: 'no such thing' });
  assert.equal((await a).v, 1);
  assert.equal((await c).v, 3);
  await assert.rejects(b, /no such thing/);
  proc.stop();
});

test('lines may arrive in pieces, with CRLF, and a broken line is ignored', async () => {
  const { proc, children, bringUp } = rig();
  proc.start(); await bringUp();
  const heard = [];
  proc.on('key', (m) => heard.push(m.vk));
  const out = proc.request('x');
  await until(() => children[0].sent.length === 2);
  const id = children[0].sent[1].id;
  const text = `{"ev":"key","vk":32}\r\nnot json at all\n{"id":${id},"ok":true}\n`;
  for (let i = 0; i < text.length; i += 7) children[0].stdout.write(text.slice(i, i + 7));
  assert.equal((await out).ok, true);
  assert.deepEqual(heard, [32]);
  proc.stop();
});

test('events reach their listeners, an "error" event needs none, and one bad listener does not stop the others', async () => {
  const { proc, children, bringUp, logs } = rig();
  proc.start(); await bringUp();
  const got = [];
  const off = proc.on('click', (m) => got.push(['a', m.x]));
  proc.on('click', () => { throw new Error('listener bug'); });
  proc.on('click', (m) => got.push(['c', m.x]));
  proc.on('event', (m) => got.push(['any', m.ev]));
  children[0].says({ ev: 'error', message: 'nobody listens for this' });
  children[0].says({ ev: 'click', x: 5 });
  await until(() => got.length >= 4);
  assert.deepEqual(got, [['any', 'error'], ['any', 'click'], ['a', 5], ['c', 5]], 'the catch-all hears an event first, then the listeners for its name');
  assert.ok(logs.some((l) => /listener bug/.test(l)), 'the listener that threw is reported');
  off();
  children[0].says({ ev: 'click', x: 6 });
  await until(() => got.length >= 6);
  assert.deepEqual(got.slice(4), [['any', 'click'], ['c', 6]]);
  proc.stop();
});

test('a request with no answer times out, and does not poison the next one', async () => {
  const { proc, children, bringUp } = rig();
  proc.start(); await bringUp();
  await assert.rejects(proc.request('slow', {}, 40), /slow timed out after 40ms/);
  const next = proc.request('quick');
  await until(() => children[0].sent.length === 3);
  children[0].says({ id: children[0].sent[2].id, ok: 1 });
  assert.equal((await next).ok, 1);
  proc.stop();
});

test('when the helper dies it is unavailable, pending requests fail, and it is started again', async () => {
  const { proc, children, bringUp } = rig();
  const seen = [];
  proc.on('availability', (v) => seen.push(v));
  proc.start(); await bringUp();
  const orphan = proc.request('never answered', {}, 2000);
  orphan.catch(() => {});
  children[0].dies(3);
  await assert.rejects(orphan, /exited/);
  assert.equal(proc.available, false);
  assert.ok(await until(() => children.length === 2, 1500), 'a second helper was started');
  await bringUp(1);
  assert.equal(proc.available, true);
  assert.deepEqual(seen, [true, false, true]);
  assert.equal(proc.status().restarts, 1);
  proc.stop();
});

test('stop() ends the helper for good and fails what was waiting', async () => {
  const { proc, children, bringUp } = rig();
  proc.start(); await bringUp();
  const waiting = proc.request('hang', {}, 2000);
  waiting.catch(() => {});
  proc.stop();
  await assert.rejects(waiting, /stopped/);
  assert.equal(children[0].killed, true);
  assert.equal(proc.available, false);
  await assert.rejects(proc.request('after'), /not running/);
  await sleep(150);
  assert.equal(children.length, 1, 'and it is not started again');
});

test('a helper that never answers its ping is given up on, not restarted in a loop', async () => {
  const { proc, children, logs } = rig();
  proc.start();
  assert.ok(await until(() => children[0] && children[0].killed, 1500), 'it was ended');
  await sleep(200);
  assert.equal(children.length, 1);
  assert.equal(proc.available, false);
  assert.ok(logs.some((l) => /giving up/.test(l)));
  await assert.rejects(proc.ready(50), /did not become ready/);
});

test('a helper that cannot be started is retried with a wait, and ready() reports what happens', async () => {
  let tries = 0;
  const kids = [];
  const spawn = () => {
    tries += 1;
    if (tries === 1) throw new Error('spawn ENOENT');
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.on('data', (d) => { const m = JSON.parse(String(d).trim()); child.stdout.write(`${JSON.stringify({ id: m.id, pid: 9 })}\n`); });
    child.kill = () => {};
    kids.push(child);
    return child;
  };
  const proc = createJsonlProcess({ command: 'x', args: [], spawn, restartMinMs: 20, restartMaxMs: 40, pingTimeoutMs: 500 });
  proc.start();
  assert.match(proc.status().lastError, /could not start: spawn ENOENT/);
  await proc.ready(1500);
  assert.equal(tries, 2);
  assert.equal(proc.available, true);
  proc.stop();
});

test('an opted-in operation timeout kills the helper, fails queued work, and ignores stale output', async (t) => {
  const { proc, children, bringUp } = rig({ opts: { restartOnTimeout: true } });
  t.after(() => proc.stop());
  proc.start(); await bringUp();
  const queued = assert.rejects(proc.request('queued-input', {}, 1000), /stopped after an operation timed out/);
  const timeout = assert.rejects(proc.request('blocked-uia', {}, 30), /blocked-uia timed out/);
  await Promise.all([queued, timeout, sleep(40)]);
  assert.equal(children[0].killed, true);
  assert.equal(proc.available, false);
  assert.ok(await until(() => children.length === 2));
  const generation = proc.status().generation;
  children[0].says({ ev: 'ready', pid: 999 });
  children[0].dies();
  assert.equal(proc.status().pid, 0);
  assert.equal(proc.status().generation, generation);
  await bringUp(1);
  assert.deepEqual(children[1].sent.map((request) => request.op), ['ping'], 'queued input is never replayed');
  let completed = false;
  const fresh = proc.request('fresh').then((result) => { completed = true; return result; });
  const id = children[1].sent.at(-1).id;
  children[0].says({ id, ok: 'stale' });
  await sleep(5);
  assert.equal(completed, false, 'the old process cannot answer a new request');
  children[1].says({ id, ok: 'fresh' });
  assert.equal((await fresh).ok, 'fresh');
});

test('a resolved old ping cannot mark a newly started helper ready', async (t) => {
  const { proc, children, bringUp } = rig();
  t.after(() => proc.stop());
  proc.start();
  children[0].says({ id: children[0].sent[0].id, pid: 999 });
  proc.stop(); proc.start();
  await sleep(5);
  assert.equal(proc.available, false);
  assert.equal(proc.status().pid, 0);
  await bringUp(1);
  assert.equal(proc.status().pid, 4243);
});

test('repeated short-lived crashes are bounded and stopping cancels a pending restart', async () => {
  const f = rig();
  f.proc.start();
  for (let index = 0; index < 5; index += 1) {
    await f.bringUp(index);
    f.children[index].dies();
  }
  await sleep(180);
  assert.equal(f.children.length, 5, 'a crash loop stops after five failures');
  assert.equal(f.proc.available, false);
  f.proc.stop();

  const stopped = rig({ opts: { restartOnTimeout: true } });
  stopped.proc.start(); await stopped.bringUp();
  await Promise.all([assert.rejects(stopped.proc.request('blocked', {}, 10), /timed out/), sleep(15)]);
  stopped.proc.stop();
  await sleep(150);
  assert.equal(stopped.children.length, 1);
});
