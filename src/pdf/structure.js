'use strict';
// Reading and rewriting the bytes of a simple PDF: one classic xref table, no encryption, no later revisions.
// Everything works on a latin1 view of the file, so a string index is a byte offset.

const zlib = require('zlib');

const HEAD = /^\s*(\d+)\s+(\d+)\s+obj\b/;
const MAX_INFLATED = 256 * 1024 * 1024;

const REVISIONS = 'This PDF has several revisions, which are not supported yet.';
const PROTECTED = 'Encrypted, signed, fillable and attachment PDFs are not supported.';
const COMPRESSED_INDEX = 'This PDF uses a compressed index, which is not supported yet.';
const BAD_INDEX = 'This PDF\'s index points at things that are not there.';

// ---- syntax ----------------------------------------------------------------------------------

const isDelim = (c) => c <= ' ' || '()<>[]{}/%'.includes(c);

function skipSpace(src, i, max) {
  while (i < max) {
    const c = src[i];
    if (c === '%') { while (i < max && src[i] !== '\n' && src[i] !== '\r') i += 1; } else if (c <= ' ') i += 1;
    else break;
  }
  return i;
}

/** End of the one PDF value that starts at src[i] (name, number, string, array, dictionary, "N G R"), or -1. */
function valueEnd(src, i, max) {
  if (i >= max) return -1;
  const c = src[i];
  if (c === '/') { let j = i + 1; while (j < max && !isDelim(src[j])) j += 1; return j; }
  if (c === '<' && src[i + 1] === '<') { const d = dictEntries(src, i, max); return d ? d.end : -1; }
  if (c === '[') {
    let j = skipSpace(src, i + 1, max);
    while (j < max && src[j] !== ']') {
      const e = valueEnd(src, j, max);
      if (e < 0) return -1;
      j = skipSpace(src, e, max);
    }
    return j < max ? j + 1 : -1;
  }
  if (c === '(') {
    let depth = 0;
    let j = i;
    do {
      const ch = src[j];
      if (ch === '\\') j += 1; else if (ch === '(') depth += 1; else if (ch === ')') depth -= 1;
      j += 1;
    } while (depth && j < max);
    return depth ? -1 : j;
  }
  if (c === '<') { const k = src.indexOf('>', i); return k < 0 || k >= max ? -1 : k + 1; }
  if (c === '>' || c === ']' || c === ')') return -1;
  const ref = /^\d+\s+\d+\s+R(?![^\s()<>[\]{}\/%])/.exec(src.slice(i, i + 40));
  if (ref) return i + ref[0].length;
  let j = i;
  while (j < max && !isDelim(src[j])) j += 1;
  return j > i ? j : -1;
}

/** The dictionary that starts at src[start] ('<<'): { end, entries:[{ key, ks, vs, ve }] }, or null. */
function dictEntries(src, start, max) {
  if (src[start] !== '<' || src[start + 1] !== '<') return null;
  const entries = [];
  let i = start + 2;
  for (;;) {
    i = skipSpace(src, i, max);
    if (i >= max) return null;
    if (src[i] === '>' && src[i + 1] === '>') return { end: i + 2, entries };
    if (src[i] !== '/') return null;
    const ks = i;
    i += 1;
    while (i < max && !isDelim(src[i])) i += 1;
    const key = src.slice(ks + 1, i);
    const vs = skipSpace(src, i, max);
    const ve = valueEnd(src, vs, max);
    if (ve < 0) return null;
    entries.push({ key, ks, vs, ve });
    i = ve;
  }
}

/** In-use rows of a classic xref table (the text from "xref" up to "trailer"), in table order. */
function parseXref(text) {
  const rows = [];
  let num = 0;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const head = /^(\d+) (\d+)\s*$/.exec(line);
    if (head) { num = Number(head[1]); continue; }
    const row = /^(\d{10}) (\d{5}) ([nf])/.exec(line);
    if (!row) continue;
    if (row[3] === 'n') rows.push({ num, offset: Number(row[1]) });
    num += 1;
  }
  return rows;
}

// ---- the document ------------------------------------------------------------------------------

