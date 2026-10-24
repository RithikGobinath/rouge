'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createClaudeCode } = require('../src/ai/claudeCode');

/** A stand-in for the `claude` command: what it prints and how it exits are the test's to say. */
function fakeCli({ stdout = '', stderr = '', code = 0 } = {}) {
  const calls = [];
  const spawn = (file, argv, o) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    let said = '';
    child.stdin.on('data', (d) => { said += d; });
    child.stdin.on('end', () => {
      calls.push({ argv, cwd: o.cwd, said });
      setImmediate(() => { if (stdout) child.stdout.write(stdout); if (stderr) child.stderr.write(stderr); child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', code)); });
    });
    return child;
  };
  return { spawn, calls };
}

const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('clippy-claude-'));

test('an answer comes back, the prompt goes in on stdin, and the temp folder is gone afterwards', async () => {
  const cli = fakeCli({ stdout: 'hi\n' });
  const cc = createClaudeCode({ spawn: cli.spawn, tidyWaitMs: 1 });
  const before = new Set(leftovers());
  assert.equal(await cc.ask({ prompt: 'say hi' }), 'hi');
  assert.match(cli.calls[0].said, /say hi/);
  assert.ok(cli.calls[0].argv.includes('-p'));
  assert.deepEqual(leftovers().filter((n) => !before.has(n)), [], 'nothing new is left behind');
});

test('a signed-out account is named as such, even when the command says so on stdout', async () => {
  const out = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has expired. Re-authenticate to continue."}}';
  const cc = createClaudeCode({ spawn: fakeCli({ stdout: out, code: 1 }).spawn, tidyWaitMs: 1 });
  await assert.rejects(cc.ask({ prompt: 'hi' }), (e) => e.code === 'auth' && /signed out/.test(e.message));
});

test('any other failure shows what the command said, not just that it failed', async () => {
  const cc = createClaudeCode({ spawn: fakeCli({ stdout: 'Rate limit reached for this hour.', code: 1 }).spawn, tidyWaitMs: 1 });
  await assert.rejects(cc.ask({ prompt: 'hi' }), (e) => e.code === 'cli' && /Rate limit reached/.test(e.message));
  const silent = createClaudeCode({ spawn: fakeCli({ code: 3 }).spawn, tidyWaitMs: 1 });
  await assert.rejects(silent.ask({ prompt: 'hi' }), /claude exited 3/);
});

test('a folder that will not delete does not cost the answer, and is swept on a later call', async (t) => {
  const real = fs.rmSync;
  let blocked = true;
  fs.rmSync = (p, o) => { if (blocked && path.basename(String(p)).startsWith('clippy-claude-')) { const e = new Error('EPERM, Permission denied'); e.code = 'EPERM'; throw e; } return real(p, o); };
  t.after(() => { fs.rmSync = real; });
  const cc = createClaudeCode({ spawn: fakeCli({ stdout: 'still here' }).spawn, tidyWaitMs: 1 });
  assert.equal(await cc.ask({ prompt: 'hi' }), 'still here', 'the answer survives a clean-up that fails');
  const stuck = leftovers();
  assert.ok(stuck.length >= 1, 'the folder it could not remove is still there');
  // an hour later the next call tidies up what is left
  for (const n of stuck) { const old = new Date(Date.now() - 60 * 60 * 1000); fs.utimesSync(path.join(os.tmpdir(), n), old, old); }
  blocked = false;
  assert.equal(await cc.ask({ prompt: 'again' }), 'still here');
  for (const n of stuck) assert.equal(fs.existsSync(path.join(os.tmpdir(), n)), false, `${n} was swept`);
});
