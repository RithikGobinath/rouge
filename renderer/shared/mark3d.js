// The mark: a trefoil knot tied in red satin ribbon. One closed loop that
// tumbles slowly and carries a band of light around its own length. When the
// thread is let out, the last stretch of the ribbon is drawn away from the knot
// and straightens into a tail (strand.js carries it on across the screen).
// Canvas 2D, no libraries.
//
//   const mark = Mark3D.mount(canvas, { scale: 0.2, focusGate: false });
//   mark.setState('listening'); mark.setUnravel(0.5); mark.getTailFrame(1);
(() => {
  'use strict';
  const RB = window.SatinMaterial;
  const { TAU, clamp, smooth, mix } = RB;

  // ---- the shape (lengths in knot radii) ----------------------------------------------
  const SEAM = [0, -1 / 3, 0];                       // where the loop is closed
  const TAIL_DIR = RB.norm([0.18, -1, 0.12]);        // the way the tail is drawn out
  const TAIL_LEN = 1.7;                              // how long the tail is
  const HALF_WIDTH = 0.185;                          // half the ribbon's width
  const TWIST_TURNS = 2;                             // whole turns of the ribbon around its own length
  const TWIST_PHASE = 0.7;
  const CROWN = 0.34;                                // how much each half of the ribbon rolls away from flat
  const FOV = 6.2;
  const BASE_POSE = 2.35;                            // the pose where the loop reads as an S

  const trefoil = (t) => [(Math.sin(t) + 2 * Math.sin(2 * t)) / 3, (Math.cos(t) - 2 * Math.cos(2 * t)) / 3, -Math.sin(3 * t) / 1.2];

  /** How far along the part of the loop that becomes the tail: 0 before it, 1 at the seam. */
  const tailShare = (t) => smooth((t / TAU - 0.64) / 0.36);

  /** The loop at parameter t (0..2pi); with u > 0 its last stretch is drawn out into a straight tail. */
  function loopPoint(t, u) {
    const base = trefoil(t);
    const q = u > 0 ? tailShare(t) : 0;
    if (q <= 0) return base;
    const bow = 0.12 * Math.sin(Math.PI * q);
    const run = TAIL_LEN * q;
    const tail = [SEAM[0] + TAIL_DIR[0] * run + bow * 0.6, SEAM[1] + TAIL_DIR[1] * run, SEAM[2] + TAIL_DIR[2] * run + bow];
    const blend = q * smooth(u);
    return base.map((v, k) => mix(v, tail[k], blend));
  }

  // ---- the ribbon along it -------------------------------------------------------------
  let holonomy = null;                               // how far a transported frame is turned after one lap
  function lap() {
    if (holonomy != null) return holonomy;
    const P = []; for (let i = 0; i < 400; i += 1) P.push(trefoil((i / 399) * TAU));
    const T = RB.tangents(P, true);
    const Rn = RB.transport(P, T);
    const a = Rn[399]; const b = Rn[0];
    holonomy = Math.atan2(RB.dot(T[0], RB.cross(a, b)), RB.dot(a, b));
    return holonomy;
  }

  const viewerInCurveSpace = (() => { const m = matrix(BASE_POSE * 0.26, BASE_POSE * 0.17, 0); return [m[2][0], m[2][1], m[2][2]]; })();

  /** Centre line, tangents and width directions for a given unravel, n samples. */
  function build(n, u) {
    const P = []; for (let i = 0; i < n; i += 1) P.push(loopPoint((i / (n - 1)) * TAU, u));
    const T = RB.tangents(P, u <= 0);
    const Rn = RB.transport(P, T);
    const hol = lap();
    const W = []; const N = []; const H = [];
    for (let i = 0; i < n; i += 1) {
      const s = i / (n - 1);
      const th = TWIST_TURNS * TAU * s + TWIST_PHASE + hol * s;
      const c = Math.cos(th); const sn = Math.sin(th);
      const side = RB.cross(T[i], Rn[i]);
      let w = [Rn[i][0] * c + side[0] * sn, Rn[i][1] * c + side[1] * sn, Rn[i][2] * c + side[2] * sn];
      const off = u > 0 ? tailShare(s * TAU) * smooth(u) : 0;
      H.push(1 + 0.9 * off);                           // drawn out, the ribbon fans out wider
      if (off > 0) {
        // drawn out, the ribbon loses its twist and turns its face to the viewer
        let face = RB.norm(RB.cross(T[i], viewerInCurveSpace));
        if (RB.dot(face, w) < 0) face = [-face[0], -face[1], -face[2]];
        w = RB.norm([mix(w[0], face[0], off), mix(w[1], face[1], off), mix(w[2], face[2], off)]);
      }
      W.push(w); N.push(RB.norm(RB.cross(T[i], w)));
    }
    return { P, T, W, N, H, n, u };
  }

  /** A turn about Y, then X, then the screen: the matrix as three rows. */
  function matrix(rx, ry, rot) {
    const cx = Math.cos(rx); const sx = Math.sin(rx); const cy = Math.cos(ry); const sy = Math.sin(ry); const cr = Math.cos(rot); const sr = Math.sin(rot);
    const apply = (x, y, z) => {
      const x1 = x * cy + z * sy; const z1 = -x * sy + z * cy;
      const y1 = y * cx - z1 * sx; const z2 = y * sx + z1 * cx;
      return [x1 * cr - y1 * sr, x1 * sr + y1 * cr, z2];
    };
    const ex = apply(1, 0, 0); const ey = apply(0, 1, 0); const ez = apply(0, 0, 1);
    return [[ex[0], ey[0], ez[0]], [ex[1], ey[1], ez[1]], [ex[2], ey[2], ez[2]]];
  }
  const turn = (m, v) => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];

  // How each state moves and glows. The ribbon stays red; the state shows in how it moves and in the light.
  const STATES = {
    idle: { rock: 1, band: 1, glow: 0.3 },
    ready: { rock: 1.25, band: 1.35, glow: 0.45 },
    listening: { rock: 1.7, band: 1.9, glow: 0.72 },
    thinking: { rock: 2.4, band: 2.6, glow: 0.85 },
    speaking: { rock: 1.5, band: 2.4, glow: 0.8 },
    reading: { rock: 1.3, band: 2.2, glow: 1.05 },
  };

  function mount(canvas, opts = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    let size = opts.scale || 0.2;                      // radius of the knot, as a share of the canvas
    const quiet = opts.focusGate !== false;            // when the page is not focused, draw less often
    const pauseHidden = opts.pauseWhenHidden !== false;
    const icon = Boolean(opts.simple);                 // an icon: no halo, a bolder ribbon
    const halfWidth = HALF_WIDTH * (icon ? 1.3 : 1);
    let screenTurn = Number(opts.rotate) || 0;
    let calm = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) || /motion=reduce/.test(String(window.location && window.location.search));

    let state = 'idle'; let running = false; let frame = null; let last = performance.now();
    let time = opts.startTime == null ? BASE_POSE : Number(opts.startTime);
    let rock = STATES.idle.rock; let band = STATES.idle.band; let glowAmt = STATES.idle.glow;
    let bandTime = time; let level = 0; let liveLevel = 0;
    let unravel = 0; let unravelGoal = 0;
    let accent = [255, 110, 120]; let accentAt = 0;
    let boxW = canvas.clientWidth || 0; let boxH = canvas.clientHeight || 0;
    const geoCache = new Map();
    let quads = [];
    let cx = 0; let cy = 0; let R = 1; let dpr = 1;

    const samplesFor = (px) => clamp(Math.round(px * 1.6), 260, 900);
    function geometry(u) {
      const n = samplesFor(Math.min(canvas.width, canvas.height) || 200);
      const step = Math.round(u * 400);
      const key = `${n}:${step}`;
      let g = geoCache.get(key);
      if (!g) { g = build(n, step / 400); geoCache.set(key, g); if (geoCache.size > 40) geoCache.delete(geoCache.keys().next().value); }
      return g;
    }

    /** Tumbling a little about its resting pose, less and less as the ribbon is let out, so the tail holds still where the thread starts. */
    function pose() {
      const t = BASE_POSE + Math.sin(time * 0.18) * 0.16 * (1 - unravel * 0.85);
      return matrix(t * 0.26, t * 0.17, screenTurn);
    }
    const persp = (z) => FOV / (FOV - z * 1.6);
    function layout() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(boxW * dpr)); const h = Math.max(1, Math.round(boxH * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      cx = canvas.width / 2; cy = canvas.height / 2; R = Math.min(canvas.width, canvas.height) * size;
    }
    function readAccent(now) {
      if (now - accentAt < 500) return;
      accentAt = now;
      accent = RB.parseColor(getComputedStyle(canvas.parentElement || canvas).getPropertyValue('--mark-accent'), [255, 110, 120]);
    }

    // ---- one frame ---------------------------------------------------------------
    function draw(now) {
      if (quiet && typeof document !== 'undefined' && !document.hasFocus() && Math.random() < 0.66) { if (running) frame = requestAnimationFrame(draw); return; }
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const goal = STATES[state] || STATES.idle;
      const follow = (rate) => 1 - Math.exp(-dt * rate);                   // the share of the way to a goal that one frame covers
      rock += (goal.rock - rock) * follow(4.5); band += (goal.band - band) * follow(4.5); glowAmt += (goal.glow - glowAmt) * follow(4.5);
      unravel += (unravelGoal - unravel) * follow(2.75);
      time += dt * rock;
      level = liveLevel > level ? liveLevel : level + (liveLevel - level) * Math.min(1, dt * 5);
      bandTime += dt * band * (1 + level * 0.5);
      readAccent(now);
      layout();
      paint();
      if (running) frame = requestAnimationFrame(draw);
    }

    function paint() {
      const W = canvas.width; const H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      const glowE = Math.min(1.4, glowAmt * (1 + level * 0.6));
      const closed = 1 - unravel;
      if (!icon) {
        // a soft glow behind the knot, warmer and wider the more it is doing
        const halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.55);
        halo.addColorStop(0, `rgba(${accent[0]},${accent[1]},${accent[2]},${(0.06 + glowE * 0.12) * closed})`);
        halo.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = halo; ctx.fillRect(0, 0, W, H);
      }

      const g = geometry(unravel); const n = g.n;
      const M = pose();
      const xs = new Float32Array(n * 3); const ys = new Float32Array(n * 3); const zs = new Float32Array(n * 3);
      const Nv = new Array(n); const Tv = new Array(n); const Wv = new Array(n);
      for (let i = 0; i < n; i += 1) {
        const p = turn(M, g.P[i]); const w = turn(M, g.W[i]);
        Wv[i] = w; Nv[i] = turn(M, g.N[i]); Tv[i] = turn(M, g.T[i]);
        const reach = halfWidth * g.H[i];
        for (let side = -1; side <= 1; side += 1) {
          const x = p[0] + w[0] * reach * side; const y = p[1] + w[1] * reach * side; const z = p[2] + w[2] * reach * side;
          const k = persp(z); const j = i * 3 + side + 1;
          xs[j] = cx + x * R * k; ys[j] = cy + y * R * k; zs[j] = z;
        }
      }

      // the travelling light: a soft band that runs round the ribbon
      const at = ((bandTime * 0.11) % 1 + 1) % 1;
      const spread = 0.032;
      const glint = (s) => { let d = Math.abs(s - at); d = Math.min(d, 1 - d); return Math.exp(-(d * d) / (2 * spread * spread)); };

      // each short stretch of ribbon is two half-strips, one either side of the centre line
      let count = 0;
      for (let i = 0; i < n - 1; i += 1) {
        const s = i / (n - 1);
        const a = i * 3; const b = (i + 1) * 3;
        const lit = glint(s) * Math.min(1, band * 0.5) * (0.55 + glowE * 0.5);
        const depth = clamp(0.5 + 0.5 * (zs[a + 1] + zs[b + 1]) / 2, 0, 1);
        for (let half = 0; half < 2; half += 1) {
          const sgn = half === 0 ? -1 : 1;
          const face = RB.norm([Nv[i][0] + sgn * CROWN * Wv[i][0], Nv[i][1] + sgn * CROWN * Wv[i][1], Nv[i][2] + sgn * CROWN * Wv[i][2]]);
          const col = RB.shade(face[0], face[1], face[2], Tv[i][0], Tv[i][1], Tv[i][2], depth, { glint: lit, lift: lit * 0.25 });
          const e0 = half === 0 ? a : a + 2; const e1 = half === 0 ? b : b + 2;
          const q = quads[count] || (quads[count] = {});
          q.z = (zs[e0] + zs[e1] + zs[a + 1] + zs[b + 1]) / 4;
          q.x0 = xs[e0]; q.y0 = ys[e0]; q.x1 = xs[a + 1]; q.y1 = ys[a + 1];
          q.x2 = xs[b + 1]; q.y2 = ys[b + 1]; q.x3 = xs[e1]; q.y3 = ys[e1];
          q.fill = RB.rgb(col);
          q.hem = RB.rgb([col[0] * 0.5, col[1] * 0.5, col[2] * 0.5]);
          count += 1;
        }
      }
      quads.length = count;
      const order = new Array(count); for (let i = 0; i < count; i += 1) order[i] = i;
      order.sort((p, q) => quads[p].z - quads[q].z);
      const seam = Math.max(0.8, dpr * 0.8);
      ctx.lineJoin = 'round';
      for (let k = 0; k < count; k += 1) {
        const q = quads[order[k]];
        ctx.beginPath(); ctx.moveTo(q.x0, q.y0); ctx.lineTo(q.x1, q.y1); ctx.lineTo(q.x2, q.y2); ctx.lineTo(q.x3, q.y3); ctx.closePath();
        ctx.fillStyle = q.fill; ctx.fill();
        ctx.strokeStyle = q.fill; ctx.lineWidth = seam; ctx.stroke();
        // a darker hem along the outer edge, so the ribbon reads as cloth with an edge
        ctx.beginPath(); ctx.moveTo(q.x0, q.y0); ctx.lineTo(q.x3, q.y3);
        ctx.strokeStyle = q.hem; ctx.lineWidth = Math.max(0.7, dpr * 0.85); ctx.lineCap = 'round'; ctx.stroke();
      }

      // the light, over everything
      if (!icon) {
        const j = Math.min(n - 1, Math.max(0, Math.round(at * (n - 1)))) * 3 + 1;
        RB.glow(ctx, xs[j], ys[j], R * (0.16 + glowE * 0.1), accent, 0.28 + glowE * 0.38);
      }
    }

    // ---- where things are, for the thread ---------------------------------------------
    /** The open end of the ribbon at unravel level u (the closed knot's seam when u is 0), in viewport pixels. */
    function tailFrame(u) {
      layout();
      const g = geometry(u == null ? unravel : clamp(Number(u) || 0, 0, 1));
      const i = g.n - 1;
      const M = pose();
      const p = turn(M, g.P[i]); const w = turn(M, g.W[i]); const t = turn(M, g.T[i]);
      const r = canvas.getBoundingClientRect();
      const kx = canvas.width && r.width ? r.width / canvas.width : 1; const ky = canvas.height && r.height ? r.height / canvas.height : 1;
      const k = persp(p[2]);
      const px = cx + p[0] * R * k; const py = cy + p[1] * R * k;
      const reach = halfWidth * g.H[i];
      const wx = w[0] * reach * R * k * kx; const wy = w[1] * reach * R * k * ky;
      const tl = Math.hypot(t[0], t[1]) || 1;
      return { x: r.left + px * kx, y: r.top + py * ky, z: p[2], r: reach * R * k * kx, tx: t[0] / tl, ty: t[1] / tl, wx, wy, hw: Math.hypot(wx, wy), face: Math.abs(turn(M, g.N[i])[2]) };
    }

    function play() { if (running) return; running = true; last = performance.now(); frame = requestAnimationFrame(draw); }
    function halt() { running = false; if (frame) cancelAnimationFrame(frame); frame = null; }
    const onVisibility = () => { if (document.hidden) halt(); else play(); };

    const remeasure = () => { const b = canvas.getBoundingClientRect(); boxW = b.width; boxH = b.height; geoCache.clear(); if (!running) { layout(); paint(); } };
    let watcher = null;
    if (window.ResizeObserver) { watcher = new ResizeObserver((e) => { const b = e[e.length - 1].contentRect; boxW = b.width; boxH = b.height; geoCache.clear(); if (!running) { layout(); paint(); } }); watcher.observe(canvas); }
    window.addEventListener('resize', remeasure);

    layout();
    if (calm) { time = BASE_POSE; layout(); paint(); canvas.classList.add('mark-static'); } else { play(); if (pauseHidden) document.addEventListener('visibilitychange', onVisibility); }

    return {
      setState(next) { state = STATES[next] ? next : 'idle'; accentAt = 0; if (calm) { layout(); paint(); } },
      setReducedMotion(v) { calm = !!v; if (calm) { halt(); unravel = unravelGoal; layout(); paint(); } else play(); },
      setLevel(v) { if (!calm) liveLevel = clamp(Number(v) || 0, 0, 1); },
      /** How big the knot is drawn, as a fraction of its canvas (the strip's is smaller than the corner's). */
      setScale(v) { size = clamp(Number(v) || 0.2, 0.08, 0.4); geoCache.clear(); layout(); if (calm || !running) paint(); },
      setUnravel(v) { unravelGoal = clamp(Number(v) || 0, 0, 1); if (calm) { unravel = unravelGoal; layout(); paint(); } },
      getUnravel: () => unravel,
      setRotate(rad) { screenTurn = Number(rad) || 0; if (calm || !running) { layout(); paint(); } },
      getRotate: () => screenTurn,
      getTailAnchor: (u) => tailFrame(u),
      getTailFrame: (u) => tailFrame(u),
      /** Draw one still frame at a chosen moment (icons, previews). */
      still({ at = BASE_POSE, unravel: uu = 0, bandAt = 0.12 } = {}) { time = at; unravel = unravelGoal = clamp(uu, 0, 1); bandTime = bandAt / 0.11; layout(); paint(); },
      pause() { halt(); },
      resume() { if (!calm) play(); else { layout(); paint(); } },
      destroy() { halt(); document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('resize', remeasure); if (watcher) watcher.disconnect(); },
    };
  }

  window.Mark3D = { mount };
})();