/**
 * Index the objects of a PDF. Returns { doc } or { reason }. The objects are the ones the index really
 * points at; rows that name nothing (offset 0, which some producers write for objects they dropped) stay
 * in the table untouched.
 */
function load(buf) {
  const src = buf.toString('latin1');
  const starts = [...src.matchAll(/startxref\s+(\d+)/g)];
  if (starts.length !== 1) return { reason: REVISIONS };
  if (/\/(?:Encrypt|ByteRange|AcroForm|EmbeddedFiles)\b/.test(src)) return { reason: PROTECTED };
  const xrefAt = Number(starts[0][1]);
  const trailerAt = src.indexOf('trailer', xrefAt);
  if (!src.startsWith('xref', xrefAt) || trailerAt < 0) return { reason: COMPRESSED_INDEX };
  const trailerOpen = src.indexOf('<<', trailerAt);
  const trailer = trailerOpen < 0 ? null : dictEntries(src, trailerOpen, src.length);
  if (!trailer || trailer.entries.some((e) => e.key === 'Prev' || e.key === 'XRefStm')) return { reason: REVISIONS };

  const table = src.slice(xrefAt, trailerAt);
  const rows = parseXref(table);
  const offsets = [...new Set(rows.filter((r) => r.offset > 0).map((r) => r.offset))].sort((a, b) => a - b);
  const objects = [];
  for (let k = 0; k < offsets.length; k += 1) {
    const head = HEAD.exec(src.slice(offsets[k], offsets[k] + 40));
    if (!head) return { reason: BAD_INDEX };
    const next = k + 1 < offsets.length ? offsets[k + 1] : src.length;
    objects.push({
      offset: offsets[k],
      end: offsets[k] < xrefAt && xrefAt < next ? xrefAt : next,
      from: offsets[k] + head[0].length,
      num: Number(head[1]),
      key: `${head[1]} ${head[2]}`,
    });
  }
  const byNum = new Map(objects.map((o) => [o.num, o]));
  return { doc: { buf, src, xrefAt, table, rows, objects, byNum } };
}

/** The text of an object between its header and "endobj". */
function bodyOf(doc, o) {
  return doc.src.slice(o.from, o.end).replace(/endobj[^]*$/, '').trim();
}

function integerObject(doc, num) {
  const o = doc.byNum.get(num);
  const m = o && /^\s*(\d+)\s*(?:endobj|$)/.exec(doc.src.slice(o.from, Math.min(o.end, o.from + 40)));
  return m ? Number(m[1]) : null;
}

/**
 * The stream of an object: { open, dict, dataStart, dataEnd, values }, or null when the object has no
 * stream or its length cannot be trusted. `values` maps each key of the dictionary to its text.
 */
function streamOf(doc, o) {
  if (o.stream !== undefined) return o.stream;
  o.stream = null;
  const { src } = doc;
  const open = src.indexOf('<<', o.from);
  if (open < 0 || open >= o.end || src.slice(o.from, open).trim()) return null;
  const dict = dictEntries(src, open, o.end);
  if (!dict) return null;
  const keyword = /^\s*stream(\r\n|\n)/.exec(src.slice(dict.end, dict.end + 32));
  if (!keyword) return null;
  const values = Object.fromEntries(dict.entries.map((e) => [e.key, src.slice(e.vs, e.ve)]));
  let length = null;
  if (/^\d+$/.test(values.Length || '')) length = Number(values.Length);
  else { const ref = /^(\d+)\s+\d+\s+R$/.exec(values.Length || ''); if (ref) length = integerObject(doc, Number(ref[1])); }
  if (length === null) return null;
  const dataStart = dict.end + keyword[0].length;
  const dataEnd = dataStart + length;
  if (dataEnd > o.end || !/^(\r\n|\n|\r)?endstream/.test(src.slice(dataEnd, dataEnd + 11))) return null;
  o.stream = { open, dict, dataStart, dataEnd, values };
  return o.stream;
}

/**
 * An edit that gives an object's stream new bytes: its dictionary is kept except for the keys in `drop`
 * and `set`, which are replaced. A length that was a reference becomes the number itself.
 */
