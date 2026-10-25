'use strict';
// Make a smaller copy of a PDF that fits under a site's size limit. The lossless pass comes first (structure.js).
// When that is not enough and an image codec is available, the pictures are re-encoded in up to three steps
// (images.js), each from the original and a little coarser than the last, and the first copy that fits wins.
// The source file is never changed.

const fs = require('fs');
const path = require('path');
const { loadPdfjs, pdfText } = require('../folders/extract');
const { load, squeeze, assemble } = require('./structure');
const { recodeImages } = require('./images');

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_PAGES = 300;
const READ_MS = 25000;
const DEADLINE_MS = 120000;
const TIERS = [{ scale: 1, quality: 80 }, { scale: 0.75, quality: 70 }, { scale: 0.5, quality: 60 }];

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function pageCount(buf) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: Uint8Array.from(buf), useSystemFonts: false, disableFontFace: true, isEvalSupported: false, verbosity: 0 });
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('PDF took too long to read')), READ_MS); });
  try { return (await Promise.race([task.promise, timeout])).numPages; }
  finally { clearTimeout(timer); Promise.resolve().then(() => task.destroy()).catch(() => {}); }
}

/** Why the copy cannot stand in for the original (different pages or text), or '' when it can. */
async function mismatch(original, copy) {
  let pages; let text;
  try { pages = await pageCount(original); text = await pdfText(original); } catch (_) { return 'Could not read this PDF.'; }
  if (pages > MAX_PAGES) return `PDF has ${pages} pages, over the ${MAX_PAGES} page limit.`;
  try {
    if (await pageCount(copy) !== pages || await pdfText(copy) !== text) return 'The smaller copy did not match the original, so I did not save it.';
  } catch (_) { return 'The smaller copy would not open, so I did not save it.'; }
  return '';
}

/** Saves `data` under `wanted`, or `-2`, `-3`... if taken. Never replaces a file; removes a partial one. */
async function publish(wanted, data) {
  const { dir, name, ext } = path.parse(wanted);
  for (let n = 1; n <= 20; n += 1) {
    const target = n === 1 ? wanted : path.join(dir, `${name}-${n}${ext}`);
    let file;
    try { file = await fs.promises.open(target, 'wx'); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    try { await file.writeFile(data); await file.close(); return target; }
    catch (e) { await file.close().catch(() => {}); await fs.promises.unlink(target).catch(() => {}); throw e; }
  }
  throw new Error('too many copies already exist');
}

/**
 * Make a smaller copy of a PDF that fits under the site's limit. The source is never changed.
 * @param {{ inputPath:string, outputPath:string, limitBytes:number, codec?:{decode:Function, encode:Function}, log?:Function }} opts
 *   `codec` is the image codec (src/pdf/codec.js in the app); without it only the lossless pass runs.
 * @returns {Promise<{ok:boolean, outputPath?:string, originalSize?:number, compressedSize?:number, lossy?:boolean, reason?:string}>}
 */
async function compressPdf({ inputPath, outputPath, limitBytes, codec, log }) {
  const say = log || (() => {});
  const fail = (reason) => ({ ok: false, reason });
  const deadline = Date.now() + DEADLINE_MS;
  try {
    if (!(limitBytes > 0)) return fail('I need the site\'s size limit to know how small to make the PDF.');
    const budgetBytes = Math.floor(limitBytes * 0.95);

    let stat;
    try { stat = await fs.promises.lstat(inputPath); } catch (_) { return fail('Cannot access the PDF file.'); }
    if (!stat.isFile() || !/\.pdf$/i.test(inputPath)) return fail('That is not a PDF file.');
    if (stat.size > MAX_INPUT_BYTES) return fail('PDF exceeds the 100 MB processing limit.');
    if (stat.size <= budgetBytes) return fail('File is already within the size limit.');

    let buf;
    try { buf = await fs.promises.readFile(inputPath); } catch (_) { return fail('Could not read the PDF file.'); }
    if (buf.length !== stat.size) return fail('The PDF changed while it was being read.');
    if (buf.toString('latin1', 0, 5) !== '%PDF-') return fail('File does not look like a valid PDF.');

    const loaded = load(buf);
    if (loaded.reason) return fail(loaded.reason);
    const { doc } = loaded;

    const lossless = new Map();
    for (const o of doc.objects) { const edit = squeeze(doc, o); if (edit) lossless.set(o.offset, edit); }

    let best = null;
    let chosen = null;
    for (const tier of codec ? [null, ...TIERS] : [null]) {
      if (Date.now() > deadline) return fail('That took too long, so I stopped. Your PDF is unchanged.');
      const edits = new Map(lossless);
      let lossy = false;
      if (tier) {
        const pictures = await recodeImages(doc, codec, tier, tick);
        if (!pictures.size) continue;   // nothing at this step differs from the one before
        for (const [at, edit] of pictures) edits.set(at, edit);
        lossy = true;
      }
      if (!edits.size) continue;
      const made = assemble(doc, [...edits.values()]);
      if (made.reason) return fail(made.reason);
      say(`pdf compress: ${tier ? `scale ${tier.scale}, quality ${tier.quality}` : 'lossless'} -> ${made.buf.length} bytes (budget ${budgetBytes})`);
      if (!best || made.buf.length < best.buf.length) best = { buf: made.buf, lossy };
      if (made.buf.length <= budgetBytes) { chosen = { buf: made.buf, lossy }; break; }
    }

    if (!best) {
      return fail(codec ? 'This PDF is already as small as I can make it.'
        : 'This PDF is already as small as it gets without lowering image quality, and image downsampling is not set up yet.');
    }
    if (!chosen) {
      return fail(codec ? `Even at the lowest image quality I allow, the copy is ${formatBytes(best.buf.length)}, above the ${formatBytes(limitBytes)} limit.`
        : `Lossless recompression only reached ${formatBytes(best.buf.length)}, above the ${formatBytes(limitBytes)} limit. Going lower means reducing image quality, which is not set up yet.`);
    }
    const problem = await mismatch(buf, chosen.buf);
    if (problem) return fail(problem);
    const saved = await publish(outputPath, chosen.buf);
    return { ok: true, outputPath: saved, originalSize: stat.size, compressedSize: chosen.buf.length, lossy: chosen.lossy };
  } catch (e) {
    say(`pdf compress failed: ${e.code || e.name}`);
    return fail('Could not save the compressed PDF.');
  }
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

module.exports = { compressPdf, formatBytes };
