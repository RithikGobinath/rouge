'use strict';
// Detects PDF upload size-rejection errors in the foreground browser window
// using the existing Windows accessibility sidecar — same approach as
// createFormWatcher in src/calendar/watch.js. No separate native helper process.

// Matches visible error text that confirms a file-size rejection.
const SIZE_ERROR_RE = /(?:file\s+too\s+large|exceeds?\s+(?:the\s+)?(?:maximum\s+)?(?:file\s+)?size|must\s+be\s+(?:less\s+than|under)\b|file\s+size\s+limit|maximum\s+(?:file\s+)?size|too\s+big\s+to\s+upload)/i;

// Parses an explicit size limit from an error string.
const LIMIT_RE = /(\d+(?:[.,]\d+)?)\s*(B|KB|KiB|MB|MiB|GB|GiB)\b/i;

// Extracts a .pdf filename from the error message where accessible.
const PDF_NAME_RE = /(?:["']([^"'\\/:*?<>|\r\n]{1,200}\.pdf)["']|(\S{1,200}\.pdf))/i;

const REJECTION_COOLDOWN = 60_000;

/**
 * Parse a size string like "2 MB" to bytes.
 * Decimal units: 1 KB = 1000 B, 1 MB = 1 000 000 B (as used by most web sites).
 * Binary units: 1 KiB = 1024 B, 1 MiB = 1 048 576 B.
 * @param {string} text
 * @returns {number|null}
 */
function parseLimitBytes(text) {
  const m = LIMIT_RE.exec(text);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  const unit = m[2].toLowerCase();
  const factors = { b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1048576, gb: 1e9, gib: 1073741824 };
  const factor = factors[unit];
  if (!factor || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * factor);
}

/**
 * Scan a UIA element list for a visible size-rejection message.
 * Returns the first matching element's text, parsed limit and any visible filename.
 * @param {object[]} elements - UIA elements from sidecar.uiaList()
 * @returns {{ errorText:string, limitBytes:number|null, filename:string|null }|null}
 */
function detectRejection(elements) {
  for (const el of (elements || [])) {
    const text = String(el.name || '');
    // Skip long document text and strings with no size-error signal.
    if (text.length > 500 || !SIZE_ERROR_RE.test(text)) continue;
    const limitBytes = parseLimitBytes(text);
    const nameMatch = PDF_NAME_RE.exec(text);
    const filename = nameMatch ? (nameMatch[1] || nameMatch[2]) : null;
    return { errorText: text, limitBytes, filename };
  }
  return null;
}

/**
 * Create an upload rejection watcher using the existing sidecar.
 *
 * Polls the foreground browser window every pollMs ms for accessible
 * size-rejection text. Fires onRejection at most once per hwnd per
 * REJECTION_COOLDOWN. Pauses while busy() returns true.
 *
 * @param {{ sidecar:object, log?:Function, pollMs?:number,
 *           busy?:Function, onRejection?:Function }} deps
 *   sidecar     – the createWinSidecar() instance (.fg() and .uiaList())
 *   onRejection – called with { errorText, limitBytes, filename, hwnd, windowTitle }
 */
function createUploadCapture({ sidecar, log, pollMs, busy, onRejection } = {}) {
  const _log = log || (() => {});
  const _pollMs = pollMs || 2000;
  let stopped = true;
  let timer = null;
  const cooldowns = new Map();

  async function tick() {
    if (stopped) return;
    if (busy && busy()) return;
    let fg;
    try { fg = await sidecar.fg(); } catch (_) { return; }
    const hwnd = fg && fg.hwnd;
    if (!hwnd) return;
    let result;
    try { result = await sidecar.uiaList(hwnd, 200); } catch (_) { return; }
    const elements = (result && result.elements) || [];
    const rejection = detectRejection(elements);
    if (!rejection) return;
    const now = Date.now();
    const lastAt = cooldowns.get(hwnd) || -Infinity;
    if (now - lastAt < REJECTION_COOLDOWN) return;
    cooldowns.set(hwnd, now);
    // Rejection text stays out of logs; only stage/status is recorded.
    _log('upload capture: size rejection detected');
    if (onRejection) onRejection({ ...rejection, hwnd, windowTitle: (fg && fg.title) || '' });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      cooldowns.clear();
      timer = setInterval(() => { tick().catch((e) => _log(`upload capture: ${e.message}`)); }, _pollMs);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
      cooldowns.clear();
    },
  };
}

module.exports = { createUploadCapture, detectRejection, parseLimitBytes, REJECTION_COOLDOWN };
