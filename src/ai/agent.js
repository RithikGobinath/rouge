'use strict';

const { AiError } = require('./http');
const { computerSystem } = require('./prompts');

const MAX_TURNS = 20;
const MAX_TOOLS = 24;
const DEADLINE_MS = 180000;

/** One selected worker owns the task until observed completion or a clear stop. */
async function runComputerAgent({ controller, request, user, goal, task, model, timestamp, signal, log = () => {} }) {
  const started = Date.now();
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }];
  const system = [{ type: 'text', text: computerSystem(task, { timestamp }), cache_control: { type: 'ephemeral' } }];
  let session; let last; let toolCount = 0; let observed = false; let consecutiveFailures = 0;
  const failedActions = new Set();
  function checkCancelled() {
    if (signal && signal.aborted) throw new AiError('The request was cancelled.', { provider: 'anthropic', code: 'cancelled' });
    return deadline.aborted;
  }
  function finish(say) {
    return { text: task === 'plan' ? JSON.stringify({ say, actions: [] }) : say, sources: [], webUsed: false, computerUsed: true,
      provider: 'anthropic', role: last && last.role, model, calls: last && last.calls };
  }
  try {
    if (checkCancelled()) return finish('I ran out of time before I could verify the task was complete.');
    if (!controller || typeof controller.createSession !== 'function') return finish('Computer control is unavailable, so I could not complete that task.');
    session = await controller.createSession({ signal: active, goal });
    if (!session || !Array.isArray(session.tools) || !session.tools.length || typeof session.runTool !== 'function') {
      throw new AiError('Computer control is not ready. Please try again.', { code: 'computer_unavailable' });
    }
    const names = new Set(session.tools.map((tool) => tool.name));
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      if (checkCancelled()) return finish('I ran out of time before I could verify the task was complete.');
      last = await request({ system, messages, tools: session.tools, signal: active, cacheControl: { type: 'ephemeral' },
        timeoutMs: Math.max(1, DEADLINE_MS - (Date.now() - started)),
        ...(/^claude-sonnet-5-5(?:-|$)/.test(model) ? { thinking: { type: 'between_tools' } } : {}) });
      if (checkCancelled()) return finish('I ran out of time before I could verify the task was complete.');
      const content = last && Array.isArray(last.content) ? last.content : [];
      const calls = content.filter((block) => block.type === 'tool_use');
      log(`computer turn=${turn + 1} tools=${toolCount} elapsedMs=${Date.now() - started} stop=${['tool_use', 'end_turn', 'refusal', 'pause_turn', 'max_tokens', 'stop_sequence'].includes(last.stop_reason) ? last.stop_reason : 'other'}`);
      if (last.stop_reason === 'refusal') return finish('Claude declined to continue this computer task.');
      if (last.stop_reason === 'max_tokens' || last.stop_reason === 'model_context_window_exceeded') {
        return finish('I reached the response limit before I could verify the task was complete.');
      }
      // No server tools are installed here; a paused server turn is not safe to execute or restart.
      if (last.stop_reason === 'pause_turn') return finish('The computer task paused before I could verify completion.');
      if (last.stop_reason !== 'tool_use') {
        if (!['end_turn', 'stop_sequence'].includes(last.stop_reason) || calls.length) return finish('The computer task stopped without a complete answer.');
        if (!observed) return finish('I could not inspect the computer, so I cannot verify that task was completed.');
        const text = content.filter((block) => block.type === 'text').map((block) => block.text || '').join('').trim();
        if (task !== 'plan') return finish(text || 'The computer task stopped without a usable answer.');
        let final;
        try { final = JSON.parse(text); } catch (_) { /* Never execute a partial or malformed final plan. */ }
        if (!final || typeof final.say !== 'string' || !final.say.trim() || !Array.isArray(final.actions) || final.actions.length) {
          return finish('The computer task stopped without a verified final answer.');
        }
        return finish(final.say.trim());
      }
      if (!calls.length || calls.some((call) => typeof call.id !== 'string' || !call.id) || new Set(calls.map((call) => call.id)).size !== calls.length) {
        return finish('Claude returned an incomplete computer command, so I stopped.');
      }
      if (toolCount + calls.length > MAX_TOOLS) return finish('I reached the action limit before I could verify the task was complete.');
      // Keep signatures, thinking and tool_use blocks intact; tool results immediately follow.
      messages.push({ role: 'assistant', content });
      const results = [];
      for (const call of calls) {
        if (checkCancelled()) return finish('I ran out of time before I could verify the task was complete.');
        toolCount += 1;
        const signature = JSON.stringify([call.name, call.input], (key, value) => key === 'snapshotId' ? undefined : value);
        if (call.name === 'computer_act' && failedActions.has(signature)) return finish('That computer action already failed, so I stopped instead of repeating it.');
        let result;
        if (call.name === 'computer_act') observed = false;
        try {
          result = names.has(call.name) ? await session.runTool(call.name, call.input) : { ok: false, error: { code: 'unknown_tool', message: 'Use an available computer tool.' } };
        } catch (_) {
          if (checkCancelled()) return finish('I ran out of time before I could verify the task was complete.');
          result = { ok: false, stopped: true, error: { code: 'tool_failed', message: 'Computer control failed before I could verify the result, so I stopped.' } };
        }
        if (checkCancelled()) return finish('I ran out of time before I could verify the task was complete.');
        const failed = !result || result.ok !== true;
        if (!failed && result.snapshot && ((typeof result.snapshot.text === 'string' && result.snapshot.text.trim())
          || (Array.isArray(result.snapshot.elements) && result.snapshot.elements.length))) observed = true;
        if (failed) consecutiveFailures += 1;
        else if (call.name === 'computer_act') consecutiveFailures = 0;
        if (failed && call.name === 'computer_act' && !['stale_reference', 'stale_snapshot'].includes(result && result.error && result.error.code)) failedActions.add(signature);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result || { ok: false, error: { code: 'empty_result', message: 'Computer control returned no state.' } }), ...(failed ? { is_error: true } : {}) });
        log(`computer tool=${call.name === 'computer_act' ? 'act' : call.name === 'computer_inspect' ? 'inspect' : 'unknown'} count=${toolCount} status=${failed ? 'error' : 'ok'} elapsedMs=${Date.now() - started}`);
        if (result && result.stopped) {
          if (signal && signal.aborted) checkCancelled();
          return finish(result.error && typeof result.error.message === 'string' ? result.error.message : 'Computer control stopped before the task was complete.');
        }
        if (consecutiveFailures >= 3) return finish('Computer control failed repeatedly, so I stopped before making more changes.');
      }
      messages.push({ role: 'user', content: results });
    }
    return finish('I reached the task limit before I could verify completion.');
  } catch (error) {
    if (signal && signal.aborted) checkCancelled();
    if (deadline.aborted) return finish('I ran out of time before I could verify the task was complete.');
    throw error;
  } finally {
    if (session && typeof session.close === 'function') await session.close();
  }
}

module.exports = { runComputerAgent };
