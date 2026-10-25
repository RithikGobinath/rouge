// living-knot.js — pure knot geometry, formation deformation, cursor response,
// morph tempo, spring physics, path computation, and popup geometry.
// Exports: window.Rouge (vector helpers), window.RougeMotionMath (pure math API).
// No rendering here — pure data transforms and simulation.
(function () {
'use strict';

// ---- Vector helpers --------------------------------------------------------
const Rouge = {
  dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; },
  cross(a, b) {
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  },
  norm(a) {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 1e-14 ? [a[0]/l, a[1]/l, a[2]/l] : [0, 0, 1];
  },
  sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; },
  add(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; },
  scale(a, s) { return [a[0]*s, a[1]*s, a[2]*s]; },
  len(a) { return Math.hypot(a[0], a[1], a[2]); },
  reflect(v, axis) {
    const d2 = Rouge.dot(axis, axis);
    if (d2 < 1e-24) return v.slice();
    const k = 2 * Rouge.dot(axis, v) / d2;
    return [v[0]-k*axis[0], v[1]-k*axis[1], v[2]-k*axis[2]];
  },
  mix3(a, b, t) { return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t]; },
};

// ---- Trefoil parameterization ---------------------------------------------
// P(t) = ([sin(t)+2sin(2t)]/3, [cos(t)-2cos(2t)]/3, -sin(3t)/1.2)
function knotPoint(t) {
  return [
    (Math.sin(t) + 2*Math.sin(2*t)) / 3,
    (Math.cos(t) - 2*Math.cos(2*t)) / 3,
    -Math.sin(3*t) / 1.2,
  ];
}

// ---- Formation deformation ------------------------------------------------
// f = [sx, sy, sz, twist, shearX, shearY]
// Scales clamped to [0.72,1.28], others to [-0.65,0.65], quantized to 1/1024.
function clampFormation(f) {
  const out = new Float64Array(6);
  out[0] = Math.round(Math.min(1.28, Math.max(0.72, f[0])) * 1024) / 1024;
  out[1] = Math.round(Math.min(1.28, Math.max(0.72, f[1])) * 1024) / 1024;
  out[2] = Math.round(Math.min(1.28, Math.max(0.72, f[2])) * 1024) / 1024;
  out[3] = Math.round(Math.min(0.65, Math.max(-0.65, f[3])) * 1024) / 1024;
  out[4] = Math.round(Math.min(0.65, Math.max(-0.65, f[4])) * 1024) / 1024;
  out[5] = Math.round(Math.min(0.65, Math.max(-0.65, f[5])) * 1024) / 1024;
  return out;
}

function deformPoint(p, f) {
  const [x, y, z] = p;
  const a = f[3] * y;  // twist * y
  const ca = Math.cos(a), sa = Math.sin(a);
  const xr = x*ca + z*sa;
  const zr = -x*sa + z*ca;
  return [
    f[0] * xr + f[4] * Math.tanh(y),
    f[1] * y  + f[5] * Math.tanh(zr),
    f[2] * zr,
  ];
}

