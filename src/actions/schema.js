'use strict';
// The fixed set of actions, as data. Every action that is about to run, from
// the reflex grammar, from Jev, from a model's plan, or from a saved routine,
// passes through validate() first: a closed set of types, bounded fields, and
// keys that exist. Anything else is dropped, never "best-effort" executed.

const { vkOf } = require('../win/vk');
const { safeUrl } = require('./safety');
const { labelFor } = require('../voice/keys');

const str = (v, max, min = 0) => typeof v === 'string' && v.length >= min && v.length <= max;
const oneOf = (v, list) => list.includes(v);

const WINDOW_OPS = ['minimize', 'maximize', 'restore', 'close', 'show_desktop'];
const MEDIA_OPS = ['play_pause', 'next', 'prev', 'mute', 'vol_up', 'vol_down', 'volume_set'];

/** @type {Record<string, (a:any) => (string|null)>} each returns an error message, or null when fine */
const CHECK = {
  open_app: (a) => (str(a.app, 80, 1) ? null : 'open_app needs an app name'),
  open_url: (a) => (str(a.url, 2000, 1) && safeUrl(a.url) ? null : 'open_url needs an http, https, mailto or ms-settings link'),
  open_folder: (a) => (str(a.name, 120, 1) ? null : 'open_folder needs a folder name'),
  switch_to: (a) => (str(a.app, 80, 1) ? null : 'switch_to needs a name'),
  type_text: (a) => (str(a.text, 4000, 1) ? null : 'type_text needs text up to 4000 characters'),
  press_keys: (a) => (Array.isArray(a.keys) && a.keys.length >= 1 && a.keys.length <= 5 && a.keys.every((k) => typeof k === 'string' && vkOf(k) != null) ? null : 'press_keys has an unknown key'),
  window_op: (a) => (oneOf(a.op, WINDOW_OPS) ? null : 'unknown window operation'),
  media: (a) => (oneOf(a.op, MEDIA_OPS) && (a.times == null || (Number.isInteger(a.times) && a.times >= 1 && a.times <= 50)) && (a.op !== 'volume_set' || (Number.isFinite(a.level) && a.level >= 0 && a.level <= 100)) ? null : 'unknown media operation'),
  scroll: (a) => (oneOf(a.dir, ['up', 'down']) && oneOf(a.amount, ['little', 'page', 'lot', 'edge']) ? null : 'unknown scroll'),
  click: (a) => (str(a.name, 80, 1) && (a.kind == null || oneOf(a.kind, ['single', 'double', 'right'])) ? null : 'click needs the name of a control'),
  run_routine: (a) => (str(a.name == null ? '' : a.name, 80) ? null : 'bad routine name'),
  save_routine: (a) => (str(a.name == null ? '' : a.name, 80) ? null : 'bad routine name'),
  compose_email: (a) => (str(a.to == null ? '' : a.to, 200) && str(a.subject == null ? '' : a.subject, 300) && str(a.body == null ? '' : a.body, 4000) ? null : 'bad email draft'),
  wait: (a) => (Number.isFinite(a.ms) && a.ms >= 0 && a.ms <= 30000 ? null : 'wait must be 0 to 30 seconds'),
  say: (a) => (str(a.text, 600, 1) ? null : 'say needs words'),
  cancel: () => null,
};

/**
 * @param {any} action
 * @returns {{ok:true, action:object} | {ok:false, error:string}}
 */
function validate(action) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') return { ok: false, error: 'not an action' };
  const check = CHECK[action.type];
  if (!check) return { ok: false, error: `unknown action ${String(action.type).slice(0, 30)}` };
  const err = check(action);
  if (err) return { ok: false, error: err };
  const out = { ...action };
  if (action.type === 'press_keys') out.label = labelFor(action.keys);
  if (action.type === 'media') out.times = action.times || 1;
  if (action.type === 'click') out.kind = action.kind || 'single';
  return { ok: true, action: out };
}

/** Keep the valid actions of a list, and say how many were dropped. */
function validateAll(list, max = 25) {
  const actions = []; const errors = [];
  for (const a of Array.isArray(list) ? list.slice(0, max) : []) {
    const v = validate(a);
    if (v.ok) actions.push(v.action); else errors.push(v.error);
  }
  return { actions, errors };
}

module.exports = { validate, validateAll, WINDOW_OPS, MEDIA_OPS };
