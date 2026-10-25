'use strict';
// src/profile/index.js
// Load, save, and patch the user profile JSON.
//
// Storage: profile.json lives next to this file for now (Phase 1).
// It is .gitignored so personal data is never committed.
// Phase 2 will move this to the OS app-data directory alongside keys.json.
//
// All writes are atomic: write to a tmp file then rename, matching
// the same pattern used by src/store.js.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROFILE_PATH = path.join(__dirname, 'profile.json');

/**
 * Read and parse the profile from disk.
 * Returns a plain object. Throws on IO or JSON error.
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
 * For fine-grained mutations (e.g. push to experience[]) call
 * loadProfile(), mutate, then saveProfile() directly.
 *
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
 * Append a free-form note to profile.notes and save.
 * Called by the voice session when the user states something new
 * about themselves ("my new email is …", "I'm open to remote roles").
 *
 * @param {string} note  Raw text from the user utterance.
 * @returns {object}     The updated profile.
 */
function appendNote(note) {
  const profile = loadProfile();
  if (!Array.isArray(profile.notes)) profile.notes = [];
  profile.notes.push({ text: note, addedAt: new Date().toISOString() });
  saveProfile(profile);
  return profile;
}

/**
 * Return only the fields useful for filling typical web/app forms.
 * Publications, scholarMetrics and raw notes are excluded from the
 * fill context to keep the prompt concise.
 *
 * @returns {object}
 */
function profileForAutofill() {
  const p = loadProfile();
  return {
    personal: p.personal || {},
    education: Array.isArray(p.education) ? p.education.slice(0, 3) : [],
    experience: Array.isArray(p.experience) ? p.experience.slice(0, 4) : [],
    skills: p.skills || {},
    projects: Array.isArray(p.projects) ? p.projects.slice(0, 4) : [],
    notes: Array.isArray(p.notes) ? p.notes.slice(-10) : [],
  };
}

module.exports = { loadProfile, saveProfile, updateProfile, appendNote, profileForAutofill, PROFILE_PATH };
