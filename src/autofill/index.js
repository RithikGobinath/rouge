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

const JSON_ARRAY_RE = /\[[\s\S]*?\]/;

/**
 * Extract the first JSON array from a freeform model response.
 * Returns [] if the response contains no valid JSON array.
 * @param {string} text
 * @returns {Array}
 */
function parsePlan(text) {
  const m = JSON_ARRAY_RE.exec(String(text || ''));
  if (!m) return [];
  try { return JSON.parse(m[0]); } catch (_) { return []; }
}

/**
 * @param {{
 *   profile:  { profileForAutofill: () => object },
 *   voice:    { ask: (card:object) => Promise<boolean> },
 *   ai:       { answer: (q:string, opts?:object) => Promise<{text:string}> },
 *   ui:       { review: (payload:object) => Promise<Array|null>, notice: (t:string, o:object) => void },
 *   executor: { fill: (opts:object) => Promise<object> },
 *   log?:     Function,
 * }} deps
 */
function createAutofill({ profile, voice, ai, ui, executor, log }) {
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

    if (!fieldSchema.length) {
      ui.notice('No labelled fields were found in the form.', { tone: 'info' });
      return { filled: 0 };
    }

    let plan = [];
    try {
      const prompt = [
        'Map each form field to the best matching profile value.',
        'Return ONLY a JSON array — no prose, no markdown fences.',
        'Each element: {"label": "<field label>", "value": "<value to fill>"}',
        'Omit any field you cannot confidently fill. Never invent data.',
        '',
        `Form fields:\n${JSON.stringify(fieldSchema)}`,
        '',
        `Profile:\n${JSON.stringify(rawProfile)}`,
      ].join('\n');

      ui.notice('Working out which fields to fill…', { tone: 'info' });
      const result = await ai.answer(prompt, { signal: AbortSignal.timeout(15000) });
      plan = parsePlan(result.text);
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

    // 4. Execute the accepted fields.
    try {
      const { results, filled } = await executor.fill({ hwnd: formInfo.hwnd, plan: accepted });
      const failed = results.filter((r) => !r.ok);
      if (filled > 0) {
        ui.notice(`Filled ${filled} field${filled !== 1 ? 's' : ''}.${failed.length ? ` ${failed.length} could not be reached.` : ''}`, { tone: 'info' });
      } else {
        ui.notice('None of the fields could be filled. The window may have changed.', { tone: 'error' });
      }
      return { filled };
    } catch (e) {
      _log(`autofill: executor error: ${e.message}`);
      ui.notice('Fill did not complete. Please try again.', { tone: 'error' });
      return { filled: 0 };
    }
  }

  return { offer };
}

module.exports = { createAutofill };
