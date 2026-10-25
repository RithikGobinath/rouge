'use strict';
// Making the pictures inside a PDF smaller: each one is decoded, optionally scaled down, and stored again as
// a JPEG. The image codec (the engine inside Electron) is handed in, so this file needs no dependency.
// Only plain pictures are touched: 8-bit gray or RGB, JPEG or Flate. Masks, palettes, CMYK, inverted
// ranges and anything unusual are left exactly as they are.

const zlib = require('zlib');
const { streamOf, restream, bodyOf, dictEntries, isFlate } = require('./structure');

const MIN_IMAGE_BYTES = 4096;      // smaller pictures are not worth the risk
const MIN_GAIN = 0.85;             // replace a picture only when the new one is at most this share of the old
const MAX_INFLATED = 256 * 1024 * 1024;

const isJpeg = (f) => f === '/DCTDecode' || /^\[\s*\/DCTDecode\s*\]$/.test(f || '');

/** How many color components a ColorSpace value has (1 or 3), or null for anything else. */
function components(doc, cs, depth = 0) {
  if (!cs || depth > 3) return null;
  if (cs === '/DeviceGray' || cs === '/CalGray') return 1;
  if (cs === '/DeviceRGB' || cs === '/CalRGB') return 3;
  const ref = /^(\d+)\s+\d+\s+R$/.exec(cs);
  if (ref) { const o = doc.byNum.get(Number(ref[1])); return o ? components(doc, bodyOf(doc, o), depth + 1) : null; }
  const name = /^\[\s*\/(\w+)/.exec(cs);
  if (!name) return null;
  if (name[1] === 'CalGray') return 1;
  if (name[1] === 'CalRGB') return 3;
  if (name[1] === 'ICCBased') {
    const r = /^\[\s*\/ICCBased\s+(\d+)\s+\d+\s+R/.exec(cs);
    const o = r && doc.byNum.get(Number(r[1]));
    const n = o && /\/N\s+(\d+)/.exec(doc.src.slice(o.from, Math.min(o.end, o.from + 600)));
    return n ? Number(n[1]) : null;
  }
  return null;
}

/** Width, height, component count and sample size of a JPEG, from its first frame header. */
function jpegInfo(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { bits: buf[i + 4], height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), comps: buf[i + 9] };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/** PNG-style row filters undone, for Flate pictures stored with a predictor. */
function unpredict(data, { colors, columns, bits }, height) {
  const bpp = Math.max(1, Math.ceil((colors * bits) / 8));
  const rowBytes = Math.ceil((colors * bits * columns) / 8);
  if (data.length !== height * (rowBytes + 1)) return null;
  const out = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y += 1) {
    const type = data[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1;
    const row = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[row - rowBytes + x] : 0;
      const c = x >= bpp && y > 0 ? out[row - rowBytes + x - bpp] : 0;
      let add;
      if (type === 0) add = 0;
      else if (type === 1) add = a;
      else if (type === 2) add = b;
      else if (type === 3) add = (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else return null;
      out[row + x] = (data[src + x] + add) & 255;
    }
  }
  return out;
}

/** The DecodeParms of a Flate picture as { predictor, colors, columns, bits }, or null when it is something else. */
function parms(text, comps, width) {
  if (!text || text === 'null' || text === '[null]') return { predictor: 1, colors: comps, columns: width, bits: 8 };
  const inner = /^\[\s*(<<[^]*>>)\s*\]$/.exec(text);
  const at = inner ? inner[1] : text;
  const d = dictEntries(at, 0, at.length);
  if (!d) return null;
  const get = (key, dflt) => { const e = d.entries.find((x) => x.key === key); return e ? Number(at.slice(e.vs, e.ve)) : dflt; };
  const p = { predictor: get('Predictor', 1), colors: get('Colors', 1), columns: get('Columns', 1), bits: get('BitsPerComponent', 8) };
  return Object.values(p).every(Number.isFinite) ? p : null;
}

function toBgra(raw, width, height, comps) {
  const pixels = width * height;
  const out = Buffer.alloc(pixels * 4);
  if (comps === 3) {
    for (let i = 0, j = 0; i < pixels * 3; i += 3, j += 4) { out[j] = raw[i + 2]; out[j + 1] = raw[i + 1]; out[j + 2] = raw[i]; out[j + 3] = 255; }
  } else {
    for (let i = 0, j = 0; i < pixels; i += 1, j += 4) { out[j] = raw[i]; out[j + 1] = raw[i]; out[j + 2] = raw[i]; out[j + 3] = 255; }
  }
  return out;
}

/** The picture's pixels as BGRA, or null when it is not a plain picture this code understands. */
function decodePixels(codec, v, data, { jpeg, width, height, comps }) {
  if (jpeg) {
    const info = jpegInfo(data);
    if (!info || info.comps !== comps || info.bits !== 8 || info.width !== width || info.height !== height) return null;
    const decoded = codec.decode(data);
    return decoded && decoded.width === width && decoded.height === height ? decoded.bgra : null;
  }
  const p = parms(v.DecodeParms, comps, width);
  if (!p || p.bits !== 8 || p.colors !== comps || p.columns !== width || !(p.predictor === 1 || p.predictor >= 10)) return null;
  let plain;
  try { plain = zlib.inflateSync(data, { maxOutputLength: MAX_INFLATED }); } catch (_) { return null; }
  const raw = p.predictor === 1 ? plain : unpredict(plain, p, height);
  return raw && raw.length === width * height * comps ? toBgra(raw, width, height, comps) : null;
}

/** The objects that other pictures use as their mask: those must stay as they are. */
function maskTargets(doc) {
  const set = new Set();
  for (const m of doc.src.matchAll(/\/(?:SMask|Mask)\s+(\d+)\s+\d+\s+R/g)) set.add(Number(m[1]));
  return set;
}

/**
 * Edits that re-encode the eligible pictures of a document.
 * @param {object} doc  from structure.load
 * @param {{ decode: Function, encode: Function }} codec
 * @param {{ scale:number, quality:number }} tier
 * @param {() => Promise<void>} tick  yields to the event loop between pictures
 * @returns {Promise<Map<number, object>>}  object offset -> edit
 */
async function recodeImages(doc, codec, tier, tick) {
  const edits = new Map();
  const masks = maskTargets(doc);
  for (const o of doc.objects) {
    const s = streamOf(doc, o);
    if (!s || s.values.Subtype !== '/Image' || masks.has(o.num)) continue;
    const v = s.values;
    if (v.ImageMask === 'true' || v.Mask || v.Decode || v.Matte || v.F) continue;
    const length = s.dataEnd - s.dataStart;
    const jpeg = isJpeg(v.Filter);
    if (length < MIN_IMAGE_BYTES || !(jpeg || isFlate(v.Filter))) continue;
    const width = Number(v.Width);
    const height = Number(v.Height);
    const comps = components(doc, v.ColorSpace);
    if (!(width > 0 && height > 0) || (comps !== 1 && comps !== 3) || (v.BitsPerComponent && Number(v.BitsPerComponent) !== 8)) continue;

    let out = null;
    try {
      const pixels = decodePixels(codec, v, doc.buf.subarray(s.dataStart, s.dataEnd), { jpeg, width, height, comps });
      out = pixels && codec.encode({ width, height, bgra: pixels }, tier);
    } catch (_) { out = null; }
    if (out && out.jpeg && out.jpeg.length <= length * MIN_GAIN) {
      edits.set(o.offset, restream(doc, s, {
        drop: ['DecodeParms'],
        set: { Filter: '/DCTDecode', Width: out.width, Height: out.height, BitsPerComponent: 8, ...(comps === 1 ? { ColorSpace: '/DeviceRGB' } : {}) },
      }, out.jpeg));
    }
    await tick();
  }
  return edits;
}

module.exports = { recodeImages, components, jpegInfo, unpredict };
