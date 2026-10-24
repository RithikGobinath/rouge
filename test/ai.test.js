'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/store');
const { createAI } = require('../src/ai');
const { parseJson } = require('../src/ai/http');

const cipher = { available: () => true, encrypt: (s) => Buffer.from(`enc:${s}`), decrypt: (b) => b.toString().replace(/^enc:/, '') };
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function server(route) {
  return new Promise((resolve) => {
    const seen = [];
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const rec = { url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
        seen.push(rec);
        const out = route(rec);
        res.writeHead(out.status || 200, { 'content-type': 'application/json' });
        res.end(typeof out.json === 'string' ? out.json : JSON.stringify(out.json));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, seen, base: `http://127.0.0.1:${s.address().port}` }));
  });
}

async function withAI(t, { keys = {}, folders, settings, claudeCode } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-ai-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore({ dir, cipher });
  if (Object.keys(keys).length) await store.setKeys(keys);
  if (settings) store.patch(settings);
  const noCli = { available: async () => false, ask: async () => { throw new Error('no cli'); } };
  return { store, ai: createAI({ store, folders, claudeCode: claudeCode || noCli }) };
}

const gemReply = (text) => ({ json: { candidates: [{ content: { parts: [{ text }] } }] } });
const claudeReply = (text) => ({ json: { content: [{ type: 'text', text }] } });

