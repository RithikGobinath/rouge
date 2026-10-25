/* Rouge Autofill — content script
 * Runs in every frame. The top frame detects fillable forms and fills them on command from background.
 * Every frame senses PDF uploads: the PDF the user picks, the size limits the page announces and the
 * rejection messages it shows. Those facts go to background.js, which decides. No UI here — all
 * interaction lives in the Rouge ribbon.
 */
'use strict';

(() => {
  if (window.__rougeContent) return;   // injected twice (for example after the extension was reloaded)
  window.__rougeContent = true;

  const E = globalThis.RougeEvidence;
  const IS_TOP = window === window.top;
  const SCAN_DEBOUNCE_MS = 1200;
  const MAX_COPY_BYTES = 32 * 1024 * 1024;   // larger PDFs are chosen again in Rouge's own file dialog

  const send = (msg) => {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (_) { /* extension reloaded: this script is orphaned */ }
  };

  // ── Field label resolution ────────────────────────────────────────────────

  const textOf = (n) => ((n && n.textContent) || '').replace(/\s+/g, ' ').trim();
  const clean = (s) => s.replace(/\s*\*+\s*$/, '').trim();   // the "required question" star
  const GENERIC = /^(?:your answer|other(?: response)?|type here|enter text|search)$/i;

  function getLabel(el) {
    // 1. aria-labelledby is a list of ids (Google Forms writes "i1 i4"); ids that do not exist are skipped.
    const named = (el.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((id) => (id && id !== el.id ? textOf(document.getElementById(id)) : '')).filter(Boolean).join(' ');
    if (named && !GENERIC.test(named)) return clean(named);
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria && !GENERIC.test(aria)) return clean(aria);
    // 2. Associated <label for="...">
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return clean(textOf(lbl));
    }
    // 3. Wrapping <label>
    const wrap = el.closest('label');
    if (wrap) {
      const clone = wrap.cloneNode(true);
      clone.querySelectorAll('input,select,textarea').forEach((n) => n.remove());
      const t = textOf(clone);
      if (t) return clean(t);
    }
    // 4. Preceding sibling / parent text
    const parent = el.parentElement;
    if (parent) {
      const prev = el.previousElementSibling;
      if (prev && !prev.matches('input,select,textarea,button')) {
        const t = textOf(prev);
        if (t && t.length < 100 && !GENERIC.test(t)) return clean(t);
      }
      const grandparent = parent.parentElement;
      if (grandparent) {
        const sibling = Array.from(grandparent.children).find(
          (c) => c !== parent && textOf(c) && textOf(c).length < 100 && !c.matches('input,select,textarea,button')
        );
        if (sibling && !GENERIC.test(textOf(sibling))) return clean(textOf(sibling));
      }
    }
    // 5. The heading of the question or group around the field
    const box = el.closest('[role=listitem],[role=group],[role=radiogroup],fieldset');
    const head = box && box.querySelector('[role=heading],legend,h1,h2,h3,h4,h5,h6');
    if (head && !head.contains(el)) {
      const t = textOf(head);
      if (t) return clean(t);
    }
    // 6. placeholder / name / generic aria as a last resort
    return clean(el.placeholder || el.name || aria || '');
  }

  // A selector that finds this field again later: its id, else its path of positions from a unique ancestor.
  function getSelector(el) {
    const unique = (id) => document.querySelectorAll(`#${CSS.escape(id)}`).length === 1;
    if (el.id && unique(el.id)) return `#${CSS.escape(el.id)}`;
    const path = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n !== el && n.id && unique(n.id)) { path.unshift(`#${CSS.escape(n.id)}`); break; }
      const at = n.parentElement ? Array.prototype.indexOf.call(n.parentElement.children, n) + 1 : 1;
      path.unshift(`${n.tagName.toLowerCase()}:nth-child(${at})`);
    }
    return path.join('>');
  }

  function isVisible(el) {
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function scanFields() {
    const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'color', 'range']);
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'))
      .filter((el) => !SKIP_TYPES.has(el.type) && isVisible(el) && !el.disabled && !el.readOnly
        && !/^other(?: response)?$/i.test((el.getAttribute('aria-label') || '').trim()));   // the extra box on a choice question

    return inputs.slice(0, 80).map((el) => ({
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

  // ── React / Vue / Angular safe fill ───────────────────────────────────────

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
      try { el = entry.selector ? document.querySelector(entry.selector) : null; } catch (_) { /* a stale selector */ }
      if (!el) {
        // Fall back: find field whose label contains the plan label
        const labelLow = entry.label.toLowerCase();
        const fields = scanFields();
        const match = fields.find(
          (f) => f.label.toLowerCase().includes(labelLow) || labelLow.includes(f.label.toLowerCase())
        );
        if (match) {
          try { el = document.querySelector(match.selector); } catch (_) { /* a stale selector */ }
        }
      }
      if (el && fillField(el, entry.value)) filled++;
    }
    return filled;
  }

  // ── Form detection (top frame only) ───────────────────────────────────────

  let lastSig = '';
  let pageKey = location.href;

  function tryReport() {
    const fields = isRealForm();
    if (!fields) return;
    // Report again only when the questions on the page changed (the next section of a form).
    const sig = fields.map((f) => f.label).join('|');
    if (sig === lastSig) return;
    lastSig = sig;
    send({ type: 'form_detected', url: location.href, title: document.title, fields });
  }

  let debounceTimer = null;
  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (location.href !== pageKey) { lastSig = ''; pageKey = location.href; }
      tryReport();
    }, SCAN_DEBOUNCE_MS);
  }

  // ── Upload sensing (every frame) ──────────────────────────────────────────

  let picked = null;        // { file, key } the PDF most recently chosen in this frame
  let sentHints = '';

  const isPdf = (f) => f && f.size > 0 && (/\.pdf$/i.test(f.name) || f.type === 'application/pdf');

  function notePdf(file) {
    if (!isPdf(file)) return;
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (picked && picked.key === key && Date.now() - picked.at < 2000) return;   // the same pick, seen twice
    picked = { file, key, at: Date.now() };
    send({ type: 'pdf_selected', name: file.name.slice(0, 200), size: file.size, key });
    reportHintsSoon();
  }

  // The limits this frame announces ("Upload 1 supported file. Max 10 MB."). Asked for only around a pick.
  function sendHints(force) {
    const hints = E.limitHints(document.body ? document.body.innerText : '');
    const sig = hints.join(',');
    if (!hints.length && !sentHints) return;
    if (!force && sig === sentHints) return;
    sentHints = sig;
    send({ type: 'upload_hints', hints });
  }
  function reportHintsSoon() { [0, 800, 2500].forEach((ms) => setTimeout(() => sendHints(true), ms)); }

  // A pick through a file input that is on the page, or through a drop onto it.
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type === 'file') for (const f of t.files || []) notePdf(f);
  }, true);
  document.addEventListener('drop', (e) => {
    for (const f of (e.dataTransfer && e.dataTransfer.files) || []) notePdf(f);
  }, true);
  // A pick through an input the page never attached (page-hook.js passes it on).
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source === window && d && d.__rouge === 'file' && d.file) notePdf(d.file);
  });

  // Messages that appear on the page after it loaded. Static help text is not an error.
  const heard = new Map();   // text -> time, so a message that re-renders is reported once
  function consider(text, node) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length < 5 || s.length > E.MAX_TEXT) return;
    const strength = E.classify(s);
    if (!strength) return;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.getClientRects().length) return;                     // not showing
    const now = Date.now();
    if (now - (heard.get(s) || 0) < 5000) return;
    heard.set(s, now);
    if (heard.size > 200) heard.clear();
    const upload = Boolean(document.querySelector('input[type=file]') || el.closest('[role=alert],[aria-live]'));
    send({ type: 'upload_text', text: s, strength, upload });
  }

  // The text of an element if it is short, read without ever building the text of a large subtree.
  function shortText(el) {
    let out = '';
    let nodes = 0;
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      out += t.data;
      if (out.length > E.MAX_TEXT || ++nodes > 60) return '';
    }
    return out;
  }

  function scanChanges(records) {
    let budget = 400;
    for (const r of records.length > 600 ? records.slice(-600) : records) {
      if (budget <= 0) return;
      if (r.type === 'characterData') { consider(r.target.data, r.target); budget -= 1; continue; }
      if (r.type === 'attributes') {
        const t = r.target;   // a message shown by switching a style, class or the hidden flag
        const text = t.nodeType === 1 && t.childElementCount <= 5 ? shortText(t) : '';
        if (text) consider(text, t);
        budget -= 1;
        continue;
      }
      for (const n of r.addedNodes) {
        if (n.nodeType === 3) { consider(n.data, n); budget -= 1; continue; }
        if (n.nodeType !== 1) continue;
        const text = shortText(n);
        if (text) { consider(text, n); budget -= 1; continue; }
        const walk = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
        for (let t = walk.nextNode(); t && budget > 0; t = walk.nextNode(), budget -= 1) consider(t.data, t);
      }
    }
  }

  function readBase64(file) {
    return new Promise((resolve, reject) => {
      if (file.size > MAX_COPY_BYTES) { reject(new Error('too large to copy')); return; }
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  // ── Messages from background ──────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return undefined;
    if (msg.type === 'fill' && Array.isArray(msg.plan)) {
      sendResponse({ ok: true, filled: applyPlan(msg.plan) });
    } else if (msg.type === 'rescan') {
      if (IS_TOP) { lastSig = ''; tryReport(); }
      sendResponse({ ok: true });
    } else if (msg.type === 'selected') {
      sendHints(true); reportHintsSoon();   // a PDF was chosen somewhere in this tab: say which limits this frame shows
    } else if (msg.type === 'read_pdf') {
      if (!picked || picked.key !== msg.key) return undefined;   // not this frame's file: stay silent so the right frame answers
      readBase64(picked.file).then((b64) => sendResponse({ ok: true, b64 }), () => sendResponse({ ok: false }));
      return true;
    }
    return undefined;
  });

  // ── Start ─────────────────────────────────────────────────────────────────

  new MutationObserver((records) => { try { scanChanges(records); } catch (_) { /* never break the page */ } })
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });

  if (IS_TOP && document.body) {
    // Watch for new inputs added to the DOM (SPAs, multi-step forms)
    new MutationObserver((mutations) => {
      const addedInput = mutations.some((m) =>
        Array.from(m.addedNodes).some(
          (n) => n.nodeType === 1 && (n.matches?.('input,select,textarea') || n.querySelector?.('input,select,textarea'))
        )
      );
      if (addedInput) scheduleScan();
    }).observe(document.body, { childList: true, subtree: true });
    scheduleScan();
  }
})();
