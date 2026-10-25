'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createUploadOffer, safeName } = require('../src/uploads/offer');

const formatBytes = (n) => `${(n / 1e6).toFixed(1)} MB`;

function rig({ answer = true, busy = false, pick = null, result = null, waitMs = 300, hold = undefined } = {}) {
  const r = { asked: [], notices: [], deleted: [], compressed: [], picks: 0, held: [] };
  r.voice = { active: false, asking: busy, ask: async (card) => { r.asked.push(card); return answer; } };
  r.offer = createUploadOffer({
    voice: () => r.voice,
    ui: { notice: (text) => r.notices.push(text) },
    compress: async (opts) => { r.compressed.push(opts); return result || { ok: true, outputPath: opts.outputPath, originalSize: 12_000_000, compressedSize: 9_000_000 }; },
    formatBytes,
    pickPdf: async () => { r.picks += 1; return pick; },
    downloads: () => path.join('C:', 'Users', 'me', 'Downloads'),
    hold: hold === undefined ? undefined : async (file) => { r.held.push(file); if (hold === 'throws') throw new Error('shelf broke'); return hold; },
    fs: { unlink: (p, cb) => { r.deleted.push(p); cb(); } },
    waitMs,
  });
  return r;
}
const ev = (extra = {}) => ({ limitBytes: 10_000_000, filename: 'cv.pdf', fileSize: 12_000_000, windowTitle: 'Apply', tempPath: 'C:\\tmp\\upload-1.pdf', ...extra });

test('safeName keeps only characters a Windows file name may hold', () => {
  assert.equal(safeName('my:cv?.pdf'), 'mycv.pdf');
  assert.equal(safeName('a"b|c*d<e>f.pdf'), 'abcdef.pdf');
  assert.equal(safeName(null), '');
});

test('without a limit there is nothing to compress to: say so, ask nothing, drop the copy', async () => {
  const r = rig();
  await r.offer.handle(ev({ limitBytes: null }));
  assert.equal(r.asked.length, 0);
  assert.match(r.notices[0], /did not say how small/);
  assert.deepEqual(r.deleted, ['C:\\tmp\\upload-1.pdf']);
});

test('the card names the file, its size and the limit', async () => {
  const r = rig();
  await r.offer.handle(ev());
  assert.equal(r.asked[0].title, 'Compress cv.pdf (12.0 MB) below 10.0 MB?');
  assert.equal(r.asked[0].hint, 'Apply · Image quality may decrease');
});

test('a copied PDF is compressed into Downloads under the name the site saw', async () => {
  const r = rig();
  await r.offer.handle(ev({ filename: '../my:cv.pdf' }));
  assert.equal(r.compressed.length, 1);
  assert.equal(r.compressed[0].inputPath, 'C:\\tmp\\upload-1.pdf');
  assert.equal(r.compressed[0].outputPath, path.join('C:', 'Users', 'me', 'Downloads', 'mycv-compressed.pdf'));
  assert.equal(r.compressed[0].limitBytes, 10_000_000);
  assert.match(r.notices.at(-1), /saved in Downloads\. Original unchanged\./);
  assert.deepEqual(r.deleted, ['C:\\tmp\\upload-1.pdf'], 'the temporary copy is removed afterwards');
});

test('declining removes the copy and compresses nothing', async () => {
  const r = rig({ answer: false });
  await r.offer.handle(ev());
  assert.equal(r.compressed.length, 0);
  assert.deepEqual(r.deleted, ['C:\\tmp\\upload-1.pdf']);
});

test('with no copy, Rouge asks for the file and saves beside it', async () => {
  const r = rig({ pick: path.join('C:', 'Docs', 'Resume.PDF') });
  await r.offer.handle(ev({ tempPath: null }));
  assert.equal(r.picks, 1);
  assert.equal(r.compressed[0].outputPath, path.join('C:', 'Docs', 'Resume-compressed.pdf'));
  assert.match(r.notices.at(-1), /next to the original/);
});

