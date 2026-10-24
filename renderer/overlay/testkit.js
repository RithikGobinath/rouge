// Test page only (overlay.html?test=1): a stand-in desktop behind the overlay,
// so a screenshot shows the ribbon over something, and a fake error line for the
// strand to point at. Never loaded in the real app.
(() => {
  document.body.classList.add('shots');
  const css = document.createElement('style');
  css.textContent = `
    body.shots { --shots-bg: radial-gradient(120% 90% at 18% 0%, #33477f 0%, #19254a 45%, #0b1024 100%); }
    .fake { position: fixed; z-index: 0; border-radius: 9px; background: #15182a; border: 1px solid rgba(255,255,255,.07); box-shadow: 0 18px 40px rgba(0,0,0,.45); overflow: hidden; font: 12px "Segoe UI", sans-serif; color: #9aa0b4; }
    .fake .bar { height: 30px; background: #1c1f33; display: flex; align-items: center; padding: 0 12px; gap: 10px; font-size: 12px; }
    .fake .bar b { width: 46px; height: 7px; border-radius: 4px; background: #2b3050; }
    .fake .body { padding: 22px 26px; display: grid; gap: 12px; }
    .fake .ln { height: 8px; border-radius: 4px; background: #262b45; } .fake .ln.s { width: 55%; } .fake .ln.m { width: 78%; }
    .fake .err { margin-top: 6px; padding: 10px 12px; border-radius: 7px; background: rgba(217,75,67,.12); border: 1px solid rgba(217,75,67,.35); color: #f0b3ae; font-size: 13px; width: 62%; }
    .fake.note { background: #f3f1ea; color: #1d1f27; }
    .fake.note .bar { background: #e3e0d6; color: #555; border-radius: 9px 9px 0 0; }
    .fake.note .txt { padding: 14px; font: 14px Consolas, monospace; }
  `;
  document.head.appendChild(css);
  const add = (cls, html, pos) => { const d = document.createElement('div'); d.className = `fake ${cls}`; d.innerHTML = html; Object.assign(d.style, pos); document.body.prepend(d); return d; };
  const W = innerWidth; const H = innerHeight;
  add('doc', '<div class="bar"><b></b>report-draft.docx</div><div class="body"><div class="ln m"></div><div class="ln"></div><div class="ln s"></div><div class="ln m"></div><div id="fake-error" class="err">Error: the linked file was not found</div><div class="ln"></div><div class="ln s"></div></div>',
    { left: `${W * 0.06}px`, top: `${H * 0.18}px`, width: `${W * 0.5}px`, height: `${H * 0.52}px` });
  add('note', '<div class="bar">Untitled - Notepad</div><div class="txt">hello|</div>',
    { left: `${W * 0.46}px`, top: `${H * 0.34}px`, width: `${W * 0.3}px`, height: `${H * 0.3}px` });
})();
