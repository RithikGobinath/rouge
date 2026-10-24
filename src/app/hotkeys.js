'use strict';
// Global hotkeys. "Hold to talk" needs to know when the keys come back up,
// which Electron's globalShortcut does not say, so the Windows sidecar watches
// the keys while they are down (and only then).

const { globalShortcut } = require('electron');
const { chordVks } = require('../win/vk');

const ALIAS = { control: 'ctrl', ctrl: 'ctrl', commandorcontrol: 'ctrl', alt: 'alt', shift: 'shift', super: 'win', meta: 'win', command: 'win', cmd: 'win',
  return: 'enter', esc: 'escape', pgup: 'pageup', pgdn: 'pagedown', pageup: 'pageup', pagedown: 'pagedown' };

/** "Control+Alt+Space" -> ['ctrl','alt','space'] */
function canonicalKeys(accelerator) {
  return String(accelerator).split('+').map((p) => { const k = p.trim().toLowerCase(); return ALIAS[k] || k; });
}

/** A chord as a person says it: "Control+Alt+Space" -> "Ctrl Alt Space". */
function spoken(accelerator) {
  return String(accelerator).split('+').map((p) => (p === 'Control' ? 'Ctrl' : p)).join(' ');
}

/** Other ways to write a chord another app already owns: add Alt, then Shift, then both. */
function alternatives(accel) {
  const parts = String(accel).split('+'); const key = parts.pop();
  const has = (m) => parts.some((p) => p.toLowerCase() === m);
  const out = [];
  if (!has('alt')) out.push([...parts, 'Alt', key].join('+'));
  if (!has('shift')) out.push([...parts, 'Shift', key].join('+'));
  if (!has('alt') || !has('shift')) out.push([...parts.filter((p) => !['alt', 'shift'].includes(p.toLowerCase())), 'Alt', 'Shift', key].join('+'));
  return [...new Set(out)];
}

const MAX_HOLD_MS = 45000;
const TAP_MS = 320;

/**
 * @param {{sidecar:any, now?:()=>number, log?:Function, register?:Function, unregister?:Function,
 *          handlers:{talkDown:()=>any, talkUp:(o:{tap:boolean})=>any, point:()=>any, toggle:()=>any, panic:()=>any}}} o
 */
function createHotkeys(o) {
  const log = o.log || (() => {});
  const reg = o.register || ((a, f) => globalShortcut.register(a, f));
  const unreg = o.unregister || ((a) => globalShortcut.unregister(a));
  const now = o.now || Date.now;
  let registered = [];
  let holding = null;     // { at, vks, off, timer }
  let used = {};          // name -> the chord that registered

  async function down(accelerator) {
    if (holding) return;                                   // key auto-repeat while held
    const vks = chordVks(canonicalKeys(accelerator));
    holding = { at: now(), vks };
    log(`talk key down (${accelerator})`);
    const finish = async () => {
      const h = holding;
      if (!h) return;
      holding = null;
      clearTimeout(h.timer);
      if (h.off) h.off();
      try { await o.sidecar.unwatch('talk'); } catch (_) { /* sidecar gone */ }
      log(`talk key up after ${now() - h.at} ms`);
      await o.handlers.talkUp({ tap: now() - h.at < TAP_MS });
    };
    holding.finish = finish;
    holding.timer = setTimeout(() => finish().catch((e) => log(`talk up: ${e.message}`)), MAX_HOLD_MS);        // a stuck key must never leave the microphone open
    try {
      holding.off = o.sidecar.on('key', (m) => { log(`key event vk=${m.vk} down=${m.down}`); if (m.down === false && vks.includes(m.vk)) finish().catch((e) => log(`talk up: ${e.message}`)); });
      await o.sidecar.watch(vks, false, false, 'talk');
      // Letting go of Alt with nothing pressed in between opens the menu bar of the app in front; an unassigned key in between prevents it.
      if (vks.includes(0x12)) o.sidecar.tap(0xE8).catch(() => {});
      // The keys may already be up again (a quick tap) before the watch began.
      const st = await o.sidecar.keyState(vks);
      log(`keys at start: ${JSON.stringify(st.keys)}`);
      if (Object.values(st.keys).some((v) => v === false)) { setTimeout(() => finish().catch((e) => log(`talk up: ${e.message}`)), 0); }
    } catch (e) {
      log(`hotkey watch: ${e.message}`);
      finish();
      return;
    }
    try { await o.handlers.talkDown(); } catch (e) { log(`talkDown: ${e.message}`); finish(); }
  }

  return {
    /** @param {{talk:string, point:string, hide:string, panic:string}} keys @returns {Record<string, boolean>} which ones took */
    register(keys, { fallback = true } = {}) {
      this.unregister();
      const table = [['talk', (a) => down(a)], ['point', () => o.handlers.point()], ['hide', () => o.handlers.toggle()], ['panic', () => o.handlers.panic()]];
      const result = {};
      used = {};
      for (const [name, fn] of table) {
        const want = keys[name];
        // Another app may already own the chord (Claude's quick entry takes Ctrl+Alt+Space): try close neighbours.
        for (const accel of [want, ...(fallback ? alternatives(want) : [])]) {
          let ok = false;
          try { ok = Boolean(reg(accel, () => fn(accel))); } catch (e) { log(`hotkey ${accel}: ${e.message}`); }
          if (ok) { registered.push(accel); used[name] = accel; break; }
        }
        result[name] = Boolean(used[name]);
      }
      return result;
    },
    /** Which chord each hotkey ended up on, after any fallback. */
    get used() { return { ...used }; },
    unregister() { for (const a of registered) { try { unreg(a); } catch (_) { /* already gone */ } } registered = []; },
    get holding() { return Boolean(holding); },
    /** Test and panic hook: end a hold now. */
    release() { return holding ? holding.finish() : undefined; },
  };
}

module.exports = { createHotkeys, canonicalKeys, alternatives, spoken, TAP_MS, MAX_HOLD_MS };
