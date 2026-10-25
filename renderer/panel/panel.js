(() => {
  'use strict';
  const api = window.panelApi;
  const $ = (s) => document.querySelector(s);

  /** Build an element. Text is always set as text, never as markup: folder and shortcut names come from the user's disk. */
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith('aria-')) { el.setAttribute(k, String(Boolean(v))); continue; }
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }

  const KEYS = [
    { id: 'anthropic', name: 'Anthropic', role: 'Haiku, Sonnet and Opus for A, B and C', url: 'https://console.anthropic.com', ph: 'Paste your Anthropic key' },
    { id: 'gemini', name: 'Gemini', role: 'Optional speech backup', url: 'https://aistudio.google.com/apikey', ph: 'Paste your Gemini key' },
    { id: 'typesafe', name: 'TypeSafe', role: 'Optional voice parsing without Claude routing', url: 'https://typesafe.ai', ph: 'Paste your TypeSafe key' },
  ];
  const MODEL_FIELDS = [['#model-anthropic-a', 'anthropicA'], ['#model-anthropic-b', 'anthropicB'], ['#model-anthropic-c', 'anthropicC'], ['#model-gemini', 'gemini']];

  let S = null;                 // the latest state from the app
  let tab = 'saved';
  let snackTimer = 0;

  function snack(text) { const s = $('#snack'); s.textContent = text; s.hidden = false; clearTimeout(snackTimer); snackTimer = setTimeout(() => { s.hidden = true; }, 3200); }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const ago = (t) => { if (!t) return 'never run'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'ran just now' : m < 60 ? `ran ${m} min ago` : m < 1440 ? `ran ${Math.round(m / 60)} h ago` : `ran ${Math.round(m / 1440)} d ago`; };

  function setTab(name) {
    tab = name;
    for (const b of document.querySelectorAll('.tabs button')) { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
    for (const t of document.querySelectorAll('.tab')) t.hidden = t.id !== `tab-${name}`;
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // ---- Saved ---------------------------------------------------------------------
  function renderRoutines() {
    const list = $('#routines'); list.replaceChildren();
    $('#routines-empty').hidden = S.routines.length > 0;
    for (const r of S.routines) {
      list.append(h('div', { class: 'row' },
        h('div', {}, h('b', { text: r.name }), h('div', { class: 'steps' }, r.steps.map((t) => h('i', { text: t }))), h('small', { text: `${plural(r.actions.length, 'step')} · ${ago(r.lastRunAt)}` })),
        h('div', { class: 'acts' },
          h('button', { class: 'run', type: 'button', text: 'Run', onclick: async () => { const x = await api.routine('run', r.id); snack(x.ok ? `Ran ${r.name}` : x.error || 'That did not run.'); } }),
          h('button', { type: 'button', text: 'Rename', onclick: () => rename(r) }),
          h('button', { class: 'del', type: 'button', text: 'Delete', onclick: async () => { await api.routine('remove', r.id); snack('Deleted'); } }))));
    }
  }
  /** Rename in place: window.prompt does not exist in a sandboxed window. */
  function rename(r) {
    const rows = $('#routines'); const row = [...rows.children].find((x) => x.querySelector('b') && x.querySelector('b').textContent === r.name);
    if (!row) return;
    const b = row.querySelector('b');
    const input = h('input', { type: 'text', value: r.name, maxlength: '60', 'aria-label': 'Shortcut name' });
    input.style.cssText = 'height:26px;border-radius:8px;border:1px solid rgba(144,165,255,.6);background:rgba(0,0,0,.35);color:#fff;padding:0 8px;width:100%;outline:none';
    b.replaceWith(input); input.focus(); input.select();
    const done = async (save) => { if (save && input.value.trim()) { await api.routine('rename', r.id, input.value.trim()); } else render(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    input.addEventListener('blur', () => done(true));
  }

  // ---- Folders -------------------------------------------------------------------
  function renderFolders() {
    const list = $('#folders'); list.replaceChildren();
    for (const f of S.folders) {
      const sub = f.missing ? 'This folder is gone from the disk.' : f.indexing ? 'Reading…' : plural(f.files, 'file') + (f.skipped ? ` · ${f.skipped} over the 200 limit` : '') + (f.tooBig ? ` · ${plural(f.tooBig, 'file')} over 2 MB` : '') + (f.errors ? ` · ${plural(f.errors, 'file')} could not be read` : '');
      list.append(h('div', { class: `frow${f.enabled ? '' : ' off'}`, 'data-id': f.id },
        h('span', { class: 'ic' }),
        h('span', {}, h('b', { text: f.name, title: f.path }), h('small', { class: f.indexing ? 'busy' : '', text: sub })),
        h('button', { class: 'tg', type: 'button', role: 'switch', 'aria-checked': f.enabled, 'aria-label': `Use ${f.name}`, onclick: () => api.folder('toggle', f.id, !f.enabled) }),
        h('button', { class: 'x', type: 'button', title: 'Remove this folder from the list (your files are not touched)', 'aria-label': `Remove ${f.name}`, text: '×', onclick: () => api.folder('remove', f.id) })));
    }
  }
  $('#add-folder').addEventListener('click', async () => {
    const r = await api.addFolder();
    const note = $('#folder-note');
    if (r && r.error) { note.textContent = r.error; note.hidden = false; } else note.hidden = true;
  });

  // ---- Settings: keys ------------------------------------------------------------
  function renderKeys() {
    const box = $('#keys');
    const typed = Object.fromEntries([...box.querySelectorAll('input')].map((i) => [i.dataset.id, i.value]));
    box.replaceChildren();
    for (const k of KEYS) {
      const saved = S.keys[k.id];
      const input = h('input', { type: 'password', 'data-id': k.id, placeholder: saved ? '•••••••• saved' : k.ph, autocomplete: 'off', spellcheck: 'false', 'aria-label': `${k.name} key` });
      input.value = typed[k.id] || '';
      const kids = [
        h('label', {}, k.name, h('small', { text: k.role })),
        h('span', { class: `badge${saved ? ' ok' : ''}`, text: saved ? 'Saved' : 'Not set' }),
        h('button', { class: 'get', type: 'button', text: 'Get a key ↗', onclick: () => api.openExternal(k.url) }),
        input,
      ];
      if (k.id === 'anthropic') kids.push(h('div', { class: 'note', text: 'A, B and C share this key. You only need to save it once.' }));
      if (saved) kids.push(h('button', { class: 'get rm', type: 'button', text: `Remove the saved ${k.name} key`, onclick: async () => { await api.saveKeys({ [k.id]: '' }); snack(`${k.name} key removed`); } }));
      box.append(h('div', { class: 'krow' }, kids));
    }
  }
  $('#save-keys').addEventListener('click', async () => {
    const given = {};
    for (const i of document.querySelectorAll('#keys input')) if (i.value.trim()) given[i.dataset.id] = i.value.trim();
    const msg = $('#keys-msg');
    if (!Object.keys(given).length) { msg.textContent = 'Paste a key first.'; msg.className = 'msg err'; return; }
    const r = await api.saveKeys(given);
    if (r.ok) { document.querySelectorAll('#keys input').forEach((i) => { i.value = ''; }); msg.textContent = 'Saved on this device.'; msg.className = 'msg'; } else { msg.textContent = r.error; msg.className = 'msg err'; }
    setTimeout(() => { msg.textContent = ''; }, 4000);
  });

  // ---- Settings: the rest --------------------------------------------------------
  const sw = (id, key, invert) => { const b = $(id); b.addEventListener('click', () => { const on = b.getAttribute('aria-checked') !== 'true'; api.setSettings({ [key]: invert ? !on : on }); }); };
  sw('#tg-speak', 'speakReplies'); sw('#tg-strip', 'strip'); sw('#tg-show', 'markHidden', true); sw('#tg-login', 'startWithWindows'); sw('#tg-cc', 'useClaudeCode');
  sw('#tg-web', 'webAccess'); sw('#tg-shop', 'shoppingOffers'); sw('#tg-auto', 'auto');
  $('#corners').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) api.setSettings({ markCorner: b.dataset.c }); });
  $('#save-models').addEventListener('click', async () => {
    const models = Object.fromEntries(MODEL_FIELDS.map(([id, key]) => [key, $(id).value.trim()]));
    const r = await api.setSettings({ models });
    snack(r.ok ? 'Models saved' : r.error || 'Those names do not look right.');
  });

  // ---- changing a hotkey: click it, press the new keys -------------------------------
  const HOTKEYS = [['talk', 'Hold to talk'], ['point', 'Look here'], ['hide', 'Hide or show the ribbon'], ['panic', 'Stop everything']];
  let recording = null;
  const NAMED = { Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
  function acceleratorFrom(e) {
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    let key = null;
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3); else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5); else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code; else if (NAMED[e.code]) key = NAMED[e.code];
    return mods.length && key ? [...mods, key].join('+') : null;
  }
  function startRecording(id) { recording = id; render(); }
  window.addEventListener('keydown', async (e) => {
    if (!recording) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { recording = null; render(); return; }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const accel = acceleratorFrom(e);
    if (!accel) { snack('Use at least one of Ctrl, Alt, Shift or Win, plus a key.'); return; }
    const id = recording; recording = null;
    const r = await api.setSettings({ hotkeys: { [id]: accel } });
    if (!r.ok) snack(r.error || 'That combination did not work.');
    render();
  }, true);
  $('#reset-keys').addEventListener('click', async () => { recording = null; await api.setSettings({ hotkeys: S.defaultHotkeys }); snack('The hotkeys are back as they came.'); });

  const KEYCAP = (accel) => String(accel).split('+').map((p) => h('kbd', { text: p.replace('Control', 'Ctrl') }));
  function renderSettings() {
    const s = S.settings;
    const set = (id, v) => $(id).setAttribute('aria-checked', String(Boolean(v)));
    set('#tg-speak', s.speakReplies); set('#tg-strip', s.strip); set('#tg-show', !s.markHidden); set('#tg-login', s.startWithWindows); set('#tg-cc', s.useClaudeCode);
    set('#tg-web', s.webAccess !== false); set('#tg-shop', s.shoppingOffers !== false); set('#tg-auto', s.auto !== false);
    for (const b of document.querySelectorAll('#corners button')) b.classList.toggle('on', b.dataset.c === s.markCorner);
    $('#corner-row').style.opacity = s.strip ? '.45' : '1';
    $('#cc-line').textContent = S.claudeCode ? 'Claude Code is available as a fallback without an Anthropic key. A, B and C use your Anthropic key.' : 'Claude Code was not found. Save an Anthropic key to use A, B and C.';
    for (const [id, key] of MODEL_FIELDS) if (document.activeElement !== $(id)) $(id).value = s.models[key] || '';
    $('#voice-line').textContent = S.voice.available ? `Listening on this PC with ${S.voice.recognizer.split('|').pop().trim()}. Recognized words go to the configured AI provider; microphone audio stays on this PC.` : `Windows speech recognition is not available (${S.voice.error || 'not found'}). Typing a command works: click the ribbon.`;
    const hot = $('#hotkeys'); hot.replaceChildren();
    for (const [id, label] of HOTKEYS) {
      const k = S.hotkeys[id]; const rec = recording === id;
      hot.append(h('button', { class: `hk${rec ? ' rec' : ''}${k.ok ? '' : ' bad'}`, type: 'button', 'data-id': id, title: 'Click, then press the keys you want', onclick: () => startRecording(id) },
        rec ? h('b', { text: 'Press the new keys… Esc to cancel' }) : KEYCAP(k.accel), h('span', { text: label }), !rec && !k.ok ? h('em', { text: 'taken by another app: click to change' }) : null));
    }
    $('#about-path').textContent = `Your data lives in ${S.dataDir}`;
  }

  // ---- header ---------------------------------------------------------------------
  const spoken = (accel) => String(accel).split('+').map((p) => p.replace('Control', 'Ctrl')).join(' ');
  function renderLive() {
    const live = $('#live'); const bad = Object.values(S.hotkeys).some((k) => !k.ok);
    const ready = S.helper && S.helper.win;
    live.className = `live ${ready && !bad ? 'ok' : 'warn'}`;
    $('#live-text').textContent = !ready ? 'Starting the Windows helper' : bad ? 'A hotkey is taken by another app' : `Ready · hold ${spoken(S.hotkeys.talk.accel)} to talk`;
    $('#ver').textContent = `Version ${S.version}`;
    $('#brand-name').textContent = S.name; $('#about-name').textContent = `${S.name}.`; document.title = S.name;
    // wherever the text names a hotkey, show the one it really is
    for (const [id, cls] of [['talk', '.hk-talk'], ['point', '.hk-point']]) for (const el of document.querySelectorAll(cls)) el.replaceChildren(...KEYCAP(S.hotkeys[id].accel));
  }

  function render() { renderLive(); renderRoutines(); renderFolders(); if (!document.activeElement || !document.activeElement.closest || !document.activeElement.closest('#keys')) renderKeys(); else { /* leave a field being typed in alone */ } renderSettings(); }

  const mark = window.Mark3D ? Mark3D.mount($('#mark'), { scale: 0.24, focusGate: false }) : null;
  if (mark) mark.setState('idle');

  api.on((s) => { S = s; render(); });
  api.state().then((s) => { S = s; render(); const want = new URLSearchParams(location.search).get('tab'); setTab(want || (Object.values(S.keys).some(Boolean) || S.settings.onboarded ? 'saved' : 'settings')); });
  addEventListener('beforeunload', () => { if (mark) mark.destroy(); });
})();