test('cancelling the file dialog ends the offer quietly', async () => {
  const r = rig({ pick: null });
  await r.offer.handle(ev({ tempPath: null }));
  assert.equal(r.compressed.length, 0);
  assert.deepEqual(r.notices, []);
});

test('a failure is reported with its reason', async () => {
  const r = rig({ result: { ok: false, reason: 'Encrypted, signed, fillable and attachment PDFs are not supported.' } });
  await r.offer.handle(ev());
  assert.equal(r.notices.at(-1), 'Encrypted, signed, fillable and attachment PDFs are not supported.');
});

test('a busy ribbon delays the offer instead of losing it', async () => {
  const r = rig({ busy: true, waitMs: 2000 });
  const done = r.offer.handle(ev());
  await new Promise((res) => setTimeout(res, 250));
  assert.equal(r.asked.length, 0, 'still waiting');
  r.voice.asking = false;
  await done;
  assert.equal(r.asked.length, 1);
});

test('a ribbon that stays busy drops the offer and the copy', async () => {
  const r = rig({ busy: true, waitMs: 250 });
  await r.offer.handle(ev());
  assert.equal(r.asked.length, 0);
  assert.deepEqual(r.deleted, ['C:\\tmp\\upload-1.pdf']);
});

test('the same PDF is not offered twice in a row, and a second report during an offer is ignored', async () => {
  const r = rig();
  await Promise.all([r.offer.handle(ev()), r.offer.handle(ev({ tempPath: null, filename: null, fileSize: null }))]);
  assert.equal(r.asked.length, 1, 'one offer at a time');
  await r.offer.handle(ev({ tempPath: 'C:\\tmp\\upload-2.pdf' }));
  assert.equal(r.asked.length, 1, 'same file within a minute');
  assert.ok(r.deleted.includes('C:\\tmp\\upload-2.pdf'));
  await r.offer.handle(ev({ filename: 'other.pdf', tempPath: 'C:\\tmp\\upload-3.pdf' }));
  assert.equal(r.asked.length, 2, 'a different file is offered');
});

test('the finished copy is put on the shelf to be dragged onto the upload', async () => {
  const r = rig({ hold: true });
  await r.offer.handle(ev());
  const out = path.join('C:', 'Users', 'me', 'Downloads', 'cv-compressed.pdf');
  assert.deepEqual(r.held, [out]);
  assert.match(r.notices.at(-1), /Drag it from the shelf onto the upload; it is also in Downloads\. Original unchanged\./);
  assert.doesNotMatch(r.notices.at(-1), /saved in Downloads/);
});

test('a copy made beside a picked file is held too, and the notice says where else it is', async () => {
  const r = rig({ hold: true, pick: path.join('C:', 'Docs', 'Resume.pdf') });
  await r.offer.handle(ev({ tempPath: null }));
  assert.deepEqual(r.held, [path.join('C:', 'Docs', 'Resume-compressed.pdf')]);
  assert.match(r.notices.at(-1), /from the shelf.*also next to the original/);
});

test('if the shelf cannot take the file, or breaks, the notice says where it was saved instead', async () => {
  for (const hold of [false, 'throws']) {
    const r = rig({ hold });
    await r.offer.handle(ev());
    assert.equal(r.held.length, 1, String(hold));
    assert.match(r.notices.at(-1), /saved in Downloads\. Original unchanged\./, String(hold));
    assert.doesNotMatch(r.notices.at(-1), /shelf/, String(hold));
  }
});

test('nothing goes on the shelf when there is no copy', async () => {
  const failed = rig({ hold: true, result: { ok: false, reason: 'Encrypted, signed, fillable and attachment PDFs are not supported.' } });
  await failed.offer.handle(ev());
  const declined = rig({ hold: true, answer: false });
  await declined.offer.handle(ev());
  assert.deepEqual([failed.held, declined.held], [[], []]);
});
