// Pure geometry and timing shared by the desktop wand and its development page.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RougeWandGeometry = api;
})(typeof window === 'undefined' ? globalThis : window, () => {
  'use strict';
  const OUT_MS = 1500, HOLD_MS = 4000, BACK_MS = 1500;
  const MAX_HOLD_MS = 15000, READ_MS_PER_CHAR = 55;   // reading pace: about 18 characters a second
  const TOTAL_MS = OUT_MS + HOLD_MS + BACK_MS;
  const clamp = x => Math.max(0, Math.min(1, x));
  const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
  const mix = (a, b, t) => a + (b - a) * t;
  const S = 720 / 1145, CX = 770 * S, CY = 1020 * S;

  function rect(value) {
    if (!value) return null;
    const box = { x: value.x, y: value.y, w: value.w ?? value.width, h: value.h ?? value.height };
    return Object.values(box).every(Number.isFinite) && box.w > 0 && box.h > 0 ? box : null;
  }

  // How long the wrap stays on the target: a minimum, plus time to read what is said about it.
  function holdFor(text) {
    const chars = typeof text === 'string' ? text.trim().length : 0;
    return Math.round(Math.min(MAX_HOLD_MS, HOLD_MS + chars * READ_MS_PER_CHAR));
  }

  function timeline(elapsed, startReach = 0, hold = HOLD_MS) {
    const t = Math.max(0, elapsed);
    if (t < OUT_MS) return { phase: 'unwinding', reach: mix(startReach, 1, smooth(t / OUT_MS)) };
    if (t < OUT_MS + hold) return { phase: 'pointing', reach: 1 };
    if (t < OUT_MS + hold + BACK_MS) return { phase: 'rewinding', reach: 1 - smooth((t - OUT_MS - hold) / BACK_MS) };
    return { phase: 'idle', reach: 0 };
  }

  function polyline(points) {
    let s = 0;
    return points.map((p, i) => { if (i) s += Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y); return { ...p, s }; });
  }

  function sample(points, distance) {
    const end = points.length - 1, s = Math.max(0, Math.min(points[end].s, distance));
    let lo = 0, hi = end;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid].s < s) lo = mid; else hi = mid; }
    const a = points[lo], b = points[hi], t = (s - a.s) / (b.s - a.s || 1);
    return { x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) };
  }

  // The outline `o` px outside the target (corner radius `o`, so every point is exactly `o` away), as a closed loop: f runs 0..1 clockwise.
  function loop(box, o, f) {
    const W = box.w + 2 * o, H = box.h + 2 * o, R = Math.min(o, W / 2, H / 2);
    const sx = W - 2 * R, sy = H - 2 * R, arc = Math.PI * R / 2, P = 2 * sx + 2 * sy + 4 * arc;
    const x0 = box.x - o, y0 = box.y - o;
    let d = (((f % 1) + 1) % 1) * P;
    const corner = (cx, cy, a0) => { const a = a0 + d / R; return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), tx: -Math.sin(a), ty: Math.cos(a) }; };
    if (d < sx) return { x: x0 + R + d, y: y0, tx: 1, ty: 0 };
    d -= sx; if (d < arc) return corner(x0 + W - R, y0 + R, -Math.PI / 2);
    d -= arc; if (d < sy) return { x: x0 + W, y: y0 + R + d, tx: 0, ty: 1 };
    d -= sy; if (d < arc) return corner(x0 + W - R, y0 + H - R, 0);
    d -= arc; if (d < sx) return { x: x0 + W - R - d, y: y0 + H, tx: -1, ty: 0 };
    d -= sx; if (d < arc) return corner(x0 + R, y0 + H - R, Math.PI / 2);
    d -= arc; if (d < sy) return { x: x0, y: y0 + H - R - d, tx: 0, ty: -1 };
    d -= sy; return corner(x0 + R, y0 + R, Math.PI);
  }
  const loopLength = (box, o) => { const R = Math.min(o, (box.w + 2 * o) / 2, (box.h + 2 * o) / 2); return 2 * (box.w + 2 * o - 2 * R) + 2 * (box.h + 2 * o - 2 * R) + 2 * Math.PI * R; };

  const TURNS = 2;       // laps of the wrap; the last one lies tight against the target
  const GAP = 4;         // px between the wrapped ribbon's edge and the target (keeps the text clear of the clip)

  function plan(frame, target) {
    const box = rect(target);
    if (!box) return null;
    const root = { x: frame.x + (716 * S - CX) * frame.scale, y: frame.y + (1033 * S - CY) * frame.scale };
    const halfWidth = Math.max(2, 45 * S * frame.scale), tight = halfWidth + GAP, lap = halfWidth * 2 + 1;
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    // Each lap sits one ribbon-width further in until the last lies against the text box, like a coil.
    const offset = turn => tight + lap * (1 - Math.min(1, turn / TURNS)) ** 1.5;
    // Enter the wrap at the point of the outer lap nearest the root.
    let f0 = 0, best = Infinity;
    for (let i = 0; i < 720; i++) { const q = loop(box, offset(0), i / 720), d = Math.hypot(q.x - root.x, q.y - root.y); if (d < best) { best = d; f0 = i / 720; } }
    const entryPoint = loop(box, offset(0), f0);
    // Wind whichever way turns the arriving ribbon least.
    const sign = (entryPoint.x - root.x) * entryPoint.tx + (entryPoint.y - root.y) * entryPoint.ty >= 0 ? 1 : -1;
    const tx = entryPoint.tx * sign, ty = entryPoint.ty * sign;
    const span = Math.hypot(entryPoint.x - root.x, entryPoint.y - root.y), leave = Math.min(90, span * .3), land = Math.min(90, span * .25);
    const c1 = { x: root.x, y: root.y - leave }, c2 = { x: entryPoint.x - tx * land, y: entryPoint.y - ty * land };
    const points = [], steps = Math.max(24, Math.ceil(span / 4));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      points.push({ x: u ** 3 * root.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * entryPoint.x, y: u ** 3 * root.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * entryPoint.y });
    }
    const entryIndex = points.length - 1, wrapSteps = Math.ceil(loopLength(box, tight) * TURNS / 3);
    for (let i = 1; i <= wrapSteps; i++) {
      const turn = TURNS * i / wrapSteps, q = loop(box, offset(turn), f0 + sign * turn);
      points.push({ x: q.x, y: q.y });
    }
    const path = polyline(points);
    return { points: path, length: path.at(-1).s, entry: path[entryIndex], box, cx, cy, halfWidth, tight };
  }

  function blendPlans(previous, next, amount) {
    if (!previous || amount >= 1) return next;
    const points = [];
    for (let i = 0; i <= 400; i++) {
      const t = i / 400, a = sample(previous.points, t * previous.length), b = sample(next.points, t * next.length);
      points.push({ x: mix(a.x, b.x, amount), y: mix(a.y, b.y, amount) });
    }
    const dx = next.points[0].x - points[0].x, dy = next.points[0].y - points[0].y;
    points.forEach((p, i) => { const pull = (1 - i / 400) ** 3; p.x += dx * pull; p.y += dy * pull; });
    const path = polyline(points);
    return { ...next, points: path, length: path.at(-1).s };
  }

  function profile(frames, t) {
    const f = clamp(t) * (frames.length - 1), i = Math.min(frames.length - 2, Math.floor(f)), u = f - i, a = frames[i], b = frames[i + 1];
    return { x: mix(a.x, b.x, u), y: mix(a.y, b.y, u), lo: mix(a.lo, b.lo, u), hi: mix(a.hi, b.hi, u) };
  }

  function pose(rest, material, path, reach, frame) {
    const opening = smooth(reach / .16), restLength = rest.at(-1).s * frame.scale;
    const length = mix(restLength, path.length, reach), ratio = Math.min(1, length / path.length);
    const segments = Math.max(100, Math.min(900, Math.ceil(length / 3))), centers = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments, a = profile(rest, t), b = sample(path.points, t * length), width = profile(material, t * ratio);
      centers.push({ x: mix(frame.x + (a.x - CX) * frame.scale, b.x, opening), y: mix(frame.y + (a.y - CY) * frame.scale, b.y, opening), lo: mix(a.lo, width.lo, opening) * frame.scale, hi: mix(a.hi, width.hi, opening) * frame.scale, restU: t, openU: t * ratio });
    }
    // Rotate the released tip; interpolating opposite tangent vectors would pinch it shut.
    if (opening > 0 && opening < 1) {
      const a = profile(rest, 1), a0 = profile(rest, .995), b = sample(path.points, length), b0 = sample(path.points, length * .995);
      const start = Math.atan2(a.y - a0.y, a.x - a0.x), end = Math.atan2(b.y - b0.y, b.x - b0.x);
      let angle = end - start; while (angle > Math.PI) angle -= Math.PI * 2; while (angle < -Math.PI) angle += Math.PI * 2;
      const direction = start + angle * opening, magnitude = mix(restLength, length, opening), p = centers[segments], q = centers[segments - 2];
      const dx = Math.cos(direction) * magnitude - (p.x - q.x) * segments / 2, dy = Math.sin(direction) * magnitude - (p.y - q.y) * segments / 2;
      centers.forEach((p, i) => { const t = i / segments, weight = t ** 4 * (t - 1); p.x += dx * weight; p.y += dy * weight; });
    }
    return { centers, opening };
  }

  return { OUT_MS, HOLD_MS, MAX_HOLD_MS, BACK_MS, TOTAL_MS, holdFor, S, CX, CY, smooth, mix, rect, timeline, plan, blendPlans, pose, sample };
});
