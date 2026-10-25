'use strict';
// src/profile/index.js
// Load, save, and update the user profile JSON.
//
// Storage: profile.json lives in the OS userData directory (alongside keys.json).
// Call init(dir) once from main.js before any other export is used.
// All writes are atomic (tmp + rename), matching the pattern in src/store.js.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Mutable at startup; overwritten by init().
let PROFILE_PATH = path.join(__dirname, 'profile.json');

/**
 * Point the module at the app's userData directory.
 * If no profile exists there yet, seed it from src/profile/profile.json (the
 * resume-seeded copy that ships with the repo, gitignored so data never commits).
 * @param {string} dir  app.getPath('userData')
 */
function init(dir) {
  PROFILE_PATH = path.join(dir, 'profile.json');
  if (!fs.existsSync(PROFILE_PATH)) {
    const seed = path.join(__dirname, 'profile.json');
    if (fs.existsSync(seed)) {
      try { fs.copyFileSync(seed, PROFILE_PATH); } catch (_) { /* seed unavailable, start blank */ }
    }
    if (!fs.existsSync(PROFILE_PATH)) {
      // First run with no seed: write a minimal blank profile.
      const blank = { version: 1, personal: { name: '', email: '', phone: '', location: '', linkedin: '', github: '', website: '' }, education: [], experience: [], skills: {}, projects: [], notes: [] };
      fs.writeFileSync(PROFILE_PATH, JSON.stringify(blank, null, 2), 'utf8');
    }
  }
}

/**
 * Read and parse the profile from disk.
 * Returns a plain object. Throws on IO or parse error.
 * @returns {object}
 */
function loadProfile() {
  const raw = fs.readFileSync(PROFILE_PATH, 'utf8');
  return JSON.parse(raw);
}

/**
 * Write the profile object atomically (tmp + rename).
 * @param {object} profile
 */
function saveProfile(profile) {
  const serialised = JSON.stringify(profile, null, 2);
  const tmp = path.join(os.tmpdir(), `rouge-profile-${Date.now()}.json`);
  fs.writeFileSync(tmp, serialised, 'utf8');
  fs.renameSync(tmp, PROFILE_PATH);
}

/**
 * Shallow-merge `patch` into the profile and save.
 * Arrays and nested objects in `patch` replace, not extend.
 * @param {object} patch  Top-level keys to merge.
 * @returns {object}      The updated profile.
 */
function updateProfile(patch) {
  const profile = loadProfile();
  for (const [key, value] of Object.entries(patch)) {
    profile[key] = value;
  }
  saveProfile(profile);
  return profile;
}

/**
 * Set a single nested value using a dot-path string, e.g. 'personal.email'.
 * @param {string} dotPath
 * @param {*} value
 * @returns {object} The updated profile.
 */
function setField(dotPath, value) {
  const profile = loadProfile();
  const keys = dotPath.split('.');
  let obj = profile;
  for (let i = 0; i < keys.length - 1; i++) {
    if (obj[keys[i]] == null || typeof obj[keys[i]] !== 'object') obj[keys[i]] = {};
    obj = obj[keys[i]];
  }
  obj[keys[keys.length - 1]] = value;
  saveProfile(profile);
  return profile;
}

/**
 * Append a free-form note to profile.notes and save.
 * Called when the user states something new about themselves via voice.
 * @param {string} note  Raw text from the user utterance.
 * @returns {object}     The updated profile.
 */
function appendNote(note) {
  const profile = loadProfile();
  if (!Array.isArray(profile.notes)) profile.notes = [];
  profile.notes.push({ text: String(note).trim(), addedAt: new Date().toISOString() });
  saveProfile(profile);
  return profile;
}

/**
 * Return only the fields useful for filling typical web/app forms.
 * Publications, scholarMetrics and raw notes are trimmed to keep the prompt concise.
 * @returns {object}
 */
function profileForAutofill() {
  try {
    const p = loadProfile();
    return {
      personal: p.personal || {},
      education: Array.isArray(p.education) ? p.education.slice(0, 3) : [],
      experience: Array.isArray(p.experience) ? p.experience.slice(0, 4) : [],
      skills: p.skills || {},
      projects: Array.isArray(p.projects) ? p.projects.slice(0, 4) : [],
      notes: Array.isArray(p.notes) ? p.notes.slice(-10) : [],
    };
  } catch (_) {
    return { personal: {}, education: [], experience: [], skills: {}, projects: [], notes: [] };
  }
}

// ---------- voice profile update patterns ------------------------------------

// Patterns that can be resolved locally without a model call.
// Each: [regex, handler(match) -> {path, value} | null]
const UPDATE_PATTERNS = [
  [/^my (?:new )?e[-\s]?mail (?:is|address is)\s+(.+)$/i,   (m) => ({ path: 'personal.email',    value: m[1].trim() })],
  [/^my (?:new )?phone (?:number )?(?:is|=)\s+(.+)$/i,      (m) => ({ path: 'personal.phone',    value: m[1].trim() })],
  [/^my (?:new )?name is\s+(.+)$/i,                         (m) => ({ path: 'personal.name',     value: m[1].trim() })],
  [/^my (?:new )?linkedin (?:is|url is)\s+(.+)$/i,          (m) => ({ path: 'personal.linkedin', value: m[1].trim() })],
  [/^my (?:new )?github (?:is|url is)\s+(.+)$/i,            (m) => ({ path: 'personal.github',   value: m[1].trim() })],
  [/^my (?:new )?website (?:is|url is)\s+(.+)$/i,           (m) => ({ path: 'personal.website',  value: m[1].trim() })],
  [/^my (?:new )?location (?:is|=)\s+(.+)$/i,               (m) => ({ path: 'personal.location', value: m[1].trim() })],
  [/^add (?:a )?note[:\s]+(.+)$/i,                          (m) => ({ note: m[1].trim() })],
  [/^(?:note|remember)[:\s]+(.+)$/i,                        (m) => ({ note: m[1].trim() })],
  [/^i(?:'m| am) open to\s+(.+)$/i,                        (m) => ({ note: `Open to: ${m[1].trim()}` })],
  [/^i(?:'m| am) (?:now )?(?:based|located) in\s+(.+)$/i,  (m) => ({ path: 'personal.location', value: m[1].trim() })],
];

/**
 * Try to handle a voice utterance as a profile update.
 * Returns true if handled (main loop should not forward to model).
 * Returns false if this text is not a profile update.
 *
 * @param {string} text
 * @param {Function} [notice]  Optional function(text, {tone}) for user feedback.
 * @returns {boolean}
 */
function checkUpdate(text, notice) {
  const s = String(text || '').trim();
  for (const [re, handler] of UPDATE_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    try {
      const update = handler(m);
      if (!update) continue;
      if (update.note) {
        appendNote(update.note);
        if (notice) notice(`Added to your profile notes: "${update.note}"`, { tone: 'info' });
      } else {
        setField(update.path, update.value);
        const label = update.path.split('.').pop();
        if (notice) notice(`Updated your ${label} to "${update.value}".`, { tone: 'info' });
      }
      return true;
    } catch (e) {
      if (notice) notice('Profile could not be saved.', { tone: 'error' });
      return false;
    }
  }
  return false;
}

module.exports = { init, loadProfile, saveProfile, updateProfile, setField, appendNote, profileForAutofill, checkUpdate, get PROFILE_PATH() { return PROFILE_PATH; } };
