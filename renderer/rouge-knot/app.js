// app.js — application state, task/email tools, UI rendering, backend API.
// Exports: window.RougeWorkspace (main API), window.RibbonWorkspace (alias),
//          window.RougeBackendPort (integration port, after optional patch).
(function () {
'use strict';

// ---- Storage and state -----------------------------------------------------
const STORAGE_KEY = 'rouge-workspace-v1';
const LEGACY_KEY  = 'ribbon-workspace-v1';

const DEFAULT_STATE = {
  profile: { first: 'Rouge', last: '' },
  tasks: [],
  draft: { to: '', cc: '', subject: '', body: '', brief: '' },
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    const s = JSON.parse(raw);
    const out = JSON.parse(JSON.stringify(DEFAULT_STATE));
    if (s.profile && typeof s.profile === 'object') Object.assign(out.profile, s.profile);
    if (Array.isArray(s.tasks)) out.tasks = s.tasks.filter(t => t && typeof t.id === 'string' && t.title);
    if (s.draft && typeof s.draft === 'object') Object.assign(out.draft, s.draft);
    return out;
  } catch (e) { return JSON.parse(JSON.stringify(DEFAULT_STATE)); }
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}

let state = loadState();

// Undo stack (max 30)
let undoStack = [];
function checkpoint() {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 30) undoStack.shift();
}
function undo() {
  if (!undoStack.length) return;
  state = JSON.parse(undoStack.pop());
  saveState(); render(); positionPopups();
}

// ---- View state ------------------------------------------------------------
let currentView = null;  // null | 'tasks' | 'email'
let showEmailDetails = false;

// ---- Knot / thread globals (set by rouge-motion.js) -----------------------
let knot   = null;   // Knot3D renderer instance
let thread = null;   // Strand renderer instance
let activeGuide = null;
let guideTimer = null;

// ---- DOM helpers -----------------------------------------------------------
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }
function el(tag, cls, content) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (content !== undefined) e.textContent = content;
  return e;
}

// ---- Render ----------------------------------------------------------------
function render() {
  renderTool();
  renderReply();
  positionPopups();
}

function renderTool() {
  const toolEl = $('#tool-panel');
  if (!toolEl) return;

  if (!currentView) {
    toolEl.hidden = true;
    return;
  }
  toolEl.hidden = false;
  toolEl.setAttribute('aria-label', currentView === 'tasks' ? 'Tasks' : 'Email');

  const content = toolEl.querySelector('.tool-content');
  if (!content) return;

  if (currentView === 'tasks') renderTasks(content);
  else if (currentView === 'email') renderEmail(content);
}

function renderTasks(container) {
  container.innerHTML = '';
  const open = state.tasks.filter(t => !t.done && !t.snoozed);
  const done = state.tasks.filter(t => t.done);
  const snoozed = state.tasks.filter(t => t.snoozed && !t.done);

  const header = el('div', 'tool-header');
  const title  = el('h2', 'tool-title', 'Tasks');
  const addBtn = el('button', 'tool-action icon-btn', '+');
  addBtn.setAttribute('aria-label', 'Add task');
  addBtn.onclick = () => promptAddTask();
  header.append(title, addBtn);
  container.append(header);

  function taskRow(t) {
    const row = el('div', 'task-row' + (t.done ? ' done' : ''));
    row.setAttribute('data-guide', 'task-' + t.id);

    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = t.done;
    cb.setAttribute('aria-label', t.done ? 'Reopen task' : 'Complete task');
    cb.onchange = () => {
      checkpoint();
      t.done = cb.checked;
      saveState(); render();
      emitStateChange();
    };

    const textEl = el('span', 'task-title', t.title);
    const dueEl  = el('span', 'task-due', t.due || '');

    const snoozeBtn = el('button', 'icon-btn task-snooze', t.snoozed ? '⏰' : '💤');
    snoozeBtn.title = t.snoozed ? 'Unsnooze' : 'Snooze';
    snoozeBtn.onclick = () => { checkpoint(); t.snoozed = !t.snoozed; saveState(); render(); emitStateChange(); };

    const delBtn = el('button', 'icon-btn task-del', '×');
    delBtn.setAttribute('aria-label', 'Delete task');
    delBtn.onclick = () => {
      if (!confirm('Delete "' + t.title + '"?')) return;
      checkpoint();
      state.tasks = state.tasks.filter(x => x.id !== t.id);
      saveState(); render(); emitStateChange();
    };

    row.append(cb, textEl, dueEl, snoozeBtn, delBtn);
    return row;
  }

  if (open.length) {
    const list = el('div', 'task-list');
    open.forEach(t => list.append(taskRow(t)));
    container.append(list);
  }
  if (snoozed.length) {
    const hdr = el('div', 'task-section-header', 'Snoozed');
    const list = el('div', 'task-list snoozed');
    snoozed.forEach(t => list.append(taskRow(t)));
    container.append(hdr, list);
  }
  if (done.length) {
    const hdr = el('div', 'task-section-header', 'Completed');
    const list = el('div', 'task-list done');
    done.forEach(t => list.append(taskRow(t)));
    container.append(hdr, list);
  }

  if (!open.length && !done.length && !snoozed.length) {
    container.append(el('div', 'empty-state', 'No tasks. Press + to add one.'));
  }
}