// Sample the knot: apply deformation, compute rotation-minimizing frames,
// distributed holonomy correction, and ribbon normals.
function sampleKnot(n, f) {
  const fc = f instanceof Float64Array ? f : clampFormation(f);
  const points = new Array(n);
  const tangents = new Array(n);
  const radii = new Array(n);   // Bishop frame reference vector
  const widths = new Array(n);  // ribbon width direction W
  const normals = new Array(n); // ribbon normal N = cross(T, W)

  // 1. Sample the deformed centerline
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    points[i] = deformPoint(knotPoint(t), fc);
  }

  // 2. Central-difference tangents (closed curve — look across the seam)
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    tangents[i] = Rouge.norm(Rouge.sub(next, prev));
  }

  // 3. Rotation-minimizing frames via double reflection
  // Choose initial reference not parallel to T[0]
  let r0 = [0, 1, 0];
  if (Math.abs(Rouge.dot(r0, tangents[0])) > 0.9) r0 = [1, 0, 0];
  r0 = Rouge.norm(Rouge.sub(r0, Rouge.scale(tangents[0], Rouge.dot(r0, tangents[0]))));
  radii[0] = r0;

  for (let i = 0; i < n - 1; i++) {
    const v1 = Rouge.sub(points[i+1], points[i]);
    const rL = Rouge.reflect(radii[i], v1);
    const tL = Rouge.reflect(tangents[i], v1);
    const v2 = Rouge.sub(tangents[i+1], tL);
    const ref = Rouge.reflect(rL, v2);
    const l = Rouge.len(ref);
    radii[i+1] = l > 1e-14 ? [ref[0]/l, ref[1]/l, ref[2]/l] : radii[i].slice();
  }

  // 4. Holonomy correction: compute residual rotation angle at seam
  const holonomy = Math.atan2(
    Rouge.dot(tangents[0], Rouge.cross(radii[n-1], radii[0])),
    Rouge.dot(radii[n-1], radii[0])
  );

  // 5. Distributed holonomy: width direction W and normal N
  const PI2 = 2 * Math.PI;
  for (let i = 0; i < n; i++) {
    const s = i / n;
    const theta = 2 * PI2 * s + 0.7 + holonomy * s;
    const T = tangents[i], R = radii[i];
    const TcrossR = Rouge.cross(T, R);
    const ct = Math.cos(theta), st = Math.sin(theta);
    const W = Rouge.norm([
      R[0]*ct + TcrossR[0]*st,
      R[1]*ct + TcrossR[1]*st,
      R[2]*ct + TcrossR[2]*st,
    ]);
    widths[i] = W;
    normals[i] = Rouge.norm(Rouge.cross(T, W));
  }

  return { points, tangents, radii, widths, normals, n };
}

// ---- Never-ending held flow -----------------------------------------------
const GOLDEN = 1.61803398875;
const CENTERS = [1, 1, 1, 0, 0, 0];          // scale centers = 1, twist/shear = 0
const RADII   = [0.2799, 0.2799, 0.2799, 0.65, 0.65, 0.65];
const HB_AMP  = [0.025, 0.025, 0.025, 0.015, 0.015, 0.015];

function createFlowParams(formation) {
  const params = new Array(6);
  for (let i = 0; i < 6; i++) {
    const c = CENTERS[i], r = RADII[i];
    const ni = Math.max(-0.99999, Math.min(0.99999, (formation[i] - c) / r));
    // Pick initial angle; asin gives principal value in [-π/2, π/2]
    const ia = Math.asin(ni);
    // Randomly choose the other solution π - ia ~half the time for variety
    const initialAngle = Math.random() < 0.5 ? ia : Math.PI - ia;
    params[i] = {
      initialAngle,
      direction: Math.random() < 0.5 ? -1 : 1,
      axisRate: 0.40 + Math.random() * 0.45,           // [0.40, 0.85)
      secondaryPhase: Math.random() * 2 * Math.PI,
    };
  }
  return params;
}

function evalFlow(params, t) {
  const f = new Float64Array(6);
  for (let i = 0; i < 6; i++) {
    const { initialAngle, direction, axisRate, secondaryPhase } = params[i];
    const drift = direction * (
      axisRate * t +
      0.12 * (Math.sin(secondaryPhase + axisRate * GOLDEN * t) - Math.sin(secondaryPhase))
    );
    const heartbeat = HB_AMP[i] * (Math.sin(5.1 * t) + 0.30 * Math.sin(10.2 * t));
    f[i] = CENTERS[i] + RADII[i] * Math.sin(initialAngle + drift + heartbeat);
  }
  return f;
}

// ---- Cursor response -------------------------------------------------------
function createCursorState() {
  return {
    responseX: 0, responseY: 0,
    prevVx: 0, prevVy: 0,
    filteredSpeed: 0,
    turn: 0,
    _inputX: 0, _inputY: 0, _speed: 0,
    _lastInputMs: null,
    _lastX: null, _lastY: null, _lastPointerMs: null,
  };
}

