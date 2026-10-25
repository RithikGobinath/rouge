'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { compressPdf } = require('../src/pdf/compress');
const { jpegInfo } = require('../src/pdf/images');
const { onePage, stream, objectsLand } = require('./fixtures/pdf-builder');

// ---- a stand-in for the Electron image codec: it only keeps track of sizes --------------------------
function fakeJpeg(width, height, comps, payload) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8 + 3 * comps, 8, height >> 8, height & 255, width >> 8, width & 255, comps]);
  const parts = Array.from({ length: comps }, (_, i) => Buffer.from([i + 1, 0x11, 0]));
  return Buffer.concat([head, ...parts, Buffer.alloc(payload, 7), Buffer.from([0xff, 0xd9])]);
}
function fakeCodec({ ratio = 0.05, throws = false } = {}) {
  const calls = { decode: 0, encode: [] };
  return {
    calls,
    decode(jpeg) { calls.decode += 1; const i = jpegInfo(jpeg); return { width: i.width, height: i.height, bgra: Buffer.alloc(i.width * i.height * 4, 1) }; },
    encode(px, tier) {
      if (throws) throw new Error('codec failed');
      calls.encode.push({ ...tier, width: px.width, pixels: px.bgra });
      const w = Math.max(1, Math.round(px.width * tier.scale));
      const h = Math.max(1, Math.round(px.height * tier.scale));
      return { jpeg: fakeJpeg(w, h, 3, Math.round(w * h * 3 * (tier.quality / 100) * ratio)), width: w, height: h };
    },
  };
}

// Random samples do not pack, so only re-encoding can make the file smaller.
const samples = (n) => require('node:crypto').randomBytes(n);

const ICC = [stream('/N 3', Buffer.from('icc!')), '[/ICCBased 6 0 R]'];   // objects 6 and 7 (the colour space is 7 0 R)
const image = (dict, data) => stream(`/Type /XObject /Subtype /Image ${dict}`, data);
const rgbDict = (w, h) => `/Width ${w} /Height ${h} /ColorSpace 7 0 R /BitsPerComponent 8`;

// The dictionary text and data of object `num`, read without any of the code under test.
function objectStream(buf, num) {
  const text = buf.toString('latin1');
  const dictStart = text.indexOf('<<', text.indexOf(`\n${num} 0 obj`));
  const dataStart = text.indexOf('stream\n', dictStart) + 7;
  const dict = text.slice(dictStart, dataStart);
  const length = Number([...dict.matchAll(/\/Length (\d+)/g)].pop()[1]);
  return { dict, data: buf.subarray(dataStart, dataStart + length) };
}

