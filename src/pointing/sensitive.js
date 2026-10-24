'use strict';
// Fields the app must never look at: passwords, card and account numbers,
// government ids, one-time codes. This is enforced here, in code, before any
// screenshot is taken; a prompt is not a safety boundary. Only a field's kind
// and its names are read, never what is typed in it.

const policy = require('./private-fields.json');
const FIELD_KINDS = new Set(policy.fieldKinds);
const SECRET_WORDS = new Set(policy.words);
const SECRET_PHRASES = policy.phrases.map((phrase) => phrase.split(' '));

/** "cardNumber", "Card_number" and "card-number" all become ['card', 'number']. */
function words(...names) {
  return names.filter(Boolean).join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const hasPhrase = (list, phrase) => list.some((_, i) => phrase.every((w, k) => list[i + k] === w));

/** True when the control under the pointer is somewhere a secret goes. */
function sensitiveTarget(element) {
  if (!element) return false;
  if (element.isPassword) return true;                       // Windows itself says so
  const kind = String(element.type || '').toLowerCase();
  if (kind && !FIELD_KINDS.has(kind)) return false;          // a button called "Password" is not a password
  const list = words(element.name, element.label, element.automationId);
  return list.some((w) => SECRET_WORDS.has(w)) || SECRET_PHRASES.some((p) => hasPhrase(list, p));
}

module.exports = { sensitiveTarget };
