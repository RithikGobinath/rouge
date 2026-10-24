'use strict';
// Does what an action says, on this PC, one at a time. It never trusts its
// input: every action is validated against the fixed set first, risky ones
// wait for a yes, and typing refuses password boxes and this app's own
// windows.

const { validate } = require('./schema');
const { classify, safeUrl } = require('./safety');
const { describe } = require('./describe');
const { SITES } = require('../voice/vocab');

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Actions that press keys. While the person is still holding the talk keys, a synthetic Ctrl-up or Alt-up
// would let go of them for the system and a typed letter would arrive as Ctrl+Alt+letter, so these wait.
const KEYBOARD = new Set(['type_text', 'press_keys', 'scroll', 'media']);
const usesKeyboard = (a) => KEYBOARD.has(a.type) || (a.type === 'window_op' && a.op === 'show_desktop');

/**
 * @typedef {Object} ExecDeps
 * @property {any} sidecar      the Windows sidecar (src/win/sidecar.js)
 * @property {{openExternal:(u:string)=>Promise<void>, openPath:(p:string)=>Promise<string>}} shell
 * @property {(file:string, args:string[]) => void} spawnDetached  starts a program, never waits for it
 * @property {any} apps         app registry
 * @property {any} [folders]    user folders (for "open my class notes folder")
 * @property {any} [routines]
 * @property {Record<string,string>} paths  Windows known folders by name
 * @property {(card:{kicker:string,title:string,hint:string}) => Promise<boolean>} ask  the Check first card
 * @property {(s:{text:string}) => void} [say]
 * @property {(ms:number)=>Promise<void>} [sleep]
 * @property {()=>number} [now]
 */

