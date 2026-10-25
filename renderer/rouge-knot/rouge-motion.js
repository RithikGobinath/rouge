// rouge-motion.js — drag lifecycle, continuous evolution, cursor sampling,
// movement, avoidance, subtle bob. Accesses app.js top-level bindings.
// Exports: window.RougeMotion.
(function () {
'use strict';

const M = window.RougeMotionMath;
const app = window._rougeAppInternals;

// ---- Init renderer ---------------------------------------------------------
const knotBtn    = document.getElementById('knot');
const knotCanvas = document.getElementById('knot-canvas');
const threadCanvas = document.getElementById('thread');

let knot   = null;
let thread = null;

if (knotCanvas) {
  knot = window.Knot3D.mount(knotCanvas);
  app.setKnot(knot);
}

if (threadCanvas && knot) {
  thread = window.Strand.mount(threadCanvas, knot);
  app.setThread(thread);
}

// Reduced motion
const rm = window.matchMedia('(prefers-reduced-motion: reduce)');
function applyRM() {
  if (knot)   knot.setReducedMotion(rm.matches);
  if (thread) thread.setReducedMotion(rm.matches);
  if (rm.matches && bob) { bob.x = 0; bob.y = 0; bob.vx = 0; bob.vy = 0; applyBob(); }
}
rm.addEventListener('change', applyRM);
applyRM();

// ---- Position --------------------------------------------------------------
const HIT_R = 38; // px
let posX = innerWidth / 2, posY = innerHeight / 2;

function constrainPos(x, y) {
  return {
    x: Math.max(HIT_R + 12, Math.min(innerWidth  - HIT_R - 12, x)),
    y: Math.max(HIT_R + 12, Math.min(innerHeight - HIT_R - 12, y)),
  };
}

function applyPosition(x, y) {
  const c = constrainPos(x, y);
  posX = c.x; posY = c.y;
  if (knotBtn) {
    knotBtn.style.left = (c.x - HIT_R) + 'px';
    knotBtn.style.top  = (c.y - HIT_R) + 'px';
  }
  app.positionPopups();
}

// Place initially near bottom-right
applyPosition(innerWidth - 80, innerHeight - 80);

// ---- Formation / flow state ------------------------------------------------
let formation = new Float64Array([1, 1, 1, 0, 0, 0]);
let flowParams = M.createFlowParams(formation);
let flowPhase  = 0;
let cursor     = M.createCursorState();
let bob        = M.createBobState();
let bobWatchdog = null;

// ---- Drag lifecycle --------------------------------------------------------
let dragging   = false;
let dragId     = null;
let dragOriginX = 0, dragOriginY = 0;     // knot center at drag start
let dragStartX = 0, dragStartY = 0;       // pointer at drag start
let dragFlow   = null;                    // frozen flow params for this hold
let dragFlowPhase = 0;
let lastDragTime  = performance.now();
let holdTimer     = null;                 // 32 ms watchdog
let lastPointerTs = performance.now();

const CLICK_THRESHOLD = 5; // px
let didDrag = false;

function onPointerDown(e) {
  if (dragging) return;
  dragging = true; didDrag = false;
  dragId = e.pointerId;
  knotBtn.setPointerCapture(dragId);

  dragStartX = e.clientX; dragStartY = e.clientY;
  dragOriginX = posX; dragOriginY = posY;

  formation = M.clampFormation(knot ? knot.getFormation() : formation);
  dragFlow = M.createFlowParams(formation);
  dragFlowPhase = 0;
  cursor = M.createCursorState();
  lastDragTime = performance.now();

  if (holdTimer) clearInterval(holdTimer);
  holdTimer = setInterval(tickHold, 32);
}

function onPointerMove(e) {
  if (!dragging || e.pointerId !== dragId) return;
  const dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
  if (Math.hypot(dx, dy) > CLICK_THRESHOLD) didDrag = true;

  const now = performance.now();
  M.updateCursorSample(cursor, e.clientX, e.clientY, now);
  lastPointerTs = now;

  // Advance flow phase by pointer speed
  const dt = Math.max(0.001, (now - lastDragTime) / 1000);
  const morphRate = M.tickCursor(cursor, dt, now);
  dragFlowPhase += dt * morphRate;
  lastDragTime = now;

  // Compute new position
  const c = constrainPos(dragOriginX + dx, dragOriginY + dy);
  applyPosition(c.x, c.y);

  // Update formation
  const base = M.evalFlow(dragFlow, dragFlowPhase);
  const f = M.cursorFormation(base, cursor);
  if (knot) knot.setFormation(f, { paintNow: true });

  // Bob target
  if (!rm.matches) {
    const [tx, ty] = M.bobTarget(cursor.responseX, cursor.responseY);
    tickBobTo(tx, ty, dt);
  }
}

function onPointerUp(e) {
  if (!dragging || e.pointerId !== dragId) return;
  endDrag();
  if (!didDrag) handleClick();
}

function onPointerCancel(e) {
  if (!dragging || e.pointerId !== dragId) return;
  endDrag();
}

// Catch release outside the page
window.addEventListener('pointermove', e => {
  if (!dragging || e.buttons === 0) endDrag();
}, { capture: true, passive: true });

function endDrag() {
  if (!dragging) return;
  dragging = false;
  dragId = null;
  if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
  // Keep current formation; only settle the bob
  startBobReturn();
}

function tickHold() {
  // Watchdog: keeps morphing if pointer events are delayed
  const now = performance.now();
  const dt  = Math.max(0.001, Math.min(0.05, (now - lastDragTime) / 1000));
  if (now - lastDragTime < 48) return;
  lastDragTime = now;

  const morphRate = M.tickCursor(cursor, dt, now);
  dragFlowPhase += dt * morphRate;
  const base = M.evalFlow(dragFlow, dragFlowPhase);
  const f = M.cursorFormation(base, cursor);
  if (knot) knot.setFormation(f, { paintNow: true });
}

// ---- Click -----------------------------------------------------------------
function handleClick() {
  const chatPanel = document.getElementById('chat-panel');
  if (!chatPanel) return;
  const expanded = knotBtn.getAttribute('aria-expanded') === 'true';
  knotBtn.setAttribute('aria-expanded', String(!expanded));
  chatPanel.hidden = expanded;
  app.positionPopups();
}

// ---- Bob animation ---------------------------------------------------------
let bobRafId = null;
let bobLastTs = null;

function tickBobTo(targetX, targetY, dt) {
  M.tickBob(bob, targetX, targetY, dt);
  applyBob();
}

function applyBob() {
  document.documentElement.style.setProperty('--bob-x', bob.x.toFixed(2) + 'px');
  document.documentElement.style.setProperty('--bob-y', bob.y.toFixed(2) + 'px');
}

function startBobReturn() {
  if (bobRafId) cancelAnimationFrame(bobRafId);
  bobLastTs = null;

  function step(ts) {
    const dt = bobLastTs === null ? 0.016 : Math.min(0.05, (ts - bobLastTs) / 1000);
    bobLastTs = ts;
    M.tickBob(bob, 0, 0, dt);
    applyBob();
    if (M.bobSettled(bob)) {
      bob.x = 0; bob.y = 0; bob.vx = 0; bob.vy = 0;
      applyBob();
    } else {
      bobRafId = requestAnimationFrame(step);
    }
  }
  bobRafId = requestAnimationFrame(step);
}

// Bob watchdog
setInterval(() => {
  if (!dragging && !M.bobSettled(bob)) applyBob();
}, 32);

// ---- Pointer event wiring --------------------------------------------------
if (knotBtn) {
  knotBtn.addEventListener('pointerdown', onPointerDown);
  knotBtn.addEventListener('pointermove', onPointerMove);
  knotBtn.addEventListener('pointerup',   onPointerUp);
  knotBtn.addEventListener('pointercancel', onPointerCancel);
  knotBtn.addEventListener('click', e => { if (didDrag) { e.stopImmediatePropagation(); didDrag = false; } });
}

// ---- Programmatic flight ---------------------------------------------------
let flightRaf = null;
let flightResolve = null;

function cancelFlight(reason) {
  if (flightRaf) { cancelAnimationFrame(flightRaf); flightRaf = null; }
  if (flightResolve) { flightResolve(reason); flightResolve = null; }
}

function moveTo(x, y, opts) {
  if (dragging) return Promise.resolve({ held: true, x: posX, y: posY, moving: false });
  cancelFlight({ cancelled: true, x: posX, y: posY, moving: false });

  const ox = posX, oy = posY;
  const dest = constrainPos(x, y);
  const dist = Math.hypot(dest.x - ox, dest.y - oy);
  const dur  = M.flightDuration(dist, opts && opts.duration);

  if (rm.matches) {
    applyPosition(dest.x, dest.y);
    return Promise.resolve({ x: dest.x, y: dest.y, moving: false });
  }

  const start = performance.now();
  return new Promise(resolve => {
    flightResolve = resolve;
    function step(ts) {
      const progress = Math.min(1, (ts - start) / dur);
      const p = M.flightPos(ox, oy, dest.x - ox, dest.y - oy, progress);
      applyPosition(p.x, p.y);
      document.dispatchEvent(new CustomEvent('rouge:move-start', { detail: getState() }));
      if (progress < 1) {
        flightRaf = requestAnimationFrame(step);
      } else {
        flightRaf = null; flightResolve = null;
        const s = getState();
        document.dispatchEvent(new CustomEvent('rouge:moved', { detail: s }));
        resolve(s);
      }
    }
    flightRaf = requestAnimationFrame(step);
  });
}

function avoidRect(rect, opts) {
  const candidate = M.chooseAvoidPosition(posX, posY, innerWidth, innerHeight, HIT_R, rect, []);
  if (!candidate) return Promise.resolve({ blocked: true, x: posX, y: posY, moving: false });
  if (Math.hypot(candidate.x - posX, candidate.y - posY) < 1)
    return Promise.resolve({ unchanged: true, x: posX, y: posY, moving: false });
  return moveTo(candidate.x, candidate.y, opts);
}

function moveAway() {
  return moveTo(posX < innerWidth/2 ? innerWidth - 80 : 80, posY < innerHeight/2 ? innerHeight - 80 : 80);
}

function getState() {
  return {
    x: posX, y: posY,
    formation: knot ? 'custom' : 'default',
    moving: !!flightRaf || dragging,
    move: 0,
  };
}

// ---- DOM events for programmatic movement ----------------------------------
document.addEventListener('rouge:move', e => {
  const d = e.detail || {};
  if (isFinite(d.x) && isFinite(d.y)) moveTo(d.x, d.y, d.duration ? { duration: d.duration } : undefined);
});
document.addEventListener('rouge:avoid', e => {
  const d = e.detail || {};
  const r = d.rect || d;
  if (r && isFinite(r.x)) avoidRect(r);
});

// ---- Proximity avoidance of external controls (browser trigger) ------------
let avoidCooldown = 0;
document.addEventListener('pointermove', e => {
  if (dragging || Date.now() < avoidCooldown) return;
  const target = document.elementFromPoint(e.clientX, e.clientY);
  if (!target || knotBtn.contains(target)) return;
  if (target.matches('button, a, input, textarea, select, [tabindex]')) {
    const r = target.getBoundingClientRect();
    const dist = Math.max(0, Math.hypot(
      e.clientX - (r.left + r.width/2), e.clientY - (r.top + r.height/2)
    ) - Math.hypot(r.width/2, r.height/2));
    if (dist < 110) {
      avoidCooldown = Date.now() + 1600;
      avoidRect({ x: r.left, y: r.top, width: r.width, height: r.height });
    }
  }
}, { passive: true });

document.addEventListener('focusin', e => {
  if (knotBtn.contains(e.target)) return;
  const r = e.target.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) {
    avoidRect({ x: r.left, y: r.top, width: r.width, height: r.height });
  }
});

// ---- Layout / resize -------------------------------------------------------
window.addEventListener('resize', () => {
  const p = constrainPos(posX, posY);
  applyPosition(p.x, p.y);
});

// ---- Exports ---------------------------------------------------------------
window.RougeMotion = { moveTo, avoidRect, moveAway, getState, layout: app.positionPopups };

})();
