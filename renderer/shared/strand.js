// The thread: the mark's own ribbon, let out across the screen to the one spot
// it is talking about, and drawn back in when it is done.
//
// Everything is in the overlay's CSS pixels. The ribbon leaves the end of the
// mark's unrolled tail, takes one gentle S-curve to just short of the target and
// finishes in a small curl, like the end of a gift ribbon. While it travels it
// rolls slowly about its own length so the satin catches the light, and a small
// wave runs down it. "Reach" runs from 0 (all of it in the mark) to 1 (all of it
// out); the mark unrolls its loop as the ribbon leaves. Clock reminders end
// in a straight underline and clip the clock text out of the ribbon's drawing.
//
//   const thread = Strand.mount(canvas, mark, { onArrive, onRewound });
//   thread.setTarget({ x, y, w, h });   thread.rewind();
(() => {
  'use strict';
  const RB = window.SatinMaterial;
  const { clamp, smooth, mix } = RB;

  const STEP = 3;               // px between samples along the path
  const SETTLE = 150;           // px over which the ribbon eases from the mark's own width and roll into its own
  const STOP_SHORT = 12;        // the end of the curve halts this far outside the target
  const FLARE = 1.12;           // the free ribbon is this much wider than the mark's tail
  const ROLL = 0.8;             // radians it rolls to either side as it travels
  const ROLL_EVERY = 230;       // px of ribbon per roll
  const WAVE = 10;              // px of side-to-side wave while it is let out
  const CROWN = 0.2;            // how far each half of the ribbon rolls away from flat
  const REACH_BACK = 15;        // px it reaches back over the mark's tail, fading in, so the two meet without a seam
  const CURL_TURN = 5.2;        // radians the end of the ribbon curls over
  const CURL_FROM = 19;         // px: radius of the curl where it starts ...
  const CURL_TO = 6.5;          // ... and where it ends
  const CURL_WIDTH = 0.55;      // how narrow the ribbon is at the very end of the curl
  const HOLD_MS = 30000;        // how long a settled thread keeps moving before it holds still
  const MORPH_MS = 300;         // aimed at a new spot while out: how long the curve takes to follow
  const OUT = { base: 650, perPx: 0.25, cap: 800 };      // ms to let the thread out
  const BACK = { base: 420, perPx: 0.12, cap: 600 };     // ms to draw it in

  const inOut = (v) => { const x = clamp(v, 0, 1); return x < 0.5 ? 4 * x * x * x : 1 - 4 * (1 - x) * (1 - x) * (1 - x); };
  const outCubic = (v) => { const r = 1 - clamp(v, 0, 1); return 1 - r * r * r; };
  const gap = (p, q) => Math.hypot(q.x - p.x, q.y - p.y);

  /** The point just outside the target where the curve stops: on the line from its middle toward the mark. */
  function stopPoint(box, from) {
    const cx = box.x + box.w / 2; const cy = box.y + box.h / 2;
    const d = Math.hypot(from.x - cx, from.y - cy) || 1;
    const ux = (from.x - cx) / d; const uy = (from.y - cy) / d;
    const k = Math.min((box.w / 2 + STOP_SHORT) / Math.max(1e-4, Math.abs(ux)), (box.h / 2 + STOP_SHORT) / Math.max(1e-4, Math.abs(uy)), d - 4);
    return { x: cx + ux * k, y: cy + uy * k };
  }

  /**
   * The curve as four points (where it leaves the mark, two that shape the bend,
   * where it stops) and the middle of what it reaches for. It leaves the way the
   * tail already points and bows toward the middle of the screen, so a thread
   * from a corner sweeps in rather than hugging the edge.
   */
  function aimAt(open, box, W, H, underline) {
    const a = { x: open.x, y: open.y };
    let line = null;
    if (underline) {
      const left = clamp(box.x, 6, W - 6); const right = clamp(box.x + box.w, left, W - 6);
      // Keep the thick stroke outside the clock even when there is no room below it.
      const y = box.y + box.h + 18 <= H ? box.y + box.h + 12 : Math.max(6, box.y - 12);
      const fromRight = a.x > (left + right) / 2;
      line = { start: { x: fromRight ? right : left, y }, end: { x: fromRight ? left : right, y } };
    }
    const b = line ? line.start : stopPoint(box, a);
    const span = gap(a, b) || 1;
    const ux = (b.x - a.x) / span; const uy = (b.y - a.y) / span;
    const hl = Math.hypot(open.tx, open.ty) || 1;
    const hx = open.tx / hl; const hy = open.ty / hl;
    let sx = -uy; let sy = ux;
    if (sx * (W / 2 - (a.x + b.x) / 2) + sy * (H / 2 - (a.y + b.y) / 2) < 0) { sx = -sx; sy = -sy; }
    const bow = clamp(span * 0.12, 14, 120);
    const leave = Math.min(span * 0.32, 96); const land = Math.min(span * 0.3, 130);
    const inside = (x, y) => ({ x: clamp(x, 10, W - 10), y: clamp(y, 10, H - 10) });
    return {
      a, b,
      c1: inside(a.x + hx * leave + sx * bow * 0.45, a.y + hy * leave + sy * bow * 0.45),
      c2: inside(b.x - ux * land + sx * bow * 0.7, b.y - uy * land + sy * bow * 0.7),
      mid: { x: box.x + box.w / 2, y: box.y + box.h / 2 },
      line,
    };
  }

  const blendPlans = (p, q, f) => {
    const lerp = (m, n) => ({ x: mix(m.x, n.x, f), y: mix(m.y, n.y, f) });
    return { a: lerp(p.a, q.a), c1: lerp(p.c1, q.c1), c2: lerp(p.c2, q.c2), b: lerp(p.b, q.b), mid: lerp(p.mid, q.mid), line: q.line };
  };

  /**
   * A plan as points along it, each with the length of ribbon behind it: the
   * curve itself, then a curl that bends away from the target and tightens as it
   * goes. `main` is the length at the end of the curve, before the curl.
   */
  function flatten(plan) {
    const { a, c1, c2, b, mid } = plan;
    const n = Math.max(6, Math.ceil((gap(a, c1) + gap(c1, c2) + gap(c2, b)) / STEP));
    const xs = []; const ys = []; const len = [];
    for (let i = 0; i <= n; i += 1) {
      const t = i / n; const u = 1 - t;
      const w0 = u * u * u; const w1 = 3 * u * u * t; const w2 = 3 * u * t * t; const w3 = t * t * t;
      xs.push(w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x);
      ys.push(w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y);
      len.push(i ? len[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]) : 0);
    }
    const main = len[n];
    if (plan.line) {
      const end = plan.line.end;
      const count = Math.max(1, Math.ceil(gap(b, end) / STEP));
      for (let i = 1; i <= count; i += 1) {
        const t = i / count; const x = mix(b.x, end.x, t); const y = mix(b.y, end.y, t);
        len.push(len[len.length - 1] + Math.hypot(x - xs[xs.length - 1], y - ys[ys.length - 1]));
        xs.push(x); ys.push(y);
      }
      return { n: xs.length, x: Float32Array.from(xs), y: Float32Array.from(ys), len: Float32Array.from(len), main, total: len[len.length - 1] };
    }
    // the way it is heading as it arrives, and which side the target is on: the curl goes the other way
    let hx = b.x - c2.x; let hy = b.y - c2.y;
    const hl = Math.hypot(hx, hy) || 1; hx /= hl; hy /= hl;
    const side = (hx * (mid.y - b.y) - hy * (mid.x - b.x)) > 0 ? -1 : 1;
    let heading = Math.atan2(hy, hx); let turned = 0; let x = b.x; let y = b.y;
    while (turned < CURL_TURN) {
      const r = mix(CURL_FROM, CURL_TO, turned / CURL_TURN);
      const dTurn = STEP / r;
      heading += side * dTurn; turned += dTurn;
      x += Math.cos(heading) * STEP; y += Math.sin(heading) * STEP;
      xs.push(x); ys.push(y); len.push(len[len.length - 1] + STEP);
    }
    return { n: xs.length, x: Float32Array.from(xs), y: Float32Array.from(ys), len: Float32Array.from(len), main, total: len[len.length - 1] };
  }

  /** Unit tangents of a polyline, by central differences. */
  function directions(xs, ys) {
    const n = xs.length; const tx = new Array(n); const ty = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const lo = Math.max(0, i - 1); const hi = Math.min(n - 1, i + 1);
      const dx = xs[hi] - xs[lo]; const dy = ys[hi] - ys[lo]; const d = Math.hypot(dx, dy) || 1;
      tx[i] = dx / d; ty[i] = dy / d;
    }
    return { tx, ty };
  }

  function mount(canvas, mark, opts = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx || !mark) return null;
    const callback = (fn) => (typeof fn === 'function' ? fn : () => {});
    const onArrive = callback(opts.onArrive);
    const onRewound = callback(opts.onRewound);
    let calm = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) || /motion=reduce/.test(String(window.location && window.location.search));

    let phase = 'rest';                              // rest | out | held | back
    let box = null;                                  // what it reaches for
    let underline = false; let holdMs = HOLD_MS;
    let plan = null; let earlier = null; let planAt = 0; let flat = null;     // the curve; the one it is following from; when it was set; its points
    let tail = null;                                 // the mark's open end when the plan was made
    let reach = 0; let tween = null;                 // how much is out, and what is moving it
    let heldAt = 0;
    let tipAt = null;
    let W = 0; let H = 0; let ratio = 1;
    let running = false; let raf = null; let prev = performance.now(); let clock = 0;
    let ink = [255, 96, 108]; let inkAt = 0;

    function fit() {
      W = window.innerWidth; H = window.innerHeight; ratio = Math.min(2, window.devicePixelRatio || 1);
      const pw = Math.round(W * ratio); const ph = Math.round(H * ratio);
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    }
    function readInk(now) {
      if (now - inkAt < 500) return;
      inkAt = now;
      ink = RB.parseColor(getComputedStyle(canvas).getPropertyValue('--thread-accent'), [255, 96, 108]);
    }

    function replan() {
      fit();
      const open = mark.getTailFrame(1);
      if (!open || !box) return false;
      const now = performance.now();
      earlier = plan ? currentPlan(now) : null;
      plan = aimAt(open, box, W, H, underline); planAt = now; flat = null; tail = open;
      return true;
    }
    function currentPlan(now) {
      const k = (now - planAt) / MORPH_MS;
      return earlier && k < 1 ? blendPlans(earlier, plan, smooth(k)) : plan;
    }
    function currentPath(now) {
      if (earlier && now - planAt < MORPH_MS) return flatten(currentPlan(now));
      earlier = null;
      return flat || (flat = flatten(plan));
    }

    const moveReach = (to, ms, curve, now) => { tween = { from: reach, to, ms: Math.max(1, ms), at: now, curve }; };
    const lengthNow = () => (plan ? (flat || (flat = flatten(plan))).total : 0);

    /** Four corner marks round the spot, breathing a little, over a faint wash of colour. */
    function drawSpot(now, strength) {
      if (!box || strength <= 0) return;
      const breathe = 4 + 1.6 * Math.sin(now / 380);
      const x = box.x - breathe; const y = box.y - breathe; const w = box.w + breathe * 2; const h = box.h + breathe * 2;
      const leg = clamp(Math.min(w, h) * 0.34, 7, 16);
      ctx.save(); ctx.scale(ratio, ratio); ctx.globalAlpha = strength;
      ctx.fillStyle = 'rgba(230,57,80,0.08)';
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.fill();
      ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(232,48,74,0.95)';
      ctx.beginPath();
      ctx.moveTo(x, y + leg); ctx.lineTo(x, y); ctx.lineTo(x + leg, y);
      ctx.moveTo(x + w - leg, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + leg);
      ctx.moveTo(x + w, y + h - leg); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - leg, y + h);
      ctx.moveTo(x + leg, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - leg);
      ctx.stroke();
      ctx.restore();
    }

    /**
     * The visible length of ribbon as samples: where each is, how far along the
     * ribbon, how wide, how far rolled, and its two edges. The first stretch is
     * pulled onto the mark's live tail so the two always meet.
     */
    function samples(path, visible, live) {
      const half0 = Math.max(2, live.r || 6);
      const phi0 = Math.acos(clamp((live.hw || half0) / half0, 0.12, 1));
      const dx0 = live.x - path.x[0]; const dy0 = live.y - path.y[0];
      const px = []; const py = []; const run = [];
      const hd = Math.hypot(path.x[1] - path.x[0], path.y[1] - path.y[0]) || 1;
      const ex = (path.x[1] - path.x[0]) / hd; const ey = (path.y[1] - path.y[0]) / hd;
      for (let k = Math.ceil(REACH_BACK / STEP); k >= 1; k -= 1) { px.push(live.x - ex * k * STEP); py.push(live.y - ey * k * STEP); run.push(-k * STEP); }
      for (let i = 0; i < path.n && path.len[i] <= visible; i += 1) {
        const pull = smooth(1 - path.len[i] / SETTLE);
        px.push(path.x[i] + dx0 * pull); py.push(path.y[i] + dy0 * pull); run.push(path.len[i]);
      }
      const n = px.length;
      if (n < 2) return null;
      // let out, the ribbon waves a little, most toward its free end; once it has arrived the wave dies away, and it never reaches the curl
      const amp = phase === 'out' ? WAVE : WAVE * 0.3;
      const before = directions(px, py);
      for (let i = 0; i < n; i += 1) {
        if (run[i] <= 0) continue;
        const settled = phase === 'out' ? 1 : smooth((visible - run[i]) / 70);
        const clear = smooth((path.main - run[i]) / 90);
        const off = amp * Math.sin(run[i] / 140 - clock * 2.6) * smooth(run[i] / SETTLE) * settled * clear;
        px[i] -= before.ty[i] * off; py[i] += before.tx[i] * off;
      }
      const { tx, ty } = directions(px, py);
      const phi = new Array(n); const shine = new Array(n);
      const lx = new Array(n); const ly = new Array(n); const rx = new Array(n); const ry = new Array(n);
      for (let i = 0; i < n; i += 1) {
        const ease = smooth(run[i] / SETTLE);
        const tip = path.total > path.main ? smooth((run[i] - path.main) / (path.total - path.main)) : 0;      // 0 along the curve, 1 at the end of the curl
        const onLine = underline && run[i] >= path.main;
        const hw = onLine ? 4 : mix(half0, half0 * FLARE, ease) * mix(1, CURL_WIDTH, tip);
        // a gentle roll, never edge-on: the satin keeps showing its face; it settles flat as it curls
        const free = ROLL * Math.sin(run[i] / ROLL_EVERY - clock * 1.1) + 0.2 * Math.sin(run[i] / 83 + clock * 0.7);
        phi[i] = onLine ? 0 : mix(phi0, free, ease) * mix(1, 0.35, tip);
        shine[i] = 0.5 + 0.5 * Math.sin(run[i] / 70 - clock * 2.2);
        const across = Math.max(0.9, hw * Math.abs(Math.cos(phi[i])));
        lx[i] = px[i] + ty[i] * across; ly[i] = py[i] - tx[i] * across;
        rx[i] = px[i] - ty[i] * across; ry[i] = py[i] + tx[i] * across;
      }
      return { n, px, py, run, tx, ty, phi, shine, lx, ly, rx, ry };
    }

    function paintRibbon(s) {
      ctx.save(); ctx.scale(ratio, ratio); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      // one soft shadow for the whole outline, so the ribbon lifts off whatever is behind it
      const first = s.run.findIndex((l) => l >= 0);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = underline ? 0 : 11; ctx.shadowOffsetY = underline ? 0 : 5; ctx.fillStyle = 'rgb(46,3,8)';
      ctx.beginPath(); ctx.moveTo(s.lx[first], s.ly[first]);
      for (let i = first + 1; i < s.n; i += 1) ctx.lineTo(s.lx[i], s.ly[i]);
      for (let i = s.n - 1; i >= first; i -= 1) ctx.lineTo(s.rx[i], s.ry[i]);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      for (let i = 0; i < s.n - 1; i += 1) {
        const j = i + 1;
        const c = Math.cos(s.phi[i]); const sn = Math.sin(s.phi[i]);
        // the width direction W = n cos(phi) + z sin(phi), and the face N = T x W
        const wx = -s.ty[i] * c; const wy = s.tx[i] * c; const wz = sn;
        const nx = s.ty[i] * sn; const ny = -s.tx[i] * sn; const nz = c;
        const sheen = 0.1 * s.shine[i];
        ctx.globalAlpha = s.run[i] < 0 ? clamp((s.run[i] + REACH_BACK) / REACH_BACK, 0, 1) * 0.9 : 1;
        for (const side of [-1, 1]) {
          const face = RB.norm([nx + side * CROWN * wx, ny + side * CROWN * wy, nz + side * CROWN * wz]);
          const col = RB.shade(face[0], face[1], face[2], s.tx[i], s.ty[i], 0, 0.9 + 0.08 * Math.sin(s.phi[i]), { glint: sheen, lift: sheen * 0.4, specK: 0.55, glossK: 0.6, oneSided: true });
          const ox = side < 0 ? s.lx : s.rx; const oy = side < 0 ? s.ly : s.ry;
          const fill = RB.rgb(col);
          ctx.beginPath(); ctx.moveTo(ox[i], oy[i]); ctx.lineTo(s.px[i], s.py[i]); ctx.lineTo(s.px[j], s.py[j]); ctx.lineTo(ox[j], oy[j]); ctx.closePath();
          ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = fill; ctx.lineWidth = 0.7; ctx.stroke();
          ctx.beginPath(); ctx.moveTo(ox[i], oy[i]); ctx.lineTo(ox[j], oy[j]);
          ctx.strokeStyle = RB.rgb([col[0] * 0.5, col[1] * 0.5, col[2] * 0.5]); ctx.lineWidth = 0.85; ctx.stroke();
        }
      }
      ctx.restore();
    }

    function frame(now) {
      const dt = Math.min(0.05, (now - prev) / 1000); prev = now; clock += dt;
      fit(); readInk(now);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      let done = false;
      if (tween) {
        const k = clamp((now - tween.at) / tween.ms, 0, 1);
        reach = tween.from + (tween.to - tween.from) * tween.curve(k);
        done = k >= 1;
      }
      if (mark.setUnravel) mark.setUnravel(clamp(reach * 1.6, 0, 1));
      if (done && phase === 'out') { phase = 'held'; heldAt = now; tween = null; onArrive(); }
      else if (done && phase === 'back') { clearAll(); halt(); onRewound(); return; }

      const path = plan ? currentPath(now) : null;
      if (!path || reach <= 0.001 || !tail) { next(); return; }
      const visible = reach * path.total;
      const s = samples(path, visible, mark.getTailFrame() || tail);
      if (!s) { next(); return; }
      if (underline) {
        // Even if the incoming curve passes the clock, never paint its digits.
        ctx.save(); ctx.beginPath();
        ctx.rect(0, 0, canvas.width, canvas.height);
        ctx.rect((box.x - 3) * ratio, (box.y - 3) * ratio, (box.w + 6) * ratio, (box.h + 6) * ratio);
        ctx.clip('evenodd');
      }
      paintRibbon(s);
      if (underline) ctx.restore();
      // the tip the answer sits beside is where the curve ends, not the end of the curl
      const at = Math.min(s.n - 1, Math.max(0, s.run.findIndex((l) => l >= Math.min(visible, path.main))));
      tipAt = { x: s.px[at >= 0 ? at : s.n - 1], y: s.py[at >= 0 ? at : s.n - 1] };
      if (!underline && phase === 'out') { ctx.save(); ctx.scale(ratio, ratio); RB.glow(ctx, s.px[s.n - 1], s.py[s.n - 1], 15, ink, 0.6); ctx.restore(); }
      if (!underline) drawSpot(now, phase === 'held' ? 1 : phase === 'out' ? smooth((reach - 0.9) / 0.1) : smooth((reach - 0.85) / 0.15));
      if (phase === 'held' && now - planAt >= MORPH_MS && (calm || now - heldAt >= holdMs)) { halt(); return; }
      next();
    }

    function next() { if (running) raf = requestAnimationFrame(frame); }
    function begin() { if (running) return; running = true; prev = performance.now(); raf = requestAnimationFrame(frame); }
    function halt() { running = false; if (raf) cancelAnimationFrame(raf); raf = null; }
    function clearAll() { phase = 'rest'; reach = 0; tween = null; heldAt = 0; tipAt = null; box = null; plan = null; earlier = null; flat = null; }
    const onResize = () => { if (box && phase !== 'rest') { replan(); frame(performance.now()); } };
    window.addEventListener('resize', onResize);

    return {
      /** Let the thread out to a box (window CSS px). Asked again while it is out, it stays out and its end moves. */
      setTarget(rect, options = {}) {
        if (!rect) return this.rewind();
        underline = options.underline === true;
        holdMs = Number.isFinite(options.holdMs) ? Math.max(0, options.holdMs) : HOLD_MS;
        box = { x: Number(rect.x) || 0, y: Number(rect.y) || 0, w: Math.max(1, Number(rect.w) || 1), h: Math.max(1, Number(rect.h) || 1) };
        inkAt = 0;
        if (!replan()) return false;
        const now = performance.now();
        if (phase === 'held') {
          reach = 1; tween = null; heldAt = now;
          if (calm) frame(now); else begin();
          onArrive();
          return true;
        }
        phase = 'out';
        if (calm) { reach = 1; tween = null; frame(now); phase = 'held'; heldAt = now; halt(); onArrive(); return true; }
        moveReach(1, Math.min(OUT.cap, OUT.base + lengthNow() * OUT.perPx), inOut, now);
        begin();
        return true;
      },
      rewind() {
        if (phase === 'rest') return;
        const now = performance.now();
        phase = 'back';
        if (calm) { if (mark.setUnravel) mark.setUnravel(0); ctx.clearRect(0, 0, canvas.width, canvas.height); clearAll(); halt(); onRewound(); return; }
        moveReach(0, Math.min(BACK.cap, BACK.base + lengthNow() * BACK.perPx), outCubic, now);
        begin();
      },
      setTask(task) { canvas.dataset.task = String(task || ''); inkAt = 0; },
      setReducedMotion(v) { calm = !!v; if (calm && phase !== 'rest') { halt(); } },
      getTip: () => (tipAt ? { x: tipAt.x, y: tipAt.y } : null),
      getTarget: () => (box ? { ...box } : null),
      getState: () => ({ rest: 'idle', out: 'unwinding', held: 'pointing', back: 'rewinding' }[phase]),
      getProgress: () => reach,
      relayout() { if (box) replan(); },
      pause() { halt(); },
      resume() { if (phase !== 'rest' && !calm) begin(); },
      destroy() { halt(); window.removeEventListener('resize', onResize); },
    };
  }

  window.Strand = { mount };
})();