/** @param {ExecDeps} d */
function createExecutor(d) {
  const sleep = d.sleep || sleepMs;
  const now = d.now || Date.now;
  let typedAt = 0;

  async function frontWindow() { try { return await d.sidecar.fg(); } catch (_) { return null; } }

  /** Wait for the app's window to be in front (or to appear and be brought forward). */
  async function waitForApp(spec, before) {
    const t0 = now();
    const wantTitle = (spec.match && spec.match.title) || '';
    const wantProc = (spec.match && spec.match.process) || [];
    while (now() - t0 < 6000) {
      const fg = await frontWindow();
      if (fg && fg.hwnd) {
        const title = String(fg.title || '').toLowerCase(); const proc = String(fg.process || '').toLowerCase();
        const matches = (wantProc.includes(proc)) || (wantTitle && title.includes(wantTitle));
        const changed = !before || fg.hwnd !== before.hwnd;
        if (matches) { await sleep(150); return true; }
        if (!wantProc.length && !wantTitle && changed) { await sleep(500); return true; }
      }
      await sleep(120);
    }
    return false;
  }

  async function launch(spec) {
    if (spec.kind === 'exe') d.spawnDetached('cmd.exe', ['/c', 'start', '""', spec.cmd]);
    else if (spec.kind === 'uri') await d.shell.openExternal(spec.uri);
    else if (spec.kind === 'appsfolder') d.spawnDetached('explorer.exe', [`shell:AppsFolder\\${spec.id}`]);
    else throw new Error('unknown launch kind');
  }

  const handlers = {
    async open_app(a) {
      const spec = d.apps.resolve(a.app);
      if (!spec) {
        const site = SITES[String(a.app).toLowerCase()];
        if (site) { await d.shell.openExternal(site); return { ok: true, note: `No ${a.app} app here, opened the website.` }; }
        return { ok: false, note: `I couldn't find an app called ${a.app}.` };
      }
      const before = await frontWindow();
      await launch(spec);
      const seen = await waitForApp(spec, before);
      return { ok: seen, note: seen ? '' : `I couldn't bring ${spec.label} to the front.` };
    },

    async switch_to(a) {
      const r = await d.sidecar.focusWindow(a.app, a.app.replace(/\s+/g, ''));
      if (r && r.ok) { await sleep(150); return { ok: true }; }
      return handlers.open_app({ type: 'open_app', app: a.app });
    },

    async open_url(a) {
      if (!safeUrl(a.url)) return { ok: false, note: 'I only open web, mail and settings links.' };
      await d.shell.openExternal(a.url);
      return { ok: true };
    },

    async open_folder(a) {
      const name = String(a.name).toLowerCase();
      const p = d.paths[name] || (d.folders && d.folders.resolve(name));
      if (!p) return { ok: false, note: `I couldn't find a folder called ${a.name}.` };
      const err = await d.shell.openPath(p);
      return err ? { ok: false, note: `I couldn't open ${a.name}.` } : { ok: true };
    },

    async type_text(a) {
      let fg = await frontWindow();
      // Our own window has focus (the quick ask box): hand it back to the app behind it first.
      if (fg && fg.behindSelf && fg.title) { await d.sidecar.focusWindow(fg.title, ''); await sleep(180); fg = await frontWindow(); }
      if (!fg || !fg.hwnd) return { ok: false, note: 'Click where you want it typed first.' };
      let focused = null;
      try { focused = await d.sidecar.focused(); } catch (_) { /* typing is still what was asked */ }
      if (focused && focused.element && focused.element.isPassword) return { ok: false, note: "I won't type into a password box." };
      await d.sidecar.typeText(a.text);
      typedAt = now();
      return { ok: true };
    },

    async press_keys(a) { await d.sidecar.chord(a.keys); return { ok: true }; },

    async window_op(a) {
      if (a.op === 'show_desktop') { await d.sidecar.chord(['win', 'd']); return { ok: true }; }
      const r = await d.sidecar.windowOp(a.op);
      return r && r.ok ? { ok: true } : { ok: false, note: 'There is no window to do that to.' };
    },

    async media(a) {
      if (a.op === 'volume_set') {
        await d.sidecar.media('vol_down', 50);
        await d.sidecar.media('vol_up', Math.round(a.level / 2));
        return { ok: true };
      }
      await d.sidecar.media(a.op, a.times || 1);
      return { ok: true };
    },

    async scroll(a) {
      const down = a.dir === 'down';
      const key = down ? 'pagedown' : 'pageup';
      if (a.amount === 'edge') { await d.sidecar.chord(['ctrl', down ? 'end' : 'home']); return { ok: true }; }
      const reps = a.amount === 'lot' ? 3 : 1;
      for (let i = 0; i < reps; i += 1) {
        if (a.amount === 'little') { for (let k = 0; k < 4; k += 1) await d.sidecar.chord([down ? 'down' : 'up']); } else await d.sidecar.chord([key]);
        if (i < reps - 1) await sleep(90);
      }
      return { ok: true };
    },

    async click(a) {
      if (a.kind === 'single') {
        const r = await d.sidecar.uiaInvoke(a.name);
        return r && r.ok ? { ok: true } : { ok: false, note: `I couldn't find “${a.name}” on screen.` };
      }
      const f = await d.sidecar.uiaFind(a.name);
      if (!f || !f.element || f.score < 40) return { ok: false, note: `I couldn't find “${a.name}” on screen.` };
      const r = f.element.rect;
      await d.sidecar.click(Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2), a.kind === 'right' ? 'right' : 'left', a.kind === 'double');
      return { ok: true };
    },

    async compose_email(a) {
      const to = /@/.test(a.to || '') ? a.to : '';
      const q = [];
      if (a.subject) q.push(`subject=${encodeURIComponent(a.subject)}`);
      let body = a.body || '';
      if (!body && a.to && !to) body = `Hi ${a.to},\n\n`;
      if (body) q.push(`body=${encodeURIComponent(body)}`);
      await d.shell.openExternal(`mailto:${encodeURIComponent(to).replace(/%40/g, '@')}${q.length ? `?${q.join('&')}` : ''}`);
      return { ok: true };
    },

    async wait(a) { await sleep(a.ms); return { ok: true }; },
    async say(a) { if (d.say) d.say({ text: a.text }); return { ok: true }; },
    async cancel() { return { ok: true }; },
    async save_routine() { return { ok: true, deferred: 'save_routine' }; },

    async run_routine(a, ctx) {
      const routine = d.routines && d.routines.match(a.name);
      if (!routine) return { ok: false, note: a.name ? `I don't have a shortcut called ${a.name}.` : "You don't have a shortcut yet. Do a few things in a row and I'll offer to save them." };
      const out = await runAll(routine.actions, { ...ctx, nested: true });
      d.routines.touch(routine.id);
      return { ok: out.ok, note: out.ok ? `Ran ${routine.name}.` : out.note, routine: routine.name };
    },
  };

  /**
   * Run one action. Returns { ok, note?, declined? }; never throws for an
   * action that simply could not be done.
   */
  async function runOne(raw, ctx = {}) {
    const v = validate(raw);
    if (!v.ok) return { ok: false, note: 'I can only do things from my fixed list.' };
    const action = v.action;
    if (ctx.signal && ctx.signal.aborted) return { ok: false, cancelled: true };
    const fg = ['press_keys', 'click'].includes(action.type) ? await frontWindow() : null;
    const risk = classify(action, { fg: fg || undefined, typedRecently: now() - typedAt < 90000 });
    if (risk.ask) {
      const yes = await d.ask({ kicker: 'Check first', title: risk.title, hint: risk.hint });
      if (!yes) return { ok: false, declined: true, note: 'Okay, I left it.' };
    }
    if (ctx.onStep) ctx.onStep({ action, phase: 'start', label: describe(action).present });
    try {
      if (ctx.beforeKeyboard && usesKeyboard(action)) await ctx.beforeKeyboard();
      if (ctx.signal && ctx.signal.aborted) return { ok: false, cancelled: true };
      const res = await handlers[action.type](action, ctx);
      if (ctx.onStep) ctx.onStep({ action, phase: res.ok ? 'done' : 'error', label: res.ok ? describe(action).past : (res.note || 'That did not work.') });
      return res;
    } catch (e) {
      if (ctx.onStep) ctx.onStep({ action, phase: 'error', label: 'That did not work.' });
      return { ok: false, note: `That did not work: ${String(e.message || e).slice(0, 100)}` };
    }
  }

  /** Run actions in order; stop at the first one that fails, is declined, or is cancelled. */
  async function runAll(actions, ctx = {}) {
    const results = [];
    for (const a of actions) {
      if (ctx.signal && ctx.signal.aborted) return { ok: false, cancelled: true, results, note: '' };
      const r = await runOne(a, ctx);
      results.push({ action: a, ...r });
      if (!r.ok) return { ok: false, results, note: r.note || '', declined: Boolean(r.declined), cancelled: Boolean(r.cancelled) };
      await sleep(60);
    }
    return { ok: true, results, note: '' };
  }

  return { run: runOne, runAll: runAll, typedRecently: () => now() - typedAt < 90000 };
}

module.exports = { createExecutor };
