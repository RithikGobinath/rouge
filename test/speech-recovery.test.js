'use strict';
// Mocked regression checks, authored without running a recognizer or touching the desktop.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createSpeech } = require('../src/voice/speech');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, ms = 3000) {
  const started = Date.now();
  while (!predicate()) { if (Date.now() - started > ms) throw new Error('timed out waiting for mocked helper'); await sleep(5); }
}

function fixture() {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.sent = [];
    let pending = '';
    child.stdin.on('data', (chunk) => {
      pending += chunk;
      let cut;
      while ((cut = pending.indexOf('\n')) >= 0) { child.sent.push(JSON.parse(pending.slice(0, cut))); pending = pending.slice(cut + 1); }
    });
    child.says = (message) => child.stdout.write(JSON.stringify(message) + '\n');
    child.kill = () => { setImmediate(() => child.emit('exit', 0)); };
    children.push(child);
    return child;
  };
  const speech = createSpeech({ spawn });
  const answer = (child, op, payload) => { const request = child.sent.find((message) => message.op === op); assert.ok(request, op); child.says({ id: request.id, ...payload }); };
  return { speech, children, answer };
}

test('speech initializes once per process and becomes unavailable until a restarted recognizer is ready', async (t) => {
  const { speech, children, answer } = fixture();
  t.after(() => speech.stop());
  speech.start();
  const first = speech.init();
  answer(children[0], 'ping', { pid: 11 });
  await until(() => children[0].sent.some((message) => message.op === 'init'));
  const same = speech.init();
  assert.equal(speech.available, false);
  assert.equal(children[0].sent.filter((message) => message.op === 'init').length, 1);
  answer(children[0], 'init', { recognizer: 'English' });
  assert.equal((await first).ok, true);
  assert.equal((await same).ok, true);
  assert.equal(speech.available, true);

  children[0].emit('exit', 1);
  assert.equal(speech.available, false);
  assert.equal(speech.recognizer, '');
  await until(() => children.length === 2);
  answer(children[1], 'ping', { pid: 22 });
  await until(() => children[1].sent.some((message) => message.op === 'init'));
  children[0].says({ ev: 'ready', pid: 999 });
  assert.equal(speech.available, false);
  const recovered = speech.init();
  assert.equal(children[1].sent.filter((message) => message.op === 'init').length, 1);
  answer(children[1], 'init', { recognizer: 'English recovered' });
  assert.equal((await recovered).ok, true);
  assert.equal(speech.recognizer, 'English recovered');
  assert.equal(speech.available, true);
});

test('a failed initialization never reports ready or repeatedly initializes the same process', async (t) => {
  const { speech, children, answer } = fixture();
  t.after(() => speech.stop());
  speech.start();
  const pending = speech.init();
  answer(children[0], 'ping', { pid: 11 });
  await until(() => children[0].sent.some((message) => message.op === 'init'));
  answer(children[0], 'init', { error: 'no recognizer installed' });
  assert.equal((await pending).ok, false);
  assert.equal((await speech.init()).ok, false);
  assert.equal(speech.available, false);
  assert.equal(children[0].sent.filter((message) => message.op === 'init').length, 1);
});
