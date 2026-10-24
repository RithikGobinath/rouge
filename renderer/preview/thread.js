// The ribbon mark and its thread, driven the way the overlay drives them.
(() => {
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
  const strand = Strand.mount(document.getElementById('strand'), mark, { onArrive() { document.title = 'arrived'; }, onRewound() { document.title = 'rewound'; } });
  const box = () => { const r = document.getElementById('err').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  window.__go = () => { document.title = 'going'; mark.setState('reading'); strand.setTarget(box()); };
  window.__back = () => { mark.setState('idle'); strand.rewind(); };
})();
