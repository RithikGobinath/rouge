'use strict';
// src/autofill/index.js
// Orchestrates the full autofill flow for one detected form:
//
//   1. "Fill it?" ask card  (existing overlay mechanism)
//   2. Load profile, call Model A to produce a fill plan [{label, value}]
//   3. Per-field confirmation overlay  (new autofill:review / autofill:confirm IPC)
//   4. Execute confirmed fields via the UIA executor
//
// No phase-4 planner (deterministic label mapper) — skipped by design.

/**
 * Extract the first JSON array from a freeform model response.
 * Strips markdown fences, uses a greedy match so nested objects are preserved.
 * Returns [] if the response contains no valid JSON array.
 * @param {string} text
 * @returns {Array}
 */
function parsePlan(text) {
  let s = String(text || '');
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  s = s.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');
  // Greedy match: from first '[' to last ']' so nested objects aren't cut off.
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/**
 * @param {{
 *   profile: { profileForAutofill: () => object },
 *   voice:   { ask: (card:object) => Promise<boolean>, runText: (cmd:string) => Promise<boolean> },
 *   ai:      { answer: (q:string, opts?:object) => Promise<{text:string}> },
 *   ui:      { review: (payload:object) => Promise<Array|null>, notice: (t:string, o:object) => void },
 *   log?:    Function,
 * }} deps
 */
function createAutofill({ profile, voice, ai, ui, log }) {
  const _log = log || (() => {});

  /**
   * Run the autofill flow for a detected form.
   * @param {{ hwnd:number, windowTitle:string, fields:object[] }} formInfo
   * @returns {Promise<{filled:number}>}
   */
  async function offer(formInfo) {
    // 1. Ask the user.
    const yes = await voice.ask({
      kicker: 'Form detected',
      title: 'Fill it?',
      hint: formInfo.windowTitle || '',
    });
    if (!yes) return { filled: 0 };

    // 2. Load profile and build a fill plan via Model A.
    let rawProfile;
    try { rawProfile = profile.profileForAutofill(); } catch (e) {
      ui.notice('Your profile could not be loaded.', { tone: 'error' });
      return { filled: 0 };
    }

    const fieldSchema = (formInfo.fields || [])
      .filter((f) => f.label)
      .map((f) => ({ label: f.label, type: f.type || 'text' }));

    _log(`autofill: fieldSchema (${fieldSchema.length}): ${JSON.stringify(fieldSchema)}`);

    if (!fieldSchema.length) {
      ui.notice('No labelled fields were found in the form.', { tone: 'info' });
      return { filled: 0 };
    }

    let plan = [];
    try {
      // Use a highly directive prompt with an inline example so Haiku returns only JSON.
      // The ANSWER system prompt is conversational, so we must be very explicit.
      const eg = JSON.stringify([{ label: 'Email', value: 'user@example.com' }, { label: 'Full name', value: 'Jane Doe' }]);
      const prompt = [
        'TASK: map form fields to profile values. OUTPUT: a JSON array only — no prose, no explanation, no markdown.',
        `EXAMPLE OUTPUT: ${eg}`,
        'Rules: omit any field with no confident match; never invent data; preserve exact label strings.',
        '',
        `FORM FIELDS: ${JSON.stringify(fieldSchema)}`,
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
    } catch (e) {
      _log(`autofill: AI plan failed: ${e.message}`);
      ui.notice('Could not build a fill plan. Please try again.', { tone: 'error' });
      return { filled: 0 };
    }

    if (!plan.length) {
      ui.notice('No fields could be matched to your profile.', { tone: 'info' });
      return { filled: 0 };
    }

    // 3. Per-field confirmation overlay.
    let accepted;
    try {
      accepted = await ui.review({ fields: plan });
    } catch (e) {
      _log(`autofill: review error: ${e.message}`);
      return { filled: 0 };
    }
    if (!accepted || !accepted.length) return { filled: 0 };   // user cancelled or deselected all

    // 4. Delegate to the computer agent (Model B) via voice.runText.
    // The computer agent already knows how to activate Chrome's accessibility tree
    // and fill form fields — it is the proven path. Our custom executor is not needed.
    try {
      const fieldList = accepted.map((f) => `- ${f.label}: ${f.value}`).join('\n');
      const cmd = [
        `Use the browser on screen to fill these form fields. Match each field by its visible label.`,
        `Do NOT click Submit, Continue, or Next.\n`,
        fieldList,
      ].join('\n');
      _log(`autofill: sending fill command to computer agent:\n${cmd}`);
      voice.runText(cmd).catch((e) => _log(`autofill: runText: ${e.message}`));
      ui.notice(`Filling ${accepted.length} field${accepted.length !== 1 ? 's' : ''}…`, { tone: 'info' });
      return { filled: accepted.length };
    } catch (e) {
      _log(`autofill: fill command error: ${e.message}`);
      ui.notice('Fill did not complete. Please try again.', { tone: 'error' });
      return { filled: 0 };
    }
  }

  return { offer };
}

module.exports = { createAutofill };
