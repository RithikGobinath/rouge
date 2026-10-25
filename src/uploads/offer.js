'use strict';
// The ribbon's side of a PDF the page would not take: ask, find the file, make the smaller copy and
// say where it is. The page evidence comes from the extension (autofill/bridge) or the window reader
// (uploads/capture); both end up here.

const path = require('path');

// A file name that came from a web page, cut down to characters a Windows file name may hold.
const safeName = (name) => String(name || '').split('').filter((c) => c.charCodeAt(0) > 31 && !'<>:"|?*'.includes(c)).join('');
const stem = (name) => path.basename(name, path.extname(name));

/**
 * @param {{
 *   voice:    () => { active:boolean, asking:boolean, ask:(card:object) => Promise<boolean> }|null,
 *   ui:       { notice: (text:string, opts:object) => void },
 *   compress: (opts:object) => Promise<{ok:boolean, reason?:string, outputPath?:string, originalSize?:number, compressedSize?:number}>,
 *   formatBytes: (n:number) => string,
 *   pickPdf:  () => Promise<string|null>,   Rouge's own file dialog, for when the extension could not copy the PDF
 *   downloads: () => string,
 *   hold?:    (file:string) => Promise<boolean>,   puts the copy on the shelf, to be dragged onto the upload
 *   fs:       { unlink: Function },
 *   log?:     Function,
 *   waitMs?:  number,
 * }} deps
 */
function createUploadOffer({ voice, ui, compress, formatBytes, pickPdf, downloads, hold, fs, log, waitMs = 30000 }) {
  const say = log || (() => {});
  let offering = false;
  let last = { key: '', at: 0 };

  /** @param {{limitBytes:number|null, filename?:string|null, fileSize?:number|null, windowTitle?:string, title?:string, tempPath?:string|null}} ev */
  async function handle({ limitBytes, filename, fileSize, windowTitle, title, tempPath }) {
    const dropTemp = () => { if (tempPath) fs.unlink(tempPath, () => {}); };
    // One offer at a time, and the same PDF is not offered twice within a minute: the page and the
    // window reader can both notice it, and a report must not pile up behind an open question.
    const key = `${filename || ''}:${fileSize || ''}`;
    if (offering || (filename && key === last.key && Date.now() - last.at < 60000)) { dropTemp(); return; }
    offering = true;
    try {
      last = { key, at: Date.now() };
      // The ribbon may be in the middle of something else: wait for it instead of losing the offer.
      for (let waited = 0; ; waited += 100) {
        const v = voice();
        if (v && !v.active && !v.asking) break;
        if (waited >= waitMs) { say('upload offer: ribbon stayed busy, dropped'); dropTemp(); return; }
        await new Promise((r) => setTimeout(r, 100));
      }
      await offer({ limitBytes, filename, fileSize, hint: windowTitle || title || '', tempPath, dropTemp });
    } finally { offering = false; }
  }

  async function offer({ limitBytes, filename, fileSize, hint, tempPath, dropTemp }) {
    if (!limitBytes) {
      // Without the limit there is no target to compress to.
      dropTemp();
      ui.notice('The PDF was rejected as too large, but the site did not say how small it needs to be.', { tone: 'info' });
      return;
    }
    const yes = await voice().ask({
      kicker: 'PDF too large',
      title: `Compress ${filename || 'the PDF'}${fileSize ? ` (${formatBytes(fileSize)})` : ''} below ${formatBytes(limitBytes)}?`,
      hint: hint ? `${hint} · Image quality may decrease` : 'Image quality may decrease',
    });
    if (!yes) { dropTemp(); return; }

    // The extension's copy has no home folder; otherwise the user shows Rouge the file.
    const inputPath = tempPath || await pickPdf();
    if (!inputPath) return;

    // A cached copy goes to Downloads under the name the site saw; a picked file gets its copy beside it.
    const outputPath = tempPath
      ? path.join(downloads(), `${stem(safeName(filename || 'document.pdf')) || 'document'}-compressed.pdf`)
      : path.join(path.dirname(inputPath), `${stem(inputPath)}-compressed.pdf`);
    ui.notice('Compressing…', { tone: 'info' });
    const result = await compress({ inputPath, outputPath, limitBytes, log });
    dropTemp();
    if (result.ok) {
      // The shelf keeps the copy beside the ribbon, ready to be dragged onto the upload.
      let held = false;
      try { held = hold ? await hold(result.outputPath) : false; } catch (_) { held = false; }
      const where = tempPath ? 'in Downloads' : 'next to the original';
      const sizes = `${formatBytes(result.compressedSize)} (was ${formatBytes(result.originalSize)})`;
      const softer = result.lossy ? 'Pictures were recompressed. ' : '';
      ui.notice(
        held
          ? `Ready: ${path.basename(result.outputPath)}, ${sizes}. Drag it from the shelf onto the upload; it is also ${where}. ${softer}Original unchanged.`
          : `Ready: ${path.basename(result.outputPath)}, ${sizes}, saved ${where}. ${softer}Original unchanged.`,
        { tone: 'info' },
      );
    } else {
      ui.notice(result.reason, { tone: 'info' });
    }
  }

  return { handle };
}

module.exports = { createUploadOffer, safeName };
