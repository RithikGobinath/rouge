'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');
const { parseIcs, upcoming, formatEvent, occurrences } = require('../src/folders/ics');
const { Bm25, chunk, terms } = require('../src/folders/search');
const { extract, docxXmlToText } = require('../src/folders/extract');
const { createFolders, refuse } = require('../src/folders/manager');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-folders-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

function makeDocx(paragraphs) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, '&amp;')}</w:t></w:r></w:p>`).join('');
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`),
  }));
}

function makePdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, '\\$&');
  const content = `BT /F1 12 Tf 72 720 Td ${lines.map((l) => `(${esc(l)}) Tj 0 -16 Td`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'SUMMARY:Lab meeting', 'DTSTART:20261026T140000Z', 'DTEND:20261026T150000Z', 'LOCATION:Room 3\\, East Hall', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Physics\\nmidterm', 'DTSTART;VALUE=DATE:20261030', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Weekly standup', 'DTSTART:20261026T090000Z', 'DURATION:PT30M', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Folded', ' title here', 'DTSTART;TZID=America/New_York:20261101T100000', 'DTEND;TZID=America/New_York:20261101T110000', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('calendar files: events, folding, all-day, time zones, repeats', () => {
  const ev = parseIcs(ICS);
  assert.equal(ev.length, 4);
  assert.equal(ev[0].summary, 'Lab meeting');
  assert.equal(ev[0].location, 'Room 3, East Hall');
  assert.equal(ev[0].start, Date.UTC(2026, 9, 26, 14));
  assert.equal(ev[0].end, Date.UTC(2026, 9, 26, 15));
  assert.equal(ev[1].summary, 'Physics\nmidterm');
  assert.equal(ev[1].allDay, true);
  assert.equal(ev[3].summary, 'Foldedtitle here');
  // 1 Nov 2026 10:00 in New York: DST ended at 02:00 that morning, so UTC-5.
  assert.equal(ev[3].start, Date.UTC(2026, 10, 1, 15));
  assert.equal(ev[2].end - ev[2].start, 30 * 60 * 1000, 'DURATION becomes the length');

  const weekly = occurrences(ev[2], Date.UTC(2026, 9, 1), Date.UTC(2026, 11, 31));
  assert.equal(weekly.length, 4, 'COUNT=4 stops it');
  assert.deepEqual(weekly.map((o) => new Date(o.start).getUTCDay()), [1, 3, 1, 3]);
  const soon = upcoming(ev, Date.UTC(2026, 9, 26, 12), 14);
  assert.ok(soon.length >= 5);
  assert.ok(soon.every((e, i) => i === 0 || soon[i - 1].start <= e.start), 'soonest first');
  assert.match(formatEvent(soon.find((e) => e.summary === 'Lab meeting')), /Lab meeting @ Room 3, East Hall/);
});

test('UTC, named-zone and floating recurrences retain their own clock across DST', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const daily = (start) => parseIcs(`BEGIN:VEVENT\n${start}\nDURATION:PT30M\nRRULE:FREQ=DAILY;COUNT=3\nEND:VEVENT`)[0];
    const utc = daily('DTSTART:20260307T090000Z');
    assert.equal(utc.timeZone, 'UTC');
    assert.deepEqual(occurrences(utc, Date.UTC(2026, 2, 6), Date.UTC(2026, 2, 11)).map((e) => e.start),
      [7, 8, 9].map((day) => Date.UTC(2026, 2, day, 9)));
    const floating = daily('DTSTART:20260307T090000');
    assert.equal(floating.timeZone, null);
    assert.deepEqual(occurrences(floating, Date.UTC(2026, 2, 6), Date.UTC(2026, 2, 11)).map((e) => e.start),
      [Date.UTC(2026, 2, 7, 17), Date.UTC(2026, 2, 8, 16), Date.UTC(2026, 2, 9, 16)]);

    process.env.TZ = 'Europe/London';
    const named = parseIcs('BEGIN:VEVENT\nDTSTART;TZID=America/New_York:20260301T090000\nDURATION:PT30M\nRRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=5;UNTIL=20260322T130000Z\nEXDATE;TZID=America/New_York:20260308T090000\nEND:VEVENT')[0];
    const weeks = occurrences(named, Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1));
    assert.deepEqual(weeks.map((e) => e.start), [Date.UTC(2026, 2, 1, 14), Date.UTC(2026, 2, 15, 13), Date.UTC(2026, 2, 22, 13)]);
    assert.ok(weeks.every((e) => e.end - e.start === 30 * 60 * 1000));
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test('month and year repeats skip dates that do not exist instead of shifting them', () => {
  const month = parseIcs('BEGIN:VEVENT\nDTSTART:20260131T090000Z\nRRULE:FREQ=MONTHLY;COUNT=3\nEND:VEVENT')[0];
  assert.deepEqual(occurrences(month, Date.UTC(2026, 0, 1), Date.UTC(2026, 6, 1)).map((e) => e.start),
    [Date.UTC(2026, 0, 31, 9), Date.UTC(2026, 2, 31, 9), Date.UTC(2026, 4, 31, 9)]);
  const year = parseIcs('BEGIN:VEVENT\nDTSTART:20240229T090000Z\nRRULE:FREQ=YEARLY;COUNT=2\nEND:VEVENT')[0];
  assert.deepEqual(occurrences(year, Date.UTC(2024, 0, 1), Date.UTC(2030, 0, 1)).map((e) => e.start),
    [Date.UTC(2024, 1, 29, 9), Date.UTC(2028, 1, 29, 9)]);
});

test('BM25 finds the note that answers, ignoring filler words', () => {
  const idx = new Bm25();
  idx.add('a', 'The lab report is due on Friday at noon. Submit it on Canvas.', { file: 'a' });
  idx.add('b', 'Grocery list: milk, eggs, flour, and bananas for the weekend.', { file: 'b' });
  idx.add('c', 'Meeting notes: we agreed the budget review moves to Thursday.', { file: 'c' });
  const r = idx.search('when is the lab report due', 3);
  assert.equal(r[0].id, 'a');
  assert.ok(r[0].coverage >= 0.75);
  assert.deepEqual(idx.search('bananas', 1).map((x) => x.id), ['b']);
  assert.equal(idx.search('quantum chromodynamics', 3).length, 0);
  idx.remove('a');
  assert.notEqual(idx.search('lab report due', 1)[0]?.id, 'a');
  assert.deepEqual(terms('Meetings and studied'), ['meeting', 'study']);
});

test('chunking keeps text intact and bounded', () => {
  const para = 'Sentence number one is here. '.repeat(120);
  const chunks = chunk(para, 600, 100);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((c) => c.length <= 1000));
  assert.deepEqual(chunk('short', 600), ['short']);
  assert.deepEqual(chunk('   '), []);
});

test('extractors: text, markdown, Word, PDF, calendar', async (t) => {
  const dir = tmp();
  t.after(() => rm(dir));
  fs.writeFileSync(path.join(dir, 'a.txt'), '\uFEFFPlain notes about trefoil knots.');
  fs.writeFileSync(path.join(dir, 'b.md'), '# Title\n\nSome *markdown* here.');
  fs.writeFileSync(path.join(dir, 'c.docx'), makeDocx(['Résumé draft', 'Skills: C++ & JavaScript']));
  fs.writeFileSync(path.join(dir, 'd.pdf'), makePdf(['Syllabus for Physics 101', 'Midterm on October 30']));
  fs.writeFileSync(path.join(dir, 'e.ics'), ICS);
  assert.equal((await extract(path.join(dir, 'a.txt'))).text, 'Plain notes about trefoil knots.');
  assert.match((await extract(path.join(dir, 'b.md'))).text, /Some \*markdown\* here/);
  const w = await extract(path.join(dir, 'c.docx'));
  assert.equal(w.kind, 'word');
  assert.equal(w.text, 'Résumé draft\nSkills: C++ & JavaScript');
  const p = await extract(path.join(dir, 'd.pdf'));
  assert.equal(p.kind, 'pdf');
  assert.match(p.text, /Syllabus for Physics 101/);
  assert.match(p.text, /Midterm on October 30/);
  const c = await extract(path.join(dir, 'e.ics'));
  assert.equal(c.kind, 'calendar');
  assert.equal(c.events.length, 4);
  await assert.rejects(extract(path.join(dir, 'x.exe')), /unsupported/);
  assert.equal(docxXmlToText('<w:p><w:r><w:t>a&lt;b</w:t></w:r></w:p><w:p><w:r><w:t>c</w:t></w:r></w:p>'), 'a<b\nc');
});

test('a file over 2 MB is refused', async (t) => {
  const dir = tmp();
  t.after(() => rm(dir));
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(extract(path.join(dir, 'big.txt')), /2 MB/);
});

test('Word expansion is bounded per entry and in total, including duplicate names', async (t) => {
  const dir = tmp();
  t.after(() => rm(dir));
  const xml = (bytes) => strToU8('<w:document>' + 'x'.repeat(bytes) + '</w:document>');
  const oversized = Buffer.from(zipSync({ 'word/document.xml': xml(9 * 1024 * 1024) }));
  assert.ok(oversized.length < 2 * 1024 * 1024, 'compressed input fits the ordinary file limit');
  fs.writeFileSync(path.join(dir, 'entry.docx'), oversized);
  await assert.rejects(extract(path.join(dir, 'entry.docx')), /expands beyond/);

  const total = zipSync({ 'word/document.xml': xml(6 * 1024 * 1024), 'word/header1.xml': xml(6 * 1024 * 1024), 'word/footer1.xml': xml(6 * 1024 * 1024) });
  fs.writeFileSync(path.join(dir, 'total.docx'), total);
  await assert.rejects(extract(path.join(dir, 'total.docx')), /expands beyond/);

  const repeated = Buffer.from(zipSync({ 'word/document.xml': strToU8('<w:p><w:t>Main</w:t></w:p>'), 'word/header01.xml': strToU8('<w:p><w:t>Header</w:t></w:p>') }));
  const oldName = Buffer.from('word/header01.xml');
  const duplicate = Buffer.from('word/document.xml');
  assert.equal(oldName.length, duplicate.length);
  for (let offset = repeated.indexOf(oldName); offset >= 0; offset = repeated.indexOf(oldName, offset + duplicate.length)) duplicate.copy(repeated, offset);
  fs.writeFileSync(path.join(dir, 'duplicate.docx'), repeated);
  await assert.rejects(extract(path.join(dir, 'duplicate.docx')), /invalid Word archive entry/);
});

test('old folder caches are re-extracted so calendar zones are not lost', async (t) => {
  const notes = tmp(); const data = tmp();
  t.after(() => { rm(notes); rm(data); });
  fs.writeFileSync(path.join(notes, 'calendar.ics'), ICS);
  const original = createFolders({ dir: data }); original.load();
  const added = original.add(notes);
  await original.refresh(added.folder.id);
  const cacheFile = path.join(data, 'index', `${added.folder.id}.json`);
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  cache.version = 1;
  for (const event of cache.files['calendar.ics'].events) { delete event.timeZone; delete event.startParts; }
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  let reExtracted = 0;
  const updated = createFolders({ dir: data, extract: async (file) => { reExtracted += 1; return extract(file); } });
  updated.load();
  await updated.refresh(added.folder.id);
  assert.equal(reExtracted, 1);
  const refreshed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(refreshed.files['calendar.ics'].events[0].timeZone, 'UTC');
});

test('folders: add, count, answer from them, turn off, remove', async (t) => {
  const notes = tmp(); const data = tmp();
  t.after(() => { rm(notes); rm(data); });
  fs.mkdirSync(path.join(notes, 'week1'));
  fs.writeFileSync(path.join(notes, 'week1', 'lab.md'), '# Lab\nThe lab report is due Friday at noon on Canvas.');
  fs.writeFileSync(path.join(notes, 'groceries.txt'), 'milk eggs flour bananas');
  fs.writeFileSync(path.join(notes, 'syllabus.pdf'), makePdf(['Physics 101 grading: labs 30 percent, midterm 30 percent']));
  fs.writeFileSync(path.join(notes, 'cal.ics'), ICS);
  fs.writeFileSync(path.join(notes, 'picture.png'), 'not supported');
  fs.mkdirSync(path.join(notes, '.hidden')); fs.writeFileSync(path.join(notes, '.hidden', 'secret.txt'), 'hidden words');

  const folders = createFolders({ dir: data });
  folders.load();
  const added = folders.add(notes);
  assert.equal(added.ok, true);
  assert.equal(folders.add(notes).ok, false, 'no duplicates');
  await folders.refresh(added.folder.id);
  let [f] = folders.list();
  assert.equal(f.name, path.basename(notes));
  assert.equal(f.files, 4, 'four supported files; the png and the hidden folder do not count');
  assert.equal(f.enabled, true);
  assert.deepEqual(folders.names(), [path.basename(notes)]);
  assert.equal(folders.resolve(path.basename(notes).toUpperCase()), path.resolve(notes));

  let ctx = folders.context('when is the lab report due');
  assert.match(ctx.text, /lab report is due Friday/);
  assert.deepEqual(ctx.sources[0].file, 'week1/lab.md');
  ctx = folders.context('how is physics graded');
  assert.match(ctx.text, /labs 30 percent/);
  assert.equal(folders.context('what is the capital of france').text, '', 'nothing relevant, nothing sent');
  const cal = folders.context('what is on my calendar this week', { now: Date.UTC(2026, 9, 26, 12) });
  assert.match(cal.text, /Upcoming events/);
  assert.match(cal.text, /Lab meeting/);

  // persistence: a fresh manager reads the cache without rescanning
  const again = createFolders({ dir: data, extract: async () => { throw new Error('should not re-read unchanged files'); } });
  again.load();
  assert.match(again.context('lab report due').text, /due Friday/);
  await again.refresh(added.folder.id);
  assert.equal(again.list()[0].errors, 0, 'unchanged files came from the cache');

  folders.setEnabled(added.folder.id, false);
  assert.equal(folders.context('when is the lab report due').text, '', 'a folder that is off is never used');
  assert.deepEqual(folders.names(), []);
  folders.setEnabled(added.folder.id, true);
  await folders.refresh(added.folder.id);
  assert.match(folders.context('when is the lab report due').text, /due Friday/);
  folders.remove(added.folder.id);
  assert.equal(folders.list().length, 0);
  assert.equal(folders.context('lab report due').text, '');
});

test('caps: 200 files per folder, 2 MB per file', async (t) => {
  const notes = tmp(); const data = tmp();
  t.after(() => { rm(notes); rm(data); });
  for (let i = 0; i < 212; i += 1) fs.writeFileSync(path.join(notes, `n${String(i).padStart(3, '0')}.txt`), `note number ${i} about topic${i}`);
  fs.writeFileSync(path.join(notes, 'huge.txt'), 'x'.repeat(2 * 1024 * 1024 + 10));
  const folders = createFolders({ dir: data });
  folders.load();
  const r = folders.add(notes);
  await folders.refresh(r.folder.id);
  const [f] = folders.list();
  assert.equal(f.files, 200);
  assert.equal(f.skipped, 12);
  assert.equal(f.tooBig, 1);
});

test('folders that must not be indexed are refused', () => {
  assert.match(refuse('C:\\'), /not the whole drive/);
  assert.match(refuse(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')), /system folder/);
  assert.match(refuse('relative/path'), /picker/);
  assert.equal(refuse(os.tmpdir()), null);
});