function promptAddTask() {
  const title = prompt('Task title:');
  if (!title || !title.trim()) return;
  const due = prompt('Due (e.g. Tonight, Tomorrow):', 'No deadline') || 'No deadline';
  addTask(title.trim(), due.trim());
}

function renderEmail(container) {
  container.innerHTML = '';

  const header = el('div', 'tool-header');
  header.append(el('h2', 'tool-title', 'Email'));
  container.append(header);

  const form = el('div', 'email-form');

  // To field (click opens details popup)
  const toRow = el('div', 'email-row');
  const toLabel = el('label', 'email-label', 'To');
  toLabel.htmlFor = 'draft-to';
  const toInput = el('input', 'email-input');
  toInput.id = 'draft-to'; toInput.type = 'email';
  toInput.value = state.draft.to;
  toInput.placeholder = 'Recipient';
  toInput.oninput = () => { state.draft.to = toInput.value; saveState(); };

  // Details toggle inside To row
  const detailsBtn = el('button', 'icon-btn email-details-toggle', '⋯');
  detailsBtn.title = 'Cc and Subject';
  detailsBtn.onclick = () => { showEmailDetails = !showEmailDetails; render(); };

  toRow.append(toLabel, toInput, detailsBtn);
  form.append(toRow);

  // Cc / Subject popup (absolute, inside email popup)
  if (showEmailDetails) {
    const detailPopup = el('div', 'email-details-popup');

    const ccRow = el('div', 'email-row');
    const ccLabel = el('label', 'email-label', 'Cc');
    ccLabel.htmlFor = 'draft-cc';
    const ccInput = el('input', 'email-input');
    ccInput.id = 'draft-cc'; ccInput.value = state.draft.cc;
    ccInput.oninput = () => { state.draft.cc = ccInput.value; saveState(); };
    ccRow.append(ccLabel, ccInput);

    const subRow = el('div', 'email-row');
    const subLabel = el('label', 'email-label', 'Subject');
    subLabel.htmlFor = 'draft-subject';
    const subInput = el('input', 'email-input');
    subInput.id = 'draft-subject'; subInput.value = state.draft.subject;
    subInput.oninput = () => { state.draft.subject = subInput.value; saveState(); };
    subRow.append(subLabel, subInput);

    const closeBtn = el('button', 'icon-btn email-details-close', '×');
    closeBtn.setAttribute('aria-label', 'Close details');
    closeBtn.onclick = () => { showEmailDetails = false; render(); };

    detailPopup.append(closeBtn, ccRow, subRow);
    form.append(detailPopup);

    // Close on outside click
    setTimeout(() => {
      function outside(e) {
        if (!detailPopup.contains(e.target) && e.target !== detailsBtn) {
          showEmailDetails = false; render();
          document.removeEventListener('pointerdown', outside, true);
        }
      }
      document.addEventListener('pointerdown', outside, true);
    }, 0);
  }

  // Body
  const bodyArea = el('textarea', 'email-body');
  bodyArea.id = 'draft-body';
  bodyArea.placeholder = 'Email body…';
  bodyArea.value = state.draft.body;
  bodyArea.setAttribute('aria-label', 'Email body');
  bodyArea.oninput = () => { state.draft.body = bodyArea.value; saveState(); };
  form.append(bodyArea);

  // Send button
  const sendRow = el('div', 'email-send-row');
  const sendBtn = el('button', 'send-btn', 'Send');
  sendBtn.onclick = () => sendEmail();
  sendRow.append(sendBtn);
  form.append(sendRow);

  container.append(form);
}

