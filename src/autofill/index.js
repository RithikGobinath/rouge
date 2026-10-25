'use strict';
// src/autofill/index.js
// Offers to fill a detected form with the user's stored profile.
// Asks via the Check-first card; if the user confirms, routes a fill
// command through the existing voice/computer pipeline with profile data
// included inline so the computer agent can map fields semantically.

/**
 * @param {{ profile:object, voice:object, log?:Function }} deps
 *   profile – the profile module ({ loadProfile, updateProfile, … })
 *   voice   – the voice session ({ ask, runText })
 *   log     – optional log function
 * @returns {{ fill: (formInfo:object) => Promise<{filled:boolean}> }}
 */
function createAutofill({ profile, voice, log }) {
  const _log = log || (() => {});

  /**
   * Offer to fill a detected form.
   * @param {{ windowTitle:string, fields:{name:string}[] }} formInfo
   * @returns {Promise<{filled:boolean}>}
   */
  async function fill(formInfo) {
    const yes = await voice.ask({
      kicker: 'Form detected',
      title: 'Fill it with your profile?',
      hint: formInfo.windowTitle || '',
    });
    if (!yes) return { filled: false };

    // Build a command that includes the profile data so the computer agent
    // can map form fields to profile values without an extra round-trip.
    let profileJson = '';
    try {
      const p = profile.loadProfile();
      // Only send fields that are useful for typical forms.
      const ctx = {
        personal: p.personal,
        education: Array.isArray(p.education) ? p.education.slice(0, 2) : [],
        experience: Array.isArray(p.experience) ? p.experience.slice(0, 3) : [],
        skills: p.skills,
      };
      profileJson = JSON.stringify(ctx);
    } catch (e) {
      _log(`autofill: could not load profile – ${e.message}`);
    }

    const title = formInfo.windowTitle || 'this form';
    const fieldList = formInfo.fields && formInfo.fields.length
      ? ` Fields visible: ${formInfo.fields.map((f) => f.name).filter(Boolean).join(', ')}.`
      : '';
    const cmd = profileJson
      ? `fill the form fields in ${title} using this profile data: ${profileJson}.${fieldList} Match field names semantically. Do NOT submit.`
      : `fill the form fields in ${title} using my profile. Do NOT submit.`;

    voice.runText(cmd).catch((e) => _log(`autofill runText: ${e.message}`));
    return { filled: true };
  }

  return { fill };
}

module.exports = { createAutofill };
