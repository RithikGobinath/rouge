'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUploadCapture, TTL_MS } = require('../src/uploads/capture');

function fixture() {
  const listeners = new Map();
  const calls = [];
  let clock = 1000;
  let info = { size: 42, mtimeMs: 5, dev: 1, ino: 2, isFile: () => true };
  const helper = { available: true, on: (name, fn) => listeners.set(name, fn),
    start() { calls.push('start'); }, stop() { calls.push('stop'); },
    async request(op, args) { calls.push([op, args]); return { ok: true }; } };
  const paths = [];
  const logs = [];
  const capture = createUploadCapture({ helper, now: () => clock, log: (text) => logs.push(text),
    stat: async (file) => { paths.push(file); return info; } });
  const selection = { selectionId: 'a'.repeat(32), hwnd: 123, path: 'C:\\Docs\\Résumé.pdf' };
  return { capture, helper, calls, paths, logs, selection, emit: (name, data) => listeners.get(name)(data),
    time: (value) => { clock = value; }, info: (value) => { info = { ...info, ...value }; } };
}

test('only a confirmed native PDF is retained, scoped to its window and filename', async () => {
  const f = fixture(); f.capture.start();
  assert.equal(await f.capture.current(), null);
  await f.emit('upload.selected', f.selection);
  const selected = await f.capture.current({ hwnd: 123, name: 'RÉSUMÉ.PDF' });
  assert.equal(selected.path, f.selection.path);
  assert.equal(await f.capture.current({ hwnd: 456 }), null);
  assert.equal(await f.capture.current({ name: 'different.pdf' }), null);
  assert.ok(f.calls.some((call) => Array.isArray(call) && call[0] === 'selection.current'));
  assert.ok(f.logs.every((line) => !line.includes('Résumé') && !line.includes('C:')));
});

test('untrusted, network, fake and non-PDF paths are rejected before stat', async () => {
  const f = fixture(); f.capture.start();
  for (const path of ['resume.pdf', '\\\\server\\share\\resume.pdf', 'C:\\fakepath\\resume.pdf',
    'C:\\Docs\\resume.pdf:other', 'C:\\Docs\\*.pdf', 'C:\\Docs\\resume.txt', 'C:\\Docs\\a\n.pdf']) {
    await f.emit('upload.selected', { ...f.selection, path });
    assert.equal(await f.capture.current(), null);
  }
  await f.emit('upload.selected', { ...f.selection, selectionId: 'page-content' });
  assert.deepEqual(f.paths, []);
});

test('a new dialog, expiry, file changes and native context loss invalidate the selection', async () => {
  const f = fixture(); f.capture.start();
  await f.emit('upload.selected', f.selection); f.emit('upload.pending');
  assert.equal(await f.capture.current(), null);
  await f.emit('upload.selected', f.selection); f.time(1000 + TTL_MS);
  assert.equal(await f.capture.current(), null);
  f.time(1000); await f.emit('upload.selected', f.selection); f.info({ ino: 7 });
  assert.equal(await f.capture.current(), null);
  await f.emit('upload.selected', f.selection); f.helper.request = async () => ({ ok: false });
  assert.equal(await f.capture.current(), null);
});

test('stop and helper recovery clear paths and re-arm only when capture is enabled', async () => {
  const f = fixture(); f.capture.start();
  await f.emit('upload.selected', f.selection);
  f.helper.available = false; f.emit('availability', false);
  assert.equal(await f.capture.current(), null);
  f.helper.available = true; await f.emit('availability', true);
  assert.ok(f.calls.some((call) => Array.isArray(call) && call[0] === 'watch.start'));
  f.capture.stop(); await f.emit('upload.selected', f.selection);
  assert.equal(await f.capture.current(), null);
  const count = f.calls.length;
  await f.emit('availability', true);
  assert.equal(f.calls.length, count);
});

test('late file metadata and in-flight reads cannot revive a cleared selection', async () => {
  const f = fixture(); f.capture.start(); await f.emit('upload.selected', f.selection);
  let finish;
  f.helper.request = () => new Promise((resolve) => { finish = resolve; });
  const pending = f.capture.current(); f.capture.stop(); finish({ ok: true });
  assert.equal(await pending, null);
  let release;
  const listeners = new Map();
  const capture = createUploadCapture({ helper: { ...f.helper, on: (name, fn) => listeners.set(name, fn) },
    stat: () => new Promise((resolve) => { release = resolve; }) });
  capture.start(); const event = listeners.get('upload.selected')(f.selection);
  capture.stop(); release({ size: 1, isFile: () => true }); await event;
  assert.equal(await capture.current(), null);
});
