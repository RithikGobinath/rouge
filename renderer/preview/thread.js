// The ribbon mark and its thread, driven the way the overlay drives them.
(() => {
  const development = new URLSearchParams(location.search).get('wand') === '1';
  if (development) document.body.classList.add('wand-dev');
  const status = document.getElementById('wand-status');
  const mark = Mark3D.mount(document.getElementById('mark'), { scale: 0.2, focusGate: false });
  // turn the mark so the tail it lets out points at the middle of the screen
  function aim() {
    mark.setRotate(0);
    const open = mark.getTailAnchor(1);
    const r = document.getElementById('box').getBoundingClientRect();
    const want = Math.atan2(innerHeight / 2 - (r.top + r.height / 2), innerWidth / 2 - (r.left + r.width / 2));
    mark.setRotate(want - Math.atan2(open.ty, open.tx));
  }
  aim();
  window.__mark = mark;
  const strand = Strand.mount(document.getElementById('strand'), mark, { onArrive() { document.title = 'arrived'; status.textContent = 'Holding · 2 seconds'; }, onRewound() { document.title = 'rewound'; status.textContent = 'Ready'; } });
  const box = () => { const r = document.getElementById('err').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  window.__go = () => { document.title = 'going'; mark.setState('reading'); strand.setTarget(box()); };
  window.__back = () => { mark.setState('idle'); strand.rewind(); };
  if (development) {
    let selected = null;
    function pointTo(key) {
      const target = document.getElementById('wand-' + key); if (!target) return;
      selected = key; const r = target.getBoundingClientRect();
      mark.setState('reading'); strand.setTarget({ x: r.left, y: r.top, w: r.width, h: r.height });
      status.textContent = 'Unwinding to ' + key.toUpperCase();
    }
    document.getElementById('wand-commands').addEventListener('submit', event => {
      event.preventDefault(); const text = document.getElementById('wand-command').value.trim();
      const command = RougeWandGeometry.developmentTarget(text, innerWidth, innerHeight);
      if (command) pointTo(command.key);
      else if (/^(?:retract|stop)$/i.test(text)) window.__back();
      else status.textContent = 'Use point a, point b, point c or point d.';
    });
    document.querySelectorAll('[data-target]').forEach(button => button.addEventListener('click', () => pointTo(button.dataset.target)));
    document.getElementById('wand-retract').addEventListener('click', window.__back);
    addEventListener('keydown', event => { if (event.key === 'Escape') window.__back(); });
    addEventListener('resize', () => { if (selected && strand.getState() !== 'idle') { const r = document.getElementById('wand-' + selected).getBoundingClientRect(); strand.setTarget({ x: r.left, y: r.top, w: r.width, h: r.height }); } });
  }
})();
