'use strict';

const { AiError } = require('./http');
const { computerSystem } = require('./prompts');

const MAX_TURNS = 20;
const MAX_TOOLS = 24;
const DEADLINE_MS = 180000;
const TOOLBAR = /^(back|forward|reload|refresh|home|new tab|extensions|bookmarks|downloads|history|address|omnibox|search tabs|chrome|edge|firefox|brave|file|edit|view|help)$/i;

/** Chrome toolbars alone are not proof of task completion. */
function meaningfulObservation(snapshot) {
  if (!snapshot || snapshot.blocked) return false;
  const text = String(snapshot.text || '').trim();
  if (text.length >= 80) return true;
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  const content = elements.filter((el) => {
    const name = String(el && el.name || '').trim();
    const type = String(el && el.type || '');
    if (!name || TOOLBAR.test(name)) return false;
    if (['Edit', 'Document', 'ListItem', 'DataItem', 'Hyperlink', 'Text', 'ComboBox'].includes(type)) return true;
    return name.length >= 18;
  });
  return content.length >= 3 || text.length >= 40;
}

/** Pull short alphanumeric tokens from the goal that should appear in a verified result. */
function goalTokens(goal) {
  return String(goal || '')
    .toUpperCase()
    .match(/\b(?:[A-Z]{3}|20\d{2}|(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*|\d{1,2})\b/g) || [];
}

function looksLikeBlocker(text) {
  return /\b(could not|couldn't|cannot|can't|unable|blocked|inaccessible|stopped|need (you|more)|ask(ed)? (you|the user)|not (enough|available|accessible|verified))\b/i.test(text)
    && !/\b(fare|price|\$\d|completed successfully|here are the)\b/i.test(text);
}

/**
 * Returns true when the goal is a navigation/pointer task — the agent's job is
 * to land on the right screen and tell the user what to click, not to produce
 * data that can be verified in the accessibility tree.  Windows Settings UWP
 * pages often have thin accessibility trees (mostly image thumbnails), so the
 * normal meaningfulObservation gate must be relaxed for these goals.
 */
function isNavigationGoal(goal) {
  return /\b(?:show\s+me\s+where|navigate\s+to|go\s+to|open\b.{0,80}\band\s+(?:show|find|navigate))\b/i.test(String(goal || ''));
}

function completionEvidence(goal, snapshot, answer) {
  if (!meaningfulObservation(snapshot) && !isNavigationGoal(goal)) return false;
  if (looksLikeBlocker(answer)) return true;
  const hay = `${snapshot.text || ''} ${(snapshot.elements || []).map((el) => el.name || '').join(' ')} ${answer}`.toUpperCase();
  const tokens = goalTokens(goal);
  if (!/\b(flight|flights|airfare|google flights|one-?way|round.?trip)\b/i.test(String(goal || ''))) return true;
  const needed = tokens.filter((t) => t.length >= 3);
  if (!needed.length) return /\b(flight|depart|arrive|nonstop|stop|\$\d)/i.test(hay);
  const hits = needed.filter((t) => hay.includes(t));
  return hits.length >= Math.min(2, needed.length) && /\b(flight|depart|arrive|nonstop|stop|\$\d|usd|eur|cad)/i.test(hay);
}

/** One selected worker owns the task until observed completion or a clear stop. */
async function runComputerAgent({ controller, request, user, goal, task, model, timestamp, signal, log = () => {} }) {
  const started = Date.now();
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  // The planner's "JSON only" line makes the model answer before it looks. The computer prompt already requires the final JSON.
  const opening = String(user || '').replace(/\nJSON only\.\s*$/i, '');
  const messages = [{ role: 'user', content: [{ type: 'text', text: opening }] }];
  const system = [{ type: 'text', text: computerSystem(task, { timestamp }), cache_control: { type: 'ephemeral' } }];
  let session; let last; let toolCount = 0; let observed = false; let nudged = false; let consecutiveFailures = 0;
  let lastSnapshot = null;
  const failedActions = new Set();
  function checkCancelled() {
    if (signal && signal.aborted) throw new AiError('The request was cancelled.', { provider: 'anthropic', code: 'cancelled' });
    return deadline.aborted;
  }
  function finish(say, extra) {
    return { text: task === 'plan' ? JSON.stringify({ say, actions: [] }) : say, sources: [], webUsed: false, computerUsed: true,
      provider: 'anthropic', role: last && last.role, model, calls: last && last.calls, ...(extra || {}) };
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
        if (!observed && toolCount === 0 && !nudged) {
          nudged = true;
          messages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: 'No observation yet.' }] });
          messages.push({ role: 'user', content: [{ type: 'text', text: 'You have not inspected the computer. Call computer_inspect before answering. Do not claim the task is done.' }] });
          continue;
        }
        const isNav = isNavigationGoal(goal);
        if ((!observed || !meaningfulObservation(lastSnapshot)) && !(isNav && toolCount > 0)) {
          return finish('I could not verify the requested outcome from the computer, so I stopped short of claiming it was done.');
        }
        const text = content.filter((block) => block.type === 'text').map((block) => block.text || '').join('').trim();
        if (task !== 'plan') {
          if (!completionEvidence(goal, lastSnapshot, text)) {
            return finish('I could not verify the requested outcome from the computer, so I stopped short of claiming it was done.');
          }
          return finish(text || 'The computer task stopped without a usable answer.', { snapshot: lastSnapshot });
        }
        let final;
        try { final = JSON.parse(text); } catch (_) { /* Never execute a partial or malformed final plan. */ }
        if (!final || typeof final.say !== 'string' || !final.say.trim() || !Array.isArray(final.actions) || final.actions.length) {
          return finish('The computer task stopped without a verified final answer.');
        }
        if (!completionEvidence(goal, lastSnapshot, final.say)) {
          return finish('I could not verify the requested outcome from the computer, so I stopped short of claiming it was done.');
        }
        return finish(final.say.trim(), { snapshot: lastSnapshot });
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
        if (!failed && result.snapshot) {
          lastSnapshot = result.snapshot;
          if (meaningfulObservation(result.snapshot)) observed = true;
        }
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