function sendEmail() {
  const d = state.draft;
  if (!d.to.trim()) { toast('Add a recipient first.'); return; }
  if (!d.body.trim()) { toast('Add a message body first.'); return; }

  const params = new URLSearchParams({
    to: d.to.replace(/\r?\n/g, '').replace(/;/g, ','),
    subject: d.subject.replace(/\r?\n/g, ''),
    body: d.body.replace(/\n/g, '\r\n'),
  });
  if (d.cc.trim()) params.set('cc', d.cc.replace(/\r?\n/g, '').replace(/;/g, ','));

  window.open('mailto:?' + params.toString());
}

// ---- Reply tray ------------------------------------------------------------
let replyText = '';
let replyActions = [];

function renderReply() {
  const tray = $('#reply-tray');
  if (!tray) return;
  if (!replyText) { tray.hidden = true; return; }
  tray.hidden = false;
  tray.querySelector('.reply-text').textContent = replyText;
  const acts = tray.querySelector('.reply-actions');
  if (acts) {
    acts.innerHTML = '';
    replyActions.forEach(a => {
      const btn = el('button', 'reply-action-btn', a.label);
      btn.onclick = a.callback;
      acts.append(btn);
    });
  }
}

function showReply(text, actions) {
  replyText = text || '';
  replyActions = Array.isArray(actions) ? actions : [];
  render();
}

function dismissReply() { replyText = ''; replyActions = []; render(); }

// ---- Toast -----------------------------------------------------------------
let toastTimer = null;
function toast(msg, duration) {
  const el_ = $('#toast');
  if (!el_) return;
  el_.textContent = msg;
  el_.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el_.hidden = true; }, duration || 4000);
}

// ---- Guide / wand ----------------------------------------------------------
function stopGuide() {
  if (guideTimer) { clearTimeout(guideTimer); guideTimer = null; }
  if (activeGuide) {
    activeGuide.classList.remove('guide-highlight');
    activeGuide = null;
  }
  if (thread) thread.rewind();
  const wandLabel = $('#wand-label');
  if (wandLabel) { wandLabel.hidden = true; wandLabel.textContent = ''; }
}

