'use strict';
// What "open Notepad" means on this PC: a short list of apps Windows ships
// with, plus everything in the Start menu (Get-StartApps), matched by name.
// Launching goes through the shell (`start`, a URI, or shell:AppsFolder), never
// through text a person said, and only for names that resolved to a known app.

const { execFile } = require('child_process');

/** @typedef {{kind:'exe'|'uri'|'appsfolder', cmd?:string, uri?:string, id?:string, label:string, match:{process:string[], title:string}}} AppSpec */

const exe = (label, cmd, proc, title) => ({ kind: 'exe', cmd, label, match: { process: proc, title: title || label.toLowerCase() } });
const uri = (label, u, proc, title) => ({ kind: 'uri', uri: u, label, match: { process: proc || [], title: title || label.toLowerCase() } });

const STATIC = [
  [['notepad'], exe('Notepad', 'notepad.exe', ['notepad'], 'notepad')],
  [['calculator', 'calc'], uri('Calculator', 'calculator:', ['calculatorapp', 'calculator'], 'calculator')],
  [['paint', 'ms paint', 'mspaint'], exe('Paint', 'mspaint.exe', ['mspaint', 'paintstudio.view'], 'paint')],
  [['file explorer', 'explorer', 'files', 'windows explorer'], exe('File Explorer', 'explorer.exe', ['explorer'], '')],
  [['task manager'], exe('Task Manager', 'taskmgr.exe', ['taskmgr'], 'task manager')],
  [['command prompt', 'cmd'], exe('Command Prompt', 'cmd.exe', ['cmd', 'windowsterminal'], '')],
  [['powershell', 'power shell'], exe('PowerShell', 'powershell.exe', ['powershell', 'windowsterminal'], '')],
  [['terminal', 'windows terminal'], exe('Terminal', 'wt.exe', ['windowsterminal', 'wt'], '')],
  [['settings', 'windows settings'], uri('Settings', 'ms-settings:', ['systemsettings', 'applicationframehost'], 'settings')],
  [['control panel'], exe('Control Panel', 'control.exe', ['explorer', 'control'], 'control panel')],
  [['snipping tool', 'snip and sketch'], exe('Snipping Tool', 'snippingtool.exe', ['snippingtool'], 'snipping tool')],
  [['word', 'microsoft word'], exe('Word', 'winword.exe', ['winword'], 'word')],
  [['excel', 'microsoft excel'], exe('Excel', 'excel.exe', ['excel'], 'excel')],
  [['powerpoint', 'microsoft powerpoint'], exe('PowerPoint', 'powerpnt.exe', ['powerpnt'], 'powerpoint')],
  [['outlook', 'microsoft outlook'], exe('Outlook', 'outlook.exe', ['outlook', 'olk'], 'outlook')],
  [['edge', 'microsoft edge', 'browser'], exe('Microsoft Edge', 'msedge.exe', ['msedge'], 'edge')],
  [['chrome', 'google chrome'], exe('Chrome', 'chrome.exe', ['chrome'], 'chrome')],
  [['firefox'], exe('Firefox', 'firefox.exe', ['firefox'], 'firefox')],
  [['brave'], exe('Brave', 'brave.exe', ['brave'], 'brave')],
  [['vs code', 'vscode', 'visual studio code', 'code'], exe('VS Code', 'code', ['code'], 'visual studio code')],
  [['spotify'], uri('Spotify', 'spotify:', ['spotify'], 'spotify')],
  [['teams', 'microsoft teams'], uri('Teams', 'msteams:', ['ms-teams', 'teams'], 'teams')],
  [['clock', 'alarms'], uri('Clock', 'ms-clock:', [], 'clock')],
  [['camera'], uri('Camera', 'microsoft.windows.camera:', [], 'camera')],
  [['photos'], uri('Photos', 'ms-photos:', [], 'photos')],
  [['microsoft store', 'store'], uri('Microsoft Store', 'ms-windows-store:', [], 'microsoft store')],
  [['maps'], uri('Maps', 'bingmaps:', [], 'maps')],
  [['calendar'], uri('Calendar', 'outlookcal:', [], 'calendar')],
];

const ALIASES = new Map();
for (const [names, spec] of STATIC) for (const n of names) ALIASES.set(n, spec);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Best Start-menu entry for a spoken name, or null. */
function bestStart(entries, query) {
  const q = norm(query);
  if (!q) return null;
  const qs = q.split(' ');
  let best = null; let bestScore = 0;
  for (const e of entries) {
    const n = norm(e.Name);
    let score = 0;
    if (n === q) score = 100;
    else if (n.startsWith(q + ' ') || n.startsWith(q)) score = 80 - Math.min(20, n.length - q.length);
    else if (n.includes(q)) score = 55;
    else {
      const ns = n.split(' ');
      const hits = qs.filter((w) => w.length > 2 && ns.some((x) => x === w || x.startsWith(w))).length;
      if (hits === qs.length && hits > 0) score = 40; else if (hits > 0) score = 15;
    }
    if (score > bestScore) { best = e; bestScore = score; }
  }
  return bestScore >= 40 ? best : null;
}

/** @param {{run?: (file:string, args:string[]) => Promise<string>, log?:Function}} [opts] */
function createApps(opts = {}) {
  const log = opts.log || (() => {});
  const run = opts.run || ((file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 25000, maxBuffer: 8 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(String(out))));
  }));
  let entries = [];
  let loaded = false;

  return {
    /** Read the Start menu. Slow (a second or two), so it runs once, in the background. */
    async load() {
      try {
        const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress']);
        const parsed = JSON.parse(out.trim() || '[]');
        entries = (Array.isArray(parsed) ? parsed : [parsed]).filter((e) => e && e.Name && e.AppID);
        loaded = true;
        log(`start menu: ${entries.length} apps`);
      } catch (e) { log(`start menu not read: ${e.message}`); }
      return entries.length;
    },
    get loaded() { return loaded; },
    /** Display names, for Jev's "which app" question. */
    names() { return [...new Set([...STATIC.map(([, s]) => s.label), ...entries.map((e) => e.Name)])].slice(0, 240); },
    /** @returns {AppSpec|null} */
    resolve(query) {
      const q = norm(query).replace(/^(?:the|my)\s+/, '');
      if (!q) return null;
      if (ALIASES.has(q)) return ALIASES.get(q);
      const start = bestStart(entries, q);
      if (start) return { kind: 'appsfolder', id: start.AppID, label: start.Name, match: { process: [], title: norm(start.Name) } };
      // "notepad app" -> notepad: one more try without a trailing noun
      const trimmed = q.replace(/\s+(?:app|application|program|software)$/, '');
      if (trimmed !== q) return this.resolve(trimmed);
      return null;
    },
    _setEntries(list) { entries = list; loaded = true; },
  };
}

module.exports = { createApps, bestStart, STATIC, norm };
