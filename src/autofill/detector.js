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

// Minimum number of genuine text-input Edit fields required to call something a form.
// This prevents product pages (Amazon colour pickers, quantity dropdowns) from triggering.
const MIN_EDIT_FIELDS = 2;

// Patterns for Submit-like button names.
const SUBMIT_RE = /\b(?:submit|apply|sign[\s-]?up|register|continue|next|create|join|send|get\s+started)\b/i;
// Window titles that strongly suggest a form.
const TITLE_FORM_RE = /\b(?:apply|application|sign[\s-]?up|register|contact|form|enroll|enrolment|checkout|subscription)\b/i;
// Control types that count as editable fields.
const EDIT_TYPES = new Set(['Edit', 'Document', 'Custom']);
// Browser UI element names to exclude from scoring (address bar, search bar, tab bar, etc.)
const BROWSER_UI_RE = /^(?:address\s+and\s+search\s+bar|search\s+(?:amazon|google|bing|yahoo|web|tabs|bookmarks)|address\s+bar|location\s+bar|search\s+box|search\s+bar|new\s+tab|tab\s+strip|navigation\s+bar|url\s+bar)$/i;

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

  let editCount = 0;   // track genuine text-input fields separately

  for (const el of elements) {
    const type = String(el.type || el.controlType || '');
    const name = String(el.name || '').trim();

    // Skip browser chrome elements (address bar, tab bar, site search box, etc.)
    if (BROWSER_UI_RE.test(name)) continue;
    // Skip TabItem — these are browser tabs, never form fields
    if (type === 'TabItem') continue;

    const isEdit = EDIT_TYPES.has(type);
    const isCombo = type === 'ComboBox';
    const isCheck = type === 'CheckBox' || type === 'RadioButton';
    const isButton = type === 'Button';

    if (isEdit) {
      const label = resolveLabel(el, elements);
      fields.push({ label, type: 'text', automationId: el.automationId || '', ref: el.id });
      score += label ? 2 : 1;
      editCount++;
    } else if (isCombo || isCheck) {
      const label = resolveLabel(el, elements);
      // Only score combos/checkboxes when we already have ≥1 real Edit field.
      // Prevents product pages (colour pickers, quantity dropdowns) from reaching threshold alone.
      if (editCount >= 1) {
        fields.push({ label, type: isCombo ? 'select' : 'checkbox', automationId: el.automationId || '', ref: el.id });
        score += label ? 1 : 0;
      }
    } else if (isButton && SUBMIT_RE.test(name)) {
      score += 3;
    }
  }

  // Hard gate: must have at least MIN_EDIT_FIELDS genuine text inputs.
  if (editCount < MIN_EDIT_FIELDS) return { score: 0, fields: [] };

  return { score, fields };
}

// Browser process names that need computerSnapshot to activate Chromium's accessibility tree.
const BROWSER_EXES = new Set(['chrome', 'msedge', 'firefox', 'brave', 'arc', 'opera', 'vivaldi', 'whale', 'chromium']);

/**
 * Fetch the UIA element list for a window.
 * For Chromium-based browsers use computerSnapshot (activates their accessibility tree).
 * For native apps use the lighter uiaList call.
 *
 * @param {any} sidecar
 * @param {number} hwnd
 * @param {string} [exe]  process exe name from sidecar.fg()
 * @returns {Promise<object[]>}
 */
async function getElements(sidecar, hwnd, exe) {
  const proc = String(exe || '').toLowerCase().replace(/\.exe$/i, '');
  if (BROWSER_EXES.has(proc)) {
    // computerSnapshot wakes up Chromium's accessibility — uiaList alone won't
    const snap = await sidecar.computerSnapshot(hwnd).catch(() => null);
    const elements = (snap && snap.elements) || [];
    if (snap && snap.snapshotId) sidecar.computerRelease(snap.snapshotId).catch(() => {});
    return elements;
  }
  const list = await sidecar.uiaList(hwnd, 150).catch(() => ({ elements: [] }));
  return (list && list.elements) || [];
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
  let detectedHwnd = 0;   // hwnd we already fired onFormDetected for; cleared by reset()

  // Per-window score history: hwnd -> { title, fields, hits, misses }
  // "hits" = ticks above threshold, "misses" = consecutive ticks below threshold.
  // We fire after DEBOUNCE_TICKS hits regardless of brief interruptions from
  // notification popups or other transient windows.
  const windowScores = new Map();

  async function tick() {
    try {
      if (busy && busy()) return;
      const fg = await sidecar.fg();
      const hwnd = fg && fg.hwnd;
      if (!hwnd) return;

      lastHwnd = hwnd;

      // Already fired for this window — skip until reset() is called.
      if (hwnd === detectedHwnd) return;

      // Score the element tree. Use computerSnapshot for browsers.
      const title = (fg && fg.title) || '';
      const exe = fg && (fg.exe || fg.process || '');
      const elements = await getElements(sidecar, hwnd, exe).catch((e) => { _log(`autofill/detector: element fetch failed: ${e.message}`); return []; });
      const { score, fields } = scoreElements(elements, title);

      _log(`autofill/detector: "${title}" hwnd=${hwnd} elements=${elements.length} score=${score} threshold=${FORM_THRESHOLD} types=${[...new Set(elements.map((e) => e.type))].join(',')}`);

      let entry = windowScores.get(hwnd) || { title, fields: [], hits: 0, misses: 0 };

      if (score >= FORM_THRESHOLD) {
        entry.hits += 1;
        entry.misses = 0;
        // Keep the richest fields snapshot seen so far.
        if (fields.length > entry.fields.length) { entry.title = title; entry.fields = fields; }
      } else {
        entry.misses += 1;
        // Only reset hit count if this window has been below threshold for 3+ consecutive ticks.
        // This lets brief Chrome DOM flicker or notification interruptions slide.
        if (entry.misses >= 3) { entry.hits = 0; entry.misses = 0; }
      }
      windowScores.set(hwnd, entry);

      if (entry.hits >= DEBOUNCE_TICKS) {
        detectedHwnd = hwnd;
        windowScores.delete(hwnd);
        _log(`autofill/detector: form detected in "${entry.title}" (hwnd=${hwnd}, score=${score}, fields=${entry.fields.length})`);
        onFormDetected({ hwnd, windowTitle: entry.title, fields: entry.fields });
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
      windowScores.clear();
    },
    get running() { return Boolean(timer); },
  };
}

module.exports = { createDetector, scoreElements, resolveLabel };
