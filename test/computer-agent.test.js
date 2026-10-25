'use strict';
// Authored for the user's later run. Mock transport/controller only; never a live model or desktop.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClaudeRouter } = require('../src/ai/router');
const { runComputerAgent } = require('../src/ai/agent');

const store = { getKey: () => 'test-only', settings: () => ({ models: {}, webAccess: true, auto: true }) };
const reply = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const snap = (text = 'Chrome — Google Flights — Results for SFO to MSN one-way with fares listed below.') => ({
  ok: true,
  snapshot: {
    snapshotId: 's1',
    text,
    elements: [
      { name: 'SFO', type: 'Edit' },
      { name: 'MSN', type: 'Edit' },
      { name: 'Nonstop · $198', type: 'ListItem' },
    ],
  },
});
const tools = ['computer_inspect', 'computer_act'].map((name) => ({ name, description: name, input_schema: { type: 'object' } }));
function transport(replies, bodies) {
  return async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    assert.ok(replies.length, 'no extra model requests');
    return { ok: true, text: async () => JSON.stringify(replies.shift()) };
  };
}

test('Auto answers simple work on A once, and sends a live lookup straight to B', async () => {
  const bodies = [];
  let replies = [reply('{"say":"4","actions":[]}')];
  let route = createClaudeRouter({ store, fetchImpl: transport(replies, bodies) });
  const simple = await route('plan', { system: 'JSON', user: '2+2' });
  assert.equal(simple.calls, 1);
  assert.equal(simple.role, 'A');
  assert.equal(simple.text, '{"say":"4","actions":[]}');
  replies = [reply('A sourced answer.')];
  route = createClaudeRouter({ store, fetchImpl: transport(replies, bodies) });
  const answer = await route('answer', { system: 'Answer', user: 'Look up current news' });
  assert.equal(answer.calls, 1);
  assert.equal(answer.role, 'B');
  assert.equal(answer.text, 'A sourced answer.');
  assert.equal(bodies.at(-1).model, 'claude-sonnet-5-5');
  assert.equal(bodies.at(-1).tools[0].name, 'web_search');
});

test('computer work goes straight to B, preserves thinking and returns completed JSON', async () => {
  const bodies = []; const ran = []; let closed = 0; let goal;
  const thinking = { type: 'thinking', thinking: '', signature: 'keep-this-signature' };
  const inspect = use('inspect-1', 'computer_inspect');
  const act = use('act-1', 'computer_act', { snapshotId: 's1', actions: [{ type: 'click', ref: 'c1' }] });
  const final = { say: 'I checked the results in Chrome.', actions: [] };
  const route = createClaudeRouter({ store,
    getComputer: () => ({ createSession: (options) => {
      goal = options.goal;
      return { tools, runTool: async (name) => { ran.push(name); return snap(); }, close: async () => { closed += 1; } };
    } }),
    fetchImpl: transport([
      { stop_reason: 'tool_use', content: [thinking, inspect] },
      { stop_reason: 'tool_use', content: [act] },
      reply(JSON.stringify(final)),
    ], bodies),
  });
  const result = await route('plan', { system: 'Static action rules', user: 'Context and request', goal: 'Check results in Chrome' });
  assert.deepEqual(JSON.parse(result.text), final);
  assert.equal(result.computerUsed, true);
  assert.equal(result.calls, 3);
  assert.equal(result.role, 'B');
  assert.equal(goal, 'Check results in Chrome');
  assert.deepEqual(ran, ['computer_inspect', 'computer_act']);
  assert.equal(closed, 1);
  assert.deepEqual(bodies.map((body) => body.model), Array(3).fill('claude-sonnet-5-5'));
  assert.equal(bodies[0].tools[0].name, 'computer_inspect');
  assert.deepEqual(bodies[0].thinking, { type: 'between_tools' });
  assert.deepEqual(bodies[1].messages[1].content, [thinking, inspect]);
  assert.deepEqual(bodies[1].messages[2].content.map((block) => block.type), ['tool_result']);
  assert.equal(bodies[1].messages[2].content[0].tool_use_id, inspect.id);
});

test('tool failure becomes matched is_error, and a fresh observation can recover', async () => {
  const received = []; let closed = 0;
  const requests = [
    { stop_reason: 'tool_use', content: [use('failed', 'computer_act')] },
    { stop_reason: 'tool_use', content: [use('inspect', 'computer_inspect')] },
    reply('{"say":"The page is now readable.","actions":[]}'),
  ];
  const result = await runComputerAgent({ task: 'plan', model: 'claude-sonnet-5-5', user: 'Check the page', goal: 'Check the page',
    controller: { createSession: () => ({ tools, runTool: async (name) => name === 'computer_inspect' ? snap() : { ok: false, error: { code: 'stale_reference', message: 'Inspect again.' } }, close: async () => { closed += 1; } }) },
    request: async (options) => { received.push(JSON.parse(JSON.stringify(options.messages))); return requests.shift(); },
  });
  assert.equal(JSON.parse(result.text).say, 'The page is now readable.');
  assert.equal(received[1][2].content[0].tool_use_id, 'failed');
  assert.equal(received[1][2].content[0].is_error, true);
  assert.equal(closed, 1);
});

