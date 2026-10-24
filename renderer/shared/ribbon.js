// The ribbon: the material and the geometry shared by the mark (a trefoil
// knot tied in red satin) and the thread it lets out across the screen.
//
// A ribbon here is a centre line, a width direction at each point, and a
// light. Each short piece of the ribbon is lit from its own surface normal,
// with a soft body (half-Lambert), a satin streak (an anisotropic highlight
// that runs across the ribbon where it turns to the light) and a sheen at its
// edges. Both faces are red; a ribbon with a reverse can show it a shade deeper. Canvas 2D only, no
// libraries, nothing to load.
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const smooth = (v) => { const x = clamp(v, 0, 1); return (3 - 2 * x) * x * x; };
  const mix = (a, b, f) => a + (b - a) * f;

  // ---- colour --------------------------------------------------------------------
  const PALETTE = {
    front: [206, 14, 30],      // red satin
    back: [150, 9, 22],        // the underside, deeper
    shadow: [38, 2, 6],        // the darkest fold
    spec: [255, 196, 184],     // the streak of light on the weave, warm
    sheen: [255, 72, 56],      // the glow at a turning edge
  };
  const LIGHT = (() => { const l = [-0.42, -0.62, 0.66]; const n = Math.hypot(l[0], l[1], l[2]); return l.map((v) => v / n); })();
  const HALF = (() => { const h = [LIGHT[0], LIGHT[1], LIGHT[2] + 1]; const n = Math.hypot(h[0], h[1], h[2]); return h.map((v) => v / n); })();

  /**
   * The colour of one piece of ribbon.
   * @param {number} nx @param {number} ny @param {number} nz  surface normal, view space, any sign
   * @param {number} tx @param {number} ty @param {number} tz  direction the ribbon runs
   * @param {number} depth 0 far .. 1 near
   * @param {{lift?:number, glint?:number, tint?:number[], tintAmount?:number, oneSided?:boolean}} [o] lift: extra light; glint: travelling-light amount; oneSided: no deeper reverse
   * @returns {number[]} [r, g, b], 0..255
   */
  function shade(nx, ny, nz, tx, ty, tz, depth, o = {}) {
    const face = nz >= 0 ? 1 : -1;                 // which side of the ribbon is toward us
    const sx = nx * face; const sy = ny * face; const sz = nz * face;
    const ndl = sx * LIGHT[0] + sy * LIGHT[1] + sz * LIGHT[2];
    const wrap = 0.5 + 0.5 * ndl;
    const body = 0.2 + 0.8 * Math.pow(wrap, 1.35);
    // satin: bright where the ribbon runs across the half-vector (Kajiya-Kay)
    const th = tx * HALF[0] + ty * HALF[1] + tz * HALF[2];
    const along = Math.sqrt(Math.max(0, 1 - th * th));
    const nh = sx * HALF[0] + sy * HALF[1] + sz * HALF[2];
    const spec = Math.pow(along, 34) * (0.2 + 0.8 * clamp(nh * 0.5 + 0.5, 0, 1)) * (o.specK == null ? 1 : o.specK);
    // gloss: the face flashes where the ribbon rolls to mirror the light toward the eye
    const gloss = Math.pow(clamp((nh - 0.8) / 0.15, 0, 1), 2) * (o.glossK == null ? 1 : o.glossK);
    const sheen = Math.pow(1 - Math.min(1, Math.abs(nz)), 2.2);
    const base = o.oneSided || face > 0 ? PALETTE.front : PALETTE.back;
    const far = 0.72 + 0.28 * clamp(depth, 0, 1);
    const k = body * far * (1 + (o.lift || 0));
    const sp = spec * 0.8 * far + gloss * 0.46 * far + (o.glint || 0) * 0.55;
    const sh = sheen * 0.4 * far;
    let r = mix(PALETTE.shadow[0], base[0], clamp(k, 0, 1.15)) + PALETTE.spec[0] * sp + PALETTE.sheen[0] * sh;
    let g = mix(PALETTE.shadow[1], base[1], clamp(k, 0, 1.15)) + PALETTE.spec[1] * sp + PALETTE.sheen[1] * sh;
    let b = mix(PALETTE.shadow[2], base[2], clamp(k, 0, 1.15)) + PALETTE.spec[2] * sp + PALETTE.sheen[2] * sh;
    if (o.tint && o.tintAmount) { r = mix(r, o.tint[0], o.tintAmount); g = mix(g, o.tint[1], o.tintAmount); b = mix(b, o.tint[2], o.tintAmount); }
    return [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)];
  }

  const rgb = (c, a) => (a == null || a >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`);

  /** Read "#rrggbb" or "rgb(...)" from a CSS value. */
  function parseColor(raw, fallback) {
    const v = String(raw || '').trim();
    let m = v.match(/^#([0-9a-f]{6})$/i);
    if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    m = v.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : fallback;
  }

  // ---- a soft light on top of everything (the travelling light, the tip) -------------
  function glow(ctx, x, y, radius, color, strength) {
    if (strength <= 0 || radius <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, `rgba(255,236,238,${(0.62 * strength).toFixed(3)})`);
    g.addColorStop(0.3, `rgba(${mix(255, color[0], 0.6) | 0},${mix(120, color[1], 0.6) | 0},${mix(130, color[2], 0.6) | 0},${(0.34 * strength).toFixed(3)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // ---- 3D helpers (plain arrays, short and clear) ----------------------------------------
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  /**
   * Frames along a curve that do not flip: rotation-minimizing (double reflection).
   * @param {number[][]} P points  @param {number[][]} T unit tangents
   * @returns {number[][]} a unit "normal" at every point, perpendicular to its tangent
   */
  function transport(P, T) {
    const n = P.length;
    const t0 = T[0];
    const axis = Math.abs(t0[0]) < 0.6 ? [1, 0, 0] : [0, 1, 0];
    const R = [norm(cross(t0, axis))];
    for (let i = 0; i < n - 1; i += 1) {
      const v1 = [P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1], P[i + 1][2] - P[i][2]];
      const c1 = dot(v1, v1);
      let r = R[i];
      if (c1 > 1e-14) {
        const rl = [0, 1, 2].map((k) => r[k] - (2 / c1) * dot(v1, r) * v1[k]);
        const tl = [0, 1, 2].map((k) => T[i][k] - (2 / c1) * dot(v1, T[i]) * v1[k]);
        const v2 = [0, 1, 2].map((k) => T[i + 1][k] - tl[k]);
        const c2 = dot(v2, v2);
        r = c2 > 1e-14 ? [0, 1, 2].map((k) => rl[k] - (2 / c2) * dot(v2, rl) * v2[k]) : rl;
      }
      R.push(norm(r));
    }
    return R;
  }

  /** Unit tangents of a sampled curve (central differences). A closed curve repeats its first point last, so its ends look across the seam. */
  function tangents(P, closed) {
    const n = P.length;
    return P.map((_, i) => {
      const a = closed && (i === 0 || i === n - 1) ? P[n - 2] : P[Math.max(0, i - 1)];
      const b = closed && (i === 0 || i === n - 1) ? P[1] : P[Math.min(n - 1, i + 1)];
      return norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    });
  }

  window.SatinMaterial = { TAU, clamp, smooth, mix, shade, rgb, parseColor, glow, dot, cross, norm, transport, tangents, PALETTE };
})();