function updateCursorSample(state, x, y, nowMs) {
  if (state._lastX === null) {
    state._lastX = x; state._lastY = y; state._lastPointerMs = nowMs;
    state._lastInputMs = nowMs;
    return;
  }
  const dt = Math.max(0.008, (nowMs - state._lastPointerMs) / 1000);
  const vx = (x - state._lastX) / dt;
  const vy = (y - state._lastY) / dt;
  const speed = Math.hypot(vx, vy);

  // Signed turn (only when both old and new speed > 40 px/s)
  const pvx = state.prevVx, pvy = state.prevVy;
  const prevSpeed = Math.hypot(pvx, pvy);
  if (speed > 40 && prevSpeed > 40) {
    state.turn = Math.max(-1, Math.min(1,
      Math.atan2(pvx * vy - pvy * vx, pvx * vx + pvy * vy) / (Math.PI / 2)
    ));
  }

  state._lastX = x; state._lastY = y; state._lastPointerMs = nowMs;
  state.prevVx = vx; state.prevVy = vy;
  state._inputX = Math.tanh(vx / 300);
  state._inputY = Math.tanh(vy / 300);
  state._speed = speed;
  state._lastInputMs = nowMs;
}

// Tick cursor response state; returns morphRate
function tickCursor(state, dt, nowMs) {
  const age = (state._lastInputMs !== null && nowMs !== undefined)
    ? (nowMs - state._lastInputMs) / 1000 : 0;
  const decay = Math.exp(-Math.max(0, age - 0.07) / 0.12);

  const alphaDir = 1 - Math.exp(-dt / 0.045);
  const ix = state._inputX * decay;
  const iy = state._inputY * decay;
  state.responseX += (ix - state.responseX) * alphaDir;
  state.responseY += (iy - state.responseY) * alphaDir;

  const alphaSpeed = 1 - Math.exp(-dt / 0.040);
  state.filteredSpeed += (state._speed * decay - state.filteredSpeed) * alphaSpeed;

  return 0.55 + Math.min(9.45, Math.max(0, state.filteredSpeed) / 180);
}

// Mix the continuous-flow base formation with cursor-biased values
function cursorFormation(base, state) {
  const x = state.responseX, y = state.responseY;
  const h = Math.hypot(x, y);
  const energy = 1 - Math.exp(-4 * h);
  if (energy < 1e-6) return Array.from(base);

  const nx = h > 1e-12 ? x / h : 0;
  const ny = h > 1e-12 ? y / h : 0;
  const horizontal = nx * nx;
  const vertical = ny * ny;

  function mix(a, b, t) { return a + (b - a) * t; }
  const f = new Float64Array(6);
  f[0] = mix(base[0], 1 + 0.26*horizontal - 0.23*vertical, 0.68*energy);
  f[1] = mix(base[1], 1 + 0.26*vertical   - 0.23*horizontal, 0.68*energy);
  f[2] = mix(base[2], 0.94, 0.35*energy);
  f[3] = mix(base[3], Math.max(-0.65, Math.min(0.65,
    0.60*state.turn + 0.16*nx - 0.10*ny)), 0.45*energy);
  f[4] = mix(base[4], 0.62*nx, 0.82*energy);
  f[5] = mix(base[5], 0.62*ny, 0.82*energy);
  return f;
}

// ---- Bob spring ------------------------------------------------------------
// Exact damped-spring solution per axis.
// a=14, omega0=28 → wd = sqrt(28²-14²) = sqrt(588) ≈ 24.249
const BOB_A = 14, BOB_OMEGA0 = 28;
const BOB_WD = Math.sqrt(BOB_OMEGA0*BOB_OMEGA0 - BOB_A*BOB_A);
const BOB_MAX = 8;  // cap displacement at 8 px

function createBobState() { return { x: 0, y: 0, vx: 0, vy: 0 }; }

function _spring1d(p, v, u, dt) {
  const q = p - u;
  const B = (v + BOB_A * q) / BOB_WD;
  const e  = Math.exp(-BOB_A * dt);
  const cw = Math.cos(BOB_WD * dt);
  const sw = Math.sin(BOB_WD * dt);
  const pn = u + e * (q*cw + B*sw);
  const vn = e * (-BOB_A*(q*cw + B*sw) - q*BOB_WD*sw + B*BOB_WD*cw);
  return [pn, vn];
}

