// Pure geometry and timing shared by the desktop wand and its development page.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RougeWandGeometry = api;
})(typeof window === 'undefined' ? globalThis : window, () => {
  'use strict';
  const OUT_MS = 1500, HOLD_MS = 2000, BACK_MS = 1500;
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

  function developmentTarget(text, width, height) {
    if (typeof text !== 'string' || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    const command = text.trim().match(/^(?:point(?:\s+to)?|circle|orbit\s+around)\s+([a-d])$/i);
    if (!command) return null;
    const key = command[1].toLowerCase(), positions = { a: [.18, .24], b: [.72, .2], c: [.26, .68], d: [.7, .62] };
    const w = Math.min(140, width * .25), h = Math.min(44, height * .15), inset = Math.min(12, width * .05, height * .05);
    const [x, y] = positions[key];
    return { key, rect: { x: Math.round(inset + (width - w - inset * 2) * x), y: Math.round(inset + (height - h - inset * 2) * y), w, h } };
  }

  function timeline(elapsed, startReach = 0) {
    const t = Math.max(0, elapsed);
    if (t < OUT_MS) return { phase: 'unwinding', reach: mix(startReach, 1, smooth(t / OUT_MS)) };
    if (t < OUT_MS + HOLD_MS) return { phase: 'pointing', reach: 1 };
    if (t < TOTAL_MS) return { phase: 'rewinding', reach: 1 - smooth((t - OUT_MS - HOLD_MS) / BACK_MS) };
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

  function plan(frame, target) {
    const box = rect(target);
    if (!box) return null;
    const root = { x: frame.x + (716 * S - CX) * frame.scale, y: frame.y + (1033 * S - CY) * frame.scale };
    const halfWidth = Math.max(2, 45 * S * frame.scale), clearance = halfWidth + 14;
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    // sqrt(2) keeps all four text-box corners inside the ellipse, not just its axes.
    const rx = Math.SQRT2 * (box.w / 2 + clearance), ry = Math.SQRT2 * (box.h / 2 + clearance);
    const angle = Math.atan2((root.y - cy) / ry, (root.x - cx) / rx);
    const entry = { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
    const direction = root.x < cx ? -1 : 1;
    const tx = -rx * Math.sin(angle) * direction, ty = ry * Math.cos(angle) * direction, tangent = Math.hypot(tx, ty);
    const span = Math.hypot(entry.x - root.x, entry.y - root.y), leave = Math.min(90, span * .3), land = Math.min(90, span * .25);
    const c1 = { x: root.x, y: root.y - leave };
    const c2 = { x: entry.x - tx / tangent * land, y: entry.y - ty / tangent * land };
    const points = [], steps = Math.max(24, Math.ceil(span / 4));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      points.push({ x: u ** 3 * root.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * entry.x, y: u ** 3 * root.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * entry.y });
    }
    const entryIndex = points.length - 1, sweep = Math.PI * 1.82, arcSteps = Math.max(90, Math.ceil(sweep * Math.max(rx, ry) / 4));
    for (let i = 1; i <= arcSteps; i++) {
      const a = angle + direction * sweep * i / arcSteps;
      points.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
    }
    const path = polyline(points);
    return { points: path, length: path.at(-1).s, entry: path[entryIndex], box, rx, ry, cx, cy };
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

  return { OUT_MS, HOLD_MS, BACK_MS, TOTAL_MS, S, CX, CY, smooth, mix, rect, developmentTarget, timeline, plan, blendPlans, pose, sample };
});
