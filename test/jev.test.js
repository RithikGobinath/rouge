'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createJev, buildRequest, toActions, textCandidates, domainGuess, ACTIONS } = require('../src/voice/jev');

function startServer(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : null;
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
        const out = handler(parsed, req);
        res.writeHead(out.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.json));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1/systemone` }));
  });
}

const ch = (choice, confidence = 0.9) => ({ type: 'choice', choice, confidence, probabilities: { [choice]: confidence } });
const yn = (v) => ({ type: 'noul', noul: v });

test('the request follows the published System One shape', () => {
  const req = buildRequest('put hello world in there and hit enter', { apps: ['Notepad', 'Calculator'], folders: ['Class notes'], front: 'Untitled - Notepad' });
  assert.equal(req.model, 'jev-latest');
  assert.equal(req.state.utterance, 'put hello world in there and hit enter');
  assert.equal(req.state.frontmost_window, 'Untitled - Notepad');
  assert.deepEqual(req.state.apps, ['Notepad', 'Calculator']);
  assert.ok(Object.keys(req.questions).length >= 10);
  for (const [name, q] of Object.entries(req.questions)) {
    assert.ok(['choice', 'noul'].includes(q.type), name);
    assert.equal(typeof q.instructions, 'string', name);
    if (q.type === 'choice') {
      const n = Object.keys(q.criteria).length;
      assert.ok(n >= 1 && n <= 255, `${name} has ${n} choices`);
    } else {
      assert.deepEqual(Object.keys(q.criteria).sort(), ['false', 'true']);
    }
  }
  assert.deepEqual(Object.keys(req.questions.action.criteria), Object.keys(ACTIONS));
  assert.ok('none' in req.questions.app.criteria && 'Notepad' in req.questions.app.criteria);
  assert.ok('Class notes' in req.questions.folder.criteria && 'downloads' in req.questions.folder.criteria);
  assert.equal(req.candidates.c0, 'hello world in there');
});

test('text candidates are cut from the utterance, never invented', () => {
  assert.deepEqual(Object.values(textCandidates('type hello world and press enter')), ['hello world', 'type hello world']);
  assert.ok(Object.values(textCandidates('search for lofi hip hop on youtube')).includes('lofi hip hop on youtube'));
  assert.ok(Object.values(textCandidates('click the send button')).includes('send'));
  assert.equal(domainGuess('pull up gmail'), 'gmail.com');
  assert.equal(domainGuess('go to example.org'), 'example.org');
});

test('answers become actions from the fixed set', () => {
  const req = buildRequest('put hello in there and hit enter');
  let r = toActions({ action: ch('type_text'), text: ch('c0'), submit: yn(0.95) }, req, 'put hello in there and hit enter');
  assert.deepEqual(r.actions.map((a) => a.type), ['type_text', 'press_keys']);
  assert.equal(r.actions[0].text, 'hello in there');
  assert.deepEqual(r.actions[1].keys, ['enter']);

  r = toActions({ action: ch('open_app'), app: ch('Calculator', 0.8) }, buildRequest('pull up the calculator'), 'pull up the calculator');
  assert.deepEqual(r.actions, [{ type: 'open_app', app: 'Calculator' }]);
  assert.equal(r.confidence, 0.8);

  r = toActions({ action: ch('shortcut'), shortcut: ch('select_all') }, req, 'x');
  assert.deepEqual(r.actions[0].keys, ['ctrl', 'a']);

  r = toActions({ action: ch('volume'), volume_op: ch('down') }, req, 'x');
  assert.deepEqual(r.actions[0], { type: 'media', op: 'vol_down', times: 5 });

  r = toActions({ action: ch('scroll'), scroll_dir: ch('bottom') }, req, 'x');
  assert.deepEqual(r.actions[0], { type: 'scroll', dir: 'down', amount: 'edge' });

  r = toActions({ action: ch('web_search'), engine: ch('youtube'), text: ch('c0') }, buildRequest('find videos of cats'), 'find videos of cats');
  assert.match(r.actions[0].url, /^https:\/\/www\.youtube\.com\/results\?search_query=/);

  r = toActions({ action: ch('window'), window_op: ch('minimize') }, req, 'x');
  assert.deepEqual(r.actions[0], { type: 'window_op', op: 'minimize' });

  r = toActions({ action: ch('new_item'), new_kind: ch('item') }, req, 'start a new email');
  assert.equal(r.actions[0].type, 'compose_email');

  r = toActions({ action: ch('open_website'), site: ch('other') }, req, 'go to example.org');
  assert.equal(r.actions[0].url, 'https://example.org');

  r = toActions({ action: ch('click'), text: ch('c0') }, buildRequest('click the send button'), 'click the send button');
  assert.deepEqual(r.actions[0], { type: 'click', name: 'send', kind: 'single' });
});

test('below the confidence floor, or not a command, nothing runs', () => {
  const req = buildRequest('mumble');
  assert.deepEqual(toActions({ action: ch('open_app', 0.2), app: ch('Notepad', 0.9) }, req, 'mumble').actions, []);
  assert.deepEqual(toActions({ action: ch('open_app', 0.9), app: ch('Notepad', 0.2) }, req, 'mumble').actions, []);
  assert.deepEqual(toActions({ action: ch('question'), app: ch('Notepad') }, req, 'what is a trefoil').actions, []);
  assert.deepEqual(toActions({ action: ch('open_app'), app: ch('none') }, req, 'open flarb').actions, []);
});

test('one request per clause, with the key as a bearer token', async () => {
  const { server, seen, url } = await startServer((body) => ({ json: { model: 'jev-1.13.0', answers: { action: ch('open_app'), app: ch('Notepad', 0.97) }, usage: { input_tokens: 10, output_tokens: 0 } } }));
  try {
    const jev = createJev({ apiKey: 'tsk_test', url });
    const plan = await jev.plan('pull up notepad please', { apps: ['Notepad'] });
    assert.deepEqual(plan.actions, [{ type: 'open_app', app: 'Notepad' }]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].headers.authorization, 'Bearer tsk_test');
    assert.equal(seen[0].body.model, 'jev-latest');
    assert.equal(seen[0].body.state.utterance, 'pull up notepad please');
    assert.ok(plan.ms >= 0);
  } finally { server.close(); }
});

test('a rejected key surfaces its status, and a missing key never calls out', async () => {
  const { server, seen, url } = await startServer(() => ({ status: 401, json: { detail: 'bad key' } }));
  try {
    await assert.rejects(createJev({ apiKey: 'nope', url }).plan('open notepad'), (e) => e.status === 401);
    await assert.rejects(createJev({ apiKey: '', url }).plan('open notepad'), /no TypeSafe key/);
    assert.equal(seen.length, 1);
  } finally { server.close(); }
});
