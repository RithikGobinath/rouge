'use strict';
// src/autofill/executor.js
// Fills a confirmed fill plan into a given window using the sidecar's
// computer snapshot/act cycle (same path the computer agent uses).
//
// The `fill` action in computer.act uses ValuePattern.SetValue for native
// controls and keyboard input as a fallback — no mouse movement, no focus
// stealing, works on background windows.

const MATCH_THRESHOLD = 0.2;    // minimum label similarity to accept a match

/**
 * Normalise a label for comparison: lower-case, remove punctuation.
 * @param {string} s
 * @returns {string}
 */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Simple overlap score between two normalised label strings.
 * Returns 0..1 (1 = identical).
 */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Word overlap.
  const wa = new Set(a.split(' ').filter((w) => w.length > 1));
  const wb = new Set(b.split(' ').filter((w) => w.length > 1));
  if (!wa.size || !wb.size) return a.includes(b) || b.includes(a) ? 0.6 : 0;
  let shared = 0; for (const w of wa) if (wb.has(w)) shared++;
  return (2 * shared) / (wa.size + wb.size);
}

/**
 * Match fill plan labels to snapshot elements.
 * Returns an array of { label, value, ref, score } for matched pairs.
 *
 * @param {Array<{label:string, value:string}>} plan
 * @param {object[]} elements  Snapshot elements from sidecar.computerSnapshot().
 */
function matchToRefs(plan, elements) {
  const results = [];
  const used = new Set();

  for (const entry of plan) {
    const planNorm = norm(entry.label);
    let best = null; let bestScore = 0;

    for (const el of elements) {
      if (used.has(el.ref)) continue;
      const elNorm = norm(el.name);
      const score = similarity(planNorm, elNorm);
      if (score > bestScore) { best = el; bestScore = score; }
    }

    if (best && bestScore >= MATCH_THRESHOLD) {
      used.add(best.ref);
      results.push({ label: entry.label, value: entry.value, ref: best.ref, elName: best.name, score: bestScore });
    } else {
      // Fallback: try matching by automationId (e.g. field named "email" → plan label "Email")
      const autoIdMatch = elements.find((el) => !used.has(el.ref) && el.automationId && norm(el.automationId).split(/[-_\s]/).some((w) => w.length > 2 && planNorm.includes(w)));
      if (autoIdMatch) {
        used.add(autoIdMatch.ref);
        results.push({ label: entry.label, value: entry.value, ref: autoIdMatch.ref, elName: autoIdMatch.name, score: 0.3 });
      } else {
        results.push({ label: entry.label, value: entry.value, ref: null, score: bestScore, skipped: true });
      }
    }
  }

  return results;
}

/**
 * @param {{sidecar:any, log?:Function}} opts
 */
function createExecutor({ sidecar, log }) {
  const _log = log || (() => {});

  /**
   * Fill confirmed fields into a window.
   *
   * @param {{
   *   hwnd: number,
   *   plan: Array<{label:string, value:string}>,
   * }} opts
   * @returns {Promise<{results: Array<{label:string, ok:boolean, error?:string}>, filled:number}>}
   */
  async function fill({ hwnd, windowTitle, plan }) {
    if (!plan || !plan.length) return { results: [], filled: 0 };

    // Bring the target window to the foreground — the review overlay stole focus,
    // and computerSnapshot needs the window to be active to read Chrome's accessibility tree.
    try {
      await sidecar.topmost(hwnd);
      if (windowTitle) await sidecar.focusWindow(windowTitle, '').catch(() => {});
      await new Promise((r) => setTimeout(r, 400));         // give Chrome time to activate
    } catch (_) { /* best effort */ }

    // Take a fresh snapshot of the target window.
    let snapshot;
    try {
      // hwnd=0 snapshots whatever is now foreground (should be the Chrome window we just focused).
      snapshot = await sidecar.computerSnapshot(0);
    } catch (e) {
      _log(`autofill/executor: snapshot failed: ${e.message}`);
      return { results: plan.map((p) => ({ label: p.label, ok: false, error: 'Could not inspect the window.' })), filled: 0 };
    }

    const elements = (snapshot && snapshot.elements) || [];
    const snapshotId = snapshot && snapshot.snapshotId;
    _log(`autofill/executor: snapshot has ${elements.length} elements, snapshotId=${snapshotId}`);
    _log(`autofill/executor: element names: ${elements.map((e) => `"${e.name}"(${e.type})`).join(', ')}`);
    if (!snapshotId) return { results: plan.map((p) => ({ label: p.label, ok: false, error: 'Empty snapshot.' })), filled: 0 };

    const matched = matchToRefs(plan, elements);
    const results = [];
    let filled = 0;

    _log(`autofill/executor: match results: ${JSON.stringify(matched.map((m) => ({ label: m.label, matched: !m.skipped, elName: m.elName, score: m.score })))}`);

    for (const m of matched) {
      if (m.skipped) {
        results.push({ label: m.label, ok: false, error: 'No matching field found in the window.' });
        continue;
      }

      try {
        await sidecar.computerAction(snapshotId, { type: 'fill', ref: m.ref, text: m.value });
        _log(`autofill/executor: filled "${m.label}" (→ "${m.elName}", score=${m.score.toFixed(2)})`);
        results.push({ label: m.label, value: m.value, ok: true });
        filled++;
      } catch (e) {
        _log(`autofill/executor: fill "${m.label}" failed: ${e.message}`);
        results.push({ label: m.label, ok: false, error: e.message || 'Fill failed.' });
      }
    }

    // Release the snapshot when done.
    try { await sidecar.computerRelease(snapshotId); } catch (_) { /* best effort */ }

    return { results, filled };
  }

  return { fill };
}

module.exports = { createExecutor, matchToRefs, norm, similarity };
