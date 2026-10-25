(() => {
  'use strict';
  const bridge = window.overlayApi;
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const els = {
    dock: $('#mark-dock'), canvas: $('#mark-canvas'), strip: $('#strip'), slot: $('#strip-slot'), word: $('#strip-word'), line: $('#strip-line'),
    pill: $('#pill'), pillWords: $('#pill-words'), bubble: $('#bubble'), bubK: $('#bub-k'), bubText: $('#bub-text'), bubHint: $('#bub-hint'), bubSources: $('#bub-sources'), bubActions: $('#bub-actions'),
    ask: $('#askfirst'), askTitle: $('#ask-title'), askHint: $('#ask-hint'), offer: $('#offer'), offerSteps: $('#offer-steps'),
    quick: $('#quick'), quickInput: $('#quick-input'), toast: $('#toast'), shelf: $('#shelf'), shelfItems: $('#shelf-items'),
    reminder: $('#meeting-reminder'), meetingTitle: $('#meeting-title'), meetingTime: $('#meeting-time'), meetingCountdown: $('#meeting-countdown'), clockHighlight: $('#clock-highlight'),
  };

  let settings = { markCorner: 'br', strip: false, markHidden: false, speakReplies: false };
  const state = { s: 'idle', word: '', line: '' };
  let live = '';
  let speaking = false;
  let pendingBubble = null;
  let pointing = false;
  let reminderOwnsWand = false;
  let reminderTimer = 0;
  let clockRect = null; let clockRequest = 0; let clockRetryTimer = 0;
  let workArea = null;
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
    pointing = false; reminderOwnsWand = false; els.strip.classList.remove('free');
    if (els.bubble.dataset.anchor === 'tip') hideBubble();
    render();
    if (visible(els.reminder)) pointToSystemClock();
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

  function placeReminderAtClock(work) {
    const rect = clockRect; const card = els.reminder;
    if (!rect || !visible(card)) return false;
    const w = card.offsetWidth; const h = card.offsetHeight; const gap = 8;
    const minX = work.x + 8; const minY = work.y + 8;
    const maxX = work.x + work.width - w - 8; const maxY = work.y + work.height - h - 8;
    const x = clamp(rect.x + rect.w - w, minX, maxX);
    const y = clamp(rect.y + (rect.h - h) / 2, minY, maxY);
    const aboveLeft = { x: rect.x - w - gap, y: Math.min(rect.y, work.y + work.height) - h - gap };
    const spot = [
      aboveLeft,
      { x, y: rect.y - h - gap },
      { x, y: rect.y + rect.h + gap },
      { x: rect.x - w - gap, y },
      { x: rect.x + rect.w + gap, y },
    ].find((s) => s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY
      && (s === aboveLeft || s.x < rect.x + rect.w && s.x + w > rect.x || s.y < rect.y + rect.h && s.y + h > rect.y));
    if (!spot) return false;
    card.style.left = `${spot.x}px`; card.style.top = `${spot.y}px`;
    return true;
  }

  function layout() {
    const a = anchor(); const W = innerWidth; const H = innerHeight;
    const work = workArea || { x: 0, y: 0, width: W, height: H };
    const down = settings.strip || (a.top + a.bottom) / 2 < H / 2;
    const rightSide = !settings.strip && (a.left + a.right) / 2 > W / 2;
    let edge = down ? a.bottom + 10 : a.top - 10;
    const atClock = visible(els.reminder) && clockRect;
    els.clockHighlight.classList.toggle('hidden', !atClock);
    if (atClock) {
      const r = clockRect;
      els.clockHighlight.style.left = `${r.x}px`; els.clockHighlight.style.top = `${r.y}px`;
      els.clockHighlight.style.width = `${r.w}px`; els.clockHighlight.style.height = `${r.h}px`;
    }
    const stack = [els.ask, els.pill, els.quick, els.offer, els.toast, els.shelf];
    if (!placeReminderAtClock(work)) stack.unshift(els.reminder);
    if (els.bubble.dataset.anchor !== 'tip') stack.splice(stack.indexOf(els.quick), 0, els.bubble);
    for (const el of stack) {
      if (!visible(el)) continue;
      const w = el.offsetWidth; const h = el.offsetHeight;
      const left = clamp(settings.strip ? a.left : (rightSide ? a.right - w : a.left), work.x + 8, work.x + work.width - w - 8);
      const top = down ? edge : edge - h;
      el.style.left = `${left}px`; el.style.top = `${clamp(top, work.y + 8, work.y + work.height - h - 8)}px`;
      edge = down ? top + h + 8 : top - 8;
    }
    if (visible(els.bubble) && els.bubble.dataset.anchor === 'tip') placeAtTip();
    if (reminderOwnsWand && visible(els.reminder)) pointToSystemClock();
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
  const UI = '#mark-dock, #strip, #pill, #bubble, #askfirst, #offer, #quick, #toast, #meeting-reminder, #shelf';
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

  // ---- files the ribbon is holding -------------------------------------------------
  const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  function renderShelf(list) {
    els.shelfItems.replaceChildren();
    for (const f of (Array.isArray(list) ? list.slice(0, 5) : [])) {
      if (!f || !Number.isInteger(f.id)) continue;
      const chip = document.createElement('div');
      chip.className = 'chip'; chip.draggable = true; chip.title = 'Drag this into the page or app that needs it';
      // The file's own icon (a data URL from the app), or a plain tile when Windows gave none.
      const icon = typeof f.icon === 'string' && /^data:image\/png;base64,/.test(f.icon) ? document.createElement('img') : document.createElement('span');
      if (icon.tagName === 'IMG') { icon.src = f.icon; icon.alt = ''; } else icon.className = 'ic';
      const name = document.createElement('span'); name.className = 'nm'; name.textContent = String(f.name || 'file');
      const size = document.createElement('small'); size.textContent = sizeText(Number(f.size) || 0);
      const x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', `Let go of ${f.name}`);
      // The drag itself is started by the app, which owns the file's path.
      chip.addEventListener('dragstart', (e) => { e.preventDefault(); bridge.shelfDrag(f.id); });
      x.addEventListener('click', (e) => { e.stopPropagation(); bridge.shelfRemove(f.id); });
      chip.append(icon, name, size, x);
      els.shelfItems.append(chip);
    }
    els.shelf.classList.toggle('hidden', !els.shelfItems.childElementCount);
    layout();
  }
  bridge.on('shelf:items', renderShelf);

  // A file dragged over the ribbon lights it up; letting go hands it to the shelf.
  const isFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
  for (const target of [els.dock, els.slot]) {
    target.addEventListener('dragenter', (e) => { if (isFiles(e)) { e.preventDefault(); target.classList.add('catching'); } });
    target.addEventListener('dragover', (e) => { if (isFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    target.addEventListener('dragleave', (e) => { if (!target.contains(e.relatedTarget)) target.classList.remove('catching'); });
    target.addEventListener('drop', (e) => {
      if (!isFiles(e)) return;
      e.preventDefault(); target.classList.remove('catching');
      const held = Array.from(e.dataTransfer.files).slice(0, 5).map((file) => bridge.shelfHold(file));
      if (!held.some(Boolean)) toast('Rouge can only hold files from this PC.', 'info');
    });
  }
  bridge.on('ui:ask', (m) => {
    askId = m.id;
    const kicker = m.card.kicker || 'Check first';
    // A solo card is only its button; the title stays as the label for screen readers.
    els.ask.classList.toggle('solo', Boolean(m.card.solo));
    els.ask.setAttribute('aria-label', m.card.solo ? m.card.title : kicker);
    $('#ask-kicker').textContent = kicker;
    $('#ask-title').textContent = m.card.title; $('#ask-hint').textContent = m.card.hint;
    $('#ask-yes').textContent = m.card.yes || 'Go ahead'; $('#ask-no').textContent = m.card.no || 'Not now';
    els.ask.classList.remove('hidden'); layout();
  });
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

  function pointToSystemClock() {
    if (!strand || pointing && !reminderOwnsWand) return;
    const rect = clockRect;
    if (!rect) return;
    const previous = strand.getTarget();
    if (reminderOwnsWand && previous && Math.abs(previous.x - rect.x) < 0.5 && Math.abs(previous.y - rect.y) < 0.5 && Math.abs(previous.w - rect.w) < 0.5 && Math.abs(previous.h - rect.h) < 0.5) return;
    reminderOwnsWand = true; pointing = true;
    els.strip.classList.add('free');
    strand.setTarget(rect, { underline: true, holdMs: 600 });
    if (mark) mark.setState('reading');
  }

  async function refreshClockTarget(retries = 1) {
    clearTimeout(clockRetryTimer);
    const request = ++clockRequest;
    const rect = await bridge.clockRect().catch(() => null);
    if (request !== clockRequest || !visible(els.reminder)) return;
    clockRect = rect;
    if (rect) {
      els.meetingCountdown.textContent = els.meetingCountdown.textContent.replace(/ · System clock unavailable\.$/, '');
      pointToSystemClock();
    }
    else {
      if (reminderOwnsWand) { reminderOwnsWand = false; if (strand) strand.rewind(); }
      els.meetingCountdown.textContent = els.meetingCountdown.textContent.replace(/ · System clock unavailable\.$/, '') + ' · System clock unavailable.';
      if (retries > 0) clockRetryTimer = setTimeout(() => refreshClockTarget(retries - 1), 350);
    }
    layout();
  }

  function dismissMeeting() {
    clearTimeout(reminderTimer);
    clearTimeout(clockRetryTimer);
    clockRequest += 1; clockRect = null;
    els.reminder.classList.add('hidden');
    if (reminderOwnsWand) { reminderOwnsWand = false; if (strand) strand.rewind(); }
    layout();
    bridge.dismissReminder();
  }
  $('#meeting-dismiss').addEventListener('click', dismissMeeting);
  bridge.on('calendar:reminder', (message) => {
    const events = (Array.isArray(message && message.events) ? message.events : [])
      .filter((event) => event && Number.isFinite(event.startMs) && event.startMs > Date.now());
    if (!events.length) return;
    clearTimeout(reminderTimer);
    clearTimeout(clockRetryTimer);
    clockRequest += 1; clockRect = null;
    const format = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    els.meetingTitle.textContent = events.map((event, i) => `${i ? format.format(new Date(event.startMs)) + ' · ' : ''}${String(event.title || 'Meeting').slice(0, 200)}`).join('\n');
    els.meetingTime.textContent = format.format(new Date(events[0].startMs));
    els.meetingTime.dateTime = new Date(events[0].startMs).toISOString();
    const minutes = Math.max(1, Math.ceil((events[0].startMs - Date.now()) / 60000));
    els.meetingCountdown.textContent = `Starts in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
    els.reminder.classList.remove('hidden');
    layout();
    refreshClockTarget();
    reminderTimer = setTimeout(dismissMeeting, 20000);
  });

  function pointAt(rect) {
    reminderOwnsWand = false;
    pointing = true; hideBubble();
    els.strip.classList.add('free');                     // the thread leaves the strip: let it out of the bar
    if (strand) strand.setTarget(rect);
    if (mark) mark.setState('reading');
  }
  bridge.on('point:target', (m) => pointAt(m.rect));
  bridge.on('point:bubble', (b) => {
    if (b.pending) { showBubble({ ...b, anchor: 'tip' }); return; }
    if (strand && strand.getState() === 'pointing') showBubble(b); else pendingBubble = b;
  });
  bridge.on('point:clear', () => { pendingBubble = null; if (pointing) { pointing = false; if (strand) strand.rewind(); } hideBubble(); render(); });

  bridge.on('overlay:area', (area) => {
    workArea = area;
    const style = document.documentElement.style;
    style.setProperty('--work-top', `${area.y}px`);
    style.setProperty('--work-left', `${area.x}px`);
    style.setProperty('--work-right', `${area.right}px`);
    style.setProperty('--work-bottom', `${area.bottom}px`);
    aimMark(); layout();
    if (visible(els.reminder)) refreshClockTarget();
  });
  addEventListener('resize', () => { requestAnimationFrame(() => { aimMark(); layout(); if (strand) strand.relayout(); }); });

  if (/[?&]test=1/.test(location.search)) { const s = document.createElement('script'); s.src = 'testkit.js'; document.body.appendChild(s); }

  bridge.settingsGet().then((s) => applySettings(s)).catch(() => applySettings({}));
  bridge.ready();
})();
