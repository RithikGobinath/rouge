'use strict';
// Look here. Press the look-here keys over a button, an error or a slide: the
// ribbon runs to that exact spot and the answer lands right there.
//
//   1. note where the pointer is, before anything else can move it
//   2. ask Windows what control is under it, and which window that is
//   3. send the thread to that control (or to "your spot" when Windows names
//      nothing), immediately: the picture and the answer follow
//   4. take one screenshot with the overlay hidden from it, mask any private
//      fields that land in the close-up, and refuse when those fields cannot
//      be checked
//   5. ask Claude; the answer opens as a bubble at the tip of the thread
//
// A follow-up question reuses the same picture, so it never captures again.
// Password and card fields are refused before any screenshot is taken.
// An unfiltered whole-screen overview is never sent.

const { sensitiveTarget } = require('./sensitive');
const { positionTarget } = require('./positions');
const { findTracked } = require('./track');

const SNAPSHOT_MS = 120000;
const SPOT = 56;                 // the box drawn around "your spot", in screen pixels at 100%
const MAX_AREA = 0.4;            // a "control" this large is a window, not what was pointed at
const TRACK_MAX_MS = 45000;      // the longest a control is watched: the wand holds for at most 15 s, so this is only a backstop

/**
 * @typedef {Object} PointDeps
 * @property {any} sidecar
 * @property {any} ai
 * @property {{send:(c:string,d:any)=>void, physToOverlay:(r:object)=>object, win?:any}} overlay
 * @property {{state:Function, notice:Function}} ui
 * @property {{takeDisplay:Function, cropAround:Function, maskRegions:Function}} capture
 * @property {()=>number} [now]
 * @property {(msg:string)=>void} [log]
 */

