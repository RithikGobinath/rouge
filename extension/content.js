/* Rouge Autofill — content script
 * Detects forms in the current page and fills them on command from background.
 * No UI here — all interaction lives in the Rouge ribbon.
 */
'use strict';

const ROUGE_PORT = 7432;
const SCAN_DEBOUNCE_MS = 1200;

// ── Field label resolution ──────────────────────────────────────────────────

function getLabel(el) {
  // 1. aria-label / aria-labelledby
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
  const lby = el.getAttribute('aria-labelledby');
  if (lby) {
    const ref = document.getElementById(lby);
    if (ref) return ref.textContent.trim();
  }
  // 2. Associated <label for="...">
  if (el.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lbl) return lbl.textContent.trim();
  }
  // 3. Wrapping <label>
  const wrap = el.closest('label');
  if (wrap) {
    const clone = wrap.cloneNode(true);
    clone.querySelectorAll('input,select,textarea').forEach((n) => n.remove());
    const t = clone.textContent.trim();
    if (t) return t;
  }
  // 4. Preceding sibling / parent text
  const parent = el.parentElement;
  if (parent) {
    const prev = el.previousElementSibling;
    if (prev && !prev.matches('input,select,textarea,button')) {
      const t = prev.textContent.trim();
      if (t && t.length < 100) return t;
    }
    // Check for a label-like element two levels up
    const grandparent = parent.parentElement;
    if (grandparent) {
      const sibling = Array.from(grandparent.children).find(
        (c) => c !== parent && c.textContent.trim().length < 100 && !c.matches('input,select,textarea,button')
      );
      if (sibling) {
        const t = sibling.textContent.trim();
        if (t) return t;
      }
    }
  }
  // 5. placeholder / name as last resort
  return el.placeholder || el.name || '';
}

function getSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.name) return `[name="${CSS.escape(el.name)}"]`;
  // Build a path from input type + index
  const type = el.tagName.toLowerCase() + (el.type ? `[type="${el.type}"]` : '');
  const siblings = Array.from(document.querySelectorAll(type));
  const idx = siblings.indexOf(el);
  return idx >= 0 ? `${type}:nth-of-type(${idx + 1})` : type;
}

function isVisible(el) {
  if (!el.offsetParent && el.tagName !== 'BODY') return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function scanFields() {
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'color', 'range']);
  const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'))
    .filter((el) => !SKIP_TYPES.has(el.type) && isVisible(el) && !el.disabled && !el.readOnly);

  return inputs.map((el) => ({
    label: getLabel(el),
    type: el.tagName === 'SELECT' ? 'select' : (el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text')),
    selector: getSelector(el),
    placeholder: el.placeholder || '',
    name: el.name || '',
    value: el.value || '',
  })).filter((f) => f.label || f.placeholder || f.name);
}

function isRealForm() {
  const fields = scanFields();
  // At least 2 fillable fields to count as a form worth offering.
  return fields.length >= 2 ? fields : null;
}

// ── React / Vue / Angular safe fill ────────────────────────────────────────

function fillField(el, value) {
  if (!el) return false;
  const tag = el.tagName;
  try {
    if (tag === 'SELECT') {
      // Find option by value or text match
      const opt = Array.from(el.options).find(
        (o) => o.value === value || o.text.toLowerCase().includes(value.toLowerCase())
      );
      if (opt) {
        el.value = opt.value;
      } else {
        return false;
      }
    } else if (el.type === 'checkbox') {
      el.checked = ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
    } else {
      // React-safe: override native setter to bypass React's value tracking
      const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (nativeSetter && nativeSetter.set) {
        nativeSetter.set.call(el, value);
      } else {
        el.value = value;
      }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  } catch (_) {
    return false;
  }
}

function applyPlan(plan) {
  let filled = 0;
  for (const entry of plan) {
    // Try by selector first, then by label text match
    let el = null;
    try { el = entry.selector ? document.querySelector(entry.selector) : null; } catch (_) {}
    if (!el) {
      // Fall back: find field whose label contains the plan label
      const labelLow = entry.label.toLowerCase();
      const fields = scanFields();
      const match = fields.find(
        (f) => f.label.toLowerCase().includes(labelLow) || labelLow.includes(f.label.toLowerCase())
      );
      if (match) {
        try { el = document.querySelector(match.selector); } catch (_) {}
      }
    }
    if (el && fillField(el, entry.value)) filled++;
  }
  return filled;
}

// ── Communication with background ──────────────────────────────────────────

let reported = false;
let pageKey = location.href;

function tryReport() {
  if (reported) return;
  const fields = isRealForm();
  if (!fields) return;
  reported = true;
  chrome.runtime.sendMessage({
    type: 'form_detected',
    url: location.href,
    title: document.title,
    fields,
  });
}

// Listen for fill command from background
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'fill' && Array.isArray(msg.plan)) {
    const filled = applyPlan(msg.plan);
    sendResponse({ ok: true, filled });
  }
  if (msg.type === 'rescan') {
    reported = false;
    tryReport();
    sendResponse({ ok: true });
  }
  return true; // keep channel open for async
});

// Initial scan + watch for dynamic forms (SPAs)
let debounceTimer = null;
function scheduleScan() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (location.href !== pageKey) { reported = false; pageKey = location.href; }
    tryReport();
  }, SCAN_DEBOUNCE_MS);
}

// Watch for new inputs added to the DOM (SPAs, multi-step forms)
const observer = new MutationObserver((mutations) => {
  const addedInput = mutations.some((m) =>
    Array.from(m.addedNodes).some(
      (n) => n.nodeType === 1 && (n.matches?.('input,select,textarea') || n.querySelector?.('input,select,textarea'))
    )
  );
  if (addedInput) scheduleScan();
});
observer.observe(document.body, { childList: true, subtree: true });

// Initial scan
scheduleScan();
