// A contact sheet of the ribbon mark: poses, the loop unrolling into its tail, and small sizes.
(() => {
  const q = new URLSearchParams(location.search);
  const add = (row, size, label, opts, still, cls) => {
    const fig = document.createElement('figure');
    const c = document.createElement('canvas');
    c.style.width = `${size}px`; c.style.height = `${size}px`;
    fig.appendChild(c);
    if (label) { const cap = document.createElement('figcaption'); cap.textContent = label; fig.appendChild(cap); }
    document.getElementById(row).appendChild(fig);
    if (cls) fig.style.setProperty('--mark-accent', cls);
    const k = Mark3D.mount(c, { focusGate: false, ...opts });
    k.pause(); k.still(still);
    return k;
  };
  const scale = Number(q.get('scale')) || 0.27;
  for (const at of [1.6, 2.35, 3.1, 3.9]) add('poses', 300, `pose ${at}`, { scale }, { at, bandAt: 0.12 + at * 0.1 });
  for (const u of [0.25, 0.5, 0.8, 1]) add('open', 300, `unravel ${u}`, { scale: scale * 0.78 }, { at: 2.35, unravel: u, bandAt: 0.3 });
  for (const s of [96, 64, 40, 28]) add('small', s, `${s}px`, { scale: 0.2 }, { at: 2.35, bandAt: 0.2 });
  add('small', 96, 'icon', { scale: 0.3, simple: true }, { at: 2.35, bandAt: 0.2 });
  document.title = 'ready';
})();
