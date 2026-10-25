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

// ── Available profile keys exposed to the AI fallback ──────────────────────
// These are the dot-paths Haiku can refer to. Values are resolved locally.
const PROFILE_KEY_DOCS = `
personal.firstName        - first / given name
personal.lastName         - last / family / surname
personal.name             - full name (first + last)
personal.email            - email address
personal.phone            - phone number
personal.location         - city, state or country
personal.linkedin         - LinkedIn profile URL
personal.github           - GitHub profile URL
personal.website          - personal website / portfolio URL
education.0.school        - name of university or school
education.0.degree        - degree type (e.g. Bachelor of Science)
education.0.field         - field of study / major
education.0.gpa           - GPA
education.0.endYear       - graduation year
experience.0.company      - most recent employer
experience.0.title        - most recent job title
experience.0.startDate    - start date of most recent job
`.trim();

/**
 * Resolve a dot-path against the profile object.
 * e.g. "education.0.school" → profile.education[0].school
 * @param {object} profile
 * @param {string} key
 * @returns {string|undefined}
 */
function resolvePath(profile, key) {
  const parts = key.split('.');
  let obj = profile;
  for (const p of parts) {
    if (obj == null) return undefined;
    obj = obj[p];
  }
  const v = obj == null ? undefined : String(obj).trim();
  return v || undefined;
}

/**
 * For fields that the deterministic pass missed, ask Haiku to map label → profile key.
 * Haiku never sees actual profile values — only the key schema above.
 *
 * @param {Array<{label:string, type:string, selector:string}>} unmatchedFields
 * @param {Function} aiAnswer   ai.answer(prompt, opts) → Promise<{text:string}>
 * @param {object} profile      full profileForAutofill() object
 * @returns {Promise<Array<{label:string, value:string, selector:string}>>}
 */
async function planUnmatchedWithAI(unmatchedFields, aiAnswer, profile) {
  if (!unmatchedFields.length || !aiAnswer) return [];

  const fieldList = unmatchedFields.map((f) => f.label).join(', ');
  const prompt = [
    'Map each form field label to the most appropriate profile key from the list below.',
    'Return ONLY a JSON array like [{"label":"Given Name","key":"personal.firstName"}].',
    'Use null for key if nothing fits. No prose.',
    '',
    'PROFILE KEYS:\n' + PROFILE_KEY_DOCS,
    '',
    'FORM FIELD LABELS: ' + fieldList,
    '',
    'JSON:',
  ].join('\n');

  let raw = '';
  try {
    const r = await aiAnswer(prompt, { signal: AbortSignal.timeout(12000) });
    raw = r.text || '';
  } catch (_) { return []; }

  // Parse the mapping
  let mappings = [];
  const start = raw.indexOf('['); const end = raw.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try { mappings = JSON.parse(raw.slice(start, end + 1)); } catch (_) {}
  }

  const result = [];
  for (const m of mappings) {
    if (!m || typeof m.label !== 'string' || !m.key || m.key === 'null') continue;
    const value = resolvePath(profile, m.key);
    if (!value) continue;
    const field = unmatchedFields.find((f) => f.label === m.label);
    if (field) result.push({ label: m.label, value, selector: field.selector || '' });
  }
  return result;
}

module.exports = { planFromProfile, planUnmatchedWithAI, resolvePath, PROFILE_KEY_DOCS };
