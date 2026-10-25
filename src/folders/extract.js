'use strict';
// Text out of the files people keep notes in: PDF, Word, plain text, Markdown
// and calendar files. Everything stays on this machine.

const fs = require('fs');
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');
const { parseIcs } = require('./ics');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DOCX_ENTRY = 8 * 1024 * 1024;
const MAX_DOCX_TOTAL = 16 * 1024 * 1024;
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.text']);
const SUPPORTED = new Set([...TEXT_EXT, '.pdf', '.docx', '.ics']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : ''; }
    return ENTITIES[e.toLowerCase()] || '';
  });
}

/** The words in a Word document.xml: text runs, with paragraph ends as newlines. */
function docxXmlToText(xml) {
  const out = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<\/w:p>|<w:tab\s*\/>|<w:br\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] != null) out.push(decodeEntities(m[1]));
    else if (m[0] === '</w:p>') out.push('\n');
    else if (m[0].startsWith('<w:tab')) out.push('\t');
    else out.push('\n');
  }
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function docxText(buf) {
  let expanded = 0;
  const sizes = new Map();
  const files = unzipSync(new Uint8Array(buf), { filter: (f) => {
    if (f.name !== 'word/document.xml' && !/^word\/(?:header|footer|footnotes|endnotes)\d*\.xml$/.test(f.name)) return false;
    if (sizes.has(f.name) || !Number.isSafeInteger(f.originalSize) || f.originalSize < 0 ||
        !Number.isSafeInteger(f.size) || f.size < 0 || f.size > buf.length ||
        ![0, 8].includes(f.compression) || f.compression === 0 && f.size !== f.originalSize) throw new Error('invalid Word archive entry');
    expanded += f.originalSize;
    if (f.originalSize > MAX_DOCX_ENTRY || expanded > MAX_DOCX_TOTAL) throw new Error('Word document expands beyond the safe size limit');
    sizes.set(f.name, f.originalSize);
    return true;
  } });
  for (const [name, data] of Object.entries(files)) {
    if (data.length !== sizes.get(name)) throw new Error('invalid Word archive size');
  }
  const main = files['word/document.xml'];
  if (!main) throw new Error('not a Word document');
  const parts = [docxXmlToText(strFromU8(main))];
  for (const [name, data] of Object.entries(files)) if (name !== 'word/document.xml') parts.push(docxXmlToText(strFromU8(data)));
  return parts.filter(Boolean).join('\n\n');
}

let pdfjsPromise = null;
const loadPdfjs = () => (pdfjsPromise || (pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')));

async function pdfText(buf, { maxPages = 300, timeoutMs = 25000 } = {}) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: Uint8Array.from(buf), useSystemFonts: false, disableFontFace: true, isEvalSupported: false, verbosity: 0 });
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => { try { task.destroy(); } catch (_) { /* already gone */ } rej(new Error('PDF took too long to read')); }, timeoutMs); });
  try {
    const doc = await Promise.race([task.promise, timeout]);
    const pages = [];
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p += 1) {
      const page = await Promise.race([doc.getPage(p), timeout]);
      const tc = await Promise.race([page.getTextContent(), timeout]);
      pages.push(tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim());
      page.cleanup();
    }
    await task.destroy();
    return pages.filter(Boolean).join('\n\n');
  } finally { clearTimeout(timer); }
}

/**
 * @param {string} file absolute path
 * @returns {Promise<{text:string, kind:string, events?:object[]}>}
 */
async function extract(file) {
  const ext = path.extname(file).toLowerCase();
  if (!SUPPORTED.has(ext)) throw new Error(`unsupported file type ${ext || '(none)'}`);
  const st = await fs.promises.stat(file);
  if (st.size > MAX_BYTES) throw new Error('over 2 MB');
  const chunks = []; let bytes = 0;
  for await (const piece of fs.createReadStream(file, { highWaterMark: 64 * 1024 })) {
    bytes += piece.length;
    if (bytes > MAX_BYTES) throw new Error('over 2 MB');
    chunks.push(piece);
  }
  const buf = Buffer.concat(chunks, bytes);
  if (TEXT_EXT.has(ext)) return { text: buf.toString('utf8').replace(/^﻿/, ''), kind: ext === '.txt' || ext === '.text' ? 'text' : 'markdown' };
  if (ext === '.docx') return { text: docxText(buf), kind: 'word' };
  if (ext === '.pdf') return { text: await pdfText(buf), kind: 'pdf' };
  const events = parseIcs(buf.toString('utf8'));
  return { text: '', kind: 'calendar', events };
}

module.exports = { extract, docxXmlToText, SUPPORTED, MAX_BYTES, loadPdfjs, pdfText };