function pointTo(guideKey, label, duration) {
  stopGuide();
  const target = document.querySelector('[data-guide="' + guideKey + '"]');
  if (!target) return;
  target.scrollIntoView({ block: 'nearest' });
  target.classList.add('guide-highlight');
  activeGuide = target;

  if (thread) {
    setTimeout(() => {
      const rect = target.getBoundingClientRect();
      thread.setTarget({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
    }, 260);
  }

  const wandLabel = $('#wand-label');
  if (wandLabel && label) {
    wandLabel.textContent = label;
    wandLabel.hidden = false;
    const rect = target.getBoundingClientRect();
    wandLabel.style.left = Math.max(12, rect.left) + 'px';
    wandLabel.style.top  = Math.max(12, rect.bottom + 8) + 'px';
  }

  guideTimer = setTimeout(stopGuide, duration != null ? duration : 6500);
}

// ---- Popup positioning -----------------------------------------------------
function positionPopups() {
  const knotBtn = $('#knot');
  const chat    = $('#chat-panel');
  const tool    = $('#tool-panel');
  const replyTray = $('#reply-tray');
  if (!knotBtn || !chat) return;

  const r   = knotBtn.getBoundingClientRect();
  const cx  = r.left + r.width / 2, cy = r.top + r.height / 2;
  const vw  = innerWidth, vh = innerHeight;
  const chatW = chat.offsetWidth || 340, chatH = chat.offsetHeight || 60;
  const replyH = (replyTray && !replyTray.hidden) ? replyTray.offsetHeight + 8 : 0;
  const toolH = (tool && !tool.hidden) ? tool.scrollHeight || 200 : 0;
  const hitR  = r.width / 2;

  const phase = window.RougeMotionMath ? window.RougeMotionMath.smoothstep5((cx - (vw/2 - 120)) / 240) : 0.5;
  const lift  = hitR + chatH/2 + 14;
  const side  = hitR + 12 + chatW/2;

  let chatX, chatY;
  if (phase < 0.33) {
    chatX = cx; chatY = cy - lift;
  } else if (phase < 0.67) {
    const p2 = (phase - 0.33) / 0.34;
    chatX = cx + (cx < vw/2 ? 1 : -1) * side * p2;
    chatY = cy - lift + lift * 2 * p2;
  } else {
    chatX = cx + (cx < vw/2 ? 1 : -1) * side;
    chatY = cy + lift;
  }

  chatX = Math.max(12 + chatW/2, Math.min(vw - 12 - chatW/2, chatX));
  chatY = Math.max(12 + chatH/2, Math.min(vh - 12 - chatH/2, chatY));

  chat.style.left = (chatX - chatW/2) + 'px';
  chat.style.top  = (chatY - chatH/2) + 'px';

  if (tool && !tool.hidden) {
    const aboveRoom = chatY - chatH/2 - replyH - 20;
    const belowRoom = vh - chatY - chatH/2 - replyH - 20;
    const useAbove  = aboveRoom >= Math.min(180, toolH) || aboveRoom >= belowRoom;
    const room      = Math.max(60, useAbove ? aboveRoom : belowRoom);
    const visH      = Math.min(toolH, 370, room);

    tool.style.left   = (chatX - chatW/2) + 'px';
    tool.style.width  = chatW + 'px';
    tool.style.height = visH + 'px';
    tool.style.top    = useAbove
      ? (chatY - chatH/2 - replyH - visH - 8) + 'px'
      : (chatY + chatH/2 + replyH + 8) + 'px';
  }

  if (replyTray && !replyTray.hidden) {
    replyTray.style.left  = (chatX - chatW/2) + 'px';
    replyTray.style.width = chatW + 'px';
    const toolBottom = (tool && !tool.hidden)
      ? parseFloat(tool.style.top) + parseFloat(tool.style.height || 0)
      : chatY + chatH/2;
    replyTray.style.top = (toolBottom + 8) + 'px';
  }
}

// ---- Input / chat ----------------------------------------------------------
function handleInput(text) {
  text = (text || '').trim();
  if (!text) return;
  for (const type of ['rouge:command', 'ribbon:command']) {
    document.dispatchEvent(new CustomEvent(type, { detail: { text, view: currentView } }));
  }
  stopGuide();
  // Hand off to integration if connected; else do nothing (backend handles it).
  if (window.RougeIntegration && window.RougeIntegration.isConnected()) {
    window.RougeIntegration.submit({ text, view: currentView }).catch(() => {});
    return;
  }
  // Demo fallback: echo with a placeholder reply
  showReply('(Demo) You said: ' + text);
  if (knot) knot.setState('thinking');
  setTimeout(() => {
    if (knot) knot.setState('idle');
    dismissReply();
  }, 2000);
}

// ---- IPC bridge (Electron) -------------------------------------------------
// When running inside Electron, the preload exposes window.rougeKnotBridge.
function setupBridge() {
  const bridge = window.rougeKnotBridge;
  if (!bridge) return;

  bridge.on('ui:state', (data) => {
    if (knot && data.state) knot.setState(data.state);
  });
  bridge.on('ui:say', (data) => {
    showReply(data.text || '', []);
    if (knot) { knot.setState('speaking'); setTimeout(() => knot.setState('idle'), 3000); }
  });
  bridge.on('ui:notice', (data) => {
    toast(data.text || '', 4000);
  });
  bridge.on('ui:transcript', (data) => {
    const el_ = $('#chat-transcript');
    if (el_) { el_.textContent = data.text || ''; el_.hidden = !(data.text); }
  });
  bridge.on('ui:ask', (data) => {
    // Show a confirmation card
    const card = data.card || {};
    showReply(card.title || 'Confirm?', [
      { label: 'Yes', callback: () => { bridge.send('panel:answer', { id: data.id, yes: true }); dismissReply(); } },
      { label: 'No',  callback: () => { bridge.send('panel:answer', { id: data.id, yes: false }); dismissReply(); } },
    ]);
  });
}

// ---- DOM events -----------------------------------------------------------
function emitStateChange() {
  const detail = JSON.parse(JSON.stringify(state));
  for (const name of ['rouge:statechange', 'ribbon:statechange']) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  }
  const bridge = window.rougeKnotBridge;
  if (bridge && bridge.send) bridge.send('knot:statechange', detail);
}

// ---- Public API ------------------------------------------------------------
function navigate(view) {
  if (view === 'tasks' || view === 'email') {
    currentView = view;
  } else {
    currentView = null;
  }
  render();
}

function addTask(title, due) {
  checkpoint();
  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  state.tasks.unshift({ id, title: String(title), due: due || 'No deadline', done: false, snoozed: false });
  saveState(); navigate('tasks'); emitStateChange();
  return id;
}

function setDraft(partial) {
  checkpoint();
  Object.assign(state.draft, partial);
  saveState(); navigate('email'); dismissReply(); emitStateChange();
}

function reply(text, actions) {
  showReply(text, actions);
}

// ---- Init ------------------------------------------------------------------
function init() {
  setupBridge();

  // Chat input
  const chatInput  = $('#chat-input');
  const chatSubmit = $('#chat-submit');
  if (chatInput) {
    chatInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const val = chatInput.value.trim();
        chatInput.value = '';
        if (val) handleInput(val);
      }
    });
  }
  if (chatSubmit) {
    chatSubmit.onclick = () => {
      if (!chatInput) return;
      const val = chatInput.value.trim();
      chatInput.value = '';
      if (val) handleInput(val);
    };
  }

  // Tasks / Email nav
  const tasksBtn = $('#nav-tasks');
  const emailBtn = $('#nav-email');
  if (tasksBtn) tasksBtn.onclick = () => navigate(currentView === 'tasks' ? null : 'tasks');
  if (emailBtn) emailBtn.onclick = () => navigate(currentView === 'email' ? null : 'email');

  // Escape key dismissal
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (showEmailDetails) { showEmailDetails = false; render(); return; }
    if (currentView) { currentView = null; render(); return; }
  });

  // Resize → reposition
  const ro = new ResizeObserver(positionPopups);
  const toolPanel = $('#tool-panel');
  const chatPanel = $('#chat-panel');
  if (toolPanel) ro.observe(toolPanel);
  if (chatPanel) ro.observe(chatPanel);
  window.addEventListener('resize', positionPopups);

  // Initial render
  render();
}

