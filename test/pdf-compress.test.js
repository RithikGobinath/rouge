'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { compressPdf } = require('../src/pdf/compress');
const { onePage, stream, objectsLand } = require('./fixtures/pdf-builder');

const CONTENT = `BT /F1 12 Tf 72 720 Td (Hello compress) Tj ET\n${'0 0 m 10 10 l S\n'.repeat(300)}`;
const plainPage = () => stream('', Buffer.from(CONTENT));

// The dictionary and data of object `num`, read without any of the code under test.
function streamOfObject(buf, num) {
  const text = buf.toString('latin1');
  const dictStart = text.indexOf('<<', text.indexOf(`\n${num} 0 obj`));
  const dataStart = text.indexOf('stream\n', dictStart) + 7;
  const dict = text.slice(dictStart, dataStart);
  const length = Number([...dict.matchAll(/\/Length (\d+)/g)].pop()[1]);   // the rewrite puts the real length last
  return { dict, data: buf.subarray(dataStart, dataStart + length) };
}

async function run(pdf, limitBytes, { before, codec } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rouge-pdf-'));
  try {
    const inputPath = path.join(dir, 'doc.pdf');
    const outputPath = path.join(dir, 'doc-compressed.pdf');
    fs.writeFileSync(inputPath, pdf);
    if (before) before(dir);
    const result = await compressPdf({ inputPath, outputPath, limitBytes, codec });
    const copy = result.ok ? fs.readFileSync(result.outputPath) : null;
    return { result, copy, outputPath, source: fs.readFileSync(inputPath), files: fs.readdirSync(dir).sort() };
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test('plain streams become a valid, smaller copy and the source is untouched', async () => {
  const pdf = onePage(plainPage());
  const { result, copy, outputPath, source } = await run(pdf, 3000);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.outputPath, outputPath);
  assert.equal(result.originalSize, pdf.length);
  assert.equal(result.compressedSize, copy.length);
  assert.equal(result.lossy, false);
  assert.ok(copy.length < pdf.length);
  objectsLand(copy, 5);
  const page = streamOfObject(copy, 4);
  assert.match(page.dict, /\/Filter \/FlateDecode/);
  assert.equal(zlib.inflateSync(page.data).toString('latin1'), CONTENT);
  assert.ok(source.equals(pdf));
});

test('strings and nested dictionaries do not confuse the dictionary rewrite', async () => {
  const page = stream('/Sub << /Length 7 >> /Note (a >> b (nested))', Buffer.from(CONTENT));
  const { result, copy } = await run(onePage(page), 3000);
  assert.equal(result.ok, true, result.reason);
  objectsLand(copy, 5);
  const out = streamOfObject(copy, 4);
  assert.match(out.dict, /\/Sub << \/Length 7 >> \/Note \(a >> b \(nested\)\)/, 'other entries are kept exactly');
  assert.equal(zlib.inflateSync(out.data).toString('latin1'), CONTENT);
});

test('a stream length given as a reference is resolved, and the copy states it as a number', async () => {
  const page = stream('', Buffer.from(CONTENT), '6 0 R');
  const { result, copy } = await run(onePage(page, [String(CONTENT.length)]), 3000);
  assert.equal(result.ok, true, result.reason);
  objectsLand(copy, 6);
  const out = streamOfObject(copy, 4);
  assert.doesNotMatch(out.dict, /6 0 R/);
  assert.equal(zlib.inflateSync(out.data).toString('latin1'), CONTENT);
});

test('an index with rows that name nothing, a low first subsection and references for lengths still works', async () => {
  const page = stream('', Buffer.from(CONTENT), '6 0 R');
  const pdf = onePage(page, [String(CONTENT.length)], { phantom: 3, lowIndex: true });
  const { result, copy } = await run(pdf, 3000);
  assert.equal(result.ok, true, result.reason);
  objectsLand(copy, 6);
  const text = copy.toString('latin1');
  const table = text.slice(Number(/startxref\s+(\d+)/.exec(text)[1]), text.indexOf('trailer'));
  assert.equal([...table.matchAll(/^0000000000 00000 n/gm)].length, 3, 'rows that named nothing still name nothing');
});

test('a Flate stream is packed a little harder and keeps its decode parameters', async () => {
  const words = ['lecture', 'energy', 'momentum', 'vector', 'force', 'mass', 'field', 'charge', 'wave', 'spin'];
  let plain = '';
  for (let i = 0; plain.length < 9000; i += 1) plain += `${words[(i * 7 + (i >> 2)) % words.length]} ${i % 13} `;
  const light = zlib.deflateSync(Buffer.from(plain), { level: 1 });
  const hard = zlib.deflateSync(Buffer.from(plain), { level: 9 });
  assert.ok(light.length - hard.length > 100, 'the fixture must leave room for a stronger pass');
  const pdf = onePage(stream('/Filter /FlateDecode /DecodeParms << /Predictor 1 >>', light));
  const budget = pdf.length - (light.length - hard.length) + 40;
  const { result, copy } = await run(pdf, Math.ceil(budget / 0.95) + 1);
  assert.equal(result.ok, true, result.reason);
  objectsLand(copy, 5);
  const out = streamOfObject(copy, 4);
  assert.match(out.dict, /\/DecodeParms << \/Predictor 1 >>/);
  assert.equal(zlib.inflateSync(out.data).toString(), plain);
});

test('files the rewrite cannot keep intact are refused', async () => {
  const encrypted = await run(onePage(plainPage(), ['<< /Filter /Standard >>'], { trailer: '/Encrypt 6 0 R' }), 3000);
  assert.match(encrypted.result.reason, /Encrypted/);

  const revised = await run(Buffer.concat([onePage(plainPage()), Buffer.from('startxref\n0\n%%EOF\n')]), 3000);
  assert.match(revised.result.reason, /revisions/);

  const noTable = onePage(plainPage()).toString('latin1').replace(/startxref\n\d+/, 'startxref\n9');
  const indexed = await run(Buffer.from(noTable, 'latin1'), 3000);
  assert.match(indexed.result.reason, /compressed index/);

  const lost = onePage(plainPage()).toString('latin1').replace(/(0{10} 65535 f \n)(\d{10})/, (_, a, b) => `${a}${String(Number(b) + 3).padStart(10, '0')}`);
  const wrong = await run(Buffer.from(lost, 'latin1'), 3000);
  assert.match(wrong.result.reason, /index points at things that are not there/);
});

test('limits: unknown, already met, and out of reach for lossless recompression', async () => {
  assert.match((await run(onePage(plainPage()), 0)).result.reason, /size limit/);
  assert.match((await run(onePage(plainPage()), 100000)).result.reason, /already within/);
  const tight = await run(onePage(plainPage()), 400);
  assert.equal(tight.result.ok, false);
  assert.match(tight.result.reason, /Lossless recompression only reached/);
  assert.deepEqual(tight.files, ['doc.pdf'], 'nothing is saved when the target is missed');
});

test('nothing left to shrink says so', async () => {
  const packed = zlib.deflateSync(Buffer.from(CONTENT), { level: 9 });
  const { result } = await run(onePage(stream('/Filter /FlateDecode', packed)), 300);
  assert.equal(result.ok, false);
  assert.match(result.reason, /already as small/);
});

test('an existing file is never replaced', async () => {
  const { result, files } = await run(onePage(plainPage()), 3000, { before: (dir) => fs.writeFileSync(path.join(dir, 'doc-compressed.pdf'), 'keep me') });
  assert.equal(result.ok, true, result.reason);
  assert.equal(path.basename(result.outputPath), 'doc-compressed-2.pdf');
  assert.deepEqual(files, ['doc-compressed-2.pdf', 'doc-compressed.pdf', 'doc.pdf']);
});
