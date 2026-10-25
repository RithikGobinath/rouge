// rouge-engine.js — Knot3D Canvas renderer and Strand guidance renderer.
// Exports: window.Knot3D, window.Strand.
(function () {
'use strict';

const R = window.Rouge;
const M = window.RougeMotionMath;

// ---- Material palette -------------------------------------------------------
const FRONT   = [206, 14,  30 ];
const BACK    = [150,  9,  22 ];
const SHADOW  = [ 38,  2,   6 ];
const SPEC    = [255, 196, 184];
const SHEEN   = [255,  72,  56];

const LIGHT   = R.norm([0.6, 0.8, 1.0]);
const HALF_W  = 0.185;  // ribbon half-width in knot units

function rgb(c) { return `rgb(${c[0]|0},${c[1]|0},${c[2]|0})`; }
function mix3(a, b, t) {
  return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// Satin shading: wrap diffuse + anisotropic specular + sheen.
// pn: projected (screen-space) normal; tangent: 3-D world tangent.
function shade(face, tangent, pn, lightPhase, glow) {
  const fN = face > 0 ? pn : [-pn[0], -pn[1], -pn[2]];

  // Wrap diffuse
  const wrap = 0.5 + 0.5 * clamp01(R.dot(fN, LIGHT));
  const body  = 0.2 + 0.8 * Math.pow(clamp01(wrap), 1.35);

  // Anisotropic satin highlight
  const eye  = [0, 0, 1];
  const half = R.norm(R.add(LIGHT, eye));
  const tang = R.norm(tangent);
  const along = Math.sqrt(Math.max(0, 1 - Math.pow(R.dot(tang, half), 2)));
  const nDotH = clamp01(0.5 * R.dot(pn, half) + 0.5);
  const spec  = Math.pow(along, 34) * (0.2 + 0.8 * nDotH);

  // Grazing sheen
  const sheen = Math.pow(1 - Math.min(1, Math.abs(pn[2])), 2.2);

  // Traveling light band (phase varies by segment)
  const band = (Math.sin(lightPhase) * 0.5 + 0.5) * 0.25;

  let col = face > 0 ? FRONT.slice() : BACK.slice();
  col = mix3(SHADOW, col, Math.min(1, body + band));
  col = mix3(col, SPEC,  spec  * (0.55 + glow * 0.45));
  col = mix3(col, SHEEN, sheen * (0.25 + glow * 0.20));

  return [Math.round(col[0]), Math.round(col[1]), Math.round(col[2])];
}

// ---- Projection ------------------------------------------------------------
// Camera: Y rotation → X rotation → in-plane rotation → perspective.
function projectPt(p, yaw, pitch, inplane, scale, cx, cy) {
  // Y rotation
  const cy1 = Math.cos(yaw), sy1 = Math.sin(yaw);
  let x = p[0]*cy1 + p[2]*sy1, y = p[1];
  let z = -p[0]*sy1 + p[2]*cy1;

  // X rotation
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y2 = y*cp - z*sp, z2 = y*sp + z*cp;
  y = y2; z = z2;

  // Perspective
  const w = 6.2 / (6.2 - 1.6 * z);
  x *= w; y *= w;

  // In-plane rotation
  const ci = Math.cos(inplane), si = Math.sin(inplane);
  return [cx + (x*ci - y*si)*scale, cy + (x*si + y*ci)*scale, z];
}

// Project a 3-D direction vector into screen space (no translation/perspective).
function projectDir(n, yaw, pitch, inplane) {
  const cy1 = Math.cos(yaw), sy1 = Math.sin(yaw);
  let nx = n[0]*cy1 + n[2]*sy1, ny = n[1];
  let nz = -n[0]*sy1 + n[2]*cy1;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const ny2 = ny*cp - nz*sp, nz2 = ny*sp + nz*cp;
  ny = ny2; nz = nz2;
  const ci = Math.cos(inplane), si = Math.sin(inplane);
  return [nx*ci - ny*si, nx*si + ny*ci, nz];
}

// ---- Knot3D -----------------------------------------------------------------
function mountKnot3D(canvas, options) {
  options = options || {};

  const M_ = window.RougeMotionMath;
  let formation = new Float64Array([1, 1, 1, 0, 0, 0]);
  let state = 'idle';
  let reducedMotion = false;
  let scale = 1, unravel = 0, rotate = 0;

  // Animation state
  let yaw = 0.4, pitch = -0.25;
  let lightPhase = 0, breathPhase = 0, orbitPhase = 0;
  let glowTarget = 0.30, glowCurrent = 0.30;
  let timeSpeed = 1, lightSpeed = 1;

  // Geometry cache (bounded)
  const geoCache = new Map();

  let rafId = null, lastTs = null, lastPaintTs = -1;
  let destroyed = false, paused = false;

  const dpr = Math.min(2, devicePixelRatio || 1);

  function resize() {
    const w = canvas.clientWidth || 104, h = canvas.clientHeight || 104;
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  resize();

  function sampleCount() {
    const bps = Math.min(canvas.width, canvas.height);
    return Math.max(260, Math.min(900, Math.round(bps * 1.6)));
  }

  function cacheKey(n, f) {
    return n + '|' + Array.from(f).map(v => v.toFixed(3)).join(',');
  }

  function getGeo(n, f) {
    const key = cacheKey(n, f);
    if (geoCache.has(key)) return geoCache.get(key);
    if (geoCache.size >= 40) geoCache.delete(geoCache.keys().next().value);
    const geo = M_.sampleKnot(n, f);
    geoCache.set(key, geo);
    return geo;
  }

  // Paint the knot to the canvas at the given timestamp.
  function paint(ts) {
    if (destroyed) return;
    if (ts - lastPaintTs < 12) return;
    lastPaintTs = ts;

    const ctx = canvas.getContext('2d');
    const cw = canvas.width, ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    const renderScale = 0.20 * Math.min(cw, ch) * scale;
    const cx = cw / 2, cy = ch / 2;
    const n = sampleCount();
    const geo = getGeo(n, formation);
    const { points, tangents, normals, widths } = geo;

    const breathY = reducedMotion ? 0 : Math.sin(breathPhase) * 0.012;
    const orbitX  = reducedMotion ? 0 : Math.cos(orbitPhase) * 0.008;

    const yawV = yaw + orbitX, pitchV = pitch + breathY;

    // Build segment list
    const segs = new Array(n);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const p0 = points[i], p1 = points[j];
      const w0 = widths[i], w1 = widths[j];

      const u0a = R.add(p0, R.scale(w0, HALF_W));
      const u0b = R.sub(p0, R.scale(w0, HALF_W));
      const u1a = R.add(p1, R.scale(w1, HALF_W));
      const u1b = R.sub(p1, R.scale(w1, HALF_W));

      const pa = projectPt(u0a, yawV, pitchV, rotate, renderScale, cx, cy);
      const pb = projectPt(u0b, yawV, pitchV, rotate, renderScale, cx, cy);
      const pc = projectPt(u1b, yawV, pitchV, rotate, renderScale, cx, cy);
      const pd = projectPt(u1a, yawV, pitchV, rotate, renderScale, cx, cy);

      const depth = (pa[2] + pb[2] + pc[2] + pd[2]) * 0.25;

      const avgN = R.norm(R.add(normals[i], normals[j]));
      const pn   = projectDir(avgN, yawV, pitchV, rotate);
      const face = pn[2] > 0 ? 1 : -1;

      const avgT = R.norm(R.add(tangents[i], tangents[j]));
      const col  = shade(face, avgT, pn, lightPhase + i * 0.04, glowCurrent);

      segs[i] = { pa, pb, pc, pd, depth, col };
    }

    // Depth sort: back to front
    segs.sort((a, b) => a.depth - b.depth);

    // Draw quads
    for (const { pa, pb, pc, pd, col } of segs) {
      ctx.beginPath();
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pd[0], pd[1]);
      ctx.lineTo(pc[0], pc[1]);
      ctx.lineTo(pb[0], pb[1]);
      ctx.closePath();
      ctx.fillStyle = rgb(col);
      ctx.fill();
      const hemCol = mix3(col, SHADOW, 0.45);
      ctx.strokeStyle = rgb(hemCol);
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
  }

  function frame(ts) {
    if (destroyed) return;
    rafId = requestAnimationFrame(frame);
    const dt = lastTs === null ? 0.016 : Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;

    if (!reducedMotion && !paused) {
      yaw += dt * 0.14 * timeSpeed;
      breathPhase += dt * 0.9  * timeSpeed;
      orbitPhase  += dt * 0.31 * timeSpeed;
      lightPhase  += dt * 0.75 * lightSpeed;
    }
    glowCurrent += (glowTarget - glowCurrent) * (1 - Math.exp(-dt * 5));

    paint(ts);
  }

  rafId = requestAnimationFrame(frame);

  // 32 ms watchdog: repaint if the last frame callback was delayed.
  const watchdog = setInterval(() => {
    if (destroyed) return;
    const now = performance.now();
    if (now - lastPaintTs > 48) paint(now);
  }, 32);

  const STATES = {
    idle:     { timeSpeed: 1,   lightSpeed: 1,   glow: 0.30 },
    ready:    { timeSpeed: 1.25, lightSpeed: 1.35, glow: 0.45 },
    listening:{ timeSpeed: 1.7,  lightSpeed: 1.9,  glow: 0.72 },
    thinking: { timeSpeed: 2.4,  lightSpeed: 2.6,  glow: 0.85 },
    speaking: { timeSpeed: 1.5,  lightSpeed: 2.4,  glow: 0.80 },
    reading:  { timeSpeed: 1.3,  lightSpeed: 2.2,  glow: 1.05 },
  };

  return {
    setFormation(values, opts) {
      formation = M_.clampFormation(values);
      if (opts && opts.paintNow) paint(performance.now());
    },
    getFormation() { return Array.from(formation); },
    setState(name) {
      const t = STATES[name]; if (!t) return;
      state = name; timeSpeed = t.timeSpeed; lightSpeed = t.lightSpeed;
      glowTarget = t.glow;
    },
    setReducedMotion(v) { reducedMotion = !!v; },
    setLevel(v) { /* audio intensity — not currently connected */ },
    setScale(v) { scale = v; },
    setUnravel(v) { unravel = Math.max(0, Math.min(1, v)); },
    setRotate(r) { rotate = r; },
    getRotate() { return rotate; },
    getTailAnchor(u) {
      const n = sampleCount();
      const geo = getGeo(n, formation);
      const idx = Math.floor(u * n) % n;
      const cw = canvas.width, ch = canvas.height;
      const rs = 0.20 * Math.min(cw, ch) * scale;
      const [sx, sy] = projectPt(geo.points[idx], yaw, pitch, rotate, rs, cw/2, ch/2);
      return { x: sx / dpr, y: sy / dpr };
    },
    getTailFrame(u) {
      const n = sampleCount();
      const geo = getGeo(n, formation);
      const idx = Math.floor(u * n) % n;
      return { tangent: geo.tangents[idx], normal: geo.normals[idx] };
    },
    still() { paint(performance.now()); },
    pause() { paused = true; },
    resume() { paused = false; },
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      clearInterval(watchdog);
    },
  };
}

// ---- Strand guidance renderer ----------------------------------------------
function mountStrand(canvas, knot, options) {
  let target = null;
  let progress = 0, strandState = 'idle';
  let rafId = requestAnimationFrame(frameFn);
  let destroyed = false, reducedMotion = false;

  function frameFn() {
    if (destroyed) return;
    rafId = requestAnimationFrame(frameFn);
    draw();
  }

  function draw() {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!target || progress <= 0) return;

    const anchor = knot ? knot.getTailAnchor(0.72) : { x: canvas.clientWidth/2, y: canvas.clientHeight/2 };
    const dpr_ = Math.min(2, devicePixelRatio || 1);
    const A = [anchor.x * dpr_, anchor.y * dpr_];
    const tz = target;
    const Z = [(tz.x + tz.w/2) * dpr_, (tz.y + tz.h/2) * dpr_];

    const dx = Z[0]-A[0], dy = Z[1]-A[1];
    const dist = Math.hypot(dx, dy) || 1;
    const perp = [-dy/dist, dx/dist];
    const bow = Math.min(80*dpr_, dist * 0.3);
    const mid = [(A[0]+Z[0])/2 + perp[0]*bow, (A[1]+Z[1])/2 + perp[1]*bow];
    const C1 = [A[0]+(mid[0]-A[0])*0.5, A[1]+(mid[1]-A[1])*0.5];
    const C2 = [Z[0]+(mid[0]-Z[0])*0.5, Z[1]+(mid[1]-Z[1])*0.5];

    const steps = Math.max(20, Math.round(dist / (3*dpr_)));
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = (i/steps) * progress;
      const nt = 1-t;
      const px = nt*nt*nt*A[0] + 3*nt*nt*t*C1[0] + 3*nt*t*t*C2[0] + t*t*t*Z[0];
      const py = nt*nt*nt*A[1] + 3*nt*nt*t*C1[1] + 3*nt*t*t*C2[1] + t*t*t*Z[1];
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.strokeStyle = 'rgb(206,14,30)';
    ctx.lineWidth = 3 * dpr_;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Tip glow
    const tip = (() => {
      const t2 = progress, nt = 1-t2;
      return [
        nt*nt*nt*A[0] + 3*nt*nt*t2*C1[0] + 3*nt*t2*t2*C2[0] + t2*t2*t2*Z[0],
        nt*nt*nt*A[1] + 3*nt*nt*t2*C1[1] + 3*nt*t2*t2*C2[1] + t2*t2*t2*Z[1],
      ];
    })();
    ctx.beginPath();
    ctx.arc(tip[0], tip[1], 5*dpr_, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,80,60,0.85)';
    ctx.fill();
  }

  function animate(from, to, duration, onDone) {
    const start = performance.now();
    const startVal = from;
    function tick(ts) {
      if (destroyed) return;
      const t = Math.min(1, (ts - start) / duration);
      progress = startVal + (to - startVal) * window.RougeMotionMath.smoothstep5(t);
      if (t < 1) requestAnimationFrame(tick);
      else { progress = to; if (onDone) onDone(); }
    }
    requestAnimationFrame(tick);
  }

  return {
    setTarget(rect) {
      if (!rect) { animate(progress, 0, 420, () => { target = null; strandState = 'idle'; }); return true; }
      target = rect;
      strandState = 'extending';
      const pathLen = 200; // approximate
      const dur = Math.min(800, 650 + 0.25 * pathLen);
      animate(0, 1, dur, () => { strandState = 'holding'; });
      return true;
    },
    rewind() {
      strandState = 'retracting';
      const pathLen = 200;
      const dur = Math.min(600, 420 + 0.12 * pathLen);
      animate(progress, 0, dur, () => { strandState = 'idle'; target = null; });
    },
    getTip() { return null; },
    getTarget() { return target; },
    getState() { return strandState; },
    getProgress() { return progress; },
    relayout() {},
    pause() {},
    resume() {},
    destroy() { destroyed = true; if (rafId) cancelAnimationFrame(rafId); },
    setReducedMotion(v) { reducedMotion = v; },
  };
}

window.Knot3D = { mount: mountKnot3D };
window.Strand = { mount: mountStrand };

})();