document.addEventListener('DOMContentLoaded', init);

// ---- Backend Port (optional, filled by patch) ------------------------------
// window.RougeBackendPort is set up here so it's available before the patch.
(function () {
  const validStates = new Set(['idle','ready','listening','thinking','speaking','reading']);

  function validateSnapshot(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('Invalid snapshot');
    const allowed = new Set(['profile','tasks','draft']);
    for (const k of Object.keys(s)) if (!allowed.has(k)) throw new Error('Unknown snapshot field: ' + k);
    if (s.tasks !== undefined) {
      if (!Array.isArray(s.tasks)) throw new Error('tasks must be array');
      const ids = new Set();
      s.tasks.forEach(t => {
        if (!t || typeof t.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(t.id)) throw new Error('Invalid task id');
        if (ids.has(t.id)) throw new Error('Duplicate task id: ' + t.id);
        ids.add(t.id);
        if (typeof t.title !== 'string' || !t.title.trim()) throw new Error('Task title required');
      });
    }
    if (s.draft) {
      if (typeof s.draft !== 'object' || Array.isArray(s.draft)) throw new Error('Invalid draft');
      const df = ['to','cc','subject','body','brief'];
      for (const [k, v] of Object.entries(s.draft)) {
        if (!df.includes(k)) throw new Error('Unknown draft field: ' + k);
        if (typeof v !== 'string') throw new Error('Draft field must be string');
      }
    }
  }

  function applySnapshot(s) {
    validateSnapshot(s);
    const prev = JSON.stringify(state);
    if (s.profile) Object.assign(state.profile, s.profile);
    if (s.tasks !== undefined) {
      state.tasks = s.tasks.map(t => ({
        id: t.id, title: t.title,
        due: t.due || 'No deadline',
        done: !!t.done, snoozed: !!t.snoozed,
      }));
    }
    if (s.draft) Object.assign(state.draft, s.draft);
    undoStack = [];
    saveState(); render(); positionPopups(); emitStateChange();
  }

  function pointToRect(r, label, duration) {
    if (!r || !isFinite(r.x) || !isFinite(r.y) || !isFinite(r.width) || !isFinite(r.height)) throw new Error('Invalid rect');
    if (r.width <= 0 || r.height <= 0) throw new Error('Rect must have positive dimensions');
    stopGuide();
    if (thread) thread.setTarget({ x: r.x, y: r.y, w: r.width, h: r.height });
    const wandLabel = $('#wand-label');
    if (wandLabel && label) {
      wandLabel.textContent = String(label);
      wandLabel.hidden = false;
      wandLabel.style.left = Math.max(12, Math.min(r.x, innerWidth - 200)) + 'px';
      wandLabel.style.top  = Math.max(12, Math.min(r.y + r.height + 10, innerHeight - 50)) + 'px';
    }
    guideTimer = setTimeout(stopGuide, Math.max(100, Math.min(30000, duration || 6500)));
  }

  window.RougeBackendPort = {
    validateSnapshot, applySnapshot, pointToRect,
    clearGuide: stopGuide,
    setVisualState(name) {
      if (!validStates.has(name)) throw new Error('Invalid visual state: ' + name);
      if (knot) knot.setState(name);
    },
  };
})();

