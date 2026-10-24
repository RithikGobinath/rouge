'use strict';
// Fields the app must never look at: passwords, card and account numbers,
// government ids, one-time codes. This is enforced here, in code, before any
// screenshot is taken; a prompt is not a safety boundary. Only a field's kind
// and its names are read, never what is typed in it.

const FIELD_KINDS = new Set(['edit', 'combobox', 'textbox', 'password']);

// A field with one of these words in its name is treated as a secret. It errs
// toward refusing: a text box called "Account name" is skipped too.
const SECRET_WORDS = new Set([
  'password', 'passcode', 'passwd', 'pwd', 'pin', 'otp',
  'cvv', 'cvc', 'card', 'credit', 'debit', 'account', 'routing',
  'ssn', 'passport',
]);
// And these, as two or more words in a row.
const SECRET_PHRASES = [
  ['social', 'security'], ['national', 'id'], ['government', 'id'], ['tax', 'id'],
  ['security', 'code'], ['verification', 'code'], ['one', 'time', 'code'],
  ['driver', 'license'], ['drivers', 'license'], ['driver', 'licence'], ['drivers', 'licence'],
];

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
