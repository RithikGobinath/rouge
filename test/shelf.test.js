'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createShelf, MAX_ITEMS } = require('../src/shelf');

function harness(over = {}) {
  const sent = []; const notices = []; const dragged = [];
  const disk = new Map([['/work/matlab/solver.m', 2048], ['/work/notes.pdf', 400000], ['/work/empty.txt', 0], ['/work/folder', 'dir']]);
  const shelf = createShelf({
    send: (items) => sent.push(items),
    notice: (text) => notices.push(text),
    stat: async (file) => {
      if (!disk.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      const size = disk.get(file);
      return { isFile: () => size !== 'dir', size: size === 'dir' ? 0 : size };
    },
    exists: (file) => disk.has(file),
    iconFor: async (file) => `icon of ${file}`,
    drag: (sender, file, icon) => dragged.push({ sender, file, icon }),
    ...over,
  });
  return { shelf, sent, notices, dragged, disk, last: () => sent[sent.length - 1] };
}

test('a dropped file is held and shown by name and size, never by path', async () => {
  const h = harness();
  assert.equal(await h.shelf.hold('/work/matlab/solver.m'), true);
  assert.deepEqual(h.last(), [{ id: 1, name: 'solver.m', size: 2048, icon: '' }]);
  assert.ok(!JSON.stringify(h.sent).includes('work'), 'the overlay never sees a folder');
});

test('the overlay gets the file icon as an image to draw, so a held file looks like the one being dragged', async () => {
  const h = harness({ iconFor: async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AAAA' }) });
  await h.shelf.hold('/work/matlab/solver.m');
  assert.equal(h.last()[0].icon, 'data:image/png;base64,AAAA');
});

test('the same file is held once, newest first, and no more than five at a time', async () => {
  const h = harness();
  await h.shelf.hold('/work/matlab/solver.m');
  await h.shelf.hold('/work/notes.pdf');
  await h.shelf.hold('/work/matlab/solver.m');
  assert.deepEqual(h.last().map((f) => f.name), ['notes.pdf', 'solver.m']);
  for (let i = 1; i <= 6; i += 1) { h.disk.set(`/work/f${i}.txt`, i * 10); await h.shelf.hold(`/work/f${i}.txt`); }
  assert.equal(h.last().length, MAX_ITEMS);
  assert.deepEqual(h.last().map((f) => f.name), ['f6.txt', 'f5.txt', 'f4.txt', 'f3.txt', 'f2.txt']);
});

test('only real files on this PC are taken, and anything else says so', async () => {
  const h = harness();
  const refused = ['relative/solver.m', '/work/missing.m', '/work/empty.txt', '/work/folder', 42, ''];
  for (const bad of refused) assert.equal(await h.shelf.hold(bad), false, String(bad));
  assert.equal(h.sent.length, 0);
  assert.equal(h.notices.length, refused.length);
  assert.ok(h.notices.every((text) => /files from this PC/.test(text)));
});

test('dragging a held file out starts the drag with its icon and lets go of it', async () => {
  const h = harness();
  await h.shelf.hold('/work/matlab/solver.m');
  const sender = { name: 'overlay' };
  assert.equal(h.shelf.drag(sender, 1), true);
  assert.deepEqual(h.dragged, [{ sender, file: '/work/matlab/solver.m', icon: 'icon of /work/matlab/solver.m' }]);
  assert.deepEqual(h.last(), []);
  assert.equal(h.shelf.drag(sender, 1), false, 'a chip that is gone cannot be dragged again');
});

test('a file that has gone since is not dragged, and its chip goes', async () => {
  const h = harness();
  await h.shelf.hold('/work/notes.pdf');
  h.disk.delete('/work/notes.pdf');
  assert.equal(h.shelf.drag({}, 1), false);
  assert.deepEqual(h.dragged, []);
  assert.deepEqual(h.last(), []);
  assert.deepEqual(h.notices, ['That file is gone.']);
});

test('a name with control or direction-switching characters is cleaned', async () => {
  const h = harness();
  const tricky = `/work/inv${String.fromCharCode(0x202e)}oice${String.fromCharCode(7)}.m`;
  h.disk.set(tricky, 10);
  await h.shelf.hold(tricky);
  assert.equal(h.last()[0].name, 'invoice.m');
});

test('a chip can be let go of, and a missing icon does not stop a file being held', async () => {
  const h = harness({ iconFor: async () => { throw new Error('no icon'); } });
  await h.shelf.hold('/work/matlab/solver.m');
  await h.shelf.hold('/work/notes.pdf');
  h.shelf.remove(1);
  assert.deepEqual(h.last().map((f) => f.name), ['notes.pdf']);
  h.shelf.drag({}, 2);
  assert.equal(h.dragged[0].icon, null, 'the app falls back to its own icon');
});
