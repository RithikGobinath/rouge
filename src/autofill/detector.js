'use strict';
// src/autofill/detector.js
// Vision-based form detector: when the foreground window changes, waits for
// the page to settle (3 s), takes a screenshot, and asks Model A (Haiku with
// vision) whether the screen shows a web form. Works for any browser, native
// app or web-based HR platform regardless of UIA accessibility tree quality.
//
// Only one screenshot is taken per new window — no continuous polling cost.
// Results are cached per hwnd so the user isn't asked twice for the same page.

const SETTLE_MS = 3000;         // wait after window change for the page to load
const CHECK_TIMEOUT_MS = 12000; // vision call timeout

// Regex to extract YES / NO from the model response.
const YES_RE = /^yes\b/i;
// Regex to pull out a comma-separated field list after YES (handles "YES.", "YES:", "YES -", etc.)
const FIELDS_RE = /yes\W+([^\n]+)/i;

/**
 * Parse field labels out of a model response like:
 *   "YES. Fields: First Name, Last Name, Email, Phone"
 * @param {string} text
 * @returns {Array<{label:string, type:string}>}
 */
function parseFields(text) {
  const m = FIELDS_RE.exec(text);
  if (!m) return [];
  return m[1]
    .split(/,\s*/)
    .map((s) => s.trim().replace(/[*_`"]/g, ''))
    .filter((s) => s.length > 0 && s.length < 80)
    .map((label) => ({ label, type: 'text' }));
}

/**
 * @param {{
 *   sidecar:  any,
 *   ai:       { explain: (o:object) => Promise<{text:string}> },
 *   capture:  () => Promise<string|null>,   data-URL JPEG of the current screen
 *   onFormDetected: (info:{hwnd:number, windowTitle:string, fields:object[]}) => void,
 *   busy?:    () => boolean,
 *   log?:     Function,
 * }} opts
 */
function createDetector({ sidecar, ai, capture, onFormDetected, busy, log }) {
  const _log = log || (() => {});
  let timer = null;
  let stableHwnd = 0;       // hwnd that has been foreground for >= SETTLE_TICKS ticks
  let stableTicks = 0;      // consecutive ticks on the same hwnd
  const checked = new Set();    // hwnds already asked
  const detectedSet = new Set();// hwnds where a form was found
  let pending = false;

  const SETTLE_TICKS = 2;   // 2 consecutive 1-second ticks = 2 s stable before we check

  async function checkWindow(hwnd, title) {
    if (checked.has(hwnd) || detectedSet.has(hwnd) || pending) return;
    if (busy && busy()) return;
    pending = true;
    checked.add(hwnd);
    try {
      const shot = await capture().catch((e) => { _log(`autofill/detector: screenshot failed: ${e.message}`); return null; });
      if (!shot) return;

      _log(`autofill/detector: vision check for "${title}" (hwnd=${hwnd})`);
      const result = await ai.explain({
        crop: shot,
        question: [
          'Does this screen show a web form or job application form with input fields to fill in (Name, Email, Phone, Address, Work History, etc.)?',
          'Reply in EXACTLY one of these two formats and nothing else:',
          'NO',
          'YES: Legal First Name, Legal Last Name, Email Address, Phone Number',
          '(replace the example labels with the actual visible field labels on screen, comma-separated)',
        ].join(' '),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      }).catch((e) => { _log(`autofill/detector: vision call failed: ${e.message}`); return null; });

      if (!result) return;
      _log(`autofill/detector: vision response for "${title}": ${result.text}`);

      const trimmed = result.text.trim();
      if (YES_RE.test(trimmed)) {
        const fields = parseFields(trimmed);
        detectedSet.add(hwnd);
        _log(`autofill/detector: form detected in "${title}" (hwnd=${hwnd}, fields=${fields.length})`);
        onFormDetected({ hwnd, windowTitle: title, fields });
      }
    } finally {
      pending = false;
    }
  }

  async function tick() {
    try {
      if (busy && busy()) return;
      const fg = await sidecar.fg();
      const hwnd = fg && fg.hwnd;
      if (!hwnd) return;

      if (hwnd === stableHwnd) {
        stableTicks++;
        // Fire vision check once the window has been stable for SETTLE_TICKS.
        if (stableTicks === SETTLE_TICKS && !checked.has(hwnd) && !detectedSet.has(hwnd)) {
          const title = (fg && fg.title) || '';
          // Skip system/transient windows that are never real forms.
          const SKIP_RE = /^(?:task switching|task view|start|search|cortana|action center|notification|overlay|rouge)$/i;
          if (SKIP_RE.test(title.trim())) { stableTicks = 0; return; }
          checkWindow(hwnd, title).catch((e) => _log(`autofill/detector: checkWindow: ${e.message}`));
        }
      } else {
        // Window changed — reset stability counter.
        stableHwnd = hwnd;
        stableTicks = 1;
      }
    } catch (e) {
      _log(`autofill/detector tick: ${e.message}`);
    }
  }

  return {
    start() { if (!timer) timer = setInterval(tick, 1000); },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    /** Call after a fill completes so the same window can be offered again if reloaded. */
    reset(hwnd) { if (hwnd) { checked.delete(hwnd); detectedSet.delete(hwnd); } else { checked.clear(); detectedSet.clear(); } },
    get running() { return Boolean(timer); },
  };
}

module.exports = { createDetector, parseFields };
