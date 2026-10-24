// The mark on its own: one still frame, for the app and tray icons.
(() => {
  const q = new URLSearchParams(location.search);
  if (q.get('bg') === '1') document.getElementById('tile').classList.add('bg');
  const k = Mark3D.mount(document.getElementById('mark'), { scale: Number(q.get('scale')) || 0.3, simple: q.get('simple') !== '0', focusGate: false });
  k.pause();
  k.still({ at: Number(q.get('at')) || 2.35, bandAt: Number(q.get('band')) || 0.13 });
  document.title = 'ready';
})();
