'use strict';
// Short, human labels for actions: the strip's one line while it acts, the
// steps of a saved shortcut, the text under a Check-first card.

const SPECIAL = { 'vs code': 'VS Code', vscode: 'VS Code', 'visual studio code': 'Visual Studio Code', 'ms paint': 'Paint', mspaint: 'Paint', cmd: 'Command Prompt', powershell: 'PowerShell', chatgpt: 'ChatGPT', youtube: 'YouTube', github: 'GitHub', onenote: 'OneNote', powerpoint: 'PowerPoint', outlook: 'Outlook', 'file explorer': 'File Explorer' };

/** "notepad" -> "Notepad", "vs code" -> "VS Code". */
function titleCase(name) {
  const key = String(name || '').trim().toLowerCase();
  if (SPECIAL[key]) return SPECIAL[key];
  return key.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

const WINDOW = { minimize: ['Minimizing the window', 'Minimized the window'], maximize: ['Maximizing the window', 'Maximized the window'], restore: ['Restoring the window', 'Restored the window'], close: ['Closing the window', 'Closed the window'], show_desktop: ['Showing the desktop', 'Showed the desktop'] };
const MEDIA = { vol_up: ['Turning the volume up', 'Turned the volume up'], vol_down: ['Turning the volume down', 'Turned the volume down'], mute: ['Toggling mute', 'Toggled mute'], play_pause: ['Playing or pausing', 'Played or paused'], next: ['Skipping to the next track', 'Skipped to the next track'], prev: ['Going to the previous track', 'Went to the previous track'] };

/**
 * @param {{type:string}} action
 * @returns {{present:string, past:string}} e.g. { present: "Opening Notepad", past: "Opened Notepad" }
 */
function describe(action) {
  const a = action || {};
  switch (a.type) {
    case 'open_app': return { present: `Opening ${titleCase(a.app)}`, past: `Opened ${titleCase(a.app)}` };
    case 'open_url': {
      const search = /^(\w[\w ]*): (.+)$/.exec(a.label || '');
      if (search && /[?=]/.test(a.url || '')) return { present: `Searching ${titleCase(search[1])} for “${clip(search[2], 28)}”`, past: `Searched ${titleCase(search[1])}` };
      return { present: `Opening ${titleCase(clip(a.label || a.url, 36))}`, past: `Opened ${titleCase(clip(a.label || a.url, 36))}` };
    }
    case 'open_folder': return { present: `Opening ${titleCase(a.name)}`, past: `Opened ${titleCase(a.name)}` };
    case 'switch_to': return { present: `Switching to ${titleCase(a.app)}`, past: `Switched to ${titleCase(a.app)}` };
    case 'type_text': return { present: `Typing “${clip(a.text, 30)}”`, past: `Typed “${clip(a.text, 30)}”` };
    case 'press_keys': {
      if (a.label === 'Win+Shift+S') return { present: 'Taking a screenshot', past: 'Took a screenshot' };
      if (a.label === 'Alt+Tab') return { present: 'Switching windows', past: 'Switched windows' };
      return { present: `Pressing ${a.label}`, past: `Pressed ${a.label}` };
    }
    case 'window_op': { const w = WINDOW[a.op] || ['Working on the window', 'Worked on the window']; return { present: w[0], past: w[1] }; }
    case 'media': {
      if (a.op === 'volume_set') return { present: `Setting the volume to ${a.level}%`, past: `Set the volume to ${a.level}%` };
      const m = MEDIA[a.op] || ['Controlling media', 'Controlled media']; return { present: m[0], past: m[1] };
    }
    case 'scroll': return { present: `Scrolling ${a.dir}`, past: `Scrolled ${a.dir}` };
    case 'click': return { present: `Clicking “${clip(titleCase(a.name), 28)}”`, past: `Clicked “${clip(titleCase(a.name), 28)}”` };
    case 'run_routine': return { present: a.name ? `Running ${clip(a.name, 28)}` : 'Running your shortcut', past: 'Ran your shortcut' };
    case 'save_routine': return { present: 'Saving a shortcut', past: 'Saved a shortcut' };
    case 'compose_email': return { present: 'Starting an email', past: 'Started an email' };
    case 'wait': return { present: 'Waiting', past: 'Waited' };
    case 'cancel': return { present: 'Cancelling', past: 'Cancelled' };
    default: return { present: 'Working on it', past: 'Done' };
  }
}

module.exports = { describe, titleCase, clip };
