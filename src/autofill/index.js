'use strict';
// src/autofill/index.js
// Orchestrates the autofill flow triggered by the Chrome extension:
//
//   1. Extension sends form fields via bridge POST /api/form
//   2. "Fill it?" ask card on the ribbon
//   3. Load profile → deterministic planner maps fields → values (no AI needed)
//   4. Per-field confirmation card on the ribbon
//   5. Bridge resolves the pending poll → extension fills the DOM
//
// All UI is in the Rouge overlay. The extension has no UI of its own.

const { planFromProfile, planUnmatchedWithAI } = require('./planner');

/**
 * @param {{
 *   profile:  { profileForAutofill: () => object },
 *   voice:    { ask: (card:object) => Promise<boolean> },
 *   ai?:      { answer: (q:string, opts?:object) => Promise<{text:string}> },
 *   ui:       { review: (payload:object) => Promise<Array|null>, notice: (t:string, o:object) => void },
 *   bridge:   { sendFill: (id:string, plan:Array) => void, cancel: (id:string) => void },
 *   log?:     Function,
 * }} deps
 */
function createAutofill({ profile, voice, ai, ui, bridge, log }) {
  const _log = log || (() => {});

  /**
   * Handle a form detected by the extension.
   * @param {{ id:string, url:string, title:string, fields:object[] }} formInfo
   */
  async function offer(formInfo) {
    const { id, title, fields } = formInfo;

    // 1. "Fill it?" ask card.
    const yes = await voice.ask({
      kicker: 'Form detected',
      title: 'Fill it?',
      hint: title || formInfo.url || '',
    });
    if (!yes) { bridge.cancel(id); return; }

    // 2. Load profile.
    let rawProfile;
    try { rawProfile = profile.profileForAutofill(); } catch (e) {
      ui.notice('Your profile could not be loaded.', { tone: 'error' });
      bridge.cancel(id); return;
    }

    // 3. Build field schema — skip URL/file/document fields, cap at 12.
    const SKIP_TYPES = new Set(['url', 'file', 'color', 'range', 'hidden']);
    const SKIP_LABEL_RE = /\b(?:url|link|upload|attach|document|file|resume|cv|captcha|recaptcha|token|csrf)\b/i;
    const fieldSchema = (fields || [])
      .filter((f) => f.label && f.label.trim()
        && !SKIP_TYPES.has(f.type)
        && !SKIP_LABEL_RE.test(f.label)
        && f.label.trim().length < 80)
      .slice(0, 12)
      .map((f) => ({ label: f.label.trim(), type: f.type || 'text', selector: f.selector || '' }));

    _log(`autofill: fieldSchema (${fieldSchema.length}): ${JSON.stringify(fieldSchema)}`);

    if (!fieldSchema.length) {
      ui.notice('No labelled fields were found in the form.', { tone: 'info' });
      bridge.cancel(id); return;
    }

    // 4. Build fill plan — deterministic first, AI fallback for unrecognised labels.
    const deterministicPlan = planFromProfile(fieldSchema, rawProfile);
    const matchedLabels = new Set(deterministicPlan.map((e) => e.label));
    const unmatched = fieldSchema.filter((f) => !matchedLabels.has(f.label));

    let aiFallbackPlan = [];
    if (unmatched.length && ai) {
      _log(`autofill: ${unmatched.length} unmatched field(s), asking AI for key mapping`);
      aiFallbackPlan = await planUnmatchedWithAI(unmatched, ai.answer.bind(ai), rawProfile);
    }

    const plan = [...deterministicPlan, ...aiFallbackPlan];
    _log(`autofill: plan (${plan.length} entries, ${deterministicPlan.length} deterministic + ${aiFallbackPlan.length} AI): ${JSON.stringify(plan)}`);

    if (!plan.length) {
      ui.notice('No fields could be matched to your profile.', { tone: 'info' });
      bridge.cancel(id); return;
    }

    // 5. Per-field confirmation card.
    let accepted;
    try { accepted = await ui.review({ fields: plan }); } catch (e) {
      _log(`autofill: review error: ${e.message}`);
      bridge.cancel(id); return;
    }
    if (!accepted || !accepted.length) { bridge.cancel(id); return; }

    // 6. Send fill plan back to extension — resolves the pending poll.
    _log(`autofill: sending ${accepted.length} field(s) to extension`);
    bridge.sendFill(id, accepted);
    ui.notice(`Filling ${accepted.length} field${accepted.length !== 1 ? 's' : ''}…`, { tone: 'info' });
  }

  return { offer };
}

module.exports = { createAutofill };
