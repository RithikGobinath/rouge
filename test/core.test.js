'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/store');
const { createRoutines } = require('../src/routines');
const { validate, validateAll } = require('../src/actions/schema');
const { classify, classifyName, safeUrl } = require('../src/actions/safety');
const { describe } = require('../src/actions/describe');
const { parse } = require('../src/voice/reflex');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-core-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const cipher = { available: () => true, encrypt: (s) => Buffer.from(`enc:${s}`), decrypt: (b) => b.toString().replace(/^enc:/, '') };

test('settings: defaults, validated patches, persistence', (t) => {
  const dir = tmp(); t.after(() => rm(dir));
  const s = createStore({ dir, cipher });
  assert.equal(s.settings().markCorner, 'br');
  assert.equal(s.settings().strip, false);
  assert.deepEqual(s.patch({ strip: true, markCorner: 'tl' }), { ok: true });
  assert.equal(s.patch({ markCorner: 'middle' }).ok, false);
  assert.equal(s.patch({ nonsense: 1 }).ok, false);
  assert.equal(s.patch({ hotkeys: { talk: 'rm -rf' } }).ok, false);
  assert.equal(s.patch({ hotkeys: { talk: 'Control+Alt+K' } }).ok, true);
  assert.equal(s.patch({ models: { gemini: 'gemini x; drop' } }).ok, false);
  assert.equal(s.settings().hotkeys.point, 'Control+Alt+L', 'untouched hotkeys keep their defaults');
  const again = createStore({ dir, cipher });
  assert.equal(again.settings().strip, true);
  assert.equal(again.settings().hotkeys.talk, 'Control+Alt+K');
});

test('keys: encrypted on disk, never handed to a window, cleared on empty', async (t) => {
  const dir = tmp(); t.after(() => rm(dir));
  const s = createStore({ dir, cipher });
  assert.deepEqual(s.keyStatus(), { typesafe: false, gemini: false, anthropic: false, serper: false });
  const r = await s.setKeys({ gemini: 'AIzaSyExampleKey123', anthropic: 'sk-ant-example' });
  assert.equal(r.ok, true);
  assert.deepEqual(s.keyStatus(), { typesafe: false, gemini: true, anthropic: true, serper: false });
  assert.equal(s.getKey('gemini'), 'AIzaSyExampleKey123');
  const onDisk = fs.readFileSync(path.join(dir, 'keys.json'), 'utf8');
  assert.ok(!onDisk.includes('AIzaSyExampleKey123') && !onDisk.includes('sk-ant-example'), 'no plain key on disk');
  assert.ok(!JSON.stringify(s.settings()).includes('AIza'), 'settings never carry a key');
  assert.equal((await s.setKeys({ gemini: 'has a space' })).ok, false);
  assert.equal((await s.setKeys({ bogus: 'x' })).ok, false);
  await s.setKeys({ typesafe: 'tsk_abc' });
  await s.setKeys({ gemini: '' });
  assert.deepEqual(s.keyStatus(), { typesafe: true, gemini: false, anthropic: true, serper: false }, 'empty clears one and leaves the others');
  const again = createStore({ dir, cipher });
  assert.equal(again.getKey('typesafe'), '', 'nothing is readable until init() has decrypted');
  await again.init();
  assert.equal(again.getKey('typesafe'), 'tsk_abc', 'survives a restart');
  const noCipher = createStore({ dir: tmp(), cipher: { ...cipher, available: async () => false } });
  assert.equal((await noCipher.setKeys({ gemini: 'x' })).ok, false, 'no encryption, no storage');
  const slow = createStore({ dir: tmp(), cipher: { available: async () => true, encrypt: async (s) => Buffer.from(`async:${s}`), decrypt: async (b) => b.toString().replace(/^async:/, '') } });
  await slow.setKeys({ gemini: 'k1' });
  assert.equal(slow.getKey('gemini'), 'k1', 'an asynchronous cipher works the same');
});