function tickBob(state, targetX, targetY, dt) {
  [state.x, state.vx] = _spring1d(state.x, state.vx, targetX, dt);
  [state.y, state.vy] = _spring1d(state.y, state.vy, targetY, dt);
  const len = Math.hypot(state.x, state.y);
  if (len > BOB_MAX) { const s = BOB_MAX / len; state.x *= s; state.y *= s; }
}

function bobSettled(state) {
  return Math.hypot(state.x, state.y) < 0.035 && Math.hypot(state.vx, state.vy) < 0.25;
}

// targetBob from smoothed cursor response
function bobTarget(responseX, responseY) {
  const len = Math.max(1, Math.hypot(responseX, responseY));
  return [-6 * responseX / len, -6 * responseY / len];
}

// ---- Quintic smootherstep --------------------------------------------------
function smoothstep5(t) {
  t = Math.max(0, Math.min(1, t));
  return t*t*t*(10 + t*(-15 + t*6));
}

// ---- Flight interpolation --------------------------------------------------
function flightPos(ox, oy, dx, dy, progress) {
  const u = smoothstep5(progress);
  const dist = Math.hypot(dx, dy);
  const bend = Math.min(42, 0.1 * dist) * Math.sin(Math.PI * u);
  const perp = dist > 1e-9 ? [-dy/dist, dx/dist] : [0, 1];
  return {
    x: ox + dx*u + perp[0]*bend,
    y: oy + dy*u + perp[1]*bend,
  };
}

function flightDuration(dist, explicit) {
  const def = Math.max(600, Math.min(1600, 720 + 0.42 * dist));
  if (explicit == null) return def;
  return Math.max(600, Math.min(1600, explicit));
}

// ---- Avoidance (8-candidate algorithm) ------------------------------------
function chooseAvoidPosition(cx, cy, vw, vh, hitR, avoidRect, visibleBoxes) {
  const m = 12;  // margin
  const r = hitR;
  const candidates = [
    {x: r+m,    y: r+m},
    {x: vw-r-m, y: r+m},
    {x: r+m,    y: vh-r-m},
    {x: vw-r-m, y: vh-r-m},
    {x: vw/2,   y: r+m},
    {x: vw/2,   y: vh-r-m},
    {x: r+m,    y: vh/2},
    {x: vw-r-m, y: vh/2},
  ];

  function overlap(r1x,r1y,r1w,r1h, r2x,r2y,r2w,r2h) {
    const ox = Math.max(0, Math.min(r1x+r1w, r2x+r2w) - Math.max(r1x, r2x));
    const oy = Math.max(0, Math.min(r1y+r1h, r2y+r2h) - Math.max(r1y, r2y));
    return ox * oy;
  }

  const inf = 16;
  const ax = avoidRect.x - inf, ay = avoidRect.y - inf;
  const aw = avoidRect.width + inf*2, ah = avoidRect.height + inf*2;

  let best = null, bestCost = Infinity;
  for (const c of candidates) {
    const cx2 = c.x - r, cy2 = c.y - r;
    if (overlap(cx2, cy2, r*2, r*2, ax, ay, aw, ah) > 0) continue;

    let visCost = 0;
    for (const b of (visibleBoxes || [])) {
      visCost += overlap(cx2, cy2, r*2, r*2, b.x, b.y, b.w, b.h);
    }
    const near = Math.hypot(c.x - cx, c.y - cy) < 30 ? 200 : 0;
    const dist = Math.hypot(c.x - cx, c.y - cy);
    const cost = 100 * visCost + dist + near;
    if (cost < bestCost) { bestCost = cost; best = c; }
  }
  return best;
}

// ---- Popup phase / layout -------------------------------------------------
function popupPhase(knotX, vw) {
  return smoothstep5((knotX - (vw/2 - 120)) / 240);
}

window.Rouge = Rouge;
window.RougeMotionMath = {
  knotPoint, deformPoint, clampFormation, sampleKnot,
  createFlowParams, evalFlow,
  createCursorState, updateCursorSample, tickCursor, cursorFormation,
  createBobState, tickBob, bobSettled, bobTarget,
  smoothstep5, flightPos, flightDuration, chooseAvoidPosition, popupPhase,
};

})();
