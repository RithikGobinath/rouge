'use strict';
// Feeds real synthesized speech to the real on-device recognizer, then checks
// that the live transcript turns into the right actions. Skipped off Windows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createSpeech } = require('../src/voice/speech');
const { parse } = require('../src/voice/reflex');

const skip = process.platform !== 'win32' || process.env.CLIPPY_NO_UI_TESTS === '1';

function speak(text, out) {
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fixtures', 'tts.ps1'), text, out], { stdio: 'ignore' });
}

test('the recognizer hears synthesized speech and the reflexes act on it', { skip, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-speech-'));
  const speech = createSpeech({ log: () => {} });
  t.after(async () => {
    speech.stop();
    await new Promise((r) => setTimeout(r, 500));   // let the sidecar let go of the WAV
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch (_) { /* temp files are the OS's to sweep */ }
  });
  speech.start();
  const info = await speech.init();
  if (!info.ok) { t.skip(`no speech recognizer here: ${info.error}`); return; }
  assert.match(info.recognizer, /en/i);

  const cases = [
    ['Open Notepad, then type hello.', ['open_app', 'type_text']],
    ['Press control s.', ['press_keys']],
    ['Scroll down.', ['scroll']],
  ];
  for (const [sentence, types] of cases) {
    await t.test(sentence, async () => {
      const wav = path.join(dir, `${Buffer.from(sentence).toString('hex').slice(0, 16)}.wav`);
      speak(sentence, wav);
      const updates = [];
      const off = speech.on('update', (u) => updates.push(u.kind));
      await speech.listen(wav);
      const done = await speech.finish(15000);
      off();
      assert.ok(updates.length > 0, 'the recognizer reported words');
      const clauses = parse(done.text);
      assert.deepEqual(clauses.map((c) => c.action && c.action.type), types, `heard ${JSON.stringify(done.text)}`);
    });
  }

  await t.test('words arrive before the phrase is finished', async () => {
    const wav = path.join(dir, 'long.wav');
    speak('Open notepad, then new note, then type hello world, then save', wav);
    const seen = [];
    const off = speech.on('update', (u) => seen.push({ kind: u.kind, text: u.text }));
    await speech.listen(wav);
    await speech.finish(20000);
    off();
    assert.ok(seen.some((s) => s.kind === 'hyp'), 'saw at least one live guess');
    const first = seen.find((s) => parse(s.text).some((c) => c.action && c.action.type === 'open_app'));
    assert.ok(first, 'open_app was visible in a live transcript');
  });
});
