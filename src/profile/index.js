'use strict';
// src/profile/index.js
// Load, save, and patch the user profile stored at profile.json.
// All writes are atomic: write to a temp file, then rename.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROFILE_PATH = path.join(__dirname, 'profile.json');

/**
 * Read and parse the profile JSON from disk.
 * Returns the parsed object; throws on IO or JSON error.
 * @returns {object}
 */
function loadProfile() {
  const raw = fs.readFileSync(PROFILE_PATH, 'utf8');
  return JSON.parse(raw);
}

/**
 * Write the profile object to disk atomically (tmp + rename).
 * @param {object} profile
 */
function saveProfile(profile) {
  const serialised = JSON.stringify(profile, null, 2);
  const tmp = path.join(os.tmpdir(), `rouge-profile-${Date.now()}.json`);
  fs.writeFileSync(tmp, serialised, 'utf8');
  fs.renameSync(tmp, PROFILE_PATH);
}

/**
 * Merge `patch` shallowly into the profile and save.
 * Arrays and nested objects in `patch` replace, not extend.
 * For fine-grained updates (e.g. push a note) the caller should
 * loadProfile(), mutate, then saveProfile().
 *
 * @param {object} patch  Key/value pairs to merge at the top level.
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
 * Append a free-form note string to profile.notes and save.
 * Convenience wrapper used by the voice session when the user
 * says something new about themselves.
 * @param {string} note
 * @returns {object} The updated profile.
 */
function appendNote(note) {
  const profile = loadProfile();
  if (!Array.isArray(profile.notes)) profile.notes = [];
  profile.notes.push({ text: note, addedAt: new Date().toISOString() });
  saveProfile(profile);
  return profile;
}

module.exports = { loadProfile, saveProfile, updateProfile, appendNote, PROFILE_PATH };
