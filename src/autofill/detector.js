'use strict';
// src/autofill/detector.js
// Polls the foreground window every POLL_MS milliseconds and scores its UIA
// element tree for "formness".  When the same window scores above the threshold
// on two consecutive ticks (debounce), onFormDetected is called once.  The
// detection resets when the foreground window changes.
//
// No new timer is added when it is not running; start/stop gate the interval.

const POLL_MS = 2000;           // how often we check
const FORM_THRESHOLD = 6;       // score needed to declare a form
const DEBOUNCE_TICKS = 2;       // same window must score above threshold this many times in a row

// Patterns for Submit-like button names.
const SUBMIT_RE = /\b(?:submit|apply|sign[\s-]?up|register|continue|next|create|join|send|get\s+started)\b/i;
// Window titles that strongly suggest a form.
const TITLE_FORM_RE = /\b(?:apply|application|sign[\s-]?up|register|contact|form|enroll|enrolment|checkout|subscription)\b/i;
// Control types that count as editable fields.
const EDIT_TYPES = new Set(['Edit', 'Document', 'Custom']);

/**
 * Resolve a display label for a UIA element from the flat element list.
 * Priority: LabeledBy (by automationId reference) → Name → HelpText.
 *
 * @param {object} el       The element whose label we want.
 * @param {object[]} all    Full flat element list from uiaList.
 * @returns {string}
 */
function resolveLabel(el, all) {
  // UIA LabeledBy: the sidecar does not yet expose this relation directly.
  // Fall back to Name (already on the element) then HelpText.
  const name = String(el.name || '').trim();
  if (name && !/^edit$/i.test(name) && name.length < 120) return name;
  // Try a StaticText or Text element that immediately precedes this one in the list.
  const idx = all.indexOf(el);
  for (let i = idx - 1; i >= Math.max(0, idx - 4); i--) {
    const t = String(all[i].type || '');
    const n = String(all[i].name || '').trim();
    if ((t === 'Text' || t === 'StaticText') && n.length > 0 && n.length < 120) return n;
  }
  return name;
}

/**
 * Score a flat UIA element list for formness.
 * Returns { score, fields } where fields is an array of
 * { label, type, automationId } for all resolved editable fields.
 *
 * @param {object[]} elements
 * @param {string}   windowTitle
 * @returns {{ score:number, fields:object[] }}
 */
function scoreElements(elements, windowTitle) {
  let score = 0;
  const fields = [];

  if (TITLE_FORM_RE.test(String(windowTitle || ''))) score += 2;

  for (const el of elements) {
    const type = String(el.type || el.controlType || '');
    const name = String(el.name || '').trim();
    const isEdit = EDIT_TYPES.has(type);
    const isCombo = type === 'ComboBox';
    const isCheck = type === 'CheckBox' || type === 'RadioButton';
    const isButton = type === 'Button';

    if (isEdit) {
      const label = resolveLabel(el, elements);
      fields.push({ label, type: 'text', automationId: el.automationId || '', ref: el.id });
      score += label ? 2 : 1;
    } else if (isCombo || isCheck) {
      const label = resolveLabel(el, elements);
      fields.push({ label, type: isCombo ? 'select' : 'checkbox', automationId: el.automationId || '', ref: el.id });
      score += label ? 1 : 0;
    } else if (isButton && SUBMIT_RE.test(name)) {
      score += 3;
    }
  }

  return { score, fields };
}

/**
 * @param {{
 *   sidecar: any,
 *   onFormDetected: (info:{hwnd:number, windowTitle:string, fields:object[]}) => void,
 *   busy?: () => boolean,
 *   log?: Function,
 * }} opts
 */
function createDetector({ sidecar, onFormDetected, busy, log }) {
  const _log = log || (() => {});
  let timer = null;
  let lastHwnd = 0;
  let scoringHwnd = 0;
  let scoringTicks = 0;
  let detectedHwnd = 0;         // hwnd we already fired onFormDetected for; clear on window change

  async function tick() {
    try {
      if (busy && busy()) return;           // voice session active — skip
      const fg = await sidecar.fg();
      const hwnd = fg && fg.hwnd;
      if (!hwnd) return;

      // Window changed: reset debounce and detection state.
      if (hwnd !== lastHwnd) {
        lastHwnd = hwnd;
        scoringHwnd = 0;
        scoringTicks = 0;
        detectedHwnd = 0;
      }

      // Already fired for this window.
      if (hwnd === detectedHwnd) return;

      // Score the element tree.
      const title = (fg && fg.title) || '';
      const list = await sidecar.uiaList(hwnd, 120).catch(() => ({ elements: [] }));
      const elements = (list && list.elements) || [];
      const { score, fields } = scoreElements(elements, title);

      if (score >= FORM_THRESHOLD) {
        if (hwnd === scoringHwnd) {
          scoringTicks += 1;
        } else {
          scoringHwnd = hwnd;
          scoringTicks = 1;
        }
        if (scoringTicks >= DEBOUNCE_TICKS) {
          detectedHwnd = hwnd;
          _log(`autofill/detector: form detected in "${title}" (hwnd=${hwnd}, score=${score}, fields=${fields.length})`);
          onFormDetected({ hwnd, windowTitle: title, fields });
        }
      } else {
        // Below threshold: reset debounce counter for this window.
        scoringHwnd = 0;
        scoringTicks = 0;
      }
    } catch (e) {
      _log(`autofill/detector tick: ${e.message}`);
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, POLL_MS);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    /** Reset detection state for the current window (call after a fill is done). */
    reset() {
      detectedHwnd = 0;
      scoringHwnd = 0;
      scoringTicks = 0;
    },
    get running() { return Boolean(timer); },
  };
}

module.exports = { createDetector, scoreElements, resolveLabel };
