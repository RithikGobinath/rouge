/* Rouge Autofill — background service worker
 * Bridges between the content script and the Rouge desktop app via HTTP.
 * Long-polls Rouge until the user responds to the "Fill it?" popup.
 */
'use strict';

const ROUGE_BASE = 'http://127.0.0.1:7432';
const POLL_INTERVAL_MS = 600;
const MAX_WAIT_MS = 120000;   // 2 min — user has time to read the review card

// Track which tabs have an active session to avoid double-firing.
const activeTabs = new Map();  // tabId → {id, controller}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'form_detected') return;
  const tabId = sender.tab && sender.tab.id;
  if (!tabId || activeTabs.has(tabId)) return;

  handleFormDetected(tabId, msg).catch((e) => console.error('Rouge autofill:', e));
  sendResponse({ ok: true });
  return true;
});

// When the user navigates away, clear the active session.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && activeTabs.has(tabId)) {
    const session = activeTabs.get(tabId);
    session.controller.abort();
    activeTabs.delete(tabId);
  }
});

async function handleFormDetected(tabId, formInfo) {
  const controller = new AbortController();
  const signal = controller.signal;

  // 1. Report form to Rouge — returns immediately with a session id.
  let id;
  try {
    const res = await fetch(`${ROUGE_BASE}/api/form`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      const res = await fetch(`${ROUGE_BASE}/api/poll/${id}`, { signal });
      if (!res.ok) break;
      const data = await res.json();
      if (data.status === 'fill') { result = data.plan; break; }
      if (data.status === 'cancelled' || data.status === 'skip') break;
      // status === 'pending' → keep polling
    } catch (_) { break; }
  }

  activeTabs.delete(tabId);

  if (!result) return;

  // 3. Send fill plan to content script.
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'fill', plan: result });
    // Report completion back to Rouge (best effort).
    fetch(`${ROUGE_BASE}/api/done/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filled: response?.filled ?? 0 }),
    }).catch(() => {});
  } catch (_) { /* tab may have navigated away */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