function restream(doc, s, { drop = [], set = {} }, data) {
  let dict = '<<';
  for (const e of s.dict.entries) {
    if (e.key !== 'Length' && !drop.includes(e.key) && !(e.key in set)) dict += ` ${doc.src.slice(e.ks, e.ve)}`;
  }
  for (const [k, v] of Object.entries({ ...set, Length: data.length })) dict += ` /${k} ${v}`;
  return {
    start: s.open,
    end: s.dataEnd,
    bytes: Buffer.concat([Buffer.from(`${dict} >>`, 'latin1'), Buffer.from(doc.src.slice(s.dict.end, s.dataStart), 'latin1'), data]),
  };
}

const isFlate = (f) => f === '/FlateDecode' || /^\[\s*\/FlateDecode\s*\]$/.test(f || '');

/** The lossless pass: pack streams that are not packed yet, and pack the ones that are a little harder. */
function squeeze(doc, o) {
  const s = streamOf(doc, o);
  if (!s || s.values.Type === '/Metadata') return null;
  const raw = doc.buf.subarray(s.dataStart, s.dataEnd);
  const { Filter, F, DecodeParms } = s.values;
  if (!Filter && !F && !DecodeParms) {
    if (raw.length < 32) return null;
    const packed = zlib.deflateSync(raw, { level: 9 });
    return packed.length < raw.length ? restream(doc, s, { set: { Filter: '/FlateDecode' } }, packed) : null;
  }
  if (isFlate(Filter) && !F && raw.length >= 512) {
    let plain;
    try { plain = zlib.inflateSync(raw, { maxOutputLength: MAX_INFLATED }); } catch (_) { return null; }
    const packed = zlib.deflateSync(plain, { level: 9 });
    return packed.length < raw.length ? restream(doc, s, {}, packed) : null;
  }
  return null;
}

/**
 * Apply the edits (replacements of byte ranges inside objects) and make the index fit the new file.
 * Returns { buf } or { reason }.
 */
function assemble(doc, edits) {
  const { buf, xrefAt, table, rows, objects } = doc;
  edits.sort((a, b) => a.start - b.start);

  // Every edit sits inside one object, so an offset moves by the size change of the edits before it.
  let delta = 0;
  const change = edits.map((e) => (delta += e.bytes.length - (e.end - e.start)));
  const shift = (x) => {
    let lo = 0;
    let hi = edits.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (edits[mid].start < x) lo = mid + 1; else hi = mid; }
    return lo ? x + change[lo - 1] : x;
  };
  const parts = [];
  let pos = 0;
  for (const e of edits) { parts.push(buf.subarray(pos, e.start), e.bytes); pos = e.end; }
  parts.push(buf.subarray(pos));
  const body = Buffer.concat(parts);

  // Rows keep their width, so the table can be patched where it stands. A row at offset 0 stays at 0.
  const tableAt = shift(xrefAt);
  body.write(body.toString('latin1', tableAt, tableAt + table.length)
    .replace(/^(\d{10})( \d{5} n)/gm, (_, off, rest) => String(Number(off) ? shift(Number(off)) : 0).padStart(10, '0') + rest), tableAt, 'latin1');
  const sx = body.lastIndexOf('startxref');
  const out = Buffer.concat([body.subarray(0, sx), Buffer.from(`startxref\n${tableAt}${body.toString('latin1', sx + 9).replace(/^\s*\d+/, '')}`, 'latin1')]);

  // Readers repair a bad index silently, so check it ourselves: every row must land on the very object it named before.
  const keyAt = new Map(objects.map((o) => [o.offset, o.key]));
  const moved = parseXref(out.toString('latin1', tableAt, tableAt + table.length));
  const sound = out.toString('latin1', tableAt, tableAt + 4) === 'xref' && moved.length === rows.length && moved.every((r, i) => {
    if (!rows[i].offset) return r.offset === 0;
    const head = HEAD.exec(out.toString('latin1', r.offset, r.offset + 40));
    return r.offset === shift(rows[i].offset) && head && `${head[1]} ${head[2]}` === keyAt.get(rows[i].offset);
  });
  return sound ? { buf: out } : { reason: 'Could not rewrite this PDF safely.' };
}

module.exports = { load, streamOf, restream, squeeze, assemble, bodyOf, dictEntries, parseXref, isFlate };
