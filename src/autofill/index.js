'use strict';
// src/autofill/index.js
// Orchestrates the autofill flow triggered by the Chrome extension:
//
//   1. Extension sends form fields via bridge POST /api/form
//   2. "Fill it?" ask card on the ribbon
//   3. Load profile → call Model A for field → value mapping
//   4. Per-field confirmation card on the ribbon
//   5. Bridge resolves the pending poll → extension fills the DOM
//
// All UI is in the Rouge overlay. The extension has no UI of its own.

const JSON_ARRAY_RE = { start: '[', end: ']' };

function parsePlan(text) {
  let s = String(text || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

/**
 * @param {{
 *   profile:  { profileForAutofill: () => object },
 *   voice:    { ask: (card:object) => Promise<boolean> },
 *   ai:       { answer: (q:string, opts?:object) => Promise<{text:string}> },
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

    // 3. Build field schema from extension-reported fields (already labelled from DOM).
    const fieldSchema = (fields || [])
      .filter((f) => f.label && f.label.trim())
      .map((f) => ({ label: f.label.trim(), type: f.type || 'text', selector: f.selector || '' }));

    _log(`autofill: fieldSchema (${fieldSchema.length}): ${JSON.stringify(fieldSchema)}`);

    if (!fieldSchema.length) {
      ui.notice('No labelled fields were found in the form.', { tone: 'info' });
      bridge.cancel(id); return;
    }

    // 4. Ask Model A (Haiku) to map fields → profile values.
    let plan = [];
    try {
      const eg = JSON.stringify([{ label: 'Email', value: 'user@example.com', selector: '#email' }]);
      const prompt = [
        'TASK: map form fields to profile values. OUTPUT: a JSON array only — no prose, no explanation, no markdown.',
        `EXAMPLE OUTPUT: ${eg}`,
        'Rules: omit any field with no confident match; never invent data; preserve exact label and selector strings.',
        '',
        `FORM FIELDS: ${JSON.stringify(fieldSchema.map((f) => ({ label: f.label, type: f.type })))}`,
        `PROFILE: ${JSON.stringify(rawProfile)}`,
        '',
        'JSON array output:',
      ].join('\n');

      ui.notice('Working out which fields to fill…', { tone: 'info' });
      const result = await ai.answer(prompt, { signal: AbortSignal.timeout(15000) });
      _log(`autofill: raw AI response: ${result.text}`);
      plan = parsePlan(result.text);
      _log(`autofill: parsed plan (${plan.length} entries): ${JSON.stringify(plan)}`);
      plan = plan.filter((e) => e && typeof e.label === 'string' && typeof e.value === 'string' && e.value.trim());

      // Re-attach selectors from fieldSchema by label match.
      plan = plan.map((e) => {
        const match = fieldSchema.find((f) => f.label.toLowerCase() === e.label.toLowerCase());
        return { ...e, selector: e.selector || (match && match.selector) || '' };
      });
    } catch (e) {
      _log(`autofill: AI plan failed: ${e.message}`);
      ui.notice('Could not build a fill plan. Please try again.', { tone: 'error' });
      bridge.cancel(id); return;
    }

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
