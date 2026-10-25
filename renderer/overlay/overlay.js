(() => {
  'use strict';
  const bridge = window.overlayApi;
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const els = {
    dock: $('#mark-dock'), canvas: $('#mark-canvas'), strip: $('#strip'), slot: $('#strip-slot'), word: $('#strip-word'), line: $('#strip-line'),
    pill: $('#pill'), pillWords: $('#pill-words'), bubble: $('#bubble'), bubK: $('#bub-k'), bubText: $('#bub-text'), bubHint: $('#bub-hint'), bubSources: $('#bub-sources'), bubActions: $('#bub-actions'),
    ask: $('#askfirst'), askTitle: $('#ask-title'), askHint: $('#ask-hint'), offer: $('#offer'), offerSteps: $('#offer-steps'),
    quick: $('#quick'), quickInput: $('#quick-input'), toast: $('#toast'),
  };

  let settings = { markCorner: 'br', strip: false, markHidden: false, speakReplies: false };
  const state = { s: 'idle', word: '', line: '' };
  let live = '';
  let speaking = false;
  let pendingBubble = null;
  let pointing = false;
  let askId = 0; let offerId = 0;
  let quickMode = 'command';
  let bubbleTimer = 0; let toastTimer = 0; let bubbleRaf = 0;

  // ---- the ribbon and its thread ----------------------------------------------
  const MARK = { idle: 'idle', listening: 'listening', thinking: 'thinking', acting: 'thinking', speaking: 'speaking', ready: 'ready', reading: 'reading' };
  const ACCENT = { listening: '#ff4a5e', thinking: '#ff8a5e', acting: '#ff8a5e', reading: '#ffb36b', speaking: '#ff7a88', ready: '#ff7a88', idle: '#ff7a88' };
  const mark = window.Mark3D ? Mark3D.mount(els.canvas, { scale: 0.2, focusGate: false }) : null;
  const strand = (window.Strand && mark) ? Strand.mount($('#strand-layer'), mark, { onArrive, onRewound }) : null;

  function onArrive() {
    if (mark) mark.setState('ready');
    if (pendingBubble) { showBubble(pendingBubble); pendingBubble = null; }
  }
  function onRewound() {
    pointing = false; els.strip.classList.remove('free');
    if (pendingBubble) { const answer = pendingBubble; pendingBubble = null; showBubble({ ...answer, anchor: 'mark' }); }
    else if (els.bubble.dataset.anchor === 'tip') { cancelAnimationFrame(bubbleRaf); els.bubble.dataset.anchor = 'mark'; }
    render();
  }

  /** Turn the ribbon so the tail it lets out points at the middle of the screen, from any corner. */
  function aimMark() {
    if (!mark || !mark.setRotate) return;
    mark.setRotate(0);
    const open = mark.getTailAnchor(1);
    if (!open) return;
    const r = (settings.strip ? els.slot : els.dock).getBoundingClientRect();
    const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
    const want = Math.atan2(innerHeight / 2 - cy, innerWidth / 2 - cx);
    const have = Math.atan2(open.ty, open.tx);
    mark.setRotate(want - have);
  }

  // ---- layout: cards stack away from the ribbon, toward the middle of the screen ---
  const anchor = () => {
    const r = (settings.strip ? els.strip : els.dock).getBoundingClientRect();
    const inset = settings.strip ? 0 : 22;
    return { left: r.left + inset, right: r.right - inset, top: r.top + inset, bottom: r.bottom - inset };
  };
  const visible = (el) => !el.classList.contains('hidden');

  function layout() {
    const a = anchor(); const W = innerWidth; const H = innerHeight;
    const down = settings.strip || (a.top + a.bottom) / 2 < H / 2;
    const rightSide = !settings.strip && (a.left + a.right) / 2 > W / 2;
    let edge = down ? a.bottom + 10 : a.top - 10;
    const stack = [els.ask, els.pill, els.quick, els.offer, els.toast];
    if (els.bubble.dataset.anchor !== 'tip') stack.splice(3, 0, els.bubble);
    for (const el of stack) {
      if (!visible(el)) continue;
      const w = el.offsetWidth; const h = el.offsetHeight;
      const left = clamp(settings.strip ? a.left : (rightSide ? a.right - w : a.left), 8, W - w - 8);
      const top = down ? edge : edge - h;
      el.style.left = `${left}px`; el.style.top = `${clamp(top, 8, H - h - 8)}px`;
      edge = down ? top + h + 8 : top - 8;
    }
    if (visible(els.bubble) && els.bubble.dataset.anchor === 'tip') placeAtTip();
  }

  /** A bubble about a pointed-at control sits at the tip of the thread, away from the control. */
  function placeAtTip() {
    const tip = strand && strand.getTip(); const target = strand && strand.getTarget();
    if (!tip || !target) return;
    const b = els.bubble; const w = b.offsetWidth; const h = b.offsetHeight;
    const cx = target.x + target.w / 2; const cy = target.y + target.h / 2;
    let dx = tip.x - cx; let dy = tip.y - cy;
    const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
    // Four places beside the control; take the one that fits and sits farthest from where the thread comes in.
    const gap = 14;
    const spots = [
      { x: target.x, y: target.y + target.h + gap, dir: [0, 1] },
      { x: target.x, y: target.y - h - gap, dir: [0, -1] },
      { x: target.x + target.w + gap, y: cy - h / 2, dir: [1, 0] },
      { x: target.x - w - gap, y: cy - h / 2, dir: [-1, 0] },
    ].map((s) => ({ ...s, fits: s.x >= 8 && s.y >= 8 && s.x + w <= innerWidth - 8 && s.y + h <= innerHeight - 8, away: -(s.dir[0] * dx + s.dir[1] * dy) }));
    const pick = spots.filter((s) => s.fits).sort((a, c) => c.away - a.away)[0] || spots[0];
    b.style.left = `${clamp(pick.x, 8, innerWidth - w - 8)}px`; b.style.top = `${clamp(pick.y, 8, innerHeight - h - 8)}px`;
  }
  function trackBubble() { cancelAnimationFrame(bubbleRaf); bubbleRaf = requestAnimationFrame(() => { placeAtTip(); if (visible(els.bubble) && els.bubble.dataset.anchor === 'tip') trackBubble(); }); }

  // ---- state: the ribbon, the strip, the pill ----------------------------------
  function fitStrip() {
    const strip = els.strip; const was = strip.style.width;
    strip.classList.remove('wrap'); strip.style.width = 'auto';
    if (strip.scrollWidth > strip.clientWidth + 1) strip.classList.add('wrap');
    const wd = strip.offsetWidth;
    strip.style.width = was; void strip.offsetWidth; strip.style.width = `${wd}px`;
  }

  function render() {
    const { s, word } = state;
    let line = state.line;
    if (s === 'listening') line = live ? `You: ${live}` : 'You:';
    const accent = ACCENT[s] || ACCENT.idle;
    for (const e of [els.dock, els.slot]) e.style.setProperty('--mark-accent', accent);
    if (mark && !pointing) mark.setState(speaking ? 'speaking' : (MARK[s] || 'idle'));
    if (settings.strip) {
      els.strip.dataset.state = s;
      els.word.textContent = word; els.line.textContent = line;
      els.strip.classList.toggle('has-text', Boolean(word || line));
      els.strip.classList.toggle('has-line', Boolean(line));
      fitStrip();
      els.pill.classList.add('hidden');
    } else {
      const show = ['listening', 'acting', 'thinking', 'reading'].includes(s);
      els.pill.classList.toggle('hidden', !show);
      if (show) {
        els.pill.dataset.tone = s;
        els.pillWords.innerHTML = '';
        const bdi = document.createElement('bdi');
        bdi.textContent = s === 'listening' ? (live || 'Listening') : (line || word || 'Working');
        els.pillWords.appendChild(bdi);
      }
    }
    layout();
  }

  // ---- bubbles -----------------------------------------------------------------
  function hideBubble() {
    els.bubble.classList.add('hidden');
    clearTimeout(bubbleTimer); cancelAnimationFrame(bubbleRaf);
    els.bubText.textContent = ''; els.bubHint.textContent = '';
    els.bubSources.replaceChildren(); els.bubSources.classList.add('hidden');
    els.bubActions.replaceChildren();
    layout();
  }

  function fileSourceHint(sources) {
    const files = (Array.isArray(sources) ? sources : []).filter((s) => s && s.type !== 'web' && typeof s.folder === 'string' && typeof s.file === 'string');
    return files.length ? `From ${files.slice(0, 4).map((s) => `${s.folder.slice(0, 120)}/${s.file.slice(0, 160)}`).join(', ')}` : '';
  }

  function showSources(sources) {
    els.bubSources.replaceChildren();
    const seen = new Set();
    for (const source of (Array.isArray(sources) ? sources.slice(0, 32) : [])) {
      if (!source || source.type !== 'web' || typeof source.url !== 'string' || source.url.length > 2048 || seen.size >= 6) continue;
      let url;
      try { url = new URL(source.url); } catch (_) { continue; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
      // The main process also checks public hosts before opening the browser.
      seen.add(url.href);
      const link = document.createElement('a');
      const title = typeof source.title === 'string' ? source.title.trim().slice(0, 180) : '';
      link.href = url.href; link.className = 'source-link';
      link.textContent = title || url.hostname;
      link.title = `${title || url.hostname} — ${url.hostname}`;
      link.rel = 'noreferrer noopener';
      link.addEventListener('click', async (event) => {
        event.preventDefault(); event.stopPropagation();
        try {
          const result = await bridge.openSource(url.href);
          if (!result || !result.ok) toast('This source could not be opened.', 'error');
        } catch (_) { toast('This source could not be opened.', 'error'); }
      });
      link.addEventListener('auxclick', (event) => { event.preventDefault(); });
      els.bubSources.appendChild(link);
    }
    els.bubSources.classList.toggle('hidden', !els.bubSources.childElementCount);
  }

  function showBubble(b) {
    clearTimeout(bubbleTimer);
    els.bubK.textContent = b.kicker || 'Answer';
    els.bubText.textContent = b.text || '';
    els.bubHint.textContent = b.hint || '';
    els.bubHint.classList.toggle('hidden', !b.hint);
    showSources(b.sources);
    els.bubActions.replaceChildren();
    for (const a of b.actions || []) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.textContent = a.label;
      if (a.id === 'more') btn.className = 'y';
      btn.addEventListener('click', (e) => { e.stopPropagation(); onBubbleAction(a.id); });
      els.bubActions.appendChild(btn);
    }
    els.bubble.dataset.anchor = b.anchor || 'mark';
    els.bubble.classList.remove('hidden');
    layout();
    if (b.anchor === 'tip') trackBubble();
    if (b.autoHide) bubbleTimer = setTimeout(hideBubble, b.autoHide);
  }

  function onBubbleAction(id) {
    if (id === 'close') { if (pointing) { pointing = false; strand && strand.rewind(); } bridge.pointClose(); hideBubble(); return; }
    if (id === 'more') { openQuick('followup'); return; }
  }

  function toast(text, tone) {
    clearTimeout(toastTimer);
    els.toast.textContent = text; els.toast.dataset.tone = tone || 'info';
    els.toast.classList.remove('hidden'); layout();
    toastTimer = setTimeout(() => { els.toast.classList.add('hidden'); layout(); }, Math.max(tone === 'error' ? 7000 : 4500, 1500 + text.length * 50));
  }

  // ---- typing a command --------------------------------------------------------
  async function openQuick(mode) {
    quickMode = mode;
    els.quickInput.placeholder = mode === 'followup' ? 'Ask more about this' : 'Tell me what to do, or ask';
    els.quick.classList.remove('hidden'); layout();
    await bridge.focusRequest();
    els.quickInput.focus();
  }
  function closeQuick() { els.quick.classList.add('hidden'); els.quickInput.value = ''; els.quickInput.blur(); bridge.blurRequest(); layout(); }
  els.quickInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeQuick(); return; }
    if (e.key !== 'Enter') return;
    const text = els.quickInput.value.trim();
    if (!text) return;
    e.preventDefault();
    closeQuick();
    if (quickMode === 'followup') bridge.pointFollowUp(text); else bridge.sendText(text);
  });

  // ---- clicks ------------------------------------------------------------------
  function markClicked() {
    if (pointing || visible(els.bubble)) { onBubbleAction('close'); return; }
    if (visible(els.quick)) closeQuick(); else openQuick('command');
  }
  els.dock.addEventListener('click', markClicked);
  els.slot.addEventListener('click', markClicked);
  for (const e of [els.dock, els.strip]) e.addEventListener('contextmenu', (ev) => { ev.preventDefault(); bridge.menu(); });
  $('#ask-yes').addEventListener('click', () => { els.ask.classList.add('hidden'); bridge.askAnswer(askId, true); layout(); });
  $('#ask-no').addEventListener('click', () => { els.ask.classList.add('hidden'); bridge.askAnswer(askId, false); layout(); });
  $('#offer-keep').addEventListener('click', () => { els.offer.classList.add('hidden'); bridge.offerAnswer(offerId, 'keep'); layout(); });
  $('#offer-skip').addEventListener('click', () => { els.offer.classList.add('hidden'); bridge.offerAnswer(offerId, 'skip'); layout(); });

  // ---- click-through: only the UI blocks the mouse ------------------------------
  const UI = '#mark-dock, #strip, #pill, #bubble, #askfirst, #offer, #quick, #toast';
  const overUI = (x, y) => { const el = document.elementFromPoint(x, y); return Boolean(el && el.closest && el.closest(UI)); };
  let ignoring = null;
  bridge.on('cursor:probe', ({ x, y }) => { const want = !overUI(x, y); if (want !== ignoring) { ignoring = want; bridge.ignore(want); } });
  document.addEventListener('mousemove', (e) => { const want = !overUI(e.clientX, e.clientY); if (want !== ignoring) { ignoring = want; bridge.ignore(want); } });

  // ---- what the app tells us -----------------------------------------------------
  function applySettings(next) {
    settings = { ...settings, ...next };
    document.body.dataset.corner = settings.markCorner;
    document.body.dataset.mode = settings.strip ? 'strip' : 'corner';
    document.body.classList.toggle('mark-hidden', Boolean(settings.markHidden));
    els.strip.classList.toggle('hidden', !settings.strip);
    (settings.strip ? els.slot : els.dock).appendChild(els.canvas);
    if (mark) { mark.setScale(settings.strip ? 0.167 : 0.2); if (settings.markHidden) mark.pause(); else mark.resume(); }
    if (settings.markHidden && strand && strand.cancel) strand.cancel();
    render();
    requestAnimationFrame(() => { aimMark(); if (strand) strand.relayout(); layout(); });
  }

  bridge.on('settings', applySettings);
  bridge.on('ui:state', (m) => { state.s = m.state; state.word = m.word || ''; state.line = m.line || ''; if (m.state === 'listening') live = ''; if (m.state === 'idle') live = ''; render(); });
  bridge.on('ui:transcript', (m) => { live = m.text; render(); });
  bridge.on('ui:level', (v) => { if (mark) mark.setLevel(v); });
  bridge.on('ui:say', (m) => showBubble({ kicker: m.kicker || 'Answer', text: m.text, hint: fileSourceHint(m.sources), sources: m.sources, actions: [{ id: 'close', label: 'Close' }], anchor: 'mark', autoHide: 18000 }));
  // Streaming: show the bubble as soon as the first chunk arrives; update text
  // on each subsequent chunk.  The final ui:say replaces it with the complete
  // bubble including sources, Close button and autoHide timer.
  bridge.on('ui:stream', (m) => {
    const wasHidden = els.bubble.classList.contains('hidden');
    els.bubText.textContent = m.text;
    if (wasHidden) {
      els.bubK.textContent = 'Answer';
      els.bubHint.textContent = '';
      els.bubHint.classList.add('hidden');
      els.bubSources.replaceChildren();
      els.bubSources.classList.add('hidden');
      els.bubActions.replaceChildren();
      els.bubble.dataset.anchor = 'mark';
      els.bubble.classList.remove('hidden');
      layout();
    }
  });
  bridge.on('ui:notice', (m) => toast(m.text, m.tone));
  bridge.on('ui:ask', (m) => { askId = m.id; $('#ask-title').textContent = m.card.title; $('#ask-hint').textContent = m.card.hint; els.ask.classList.remove('hidden'); layout(); });
  bridge.on('ui:ask:close', (m) => { if (m.id === askId) { els.ask.classList.add('hidden'); layout(); } });
  bridge.on('ui:offer', (m) => { offerId = m.id; els.offerSteps.textContent = (m.labels || []).join('  ›  '); els.offer.classList.remove('hidden'); layout(); });
  bridge.on('ui:offer:close', (m) => { if (m.id === offerId) { els.offer.classList.add('hidden'); layout(); } });
  bridge.on('ui:speak', (m) => {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(m.text);
    u.onstart = () => { speaking = true; render(); };
    u.onend = u.onerror = () => { speaking = false; render(); };
    speechSynthesis.speak(u);
  });
  bridge.on('quick:open', () => openQuick('command'));

  function pointAt(rect) {
    pointing = true; hideBubble();
    els.strip.classList.add('free');                     // the thread leaves the strip: let it out of the bar
    if (strand && strand.setTarget(rect) === false) { pointing = false; els.strip.classList.remove('free'); render(); return; }
    if (mark) mark.setState('reading');
  }
  bridge.on('point:target', (m) => pointAt(m.rect));
  bridge.on('point:bubble', (b) => {
    if (!pointing) { showBubble({ ...b, anchor: 'mark' }); return; }
    if (b.pending) { showBubble({ ...b, anchor: 'tip' }); return; }
    if (strand && strand.getState() === 'pointing') showBubble(b); else pendingBubble = b;
  });
  bridge.on('point:clear', () => { pendingBubble = null; if (pointing) { pointing = false; if (strand) strand.rewind(); } hideBubble(); render(); });

  addEventListener('resize', () => { requestAnimationFrame(() => { aimMark(); if (strand) strand.relayout(); layout(); }); });

  if (/[?&]test=1/.test(location.search)) { const s = document.createElement('script'); s.src = 'testkit.js'; document.body.appendChild(s); }

  bridge.settingsGet().then((s) => applySettings(s)).catch(() => applySettings({}));
  bridge.ready();
})();
