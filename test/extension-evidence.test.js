'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLimitBytes, limitHints, classify, pdfNameIn, decide } = require('../extension/evidence');

test('parseLimitBytes reads the limit a message states', () => {
  assert.equal(parseLimitBytes('File too large. Maximum file size: 2 MB.'), 2_000_000);
  assert.equal(parseLimitBytes('Limit is 5 MiB'), 5 * 1048576);
  assert.equal(parseLimitBytes('Max. 500KB'), 500_000);
  assert.equal(parseLimitBytes('Up to 1.5 GB'), 1_500_000_000);
  assert.equal(parseLimitBytes('Files over 1,000 KB are rejected'), 1_000_000, 'thousands separators are not decimals');
  assert.equal(parseLimitBytes('no size here'), null);
  assert.equal(parseLimitBytes('0 MB'), null);
});

test('a decimal comma is ambiguous, so it is refused rather than guessed', () => {
  assert.equal(parseLimitBytes('Maximum 2,5 MB'), null);
});

test('with several sizes, the one worded as a limit wins over the file size', () => {
  assert.equal(parseLimitBytes('Your file (12.3 MB) exceeds the 10 MB limit'), 10_000_000);
  assert.equal(parseLimitBytes('resume.pdf is 12 MB but the maximum is 10 MB'), 10_000_000);
  assert.equal(parseLimitBytes('File too large (12.3 MB). Max is 10 MB'), 10_000_000);
  assert.equal(parseLimitBytes('12 MB or 8 MB'), null, 'two unlabeled sizes are ambiguous');
});

test('limitHints finds the limit a form announces, and nothing else', () => {
  assert.deepEqual(limitHints('Upload 1 supported file: PDF. Max 10 MB.'), [10_000_000]);
  assert.deepEqual(limitHints('Upload up to 5 files. Max 100 MB per file'), [100_000_000]);
  assert.deepEqual(limitHints('Photo: max 1 MB. Resume: up to 10 MB'), [1_000_000, 10_000_000]);
  assert.deepEqual(limitHints('Your answer\nSubmit\nThis file is 4 MB'), []);
  assert.deepEqual(limitHints(''), []);
});

test('classify tells rejection wording from help text and noise', () => {
  for (const s of [
    'File too large. Maximum file size: 2 MB.',
    'This file exceeds the maximum size of 2 MB.',
    'The file must be less than 2 MB.',
    'File too big to upload (max 2 MB).',
    'The file you selected is larger than 10 MB.',
    'File size exceeds the limit of 10 MB',
  ]) assert.equal(classify(s), 'strong', s);
  for (const s of ['Upload failed', "Couldn't upload the file", 'Maximum file size: 10 MB', 'File size limit is 2 MB.']) assert.equal(classify(s), 'weak', s);
  for (const s of ['Upload 1 supported file. Max 10 MB.', 'Required question', 'Your answer', 'Sign in to Google to save your progress', 'Add file', 'x'.repeat(500)]) assert.equal(classify(s), null, s);
});

test('wording variations a real site could use', () => {
  assert.deepEqual(limitHints('Upload 1 supported file: PDF. Max 10 MB'), [10_000_000], 'no final period');
  assert.deepEqual(limitHints('Upload 1 supported file. Max 10 MB.'), [10_000_000], 'non-breaking space');
  assert.deepEqual(limitHints('Upload up to 5 supported files. Max 1 GB per file'), [1_000_000_000]);
  for (const s of [
    'Selected file is larger than 10 MB',
    'File exceeds 10 MB limit',
    'Maximum file size exceeded',
    'The file is too large to upload',
    'Your file is over the size limit',
    'File too large (max 10 MB)',
    'Cannot upload a file larger than 10MB',
  ]) assert.equal(classify(s), 'strong', s);
  assert.equal(classify("Can't upload files over 10 MB"), 'weak');
});

test('pdfNameIn finds a quoted or bare PDF name', () => {
  assert.equal(pdfNameIn('"my resume.pdf" exceeds the maximum file size of 5 MB.'), 'my resume.pdf');
  assert.equal(pdfNameIn('resume.pdf must be less than 10 MB.'), 'resume.pdf');
  assert.equal(pdfNameIn('(resume.pdf) is too big'), 'resume.pdf');
  assert.equal(pdfNameIn('File too large'), null);
});

const pick = (size, at = 10_000) => ({ name: 'cv.pdf', size, at });
const err = (text, at = 10_500, extra = {}) => ({ text, strength: classify(text), at, ...extra });

test('decide: the form announces a limit and the PDF is over it, even with no error text', () => {
  const r = decide(pick(12_000_000), [], [10_000_000]);
  assert.deepEqual(r, { limitBytes: 10_000_000, errorText: '', why: 'size' });
});

test('decide: an explicit error after choosing the PDF, limit taken from the message', () => {
  const r = decide(pick(5_000_000), [err('File too large. Maximum file size: 2 MB.')], []);
  assert.equal(r.limitBytes, 2_000_000);
  assert.equal(r.why, 'error');
});

test('decide: an explicit error with no stated limit still reports, so Rouge can say it needs one', () => {
  const r = decide(pick(5_000_000), [err('File is too large')], []);
  assert.equal(r.limitBytes, null);
  assert.equal(r.why, 'error');
});

test('decide: a PDF that fits is never reported, whatever the page says', () => {
  assert.equal(decide(pick(1_000_000), [err('File too large. Maximum file size: 2 MB.')], []), null);
  assert.equal(decide(pick(1_000_000), [], [2_000_000]), null);
});

test('decide: help text and generic failures need a PDF that really is over the limit', () => {
  assert.equal(decide(pick(5_000_000), [err('Upload failed')], []), null, 'no limit known');
  const r = decide(pick(5_000_000), [err('Upload failed')], [2_000_000]);
  assert.equal(r.limitBytes, 2_000_000);
  assert.equal(decide(pick(1_000_000), [err('Upload failed')], [2_000_000]), null);
});

test('decide: several different announced limits are ambiguous without an error to settle it', () => {
  assert.equal(decide(pick(12_000_000), [], [1_000_000, 10_000_000]), null);
  const r = decide(pick(12_000_000), [err('File too large. Maximum file size: 10 MB.')], [1_000_000, 10_000_000]);
  assert.equal(r.limitBytes, 10_000_000);
});

test('decide: a message from before this selection is not about this file', () => {
  assert.equal(decide(pick(5_000_000, 50_000), [err('File too large. Maximum file size: 2 MB.', 10_000)], []), null);
});

test('decide: with no chosen PDF seen, only an upload widget stating its own limit counts', () => {
  assert.equal(decide(null, [err('File too large. Maximum file size: 2 MB.')], [2_000_000]), null);
  const r = decide(null, [err('File too large. Maximum file size: 2 MB.', 10_500, { upload: true })], []);
  assert.equal(r.limitBytes, 2_000_000);
  assert.equal(decide(null, [err('File is too large', 10_500, { upload: true })], []), null, 'no limit to compress to');
});