function overlaps(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** @param {PointDeps} d */
function createPointAsk(d) {
  const now = d.now || Date.now;
  const log = d.log || (() => {});
  let seq = 0;
  /** @type {null | {id:number, ac:AbortController, snap:object|null, history:Array<{q:string,a:string}>, busy:boolean}} */
  let cur = null;

  const bubble = (b) => d.overlay.send('point:bubble', b);
  const actions = () => [{ id: 'more', label: 'Ask more' }, { id: 'close', label: 'Close' }];

  function highlight(rect, label) {
    cur = { id: ++seq, ac: new AbortController(), snap: null, history: [], busy: false };
    if (d.overlay.show) d.overlay.show();
    d.ui.state('ready');
    d.overlay.send('point:target', { rect, label });
    bubble({ kicker: 'Wand', text: label, actions: [{ id: 'close', label: 'Close' }], anchor: 'tip' });
  }

  function fail(session, text) {
    if (!cur || cur.id !== session.id) return;
    session.busy = false;
    d.ui.state('ready');
    bubble({ kicker: 'Look here', text, hint: '', actions: [{ id: 'close', label: 'Close' }], anchor: 'tip' });
  }

  /** What was pointed at, as a rectangle in physical screen pixels. */
  function spotRect(el, cursor, scale, display) {
    const big = el && el.rect && (el.rect.w * el.rect.h) > MAX_AREA * display.size.width * display.size.height * scale * scale;
    if (el && el.rect && el.rect.w >= 6 && el.rect.h >= 6 && !big) return { rect: el.rect, element: el };
    const s = Math.round(SPOT * scale);
    return { rect: { x: cursor.x - s / 2, y: cursor.y - s / 2, w: s, h: s }, element: null };
  }

  async function privateFields(hwnd) {
    if (!hwnd || typeof d.sidecar.uiaList !== 'function') throw new Error('I could not check nearby private fields.');
    const listed = await d.sidecar.uiaList(hwnd, 250);
    if (!listed || !Array.isArray(listed.elements)) throw new Error('I could not check nearby private fields.');
    if (listed.truncated) throw new Error('I could not check nearby private fields.');
    return listed.elements.filter((el) => sensitiveTarget(el) && el.rect);
  }

  async function ask(session, question) {
    const snap = session.snap;
    session.busy = true;
    d.ui.state('thinking', { word: 'Working it out' });
    try {
      const asked = session.history.length
        ? `${question || 'Explain this.'}\n\nEarlier in this chat about the same spot:\n${session.history.map((h) => `Q: ${h.q}\nA: ${h.a}`).join('\n')}`
        : question;
      const r = await d.ai.explain({ crop: snap.crop, question: asked, element: snap.element, window: snap.window, signal: session.ac.signal });
      if (!cur || cur.id !== session.id) return;
      session.history.push({ q: question || 'Explain this.', a: r.text });
      session.busy = false;
      d.ui.state('ready');
      const via = r.provider === 'gemini' ? 'Answered by Gemini: add an Anthropic key for Claude.' : r.provider === 'claude-code' ? 'Answered by Claude Code.' : '';
      bubble({ kicker: r.kicker, text: r.text, hint: via, sources: (r.sources || []).slice(0, 12), actions: actions(), anchor: 'tip' });
      // Auto-retract after a duration proportional to the text length.
      // ~1 s per 100 chars, min 5 s, max 30 s.
      const autoMs = Math.min(30000, Math.max(5000, Math.round(r.text.length * 10)));
      const autoTimer = setTimeout(() => {
        if (!cur || cur.id !== session.id) return;
        cur.ac.abort(); cur = null;
        d.overlay.send('point:clear', {});
      }, autoMs);
      session.ac.signal.addEventListener('abort', () => clearTimeout(autoTimer));
    } catch (e) {
      if (session.ac.signal.aborted) return;
      fail(session, e.message || 'That did not work.');
    }
  }

  return {
    /** A local position request works without keys, a model, screen capture or computer control. */
    pointPosition(text) {
      const bounds = d.overlay.usableArea || (d.overlay.win && d.overlay.win.getBounds());
      const target = positionTarget(text, bounds);
      if (!target) return false;
      this.close();
      highlight(target.rect, target.label);
      return true;
    },
    /** The hotkey. Replaces whatever was pointed at before. */
    async trigger() {
      this.close();
      const session = { id: ++seq, ac: new AbortController(), snap: null, history: [], busy: true };
      cur = session;
      d.ui.state('reading', { word: 'Looking', line: 'At that spot' });
      try {
        const cursor = await d.sidecar.cursor();                       // before any await that could let it move
        const [hit, fg] = await Promise.all([d.sidecar.fromPoint(cursor.x, cursor.y), d.sidecar.fg().catch(() => null)]);
        if (cur !== session) return;
        const el = hit && hit.element;
        log(`point: cursor=${cursor.x},${cursor.y} element=${el ? `${el.type} "${el.name}"${el.fallback ? ' (fallback)' : ''}` : 'none'} window=${fg && fg.title}`);
        if (el && sensitiveTarget({ ...el, type: el.type })) {
          session.busy = false; d.ui.state('ready');
          const spot = { x: el.rect.x, y: el.rect.y, w: el.rect.w, h: el.rect.h };
          d.overlay.send('point:target', { rect: d.overlay.physToOverlay(spot), label: 'Private field' });
          bubble({ kicker: 'Look here', text: "That looks like a password or ID field. I won't look at it.", hint: '', actions: [{ id: 'close', label: 'Close' }], anchor: 'tip' });
          return;
        }
        const hwnd = (fg && fg.hwnd) || (hit && hit.hwnd) || 0;
        let secrets;
        try { secrets = await privateFields(hwnd); } catch (e) {
          fail(session, e.message || 'I could not check nearby private fields.');
          return;
        }
        if (cur !== session) return;
        const shotCursor = { x: cursor.x, y: cursor.y };
        const shot = await d.capture.takeDisplay(shotCursor, { win: d.overlay.win });
        if (cur !== session) return;
        const { rect, element } = spotRect(el, shotCursor, shot.scale, shot.display);
        const nearPrivate = secrets.filter((s) => overlaps(s.rect, rect));
        const masked = nearPrivate.length ? d.capture.maskRegions(shot, nearPrivate.map((s) => s.rect)) : shot;
        d.overlay.send('point:target', { rect: d.overlay.physToOverlay(rect), label: element ? '' : 'Your spot' });
        const crop = d.capture.cropAround(masked, rect);
        session.snap = {
          at: now(), crop: crop.dataUrl,
          element: element ? { name: element.name, type: element.type, automationId: element.automationId } : null,
          window: fg && fg.title ? { title: fg.title, process: fg.process } : (hit && hit.window ? { title: hit.window.title } : null),
        };
        await ask(session, '');
      } catch (e) {
        log(`point: ${e.message}`);
        fail(session, `I couldn't look at that: ${String(e.message || e).slice(0, 100)}`);
      }
    },

    /**
     * Highlight a known element without taking a screenshot or asking a model.
     * Called automatically after a navigation task when the agent names a specific control.
     * @param {{x:number,y:number,w:number,h:number}} rect physical screen pixels
     * @param {{name?:string,type?:string,automationId?:string}|null} element
     * @param {{title?:string,process?:string}|null} win
     */
    async pointAt(rect, element, win, snapshotId, hwnd) {
      if (!rect || !['x', 'y', 'w', 'h'].every((k) => Number.isFinite(rect[k])) || rect.w <= 0 || rect.h <= 0) return false;
      this.close();
      highlight(d.overlay.physToOverlay(rect), element && element.name ? element.name : 'At that control');
      const session = cur;
      // What the tracker compares against: where the wand first went, and where it last pointed.
      session._trackFirst = rect; session._trackPhys = rect; session._trackRect = d.overlay.physToOverlay(rect);
      try {
        // Element-tracking: self-scheduling poll (no overlap, ≥150 ms gap) that keeps
        // the highlight pinned as the user scrolls.  Targets the exact hwnd.
        const trackName = element && element.name;
        const trackHwnd = hwnd || (win && win.hwnd);
        let tracking = true;
        let trackFails = 0;
        const trackUntil = now() + TRACK_MAX_MS;
        const stopTracking = () => {
          tracking = false;
          if (cur && cur.id === session.id) { cur.ac.abort(); cur = null; d.overlay.send('point:clear', {}); }
        };
        if (trackName && trackHwnd && d.sidecar && typeof d.sidecar.computerSnapshot === 'function') {
          const track = async () => {
            if (!tracking || !cur || cur.id !== session.id) return;
            if (now() > trackUntil) { tracking = false; return; }
            const t0 = Date.now();
            let freshSnapshotId = null;
            try {
              const fresh = await d.sidecar.computerSnapshot(trackHwnd);
              if (!tracking || !cur || cur.id !== session.id) {
                if (fresh && fresh.snapshot) d.sidecar.computerRelease(fresh.snapshot.snapshotId).catch(() => {});
                return;
              }
              if (fresh && fresh.snapshot) {
                freshSnapshotId = fresh.snapshot.snapshotId;
                const elements = fresh.snapshot.elements || [];
                const match = findTracked(elements, { name: trackName, automationId: element && element.automationId }, session._trackPhys, session._trackFirst);
                if (match && match.rect) {
                  // Only send a new target if the element moved more than 4 CSS px.
                  // Sending setTarget on every tick restarts the strand blend animation
                  // and prevents it from ever arriving at the button.
                  const next = d.overlay.physToOverlay(match.rect);
                  const prev = session._trackRect;
                  const moved = !prev ||
                    Math.abs(next.x - prev.x) > 4 || Math.abs(next.y - prev.y) > 4 ||
                    Math.abs(next.w - prev.w) > 4 || Math.abs(next.h - prev.h) > 4;
                  if (moved) {
                    session._trackRect = next; session._trackPhys = match.rect;
                    // `follow`: the same target moved, so the wand glides over to it instead of starting its cycle again.
                    d.overlay.send('point:target', { rect: next, label: trackName, follow: true });
                  }
                }
              }
            } catch (err) {
              const msg = String(err && (err.message || err.code) || '').toLowerCase();
              if (msg.includes('unavailable') || msg.includes('closed') || msg.includes('window')) {
                stopTracking(); return;
              }
              trackFails += 1;
              if (trackFails >= 3) { stopTracking(); return; } // 3 consecutive failures → gone
            }
            finally { if (freshSnapshotId) d.sidecar.computerRelease(freshSnapshotId).catch(() => {}); }
            // Schedule next poll after at least 150 ms total elapsed
            const gap = Math.max(0, 150 - (Date.now() - t0));
            if (tracking && cur && cur.id === session.id) setTimeout(track, gap);
          };
          setTimeout(track, 0);
          session.ac.signal.addEventListener('abort', () => { tracking = false; });
        }
        let offFg = trackHwnd && d.sidecar && typeof d.sidecar.on === 'function'
          ? d.sidecar.on('fg', (ev) => {
              if (!cur || cur.id !== session.id) return;
              // hwnd 0 means nothing took focus (window was closed with no successor).
              // Any hwnd that isn't our tracked window means we should retract.
              const newHwnd = ev && Number(ev.hwnd);
              if (newHwnd !== undefined && newHwnd !== Number(trackHwnd)) {
                stopTracking();
              }
            })
          : null;
        if (offFg) session.ac.signal.addEventListener('abort', () => { if (offFg) offFg(); });
        // The wand has drawn back in: stop reading the window and listening for focus changes. The answer, and "Ask more", stay.
        session.release = () => { tracking = false; if (offFg) { offFg(); offFg = null; } };
        return true;
      } catch (e) {
        log(`pointAt: ${e.message}`);
        fail(session, `I couldn't look at that: ${String(e.message || e).slice(0, 100)}`);
        return false;
      }
    },

    /** "Ask more": a typed question about the same spot, same picture. */
    async followUp(question) {
      const q = String(question || '').trim().slice(0, 1000);
      if (!cur || !cur.snap || cur.busy || !q) return false;
      if (now() - cur.snap.at > SNAPSHOT_MS) { fail(cur, 'That picture is too old. Press the keys on the spot again.'); return false; }
      bubble({ kicker: 'You', text: q, hint: '', actions: [], anchor: 'tip', pending: true });
      await ask(cur, q);
      return true;
    },

    /** The wand has retracted: stop following the control it pointed at (the session and its answer stay). */
    release() { if (cur && cur.release) cur.release(); },

    close() {
      if (cur) { cur.ac.abort(); cur = null; }
      d.overlay.send('point:clear', {});
    },
    get active() { return Boolean(cur); },
  };
}

module.exports = { createPointAsk, SNAPSHOT_MS };
