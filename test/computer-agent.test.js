'use strict';
// Authored for the user's later run. Mock transport/controller only; never a live model or desktop.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClaudeRouter } = require('../src/ai/router');
const { runComputerAgent } = require('../src/ai/agent');

const store = { getKey: () => 'test-only', settings: () => ({ models: {}, webAccess: true }) };
const reply = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const snap = (text = 'Chrome — example.com — Results') => ({ ok: true, snapshot: { snapshotId: 's1', text, elements: [] } });
const tools = ['computer_inspect', 'computer_act'].map((name) => ({ name, description: name, input_schema: { type: 'object' } }));
function transport(replies, bodies) {
  return async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    assert.ok(replies.length, 'no extra model requests');
    return { ok: true, text: async () => JSON.stringify(replies.shift()) };
  };
}

test('A answers once; read-only research uses only A plus B', async () => {
  const bodies = [];
  let replies = [reply(JSON.stringify({ route: 'A', mode: 'reply', response: '{"say":"4","actions":[]}' }))];
  let route = createClaudeRouter({ store, fetchImpl: transport(replies, bodies) });
  assert.equal((await route('plan', { system: 'JSON', user: '2+2' })).calls, 1);
  replies = [reply(JSON.stringify({ route: 'B', mode: 'reply', response: '' })), reply('A sourced answer.')];
  route = createClaudeRouter({ store, fetchImpl: transport(replies, bodies) });
  const answer = await route('answer', { system: 'Answer', user: 'Look up current news' });
  assert.equal(answer.calls, 2);
  assert.equal(answer.text, 'A sourced answer.');
  assert.equal(bodies[2].tools[0].name, 'web_search');
});

test('computer work goes straight from A to tools, preserves thinking and returns completed JSON', async () => {
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
      reply(JSON.stringify({ route: 'B', mode: 'computer', response: '' })),
      { stop_reason: 'tool_use', content: [thinking, inspect] },
      { stop_reason: 'tool_use', content: [act] },
      reply(JSON.stringify(final)),
    ], bodies),
  });
  const result = await route('plan', { system: 'Static action rules', user: 'Context and request', goal: 'Check results in Chrome' });
  assert.deepEqual(JSON.parse(result.text), final);
  assert.equal(result.computerUsed, true);
  assert.equal(result.calls, 4);
  assert.equal(goal, 'Check results in Chrome');
  assert.deepEqual(ran, ['computer_inspect', 'computer_act']);
  assert.equal(closed, 1);
  assert.deepEqual(bodies.slice(1).map((body) => body.model), Array(3).fill('claude-sonnet-5-5'));
  assert.equal(bodies[1].tools[0].name, 'computer_inspect');
  assert.deepEqual(bodies[1].thinking, { type: 'between_tools' });
  assert.deepEqual(bodies[2].messages[1].content, [thinking, inspect]);
  assert.deepEqual(bodies[2].messages[2].content.map((block) => block.type), ['tool_result']);
  assert.equal(bodies[2].messages[2].content[0].tool_use_id, inspect.id);
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
    assert.equal(requests, scenario === 'deferred' ? 2 : 1);
    assert.equal(closed, 1);
  }
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
