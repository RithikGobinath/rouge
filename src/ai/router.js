'use strict';
// Haiku is both the first responder and the router. A direct answer costs one
// request; research escalations cost two. Interactive tasks stay with the
// selected worker while it observes and acts, without returning to A.

const { anthropic, anthropicMessages, anthropicStream } = require('./providers');
const { AiError } = require('./http');
const { routeSystem, workerSystem } = require('./prompts');
const { runComputerAgent } = require('./agent');
const { pickAuto } = require('./auto');

const ROLES = Object.freeze({
  A: Object.freeze({ key: 'anthropicA', model: 'claude-haiku-5-5', effort: 'low', maxTokens: 800, timeoutMs: 30000 }),
  B: Object.freeze({ key: 'anthropicB', model: 'claude-sonnet-5-5', effort: 'medium', maxTokens: 8192, timeoutMs: 90000 }),
  C: Object.freeze({ key: 'anthropicC', model: 'claude-opus-5-5', effort: 'high', maxTokens: 16384, timeoutMs: 120000 }),
});

// Keep this schema small and constant. It contains no user content, which is
// sent only as message text/images, and is shared across all three task types.
const ROUTE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    route: { type: 'string', enum: ['A', 'B', 'C'] },
    mode: { type: 'string', enum: ['reply', 'computer'] },
    response: { type: 'string' },
  },
  required: ['route', 'mode', 'response'],
  additionalProperties: false,
});

function abortIfNeeded(signal) {
  if (signal && signal.aborted) throw new AiError('The request was cancelled.', { provider: 'anthropic', code: 'cancelled' });
}

/** One shared key, with model IDs read from the normal validated settings. */
function createClaudeRouter({ store, fetchImpl, getComputer = () => null, log = () => {} }) {
  return async function route(task, { system, user, goal = user, imageDataUrl, extraImages = [], signal, onChunk, webSearches }) {
    const apiKey = store.getKey('anthropic');
    if (!apiKey) throw new AiError('Add an Anthropic key under Your keys to use Claude.', { provider: 'anthropic', code: 'no_key' });
    if (!['answer', 'plan', 'explain'].includes(task)) throw new AiError('That request type is not supported.', { code: 'task' });
    const settings = store.settings();
    const models = settings.models || {};
    const webAccess = settings.webAccess !== false;
    const timestamp = new Date().toISOString();
    let calls = 0;
    async function callRole(role, taskSystem, format, continuation, chunkCb) {
      abortIfNeeded(signal);
      const config = ROLES[role];
      const model = models[config.key] || config.model;
      if (typeof model !== 'string' || !/^claude-[A-Za-z0-9._-]{1,72}$/.test(model)) {
        throw new AiError(`Pick a Claude model ID for Model ${role} under Preferences.`, { provider: 'anthropic', code: 'model' });
      }
      const started = Date.now();
      calls += 1;
      // Stream only for role A plain-text replies: no format schema, no tool
      // continuation, no web tools.  Role B/C replies stay non-streaming because
      // they may include web-search content blocks that need the full response.
      const useStream = Boolean(chunkCb) && !format && !continuation && role === 'A';
      try {
        const options = { apiKey, model, effort: config.effort, maxTokens: config.maxTokens, timeoutMs: config.timeoutMs,
          system: taskSystem, text: user, imageDataUrl, extraImages, format, web: !continuation && role !== 'A' && webAccess, webSearches, details: true, signal, fetchImpl };
        const result = continuation
          ? await anthropicMessages({ ...options, ...continuation, timeoutMs: Math.min(config.timeoutMs, continuation.timeoutMs) })
          : useStream
            ? await anthropicStream({ ...options, web: false }, chunkCb)
            : await anthropic(options);
        const usage = result.usage || {};
        const thought = Array.isArray(result.content) ? result.content.filter((b) => b && b.type === 'thinking').length : 0;
        log(`ai task=${task} role=${role} calls=${calls} webUsed=${Boolean(result.webUsed)} elapsedMs=${Date.now() - started} status=ok`
          + (usage.output_tokens != null ? ` out=${usage.output_tokens} in=${usage.input_tokens} thinkingBlocks=${thought}` : ''));
        return { ...result, provider: 'anthropic', role, model, calls };
      } catch (e) {
        // Never log prompts, images, response bodies, keys, or raw provider errors.
        log(`ai task=${task} role=${role} calls=${calls} elapsedMs=${Date.now() - started} status=error`);
        throw e;
      }
    }

    // Auto matches Cursor's router: classify here, then one model answers.
    // Turning Auto off keeps the older path, where A routes inside its first call.
    if (settings.auto !== false) {
      const decision = pickAuto({ task, user, goal, webAccess });
      log(`ai auto role=${decision.role} mode=${decision.mode}`);
      if (decision.mode === 'computer') {
        const config = ROLES[decision.role];
        const model = models[config.key] || config.model;
        const result = await runComputerAgent({ controller: getComputer(), user, goal, task, model, timestamp, signal, log,
          request: (options) => callRole(decision.role, options.system, undefined, options) });
        return { ...result, role: decision.role, model, calls };
      }
      if (decision.role === 'A') {
        // Stamp the current time so model A can answer "what day is Tuesday after?" etc.
        const timedA = `Current UTC date and time: ${timestamp}. User time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.\n${system}`;
        return callRole('A', timedA, undefined, undefined, onChunk);
      }
      return callRole(decision.role, workerSystem(system, { webAccess, timestamp }));
    }

    const first = await callRole('A', routeSystem(system, task, { webAccess, timestamp }), { type: 'json_schema', schema: ROUTE_SCHEMA });
    let decision;
    try { decision = JSON.parse(first.text); } catch (_) { throw new AiError('Claude could not finish deciding how to answer. Please try again.', { provider: 'anthropic', code: 'route' }); }
    const selected = decision && decision.route;
    if (!['A', 'B', 'C'].includes(selected) || !['reply', 'computer'].includes(decision.mode) || typeof decision.response !== 'string'
      || Object.keys(decision).length !== 3 || (selected !== 'A' && decision.response !== '')
      || (decision.mode === 'computer' && (selected === 'A' || task !== 'plan'))) {
      throw new AiError('Claude returned an incomplete routing decision. Please try again.', { provider: 'anthropic', code: 'route' });
    }
    if (selected === 'A') {
      const text = decision.response.trim();
      if (!text) throw new AiError('Claude returned an empty answer. Please try again.', { provider: 'anthropic', code: 'empty' });
      return { ...first, text };
    }
    // The handoff is a local branch, not a tool round-trip or another A request.
    abortIfNeeded(signal);
    if (decision.mode === 'computer') {
      const config = ROLES[selected];
      const model = models[config.key] || config.model;
      const result = await runComputerAgent({ controller: getComputer(), user, goal, task, model, timestamp, signal, log,
        request: (options) => callRole(selected, options.system, undefined, options) });
      return { ...result, role: selected, model, calls };
    }
    return callRole(selected, workerSystem(system, { webAccess, timestamp }));
  };
}

module.exports = { createClaudeRouter, ROLES, ROUTE_SCHEMA, pickAuto };
