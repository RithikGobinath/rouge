'use strict';
// The Windows sidecar, as a typed set of calls. Coordinates are physical
// pixels; convert with Electron's screen.screenToDipPoint for the overlay.

const path = require('path');
const { createJsonlProcess } = require('./jsonl');
const { chordVks, MEDIA_VK } = require('./vk');

/**
 * @typedef {{hwnd:number, title:string, process:string, exe:string, pid:number, rect:{x:number,y:number,w:number,h:number}|null, behindSelf:boolean}} FgWindow
 * @typedef {{id:number, name:string, type:string, automationId:string, rect:{x:number,y:number,w:number,h:number}|null, pid:number}} UiaElement
 */

function createWinSidecar(opts = {}) {
  const script = opts.script || path.join(__dirname, 'sidecar.ps1');
  const ignorePid = opts.ignorePid || process.pid;
  const proc = createJsonlProcess({
    name: 'win-sidecar',
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    log: opts.log,
    spawn: opts.spawn,
    pingTimeoutMs: 30000,
  });
  const call = (op, params, ms) => proc.request(op, params, ms);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The first UI Automation walk of a window that has never been asked comes
  // back empty (Chromium and WPF build their tree on first contact), so one
  // empty answer is retried after a short wait before it is believed.
  async function warm(run, isEmpty) {
    const first = await run();
    if (!isEmpty(first)) return first;
    await sleep(450);
    return run();
  }

  // The helper watches one set of keys and clicks at a time; owners share it, and it is the union of what they ask for.
  const watchers = new Map();
  const applyWatch = () => {
    if (!watchers.size) return call('watch.stop', {});
    const all = [...watchers.values()];
    return call('watch.start', { keys: [...new Set(all.flatMap((w) => w.keys))], click: all.some((w) => w.click), fg: all.some((w) => w.fg) });
  };

  return Object.assign(proc, {
    /** @returns {Promise<FgWindow>} the window the user is working in, never one of ours */
    fg: () => call('fg', { ignorePid }),
    cursor: () => call('cursor'),
    /** @returns {Promise<{element: UiaElement|null, hwnd:number, window?:{title:string,pid:number}}>} */
    fromPoint: (x, y) => warm(() => call('uia.frompoint', { x, y, ignorePid }, 5000), (r) => !r.element && r.hwnd !== 0),
    uiaList: (hwnd, max = 150) => warm(() => call('uia.list', { hwnd, max }, 6000), (r) => r.elements.length === 0),
    uiaFind: (name, hwnd, type) => warm(() => call('uia.find', { name, hwnd, type }, 6000), (r) => !r.element),
    uiaInvoke: (name, type) => warm(() => call('uia.invoke', { name, type, ignorePid }, 8000), (r) => !r.ok),
    /** The control with keyboard focus, so typing never lands in a password box. */
    focused: () => call('uia.focused', {}, 3000),
    // Computer sessions use private, generation-scoped UIA refs; legacy voice calls keep their existing IDs.
    computerSnapshot: (hwnd = 0) => call('computer.snapshot', { hwnd, ignorePid }, 8000),
    computerDescribe: (snapshotId, ref) => call('computer.describe', { snapshotId, ref, ignorePid }, 5000),
    computerAction: (snapshotId, action) => call('computer.act', { snapshotId, ...action, ignorePid, expiresAt: Date.now() + 6500 }, 8000),
    computerRelease: (snapshotId) => call('computer.release', { snapshotId }, 3000),
    typeText: (text, delayMs = 4) => call('input.text', { text, delayMs }, 4000 + String(text).length * (delayMs + 3)),
    /** @param {string[]} keys canonical names, e.g. ['ctrl','s'] */
    chord: (keys) => call('input.chord', { vks: chordVks(keys) }),
    media: (op, count = 1) => call('input.vk', { vk: MEDIA_VK[op], count }, 3000 + count * 30),
    click: (x, y, button = 'left', double = false) => call('input.click', { x, y, button, double }),
    move: (x, y) => call('input.move', { x, y }),
    /** Tap a raw virtual key (a key no app uses, to keep a held Alt from opening a menu bar). */
    tap: (vk, count = 1) => call('input.vk', { vk, count }),
    /** Hold a chord down for `ms`, then let go. Used by the end-to-end tests to press the real hotkeys. */
    hold: (keys, ms) => call('input.hold', { vks: chordVks(keys), ms }, ms + 4000),
    windows: () => call('win.list', {}, 6000),
    focusWindow: (title, processName) => call('win.focus', { title: title || '', process: processName || '', ignorePid }, 6000),
    windowOp: (act) => call('win.op', { act, ignorePid }),
    keyState: (vks) => call('keys.state', { vks }),
    topmost: (hwnd) => call('win.topmost', { hwnd }),
    watch: (keys, click = false, fg = false, owner = 'default') => { watchers.set(owner, { keys, click, fg }); return applyWatch(); },
    unwatch: (owner = 'default') => { watchers.delete(owner); return applyWatch(); },
  });
}

module.exports = { createWinSidecar };
