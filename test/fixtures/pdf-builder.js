'use strict';
// Small classic-xref PDFs for tests. objects[i] is the body of object i + 1.

/** A stream object. `length` is what /Length says (a number, or text such as "7 0 R"). */
function stream(dict, data, length = data.length) {
  return Buffer.concat([Buffer.from(`<< ${dict} /Length ${length} >>\nstream\n`), data, Buffer.from('\nendstream')]);
}

/**
 * @param {(string|Buffer)[]} objects
 * @param {{ trailer?:string, phantom?:number, lowIndex?:boolean }} opts
 *   phantom: extra index rows marked in use at offset 0 (objects the producer never wrote);
 *   lowIndex: write the first subsection as "1 N" with the free entry first, as some producers do.
 */
function build(objects, { trailer = '', phantom = 0, lowIndex = false } = {}) {
  const parts = [Buffer.from('%PDF-1.3\n')];
  let at = parts[0].length;
  const offsets = objects.map((body, i) => {
    const bytes = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from('\nendobj\n')]);
    parts.push(bytes);
    const start = at;
    at += bytes.length;
    return start;
  });
  const rows = [...offsets, ...Array(phantom).fill(0)].map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  const count = objects.length + phantom + 1;
  parts.push(Buffer.from(`xref\n${lowIndex ? 1 : 0} ${count}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${count} /Root 1 0 R ${trailer} >>\nstartxref\n${at}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/** A one-page document whose page content is object 4; `extra` objects follow the font (object 5). */
function onePage(content, extra = [], opts = {}) {
  return build([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    content,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...extra,
  ], opts);
}

/**
 * Independent of the code under test: startxref finds the table, every row that names an object lands on
 * an "N 0 obj", and the objects found are exactly 1..count.
 */
function objectsLand(buf, count) {
  const text = buf.toString('latin1');
  const at = Number(/startxref\s+(\d+)/.exec(text)[1]);
  if (text.slice(at, at + 4) !== 'xref') throw new Error('startxref does not point at the table');
  const rows = [...text.slice(at, text.indexOf('trailer', at)).matchAll(/^(\d{10}) (\d{5}) n/gm)].map((m) => Number(m[1])).filter(Boolean);
  const found = rows.map((off) => { const m = /^(\d+) 0 obj/.exec(text.slice(off, off + 20)); if (!m) throw new Error(`no object at ${off}`); return Number(m[1]); });
  const want = Array.from({ length: count }, (_, i) => i + 1);
  if (JSON.stringify([...found].sort((a, b) => a - b)) !== JSON.stringify(want)) throw new Error(`objects found ${found}`);
  return true;
}

module.exports = { build, onePage, stream, objectsLand };
