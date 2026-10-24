'use strict';
// Claude Code as a way to point and ask without pasting an API key: if the
// `claude` command is installed and signed in, this app can use it. The
// screenshot is written to a private temp folder and the CLI is allowed one
// tool only, Read, so it can look at that picture and nothing else. The
// prompt goes in on stdin, so nothing the user said is ever a command line.

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { dataUrlParts, AiError } = require('./http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PREFIX = 'clippy-claude-';

/**
 * Remove a folder, patiently. On Windows the folder a program was started in stays locked for a
 * moment after it exits (and for longer if it left something running), and a failed clean-up must
 * never take the answer down with it: the leftovers are swept on the next call.
 */
async function tidy(dir, wait = 150) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch (_) { await sleep(wait * (attempt + 1)); }
  }
}

/** Folders from earlier calls that could not be removed then. */
function sweep(olderThanMs = 10 * 60 * 1000) {
  let names = [];
  try { names = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(PREFIX)); } catch (_) { return; }
  for (const n of names) {
    const p = path.join(os.tmpdir(), n);
    try { if (Date.now() - fs.statSync(p).mtimeMs > olderThanMs) fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* still in use */ }
  }
}

function createClaudeCode(opts = {}) {
  const spawn = opts.spawn || childProcess.spawn;
  let found = null;       // null = not checked yet

  function run(args, input, { cwd, timeoutMs }) {
    return new Promise((resolve, reject) => {
      let child;
      // `claude` is a .cmd shim on Windows: run it through cmd.exe with fixed arguments (the prompt goes in on stdin).
      const [file, argv] = process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'claude', ...args]] : ['claude', args];
      try { child = spawn(file, argv, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { reject(e); return; }
      let out = ''; let err = '';
      const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* gone */ } reject(new AiError('Claude Code took too long to answer.', { provider: 'anthropic', code: 'timeout' })); }, timeoutMs);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      // When it fails it says why, and not always on stderr: a signed-out account is reported on stdout.
      child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(out.trim()); else reject(new Error((err.trim() || out.trim()).slice(0, 300) || `claude exited ${code}`)); });
      if (input != null) { child.stdin.write(input); }
      child.stdin.end();
    });
  }

  return {
    /** Is the `claude` command here? Checked once. */
    async available() {
      if (found != null) return found;
      try { await run(['--version'], null, { cwd: os.tmpdir(), timeoutMs: 6000 }); found = true; } catch (_) { found = false; }
      return found;
    },
    reset() { found = null; },

    /**
     * Ask Claude Code, optionally about screenshots.
     * @param {{prompt:string, images?:string[], timeoutMs?:number}} o images are data URLs
     */
    async ask({ prompt, images = [], timeoutMs = 90000 }) {
      sweep();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
      try {
        const names = [];
        images.forEach((url, i) => {
          const p = dataUrlParts(url);
          if (!p) return;
          const name = `screen-${i + 1}.${p.mime.includes('jpeg') ? 'jpg' : 'png'}`;
          fs.writeFileSync(path.join(dir, name), Buffer.from(p.b64, 'base64'));
          names.push(name);
        });
        const intro = names.length ? `Look at these image files with the Read tool before answering: ${names.join(', ')}.\n\n` : '';
        const text = await run(['-p', '--output-format', 'text', '--allowedTools', 'Read', '--max-turns', '5'], intro + prompt, { cwd: dir, timeoutMs });
        if (!text) throw new AiError('Claude Code sent back nothing.', { provider: 'anthropic', code: 'empty' });
        return text;
      } catch (e) {
        if (e instanceof AiError) throw e;
        if (/login|auth|sign in|expired/i.test(e.message)) throw new AiError('Claude Code is signed out. Run claude in a terminal and sign in, then try again.', { provider: 'anthropic', code: 'auth' });
        throw new AiError(`Claude Code could not answer: ${String(e.message).slice(0, 120)}`, { provider: 'anthropic', code: 'cli' });
      } finally { await tidy(dir, opts.tidyWaitMs); }
    },
  };
}

module.exports = { createClaudeCode };
