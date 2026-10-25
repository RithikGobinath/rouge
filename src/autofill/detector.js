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
// Regex to pull out a comma-separated field list after YES.
const FIELDS_RE = /yes[^:.\n]*[:\s]+([^\n]+)/i;

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
  let lastHwnd = 0;
  const checked = new Set();    // hwnds we have already asked about
  const detectedSet = new Set();// hwnds where a form was found and popup was fired
  let pending = false;          // a screenshot + vision call is in flight

  async function checkWindow(hwnd, title) {
    if (checked.has(hwnd) || detectedSet.has(hwnd)) return;
    if (pending) return;
    pending = true;
    try {
      // Wait for the page to finish loading.
      await new Promise((r) => setTimeout(r, SETTLE_MS));

      // Confirm the user is still on this window.
      const fg2 = await sidecar.fg().catch(() => null);
      if (!fg2 || fg2.hwnd !== hwnd) { _log(`autofill/detector: window changed during settle, skipping`); return; }
      if (busy && busy()) { _log(`autofill/detector: busy, skipping`); return; }

      checked.add(hwnd);

      // Take a screenshot.
      const shot = await capture().catch((e) => { _log(`autofill/detector: screenshot failed: ${e.message}`); return null; });
      if (!shot) return;

      _log(`autofill/detector: vision check for "${title}" (hwnd=${hwnd})`);

      // Ask Model A (haiku with vision).
      const result = await ai.explain({
        crop: shot,
        question: 'Does this screen show a web form or application form with input fields for a person to fill in (like Name, Email, Phone, Address, Resume, Work Experience, etc.)? Start your answer with YES or NO. If YES, list ALL visible field labels separated by commas.',
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      }).catch((e) => { _log(`autofill/detector: vision call failed: ${e.message}`); return null; });

      if (!result) return;
      _log(`autofill/detector: vision response for "${title}": ${result.text}`);

      if (YES_RE.test(result.text.trim())) {
        const fields = parseFields(result.text);
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

      if (hwnd !== lastHwnd) {
        lastHwnd = hwnd;
        const title = (fg && fg.title) || '';
        // Fire the vision check asynchronously (doesn't block the tick).
        checkWindow(hwnd, title).catch((e) => _log(`autofill/detector: checkWindow: ${e.message}`));
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
