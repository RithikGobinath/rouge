'use strict';
// src/autofill/planner.js
// Deterministic field → profile value mapper.
// Handles 90%+ of common form fields without an AI call.
// Each rule: [labelRegex, valueFn(profile) -> string|undefined]

const RULES = [
  // ── Name ───────────────────────────────────────────────────────────────
  [/\bfirst\s*(?:name|given)?\b/i,             (p) => p.personal.firstName],
  [/\blast\s*(?:name|surname|family)?\b/i,     (p) => p.personal.lastName],
  [/\b(?:second|maternal)\s*last\s*name\b/i,   (p) => p.personal.lastName],
  [/\bmiddle\s*name\b/i,                       (p) => undefined],            // not in profile
  [/\b(?:full|preferred|legal\s*full)\s*name\b/i, (p) => p.personal.name],
  [/\b(?:suffix|name\s*suffix)\b/i,            (p) => undefined],
  [/^name$/i,                                  (p) => p.personal.name],

  // ── Contact ────────────────────────────────────────────────────────────
  [/\be[-\s]?mail\b/i,                         (p) => p.personal.email],
  [/\bphone\b|\bmobile\b|\bcell\b/i,           (p) => p.personal.phone],
  [/\bphone.*country\b|\bcountry.*code\b/i,    (p) => '+1'],
  [/\b(?:city|location|address)\b/i,           (p) => p.personal.location],
  [/\blinkedin\b/i,                            (p) => p.personal.linkedin],
  [/\bgithub\b/i,                              (p) => p.personal.github],
  [/\bwebsite\b|\bportfolio\b/i,               (p) => p.personal.website],
  [/\bgoogle\s*scholar\b/i,                    (p) => p.personal.googleScholar],

  // ── Education ──────────────────────────────────────────────────────────
  [/\b(?:university|school|institution|college)\b/i, (p) => p.education?.[0]?.school],
  [/\bdegree\b/i,                              (p) => p.education?.[0]?.degree],
  [/\b(?:major|field\s*of\s*study|subject)\b/i,(p) => p.education?.[0]?.field],
  [/\bgpa\b/i,                                 (p) => String(p.education?.[0]?.gpa || '')],
  [/\b(?:graduation|expected)\s*(?:year|date)?\b/i, (p) => String(p.education?.[0]?.endYear || '')],

  // ── Experience ─────────────────────────────────────────────────────────
  [/\b(?:current\s*)?(?:company|employer|organization)\b/i, (p) => p.experience?.[0]?.company],
  [/\b(?:job\s*)?(?:title|position|role)\b/i, (p) => p.experience?.[0]?.title],
  [/\bstart\s*date\b/i,                        (p) => p.experience?.[0]?.startDate],
  [/\bend\s*date\b/i,                          (p) => p.experience?.[0]?.endDate],
];

/**
 * Map a list of form fields to profile values deterministically.
 *
 * @param {Array<{label:string, type:string, selector:string}>} fields
 * @param {object} profile  output of profileForAutofill()
 * @returns {Array<{label:string, value:string, selector:string}>}  only matched entries
 */
function planFromProfile(fields, profile) {
  const plan = [];
  const used = new Set();   // prevent two fields mapping to the same rule

  for (const field of fields) {
    const label = field.label || '';
    for (let i = 0; i < RULES.length; i++) {
      if (used.has(i)) continue;
      const [re, fn] = RULES[i];
      if (!re.test(label)) continue;
      let value;
      try { value = fn(profile); } catch (_) {}
      if (value === undefined || value === null || String(value).trim() === '') continue;
      plan.push({ label, value: String(value).trim(), selector: field.selector || '' });
      used.add(i);
      break;
    }
  }

  return plan;
}

module.exports = { planFromProfile };