async function run(pdf, limitBytes, codec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rouge-img-'));
  try {
    const inputPath = path.join(dir, 'doc.pdf');
    fs.writeFileSync(inputPath, pdf);
    const result = await compressPdf({ inputPath, outputPath: path.join(dir, 'doc-compressed.pdf'), limitBytes, codec });
    return { result, copy: result.ok ? fs.readFileSync(result.outputPath) : null };
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
const content = () => stream('', Buffer.from('BT /F1 12 Tf 72 720 Td (Hello) Tj ET'));
const pdfWith = (...objs) => onePage(content(), [...ICC, ...objs]);   // the picture under test is object 8

test('a Flate picture becomes a smaller JPEG, with its colour space and the pixel order kept', async () => {
  const raw = samples(120 * 100 * 3);
  raw[0] = 10; raw[1] = 20; raw[2] = 30;   // the first pixel: R 10, G 20, B 30
  const codec = fakeCodec();
  const pdf = pdfWith(image(`${rgbDict(120, 100)} /Filter /FlateDecode`, zlib.deflateSync(raw)));
  const { result, copy } = await run(pdf, 30000, codec);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.lossy, true);
  assert.ok(copy.length < 30000 * 0.95);
  objectsLand(copy, 8);
  const out = objectStream(copy, 8);
  assert.match(out.dict, /\/Filter \/DCTDecode/);
  assert.match(out.dict, /\/Width 120/);
  assert.match(out.dict, /\/Height 100/);
  assert.match(out.dict, /\/ColorSpace 7 0 R/);
  assert.match(out.dict, /\/BitsPerComponent 8/);
  assert.doesNotMatch(out.dict, /FlateDecode|DecodeParms/);
  assert.deepEqual(jpegInfo(out.data), { bits: 8, height: 100, width: 120, comps: 3 });
  assert.deepEqual([...codec.calls.encode[0].pixels.subarray(0, 4)], [30, 20, 10, 255], 'the codec gets BGRA');
});

test('the first step that fits wins, and each step is coarser', async () => {
  const codec = fakeCodec({ ratio: 0.5 });
  const pdf = pdfWith(image(`${rgbDict(120, 100)} /Filter /FlateDecode`, zlib.deflateSync(samples(120 * 100 * 3))));
  const { result, copy } = await run(pdf, Math.ceil(12000 / 0.95) + 1, codec);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(codec.calls.encode.map((c) => c.scale), [1, 0.75], 'the third step was never needed');
  assert.match(objectStream(copy, 8).dict, /\/Width 90 \/Height 75/);
});

test('a picture used as a mask, and unusual pictures, are left alone', async () => {
  const flate = (dict) => image(`${dict} /Filter /FlateDecode`, zlib.deflateSync(samples(120 * 100 * 3)));
  const variants = {
    mask: pdfWith(flate(`${rgbDict(120, 100)} /SMask 9 0 R`), image('/Width 120 /Height 100 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode', zlib.deflateSync(samples(120 * 100)))),
    keyMask: pdfWith(flate(`${rgbDict(120, 100)} /Mask [0 5 0 5 0 5]`)),
    decode: pdfWith(flate(`${rgbDict(120, 100)} /Decode [1 0 1 0 1 0]`)),
    stencil: pdfWith(flate('/Width 120 /Height 100 /ImageMask true /BitsPerComponent 1')),
    sixteenBit: pdfWith(flate('/Width 120 /Height 100 /ColorSpace 7 0 R /BitsPerComponent 16')),
    palette: pdfWith(flate('/Width 120 /Height 100 /ColorSpace [/Indexed /DeviceRGB 255 <00>] /BitsPerComponent 8')),
    cmyk: pdfWith(flate('/Width 120 /Height 100 /ColorSpace /DeviceCMYK /BitsPerComponent 8')),
    tiff: pdfWith(stream(`${rgbDict(120, 100)} /Filter /FlateDecode /DecodeParms << /Predictor 2 /Colors 3 /Columns 120 >>`, zlib.deflateSync(samples(120 * 100 * 3)))),
  };
  for (const [name, pdf] of Object.entries(variants)) {
    const codec = fakeCodec();
    const { result } = await run(pdf, 20000, codec);
    if (name === 'mask') {
      // the colour picture is recoded, its mask is not
      assert.equal(codec.calls.encode.length, 1, name);
      assert.equal(result.ok, true, name);
    } else {
      assert.equal(codec.calls.encode.length, 0, name);
      assert.match(result.reason, /already as small as I can/, name);
    }
  }
});

test('a gray picture is stored as RGB, and a predictor is undone before the codec sees the pixels', async () => {
  // PNG "Sub" filter: each byte is stored as the difference from the byte one pixel to the left.
  const w = 80; const h = 60;
  const rgb = samples(w * h * 3);
  const rows = [];
  for (let y = 0; y < h; y += 1) {
    const row = Buffer.alloc(1 + w * 3);
    row[0] = 1;
    for (let x = 0; x < w * 3; x += 1) row[1 + x] = (rgb[y * w * 3 + x] - (x >= 3 ? rgb[y * w * 3 + x - 3] : 0)) & 255;
    rows.push(row);
  }
  const codec = fakeCodec();
  const predicted = image(`${rgbDict(w, h)} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /Columns ${w} /BitsPerComponent 8 >>`, zlib.deflateSync(Buffer.concat(rows)));
  const first = await run(pdfWith(predicted), 6000, codec);
  assert.equal(first.result.ok, true, first.result.reason);
  const px = codec.calls.encode[0].pixels;
  const last = (w * h - 1) * 4;
  assert.deepEqual([...px.subarray(0, 4)], [rgb[2], rgb[1], rgb[0], 255]);
  assert.deepEqual([...px.subarray(last, last + 4)], [rgb[w * h * 3 - 1], rgb[w * h * 3 - 2], rgb[w * h * 3 - 3], 255]);
  assert.doesNotMatch(objectStream(first.copy, 8).dict, /DecodeParms/);

  const gray = image('/Width 120 /Height 100 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode', zlib.deflateSync(samples(120 * 100)));
  const second = await run(pdfWith(gray), 6000, fakeCodec());
  assert.equal(second.result.ok, true, second.result.reason);
  assert.match(objectStream(second.copy, 8).dict, /\/ColorSpace \/DeviceRGB/);
});

test('a JPEG is re-encoded only when that clearly makes it smaller', async () => {
  const big = image(`${rgbDict(200, 150)} /Filter /DCTDecode`, fakeJpeg(200, 150, 3, 30000));
  const codec = fakeCodec();
  const { result, copy } = await run(pdfWith(big), 8000, codec);
  assert.equal(result.ok, true, result.reason);
  assert.equal(codec.calls.decode, 1);
  assert.ok(objectStream(copy, 8).data.length < 6000);

  const lean = image(`${rgbDict(200, 150)} /Filter /DCTDecode`, fakeJpeg(200, 150, 3, 6000));
  const again = fakeCodec({ ratio: 0.9 });
  const kept = await run(pdfWith(lean), 3000, again);
  assert.equal(kept.result.ok, false);
  assert.match(kept.result.reason, /already as small as I can/);
});

test('a codec that fails leaves the picture alone instead of failing the job', async () => {
  const pdf = pdfWith(image(`${rgbDict(120, 100)} /Filter /FlateDecode`, zlib.deflateSync(samples(120 * 100 * 3))));
  const { result } = await run(pdf, 20000, fakeCodec({ throws: true }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /already as small as I can/);
});

test('when even the coarsest step does not fit, nothing is saved and the reason says so', async () => {
  const pdf = pdfWith(image(`${rgbDict(120, 100)} /Filter /FlateDecode`, zlib.deflateSync(samples(120 * 100 * 3))));
  const { result } = await run(pdf, 1200, fakeCodec({ ratio: 0.5 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /Even at the lowest image quality I allow/);
});
