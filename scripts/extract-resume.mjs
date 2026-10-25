// scripts/extract-resume.mjs
// Reads a PDF and prints all extracted text to stdout.
// Usage: node scripts/extract-resume.mjs [path-to-pdf]
//
// Uses the same pdfjs-dist/legacy approach as src/folders/extract.js.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

const DEFAULT_PDF = resolve('C:/Users/rithi/Downloads/RithikSept.pdf');
const pdfPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_PDF;

const buf = readFileSync(pdfPath);

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const task = pdfjs.getDocument({
  data: Uint8Array.from(buf),
  useSystemFonts: false,
  disableFontFace: true,
  isEvalSupported: false,
  verbosity: 0,
});

const doc = await task.promise;
const pages = [];

for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  const text = tc.items
    .map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' '))
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ {2,}/g, ' ')
    .trim();
  pages.push(text);
  page.cleanup();
}

await task.destroy();

const fullText = pages.filter(Boolean).join('\n\n');
console.log(fullText);
