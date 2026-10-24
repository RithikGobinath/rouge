(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const dock = $('#mark'); const tag = $('#tag'); const toast = $('#toast');
  const mark = Mark3D.mount($('#mark-canvas'), { scale: 0.2, focusGate: false });
  const thread = Strand.mount($('#thread'), mark, { onArrive: arrived, onRewound: rewound });

  // the places to click, in order
  const STEPS = [
    { el: $('#b-export'), label: 'Export', said: 'Exported.' },
    { el: $('#b-share'), label: 'Share', said: 'Shared.' },
    { el: $('#b-save'), label: 'Save', said: 'Saved.' },
  ];
  const DWELL_MS = 2600;     // a spot the person clicked is held this long, then drawn back in
  const PAUSE_MS = 600;      // between the ribbon being back in and the next one going out
  let at = -1;               // the step the ribbon is out to; -1 when it is out to a spot, or in
  let reaching = null;       // what it is out to: { box, text }
  let after = null;          // what to do once it is back in
  let dwell = 0; let toastTimer = 0;

  /** Turn the mark so its open end points at the middle of the page, from whichever corner it sits in. */
  function aimMark() {
    mark.setRotate(0);
    const open = mark.getTailAnchor(1);
    if (!open) return;
    const r = dock.getBoundingClientRect();
    const want = Math.atan2(innerHeight / 2 - (r.top + r.height / 2), innerWidth / 2 - (r.left + r.width / 2));
    mark.setRotate(want - Math.atan2(open.ty, open.tx));
  }

  const boxOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const inside = (box, x, y, slack) => x >= box.x - slack && x <= box.x + box.w + slack && y >= box.y - slack && y <= box.y + box.h + slack;

  function say(text) {
    clearTimeout(toastTimer);
    toast.textContent = text; toast.classList.remove('hidden');
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
  }

  /** Put the label beside the box, on the side that fits and is farthest from where the ribbon comes in. */
  function placeTag() {
    if (!reaching) return;
    const { box, text } = reaching;
    $('#tag-text').textContent = text;
    tag.classList.remove('hidden');
    const w = tag.offsetWidth; const h = tag.offsetHeight; const gap = 14;
    const tip = thread.getTip() || { x: innerWidth, y: innerHeight };
    const cx = box.x + box.w / 2; const cy = box.y + box.h / 2;
    const d = Math.hypot(tip.x - cx, tip.y - cy) || 1;
    const spots = [
      { x: box.x, y: box.y + box.h + gap, dir: [0, 1] }, { x: box.x, y: box.y - h - gap, dir: [0, -1] },
      { x: box.x + box.w + gap, y: cy - h / 2, dir: [1, 0] }, { x: box.x - w - gap, y: cy - h / 2, dir: [-1, 0] },
    ].map((s) => ({ ...s, fits: s.x >= 8 && s.y >= 8 && s.x + w <= innerWidth - 8 && s.y + h <= innerHeight - 8, away: -(s.dir[0] * (tip.x - cx) + s.dir[1] * (tip.y - cy)) / d }));
    const pick = spots.filter((s) => s.fits).sort((a, b) => b.away - a.away)[0] || spots[0];
    tag.style.left = `${clamp(pick.x, 8, innerWidth - w - 8)}px`; tag.style.top = `${clamp(pick.y, 8, innerHeight - h - 8)}px`;
  }

  function reachFor(box, text, step) {
    clearTimeout(dwell);
    at = step; reaching = { box, text };
    tag.classList.add('hidden');
    mark.setState('reading');
    thread.setTarget(box);
  }

  const goTo = (i) => reachFor(boxOf(STEPS[i].el), STEPS[i].label, i);

  /** The ribbon goes to wherever the person clicked: a small box around the spot. */
  function spot(x, y) {
    const s = 56;
    reachFor({ x: clamp(x - s / 2, 6, innerWidth - s - 6), y: clamp(y - s / 2, 6, innerHeight - s - 6), w: s, h: s }, 'here', -1);
  }

  /** Draw the ribbon back into the mark; `next`, if there is one, runs once it is in. */
  function retract(next) {
    clearTimeout(dwell);
    after = next || null;
    tag.classList.add('hidden');
    if (thread.getState() === 'idle') rewound(); else thread.rewind();
  }

  function arrived() {
    mark.setState('ready'); placeTag();
    if (at < 0) { clearTimeout(dwell); dwell = setTimeout(() => retract(), DWELL_MS); }      // nobody is being walked anywhere: let it go back
  }
  function rewound() {
    clearTimeout(dwell);
    reaching = null; at = -1; tag.classList.add('hidden'); mark.setState('idle');
    const next = after; after = null;
    if (next) setTimeout(next, PAUSE_MS);
  }

  document.addEventListener('click', (e) => {
    if (dock.contains(e.target)) { if (thread.getState() === 'idle') goTo(0); else retract(); return; }
    const i = STEPS.findIndex((s) => s.el === e.target);
    if (i >= 0) {
      say(STEPS[i].said);
      retract(i + 1 < STEPS.length ? () => goTo(i + 1) : () => say('That was the last place to click. Click the mark to see it again.'));
      return;
    }
    if (e.target.closest('.btn')) { say('That one is not part of this walk.'); return; }
    // the place the ribbon is pointing at, clicked: it has done its job
    if (reaching && at < 0 && thread.getState() === 'pointing' && inside(reaching.box, e.clientX, e.clientY, 10)) { retract(); return; }
    spot(e.clientX, e.clientY);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') retract(); });
  addEventListener('resize', () => {
    aimMark();
    if (at >= 0) { reaching.box = boxOf(STEPS[at].el); thread.setTarget(reaching.box); } else thread.relayout();
  });

  aimMark();
  requestAnimationFrame(aimMark);
  setTimeout(() => goTo(0), 900);
})();