// ---- Exports ---------------------------------------------------------------
const workspace = {
  getState()      { return JSON.parse(JSON.stringify(state)); },
  command(text)   { handleInput(text); },
  navigate,
  reply,
  addTask,
  draftEmail(brief) {
    checkpoint();
    state.draft = { to: '', cc: '', subject: '', body: '(AI-generated draft coming from backend)', brief: brief || '' };
    saveState(); navigate('email'); dismissReply();
  },
  setDraft,
  pointTo,
  undo,
  moveTo(x, y, opts) { return window.RougeMotion ? window.RougeMotion.moveTo(x, y, opts) : Promise.resolve({}); },
  avoidRect(rect, opts) { return window.RougeMotion ? window.RougeMotion.avoidRect(rect, opts) : Promise.resolve({ blocked: true }); },
  getMotion() { return window.RougeMotion ? window.RougeMotion.getState() : { x: 0, y: 0, moving: false }; },
};

window.RougeWorkspace = workspace;
window.RibbonWorkspace = workspace;

// Internal references used by rouge-motion.js
window._rougeAppInternals = {
  getState: () => state,
  getKnot: () => knot,
  getThread: () => thread,
  setKnot: (k) => { knot = k; },
  setThread: (t_) => { thread = t_; },
  positionPopups,
  stopGuide,
  showReply,
  dismissReply,
};

})();
