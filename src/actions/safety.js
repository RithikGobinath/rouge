'use strict';
// Check first. Most voice actions are harmless (open an app, type some words),
// but a few look like they send, delete, buy or sign something. Those wait for
// a yes. This is enforced here, in code: a prompt is not a safety boundary.

const { describe, clip, titleCase } = require('./describe');

const RISKY = [
  [/\b(send|reply|reply all|forward|post|publish|tweet|share|submit|email)\b/i, 'sends something'],
  [/\b(delete|remove|erase|discard|trash|empty|wipe|clear all|uninstall|format|reset|overwrite)\b/i, 'deletes something'],
  [/\b(pay|purchase|buy|checkout|check out|place order|order now|book now|confirm booking|complete booking|reserve now|confirm reservation|donate|subscribe|confirm payment|transfer|wire|withdraw)\b|^\s*(book|reserve)\s*$/i, 'spends money'],
  [/\b(sign out|log out|logout|shut ?down|restart|turn off|power off)\b/i, 'signs out or shuts something down'],
  [/\b(install|authorize|grant|allow access|give access|enable|disable)\b/i, 'changes what this computer allows'],
];

// Windows where Enter, or Ctrl+Enter, usually sends what was just typed.
const MESSAGING = /\b(outlook|mail|gmail|slack|teams|discord|whatsapp|telegram|messenger|signal|messages|chat|inbox)\b/i;

const KEY_LABEL = (k) => (Array.isArray(k) ? k.join('+') : '');

/** @returns {{ask:boolean, reason?:string}} */
function classifyName(name) {
  const text = String(name || '');
  for (const [re, reason] of RISKY) if (re.test(text)) return { ask: true, reason };
  return { ask: false };
}

/**
 * Does this action need a yes first?
 * @param {Object} action
 * @param {{fg?: {title?: string, process?: string}, typedRecently?: boolean}} [ctx]
 * @returns {{ask:boolean, reason?:string, title?:string, hint?:string}}
 */
function classify(action, ctx = {}) {
  if (!action) return { ask: false };
  if (action.type === 'click') {
    const r = classifyName(action.name);
    return r.ask ? { ask: true, reason: r.reason, title: `Click “${clip(titleCase(action.name), 24)}”?`, hint: `This looks like it ${r.reason}.` } : { ask: false };
  }
  if (action.type === 'press_keys') {
    const k = KEY_LABEL(action.keys);
    const sends = k === 'enter' || k === 'ctrl+enter';
    const where = `${(ctx.fg && ctx.fg.title) || ''} ${(ctx.fg && ctx.fg.process) || ''}`;
    if (sends && ctx.typedRecently && MESSAGING.test(where)) {
      return { ask: true, reason: 'sends something', title: `Press ${action.label}?`, hint: 'This looks like it sends something.' };
    }
    return { ask: false };
  }
  if (action.type === 'window_op' && action.op === 'close') {
    return { ask: false };
  }
  return { ask: false };
}

/** Is a URL one the reflexes may open? Web pages, mail drafts and Settings pages, nothing that runs code. */
function safeUrl(url) {
  try {
    const u = new URL(String(url));
    return ['https:', 'http:', 'mailto:', 'ms-settings:'].includes(u.protocol);
  } catch (_) { return false; }
}

module.exports = { classify, classifyName, safeUrl, MESSAGING, describe };