test('actions: a closed set, bounded fields, real keys only', () => {
  assert.equal(validate({ type: 'open_app', app: 'notepad' }).ok, true);
  assert.equal(validate({ type: 'press_keys', keys: ['ctrl', 's'] }).action.label, 'Ctrl+S');
  for (const bad of [
    null, 'open_app', { type: 'format_disk' }, { type: 'open_app', app: '' }, { type: 'press_keys', keys: ['ctrl', 'banana'] },
    { type: 'press_keys', keys: [] }, { type: 'open_url', url: 'file:///C:/Windows/system.ini' }, { type: 'open_url', url: 'javascript:alert(1)' },
    { type: 'type_text', text: 'x'.repeat(4001) }, { type: 'media', op: 'volume_set', level: 500 }, { type: 'wait', ms: 99999 },
  ]) assert.equal(validate(bad).ok, false, JSON.stringify(bad));
  assert.equal(validate({ type: 'open_url', url: 'https://example.com/a?b=c' }).ok, true);
  assert.equal(validate({ type: 'open_url', url: 'mailto:sam@example.com?subject=hi' }).ok, true);
  const { actions, errors } = validateAll([{ type: 'open_app', app: 'a' }, { type: 'nope' }, { type: 'type_text', text: 'hi' }]);
  assert.equal(actions.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(safeUrl('ms-settings:network'), true);
  assert.equal(safeUrl('ftp://x'), false);
});

test('ask first: sends, deletes and buys wait for a yes; the rest do not', () => {
  assert.equal(classifyName('Send').ask, true);
  assert.equal(classifyName('Delete account').reason, 'deletes something');
  assert.equal(classifyName('Place order').reason, 'spends money');
  assert.equal(classifyName('Save draft').ask, false);
  assert.equal(classifyName('Cancel').ask, false);
  const c = classify({ type: 'click', name: 'Send', kind: 'single' });
  assert.deepEqual([c.ask, c.title, c.hint], [true, 'Click “Send”?', 'This looks like it sends something.']);
  assert.equal(classify({ type: 'click', name: 'Open', kind: 'single' }).ask, false);
  assert.equal(classify({ type: 'open_app', app: 'notepad' }).ask, false);
  const enter = { type: 'press_keys', keys: ['enter'], label: 'Enter' };
  assert.equal(classify(enter, { fg: { title: 'Inbox - Outlook', process: 'olk' }, typedRecently: true }).ask, true, 'Enter after typing in a mail window sends');
  assert.equal(classify(enter, { fg: { title: 'Inbox - Outlook', process: 'olk' }, typedRecently: false }).ask, false);
  assert.equal(classify(enter, { fg: { title: 'Untitled - Notepad', process: 'notepad' }, typedRecently: true }).ask, false);
  const del = { type: 'press_keys', keys: ['delete'], label: 'Delete' };
  assert.equal(classify(del, { fg: { title: 'Documents', process: 'explorer' } }).ask, true, 'Delete in Explorer asks first');
  assert.equal(classify(del, { fg: { title: 'Untitled - Notepad', process: 'notepad' } }).ask, false);
});

test('routines: save, find by name, newest by default, rename, remove', (t) => {
  const dir = tmp(); t.after(() => rm(dir));
  const file = path.join(dir, 'routines.json');
  const r = createRoutines({ file });
  const clauses = parse('open notepad then new note then type hello');
  const actions = clauses.map((c) => c.action);
  const saved = r.save({ name: '', actions });
  assert.equal(saved.ok, true);
  assert.equal(saved.routine.name, 'Opening notepad, Typing “hello”'.replace('Opening notepad', 'Opening Notepad'));
  assert.equal(r.list()[0].steps.length, 3);
  assert.equal(r.save({ name: '', actions: [{ type: 'cancel' }] }).ok, false, 'nothing runnable, nothing kept');
  assert.equal(r.save({ name: 'x', actions: [{ type: 'wait', ms: 1000 }] }).ok, false, 'a wait alone is not a routine');
  const morning = r.save({ name: 'Morning setup', actions: [{ type: 'open_app', app: 'calculator' }] }).routine;
  assert.equal(r.match('').id, morning.id, '"run my routine" is the newest');
  assert.equal(r.match('morning').id, morning.id);
  assert.equal(r.match('notepad').id, saved.routine.id);
  assert.equal(r.match('quantum'), null);
  assert.equal(r.rename(morning.id, 'Study time').ok, true);
  assert.equal(r.match('study').id, morning.id);
  r.touch(morning.id);
  assert.equal(r.get(morning.id).runs, 1);
  const dupe = r.save({ name: 'Study time', actions: [{ type: 'open_app', app: 'paint' }] }).routine;
  assert.notEqual(dupe.name, 'Study time', 'names stay distinct');
  const reread = createRoutines({ file });
  assert.equal(reread.list().length, 3, 'survives a restart');
  reread.remove(morning.id);
  assert.equal(reread.list().length, 2);
  fs.writeFileSync(file, JSON.stringify({ routines: [{ id: 'z', name: 'bad', actions: [{ type: 'format_disk' }] }] }));
  assert.equal(createRoutines({ file }).list().length, 0, 'a tampered file cannot smuggle in an unknown action');
});

test('describe: one line for the strip, one for a routine step', () => {
  assert.equal(describe({ type: 'open_app', app: 'notepad' }).present, 'Opening Notepad');
  assert.equal(describe({ type: 'type_text', text: 'hello' }).present, 'Typing “hello”');
  assert.equal(describe({ type: 'press_keys', keys: ['ctrl', 's'], label: 'Ctrl+S' }).present, 'Pressing Ctrl+S');
  assert.equal(describe({ type: 'press_keys', keys: ['win', 'shift', 's'], label: 'Win+Shift+S' }).present, 'Taking a screenshot');
  assert.equal(describe({ type: 'click', name: 'Send' }).present, 'Clicking “Send”');
  assert.equal(describe({ type: 'open_url', url: 'https://www.google.com/search?q=cats', label: 'google: cats' }).present, 'Searching Google for “cats”');
  assert.equal(describe({ type: 'media', op: 'volume_set', level: 40 }).present, 'Setting the volume to 40%');
});