test('answers: Gemini first, with your folders folded in and the key in a header', async (t) => {
  const { s, seen, base } = await server(() => gemReply('It is due Friday at noon, per week1/lab.md.'));
  t.after(() => s.close());
  process.env.CLIPPY_GEMINI_BASE = base;
  const folders = { context: (q) => ({ text: "From the user's folders:\n[Notes/week1/lab.md]\nThe lab report is due Friday.", sources: [{ folder: 'Notes', file: 'week1/lab.md' }] }) };
  const { ai } = await withAI(t, { keys: { gemini: 'AIza-test' }, folders });
  const r = await ai.answer('when is the lab report due');
  assert.equal(r.text, 'It is due Friday at noon, per week1/lab.md.');
  assert.deepEqual(r.sources, [{ folder: 'Notes', file: 'week1/lab.md' }]);
  assert.equal(r.provider, 'gemini');
  assert.equal(seen[0].url, '/v1beta/models/gemini-3.6-flash:generateContent');
  assert.equal(seen[0].headers['x-goog-api-key'], 'AIza-test');
  assert.ok(!seen[0].url.includes('AIza'), 'the key is never in the URL');
  assert.match(seen[0].body.contents[0].parts[0].text, /lab report is due Friday/);
  assert.match(seen[0].body.contents[0].parts[0].text, /User: when is the lab report due/);
  assert.equal(seen[0].body.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.match(seen[0].body.systemInstruction.parts[0].text, /quiet assistant/);
});

test('answers: Claude when there is no Gemini key', async (t) => {
  const { s, seen, base } = await server(() => claudeReply(JSON.stringify({ route: 'A', mode: 'reply', response: 'Hello from Claude.' })));
  t.after(() => s.close());
  process.env.CLIPPY_ANTHROPIC_BASE = base;
  const { ai } = await withAI(t, { keys: { anthropic: 'sk-ant-test' } });
  const r = await ai.answer('say hello');
  assert.equal(r.text, 'Hello from Claude.');
  assert.equal(r.provider, 'anthropic');
  assert.equal(seen[0].url, '/v1/messages');
  assert.equal(seen[0].headers['x-api-key'], 'sk-ant-test');
  assert.equal(seen[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(seen[0].body.model, 'claude-haiku-5-5');
  assert.equal(seen.length, 1, 'a simple answer needs no second model call');
});

test('answers: with no key and no Claude Code, say how to fix it', async (t) => {
  const { ai } = await withAI(t, {});
  await assert.rejects(ai.answer('hi'), (e) => e.code === 'no_key' && /Gemini key/.test(e.message));
  assert.equal(ai.canAnswer(), false);
});

test('plans: a partially unsupported plan is rejected before any action can run', async (t) => {
  const plan = JSON.stringify({ say: 'Drafting it.', actions: [
    { type: 'compose_email', to: 'Sam', subject: 'Lab report', body: 'Hi Sam, here is the lab report.' },
    { type: 'delete_everything' },
    { type: 'press_keys', keys: ['ctrl', 'banana'] },
    { type: 'type_text', text: 'ok' },
  ] });
  const { s, seen, base } = await server(() => gemReply(plan));
  t.after(() => s.close());
  process.env.CLIPPY_GEMINI_BASE = base;
  const { ai } = await withAI(t, { keys: { gemini: 'k' } });
  await assert.rejects(ai.plan('email sam the lab report', { front: 'Inbox - Outlook', apps: ['Outlook', 'Notepad'] }), /unsupported actions/);
  assert.equal(seen[0].body.generationConfig.responseMimeType, 'application/json');
  assert.match(seen[0].body.contents[0].parts[0].text, /Front window: Inbox - Outlook/);
  assert.match(seen[0].body.systemInstruction.parts[0].text, /fixed set/i);
});

test('point and ask: Claude gets the close-up and the overview, and answers in JSON', async (t) => {
  const { s, seen, base } = await server(() => claudeReply(JSON.stringify({ route: 'A', mode: 'reply', response: '{"kicker":"Fix","text":"The link points to a file that moved. Relink it from Insert, then Link.","confidence":0.9}' })));
  t.after(() => s.close());
  process.env.CLIPPY_ANTHROPIC_BASE = base;
  const { ai } = await withAI(t, { keys: { anthropic: 'sk-ant-test' } });
  const r = await ai.explain({ crop: PNG, overview: PNG, element: { type: 'Text', name: 'Error: the linked file was not found' }, window: { title: 'report-draft.docx - Word', process: 'WINWORD' } });
  assert.equal(r.kicker, 'Fix');
  assert.match(r.text, /Relink it from Insert/);
  assert.equal(r.provider, 'anthropic');
  const content = seen[0].body.messages[0].content;
  assert.deepEqual(content.map((c) => c.type), ['image', 'image', 'text']);
  assert.equal(content[0].source.media_type, 'image/png');
  assert.match(content[2].text, /Error: the linked file was not found/);
  assert.match(content[2].text, /report-draft\.docx/);
  assert.match(seen[0].body.system, /Reply with JSON only/);
  assert.equal(seen.length, 1);
});

test('point and ask: a plain-prose reply is still an answer, a blank one is an error', async (t) => {
  const replies = ['It is a Save button.', ''];
  const { s, base } = await server(() => claudeReply(JSON.stringify({ route: 'A', mode: 'reply', response: replies.shift() })));
  t.after(() => s.close());
  process.env.CLIPPY_ANTHROPIC_BASE = base;
  const { ai } = await withAI(t, { keys: { anthropic: 'k' } });
  assert.equal((await ai.explain({ crop: PNG })).text, 'It is a Save button.');
  await assert.rejects(ai.explain({ crop: PNG }), /empty answer/);
});

test('point and ask: with no Anthropic key it uses Claude Code, then Gemini, and says which', async (t) => {
  let asked = null;
  const cli = { available: async () => true, ask: async (o) => { asked = o; return '{"kicker":"Explain","text":"From Claude Code.","confidence":0.8}'; } };
  const first = await withAI(t, { claudeCode: cli });
  const r = await first.ai.explain({ crop: PNG, overview: PNG, question: 'what is this?' });
  assert.equal(r.provider, 'claude-code');
  assert.equal(asked.images.length, 2);
  assert.match(asked.prompt, /what is this\?/);

  const { s, base } = await server(() => gemReply('{"kicker":"Explain","text":"From Gemini.","confidence":0.6}'));
  t.after(() => s.close());
  process.env.CLIPPY_GEMINI_BASE = base;
  const second = await withAI(t, { keys: { gemini: 'k' }, settings: { useClaudeCode: false } });
  const g = await second.ai.explain({ crop: PNG });
  assert.equal(g.provider, 'gemini');
  assert.equal(g.text, 'From Gemini.');

  const none = await withAI(t, { settings: { useClaudeCode: false } });
  await assert.rejects(none.ai.explain({ crop: PNG }), (e) => e.code === 'no_key' && /Anthropic key/.test(e.message));
});

test('errors are said in plain words', async (t) => {
  const codes = [401, 429, 503];
  const { s, base } = await server(() => ({ status: codes.shift(), json: { error: 'x' } }));
  t.after(() => s.close());
  process.env.CLIPPY_GEMINI_BASE = base;
  const { ai } = await withAI(t, { keys: { gemini: 'k' } });
  await assert.rejects(ai.answer('x'), /Gemini did not accept your key/);
  await assert.rejects(ai.answer('x'), /busy or your quota/);
  await assert.rejects(ai.answer('x'), /having trouble/);
  process.env.CLIPPY_GEMINI_BASE = 'http://127.0.0.1:1';
  await assert.rejects(ai.answer('x'), /Could not reach Gemini/);
});

test('hearing: Gemini transcribes a WAV when the on-device recognizer is missing', async (t) => {
  const { s, seen, base } = await server(() => gemReply('  open notepad and type hello  '));
  t.after(() => s.close());
  process.env.CLIPPY_GEMINI_BASE = base;
  const { ai } = await withAI(t, { keys: { gemini: 'k' } });
  assert.equal(await ai.transcribe(Buffer.from('RIFFxxxx')), 'open notepad and type hello');
  const part = seen[0].body.contents[0].parts[1];
  assert.equal(part.inlineData.mimeType, 'audio/wav');
  assert.equal(Buffer.from(part.inlineData.data, 'base64').toString(), 'RIFFxxxx');
  delete process.env.CLIPPY_GEMINI_BASE;
});

test('tolerant JSON', () => {
  assert.deepEqual(parseJson('Sure! {"a":1} done'), { a: 1 });
  assert.deepEqual(parseJson('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.equal(parseJson('no json here'), null);
  assert.equal(parseJson('{broken'), null);
});
