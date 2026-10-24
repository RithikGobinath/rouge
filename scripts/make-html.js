'use strict';
// Packs the ribbon, its mark and the thread, with a small example page, into
// one HTML file that opens by double-clicking: nothing to install or load.
//
//   node scripts/make-html.js [out.html]        (default: ribbon.html in the project folder)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'ribbon.html'));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

let page = read('renderer/standalone/page.html');
const parts = { MATERIAL: 'renderer/shared/ribbon.js', MARK: 'renderer/shared/mark3d.js', STRAND: 'renderer/shared/strand.js', PAGE: 'renderer/standalone/page.js' };
for (const [name, file] of Object.entries(parts)) {
  const marker = `/*${name}*/`;
  if (!page.includes(marker)) throw new Error(`the page has no ${marker}`);
  page = page.replace(marker, () => safe(read(file)));
}
fs.writeFileSync(out, page);
process.stdout.write(`${out} (${Math.round(Buffer.byteLength(page) / 1024)} KB)\n`);
