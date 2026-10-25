'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUploadCapture, detectRejection, parseLimitBytes, REJECTION_COOLDOWN } = require('../src/uploads/capture');

// ---- parseLimitBytes ----

test('parseLimitBytes handles decimal and binary units', () => {
  assert.equal(parseLimitBytes('Maximum file size: 2 MB.'), 2_000_000);
  assert.equal(parseLimitBytes('Limit is 5 MiB'), 5 * 1048576);
  assert.equal(parseLimitBytes('500 KB'), 500_000);
  assert.equal(parseLimitBytes('1.5 GB'), 1_500_000_000);
  assert.equal(parseLimitBytes('100 B'), 100);
  assert.equal(parseLimitBytes('512 KiB'), 512 * 1024);
  assert.equal(parseLimitBytes('no size here'), null);
  assert.equal(parseLimitBytes(''), null);
  assert.equal(parseLimitBytes('0 MB'), null);
});

// ---- detectRejection ----

function el(name, type = 'Text') { return { name, type }; }

test('detectRejection finds a size-error text element and parses limit', () => {
  const result = detectRejection([
    el('Upload your files here'),
    el('File too large. Maximum file size: 2 MB.'),
    el('Choose file'),
  ]);
  assert.ok(result);
  assert.match(result.errorText, /file too large/i);
  assert.equal(result.limitBytes, 2_000_000);
  assert.equal(result.filename, null);
});

test('detectRejection extracts a quoted PDF filename from the error', () => {
  const result = detectRejection([
    el('"resume.pdf" exceeds the maximum file size of 5 MB.'),
  ]);
  assert.ok(result);
  assert.equal(result.filename, 'resume.pdf');
  assert.equal(result.limitBytes, 5_000_000);
});

test('detectRejection extracts an unquoted PDF filename from the error', () => {
  const result = detectRejection([
    el('resume.pdf must be less than 10 MB.'),
  ]);
  assert.ok(result);
  assert.equal(result.filename, 'resume.pdf');
  assert.equal(result.limitBytes, 10_000_000);
});

test('detectRejection returns null for upload-related but non-error elements', () => {
  assert.equal(detectRejection([el('Upload a file'), el('Max 10 items')]), null);
  assert.equal(detectRejection([el('Maximum size applies to all uploads')]), null);
  assert.equal(detectRejection([]), null);
  assert.equal(detectRejection(null), null);
});

test('detectRejection skips excessively long strings', () => {
  const long = 'file too large — ' + 'x'.repeat(490);
  assert.equal(detectRejection([el(long)]), null);
});

test('detectRejection matches varied phrasing', () => {
  const phrases = [
    'File too large. Maximum file size: 2 MB.',
    'This file exceeds the maximum size of 2 MB.',
    'File size limit is 2 MB.',
    'The file must be less than 2 MB.',
    'File too big to upload (max 2 MB).',
  ];
  for (const phrase of phrases) {
    const result = detectRejection([el(phrase)]);
    assert.ok(result, `should match: ${phrase}`);
    assert.equal(result.limitBytes, 2_000_000);
  }
});

// ---- createUploadCapture (watcher) ----

function fakeSidecar({ fgWindow = { hwnd: 100, title: 'Chrome' }, elements = [] } = {}) {
  return {
    async fg() { return fgWindow; },
    async uiaList() { return { elements }; },
  };
}

test('does not fire onRejection when never started', async () => {
  const events = [];
  const cap = createUploadCapture({
    sidecar: fakeSidecar({ elements: [el('File too large. Maximum file size: 2 MB.')] }),
    onRejection: (r) => events.push(r),
    pollMs: 10,
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(events.length, 0);
  cap.stop(); // no-op but safe
});

test('fires onRejection with parsed fields when rejection text is present', async () => {
  const events = [];
  const elements = [el('File too large. Maximum file size: 2 MB.')];
  const cap = createUploadCapture({
    sidecar: fakeSidecar({ elements }),
    onRejection: (r) => events.push(r),
    pollMs: 10,
  });
  cap.start();
  await new Promise((r) => setTimeout(r, 60));
  cap.stop();
  assert.ok(events.length >= 1, 'at least one rejection fired');
  assert.equal(events[0].hwnd, 100);
  assert.equal(events[0].limitBytes, 2_000_000);
  assert.equal(events[0].windowTitle, 'Chrome');
  // Cooldown: should only fire once per hwnd within the cooldown window.
  assert.equal(events.length, 1);
});

test('stop then start resets cooldown so rejection fires again', async () => {
  const events = [];
  const elements = [el('File too large. Maximum file size: 2 MB.')];
  const cap = createUploadCapture({
    sidecar: fakeSidecar({ elements }),
    onRejection: (r) => events.push(r),
    pollMs: 10,
  });
  cap.start();
  await new Promise((r) => setTimeout(r, 40));
  cap.stop();
  cap.start();
  await new Promise((r) => setTimeout(r, 40));
  cap.stop();
  assert.equal(events.length, 2, 'stop+start resets cooldown; each run fires once');
});

test('no event when no rejection text in elements', async () => {
  const events = [];
  const cap = createUploadCapture({
    sidecar: fakeSidecar({ elements: [el('Upload your resume'), el('Max size 5 MB')] }),
    onRejection: (r) => events.push(r),
    pollMs: 10,
  });
  cap.start();
  await new Promise((r) => setTimeout(r, 50));
  cap.stop();
  assert.equal(events.length, 0);
});

test('skips tick when busy() returns true', async () => {
  let fgCalls = 0;
  const sidecar = {
    async fg() { fgCalls++; return { hwnd: 1, title: '' }; },
    async uiaList() { return { elements: [el('File too large.')] }; },
  };
  const events = [];
  const cap = createUploadCapture({
    sidecar,
    busy: () => true,
    onRejection: (r) => events.push(r),
    pollMs: 10,
  });
  cap.start();
  await new Promise((r) => setTimeout(r, 50));
  cap.stop();
  assert.equal(fgCalls, 0, 'fg() never called when busy');
  assert.equal(events.length, 0);
});

test('start() is idempotent; a second call before stop is ignored', async () => {
  const events = [];
  const elements = [el('File too large. Maximum file size: 2 MB.')];
  const cap = createUploadCapture({
    sidecar: fakeSidecar({ elements }),
    onRejection: (r) => events.push(r),
    pollMs: 10,
  });
  cap.start();
  cap.start(); // second call should be ignored
  await new Promise((r) => setTimeout(r, 50));
  cap.stop();
  assert.equal(events.length, 1, 'double-start does not double-fire');
});

test('sidecar errors on fg() or uiaList() are swallowed', async () => {
  let errorSidecar = {
    async fg() { throw new Error('helper unavailable'); },
    async uiaList() { throw new Error('should not reach'); },
  };
  const events = [];
  const cap = createUploadCapture({
    sidecar: errorSidecar,
    onRejection: (r) => events.push(r),
    pollMs: 10,
  });
  cap.start();
  await new Promise((r) => setTimeout(r, 50));
  cap.stop();
  assert.equal(events.length, 0, 'errors do not propagate or fire events');
});
