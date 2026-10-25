/* Rouge Autofill — background service worker
 * Bridges between the content scripts and the Rouge desktop app via HTTP.
 * - Forms: long-polls Rouge until the user responds to the "Fill it?" popup.
 * - PDF uploads: content scripts in every frame report what they see; this worker decides when an
 *   upload has failed and tells Rouge.
 */
'use strict';

importScripts('evidence.js');

const E = self.RougeEvidence;
const ROUGE_BASE = 'http://127.0.0.1:7432';
const VERSION = chrome.runtime.getManifest().version;
const HEADERS = { 'X-Rouge-Extension': VERSION };   // Rouge's log shows which extension version is talking
const POLL_INTERVAL_MS = 600;
const MAX_WAIT_MS = 120000;   // 2 min — user has time to read the review card
const PICK_TTL_MS = 10 * 60 * 1000;
const TEXT_TTL_MS = 5 * 60 * 1000;

console.log('[Rouge] extension', VERSION, 'ready');

// A short breadcrumb for Rouge's log: sizes and counts only, never file names or page text. When an upload
// is missed, the log then shows which step did not happen.
function trace(text) {
  fetch(`${ROUGE_BASE}/api/trace`, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'text/plain' }, body: String(text).slice(0, 300) }).catch(() => {});
}
const where = (sender) => `${sender.frameId === 0 ? 'the top frame' : 'a child frame'} of ${(() => { try { return new URL(sender.tab.url).hostname; } catch (_) { return '?'; } })()}`;

// Track which tabs have an active autofill session to avoid double-firing.
const activeTabs = new Map();  // tabId → {id, controller}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;
  const tabId = sender.tab && sender.tab.id;

  if (msg.type === 'form_detected') {
    if (!tabId || sender.frameId !== 0 || activeTabs.has(tabId)) return undefined;
    handleFormDetected(tabId, msg).catch((e) => console.error('Rouge autofill:', e));
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'pdf_selected' || msg.type === 'upload_hints' || msg.type === 'upload_text') {
    if (tabId >= 0) onUploadMessage(msg, sender);
  }
  return undefined;
});

// When the user navigates away, clear the active autofill session.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && activeTabs.has(tabId)) {
    activeTabs.get(tabId).controller.abort();
    activeTabs.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lanes.delete(tabId);
  chrome.storage.session.remove(`tab${tabId}`).catch(() => {});
});

async function handleFormDetected(tabId, formInfo) {
  const controller = new AbortController();
  const signal = controller.signal;

  // 1. Report form to Rouge — returns immediately with a session id.
  let id;
  try {
    const res = await fetch(`${ROUGE_BASE}/api/form`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: formInfo.url,
        title: formInfo.title,
        fields: formInfo.fields,
      }),
      signal,
    });
    if (!res.ok) return;
    ({ id } = await res.json());
  } catch (_) {
    return; // Rouge not running or refused
  }

  activeTabs.set(tabId, { id, controller });

  // 2. Poll for the fill plan.
  const deadline = Date.now() + MAX_WAIT_MS;
  let result = null;

  while (Date.now() < deadline && !signal.aborted) {
    await sleep(POLL_INTERVAL_MS);
    if (signal.aborted) break;
    try {
      const res = await fetch(`${ROUGE_BASE}/api/poll/${id}`, { headers: HEADERS, signal });
      if (!res.ok) break;
      const data = await res.json();
      if (data.status === 'fill') { result = data.plan; break; }
      if (data.status === 'cancelled' || data.status === 'skip') break;
      // status === 'pending' → keep polling
    } catch (_) { break; }
  }

  activeTabs.delete(tabId);

  if (!result) return;

  // 3. Send fill plan to the page's top frame, where the form was found.
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'fill', plan: result }, { frameId: 0 });
    // Report completion back to Rouge (best effort).
    fetch(`${ROUGE_BASE}/api/done/${id}`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filled: response?.filled ?? 0 }),
    }).catch(() => {});
  } catch (_) { /* tab may have navigated away */ }
}

// ── PDF upload recovery ──────────────────────────────────────────────────────
// Per tab: the PDF the user picked (and in which frame), the rejection-like messages the page showed,
// and the size limits it announces. The state sits in storage.session because this worker is stopped
// when idle, and one message is handled at a time per tab so frames cannot overwrite each other.

const lanes = new Map();   // tabId → promise chain