test('unobserved completion and deferred actions are rejected; stopped control never continues', async () => {
  for (const scenario of ['unobserved', 'deferred', 'stopped']) {
    let requests = 0; let closed = 0;
    const result = await runComputerAgent({ task: 'plan', model: 'claude-opus-5-5', user: 'Complete task', goal: 'Complete task',
      controller: { createSession: () => ({ tools, runTool: async () => scenario === 'stopped' ? { ok: false, stopped: true, error: { code: 'foreground_changed', message: 'You switched apps, so I stopped.' } } : snap(), close: async () => { closed += 1; } }) },
      request: async () => {
        requests += 1;
        if (scenario !== 'unobserved' && requests === 1) return { stop_reason: 'tool_use', content: [use('inspect', 'computer_inspect')] };
        return reply(JSON.stringify({ say: 'Done', actions: scenario === 'deferred' ? [{ type: 'open_app', app: 'Chrome' }] : [] }));
      },
    });
    const output = JSON.parse(result.text);
    assert.deepEqual(output.actions, []);
    assert.notEqual(output.say, 'Done');
    assert.equal(requests, scenario === 'stopped' ? 1 : 2);
    assert.equal(closed, 1);
  }
});

test('a final answer before any inspection is sent back to inspect once', async () => {
  const seen = [];
  const requests = [
    reply(JSON.stringify({ say: 'Done', actions: [] })),
    { stop_reason: 'tool_use', content: [use('inspect', 'computer_inspect')] },
    reply(JSON.stringify({ say: 'I checked the results in Chrome.', actions: [] })),
  ];
  const result = await runComputerAgent({
    task: 'plan', model: 'claude-sonnet-5-5', user: 'Front window: Chrome\nUser said: check the results\nJSON only.', goal: 'check the results',
    controller: { createSession: () => ({ tools, runTool: async () => snap(), close: async () => {} }) },
    request: async (options) => {
      const last = options.messages.at(-1);
      const text = Array.isArray(last.content) ? last.content.map((block) => block.text || '').join('') : String(last.content || '');
      seen.push(text);
      return requests.shift();
    },
  });
  assert.equal(JSON.parse(result.text).say, 'I checked the results in Chrome.');
  assert.equal(seen[0].endsWith('JSON only.'), false);
  assert.match(seen[1], /computer_inspect/);
});

test('Chrome toolbar alone is not completion evidence for a flight search', async () => {
  const toolbar = {
    ok: true,
    snapshot: {
      snapshotId: 'toolbar',
      text: '',
      elements: [
        { name: 'Back', type: 'Button' },
        { name: 'Forward', type: 'Button' },
        { name: 'Reload', type: 'Button' },
        { name: 'Address', type: 'Edit' },
      ],
    },
  };
  let requests = 0;
  const result = await runComputerAgent({
    task: 'plan', model: 'claude-sonnet-5-5',
    user: 'Find one-way flights SFO to MSN on October 30',
    goal: 'one-way flights SFO to MSN October 30 2026',
    controller: { createSession: () => ({ tools, runTool: async () => toolbar, close: async () => {} }) },
    request: async () => {
      requests += 1;
      if (requests === 1) return { stop_reason: 'tool_use', content: [use('inspect', 'computer_inspect')] };
      return reply(JSON.stringify({ say: 'Done. Flights are ready.', actions: [] }));
    },
  });
  const output = JSON.parse(result.text);
  assert.notEqual(output.say, 'Done. Flights are ready.');
  assert.match(output.say, /could not verify/i);
});

test('cancellation closes the session before any additional model request', async () => {
  const abort = new AbortController(); let requests = 0; let closed = 0;
  await assert.rejects(runComputerAgent({ task: 'plan', model: 'claude-sonnet-5-5', user: 'Task', goal: 'Task', signal: abort.signal,
    controller: { createSession: () => ({ tools, runTool: async () => { abort.abort(); return snap(); }, close: async () => { closed += 1; } }) },
    request: async () => { requests += 1; return { stop_reason: 'tool_use', content: [use('inspect', 'computer_inspect')] }; },
  }), (error) => error.code === 'cancelled');
  assert.equal(requests, 1);
  assert.equal(closed, 1);
});