function inTab(tabId, work) {
  const next = (lanes.get(tabId) || Promise.resolve()).then(async () => {
    const key = `tab${tabId}`;
    const state = (await chrome.storage.session.get(key))[key] || { tab: { url: '', title: '' }, picked: null, texts: [], hints: {}, fired: '', seq: 0 };
    await work(state);
    await chrome.storage.session.set({ [key]: state });
  }).catch((e) => console.warn('[Rouge] upload state:', e.message));
  lanes.set(tabId, next);
  return next;
}

function onUploadMessage(msg, sender) {
  inTab(sender.tab.id, async (st) => {
    const now = Date.now();
    st.tab = { url: sender.tab.url || '', title: sender.tab.title || '' };
    if (msg.type === 'pdf_selected') {
      trace(`PDF chosen: ${Number(msg.size) || 0} bytes, in ${where(sender)}`);
      st.seq += 1;
      st.picked = { id: st.seq, name: String(msg.name || '').slice(0, 200), size: Number(msg.size) || 0, key: String(msg.key || ''), frameId: sender.frameId, at: now };
      st.hints = {};   // every frame says again which limits it shows
      chrome.tabs.sendMessage(sender.tab.id, { type: 'selected' }).catch(() => {});
    } else if (msg.type === 'upload_hints') {
      st.hints[sender.frameId] = (Array.isArray(msg.hints) ? msg.hints : []).filter((n) => Number.isFinite(n) && n > 0).slice(0, 8);
      trace(`limits announced in ${where(sender)}: ${st.hints[sender.frameId].join(', ') || 'none'}`);
    } else {
      trace(`${msg.strength === 'strong' ? 'rejection' : 'possible'} message seen in ${where(sender)} (${String(msg.text || '').length} characters, upload widget: ${Boolean(msg.upload)})`);
      st.texts = st.texts.filter((t) => now - t.at < TEXT_TTL_MS).slice(-19);
      st.texts.push({ text: String(msg.text || '').slice(0, E.MAX_TEXT), strength: msg.strength === 'strong' ? 'strong' : 'weak', upload: Boolean(msg.upload), at: now });
    }
    await judge(sender.tab.id, st);
  });
}

async function judge(tabId, st) {
  const picked = st.picked && Date.now() - st.picked.at < PICK_TTL_MS ? st.picked : null;
  const hints = [...new Set(Object.values(st.hints).flat())].sort((a, b) => a - b);
  const verdict = E.decide(picked, st.texts, hints);
  if (picked) {
    const line = `verdict for the chosen PDF: ${verdict ? `${verdict.why}, limit ${verdict.limitBytes}` : 'nothing to report'} (limits ${hints.join(', ') || 'none'}; ${st.texts.length} message(s))`;
    if (line !== st.lastTrace) { st.lastTrace = line; trace(line); }
  }
  if (!verdict) return;
  const once = picked ? `pick${picked.id}` : `text:${verdict.errorText}`;
  if (st.fired === once) return;
  st.fired = once;
  await reportRejection(tabId, st.tab, picked, verdict);
}

async function reportRejection(tabId, tab, picked, verdict) {
  const filename = picked ? picked.name : E.pdfNameIn(verdict.errorText);
  console.log('[Rouge] upload problem:', verdict.why, '| size', picked && picked.size, '| limit', verdict.limitBytes);

  // 1. Copy the PDF to Rouge now, while the frame that holds the file still exists.
  if (picked && verdict.limitBytes) {
    try {
      const reply = await chrome.tabs.sendMessage(tabId, { type: 'read_pdf', key: picked.key }, { frameId: picked.frameId });
      if (reply && reply.ok && reply.b64) {
        const body = await (await fetch(`data:application/pdf;base64,${reply.b64}`)).blob();
        const r = await fetch(`${ROUGE_BASE}/api/upload-file`, {
          method: 'POST',
          headers: { ...HEADERS, 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(picked.name), 'X-Filesize': String(picked.size) },
          body,
        });
        console.log('[Rouge] copied the PDF to Rouge:', r.status);
      }
    } catch (e) {
      console.warn('[Rouge] could not copy the PDF (Rouge will ask for it):', e.message);
    }
  }

  // 2. Tell Rouge, whether or not the copy worked.
  try {
    const r = await fetch(`${ROUGE_BASE}/api/upload`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: tab.url,
        title: tab.title,
        errorText: verdict.errorText,
        limitBytes: verdict.limitBytes,
        filename,
        fileSize: picked ? picked.size : null,
        why: verdict.why,
      }),
    });
    console.log('[Rouge] told Rouge:', r.status);
  } catch (e) {
    console.warn('[Rouge] Rouge did not answer (is it running?):', e.message);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
