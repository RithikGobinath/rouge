'use strict';
// A saved Anthropic key selects the Claude A/B/C route for every answer,
// action plan, and explicitly invoked point-and-ask. The optional legacy
// providers are used only when that key is absent, never after a failed call.
// This module does not schedule screen captures or implement the local D watcher.

const { gemini } = require('./providers');
const { AiError, parseJson } = require('./http');
const prompts = require('./prompts');
const { validateAll } = require('../actions/schema');
const { createClaudeCode } = require('./claudeCode');
const { createClaudeRouter } = require('./router');

const NEED_KEY = 'Add a Gemini key (free) or an Anthropic key under Your keys to get answers.';

/**
 * @param {{store:any, folders?:any, claudeCode?:any, fetchImpl?:Function, getComputer?:Function, log?:Function}} deps
 */
function createAI({ store, folders, claudeCode, fetchImpl, getComputer, log = () => {} }) {
  const cc = claudeCode || createClaudeCode();
  const model = (p) => store.settings().models[p];
  const keys = () => ({ gemini: store.getKey('gemini'), anthropic: store.getKey('anthropic') });
  const call = { fetchImpl };
  const route = createClaudeRouter({ store, fetchImpl, getComputer, log });

  async function text(task, { system, user, goal, json, maxTokens, signal, onChunk }) {
    const k = keys();
    if (k.anthropic) return route(task, { system, user, goal, signal, onChunk });
    if (k.gemini) return { text: await gemini({ apiKey: k.gemini, model: model('gemini'), system, text: user, json, maxTokens, signal, ...call }), provider: 'gemini' };
    if (store.settings().useClaudeCode && await cc.available()) return { text: await cc.ask({ prompt: `${system}\n\n${user}` }), provider: 'claude-code' };
    throw new AiError(NEED_KEY, { code: 'no_key' });
  }

  return {
    claudeCode: cc,
    usesClaudeRouting: () => Boolean(store.getKey('anthropic')),

    /** What is set up, for the settings window and for deciding what to offer. */
    async status() {
      const k = store.keyStatus();
      return { gemini: k.gemini, anthropic: k.anthropic, typesafe: k.typesafe, claudeCode: store.settings().useClaudeCode ? await cc.available() : false };
    },
    canAnswer() { const k = store.keyStatus(); return k.gemini || k.anthropic; },

    /**
     * A spoken or typed request for an answer or some writing.
     * @returns {Promise<{text:string, sources:object[], provider:string}>}
     */
    async answer(question, { history = [], signal, onChunk } = {}) {
      const ctx = folders ? folders.context(question) : { text: '', sources: [] };
      const recent = history.slice(-6).map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.text}`).join('\n');
      const user = [ctx.text, recent && `Earlier in this chat:\n${recent}`, `User: ${question}`].filter(Boolean).join('\n\n');
      const r = await text('answer', { system: typeof prompts.ANSWER === 'function' ? prompts.ANSWER() : prompts.ANSWER, user, maxTokens: 700, signal, onChunk });
      return { text: r.text, sources: [...(r.sources || []), ...(ctx.sources || [])].slice(0, 12), provider: r.provider, role: r.role, model: r.model, calls: r.calls, webUsed: Boolean(r.webUsed) };
    },

    /**
     * Turn a request the grammar did not know into actions from the fixed set.
     * @returns {Promise<{say:string, actions:object[], dropped:number, provider:string}>}
     */
    async plan(utterance, { front = '', apps = [], history = [], signal } = {}) {
      const ctx = folders ? folders.context(utterance) : { text: '' };
      const recent = history.slice(-6).map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.text}`).join('\n');
      const user = [`Front window: ${front || '(unknown)'}`, apps.length ? `Installed apps include: ${apps.slice(0, 60).join(', ')}` : '', ctx.text, recent && `Earlier in this chat:\n${recent}`, `User said: ${utterance}`, 'JSON only.'].filter(Boolean).join('\n');
      const r = await text('plan', { system: prompts.PLAN, user, goal: utterance, json: true, maxTokens: 1200, signal });
      const obj = parseJson(r.text);
      if (!obj) throw new AiError('Claude could not finish that request in a usable form. Please try again.', { provider: r.provider, code: 'plan' });
      if (!Array.isArray(obj.actions) || obj.actions.length > 6 || (r.computerUsed && obj.actions.length)) {
        throw new AiError('The request returned an incomplete action plan, so I stopped before running it.', { provider: r.provider, code: 'plan' });
      }
      const v = validateAll(obj.actions, 6);
      if (v.errors.length) throw new AiError('The request included unsupported actions, so I stopped before running it.', { provider: r.provider, code: 'plan' });
      const say = typeof obj.say === 'string' ? obj.say.trim().slice(0, 24000) : '';
      if (!say && !v.actions.length) throw new AiError('The request returned no answer or supported actions. Please try again.', { provider: r.provider, code: 'empty_plan' });
      return { say, actions: v.actions, dropped: 0, provider: r.provider, sources: [...(r.sources || []), ...(ctx.sources || [])].slice(0, 12), role: r.role, model: r.model, calls: r.calls, webUsed: Boolean(r.webUsed), computerUsed: Boolean(r.computerUsed), ...(r.snapshot ? { snapshot: r.snapshot } : {}) };
    },

    /**
     * Point and ask. Claude first; the fallbacks say so in the result.
     * @param {{crop:string, overview?:string, question?:string, element?:object, window?:object, signal?:AbortSignal}} o images are data URLs
     * @returns {Promise<{kicker:string, text:string, confidence:number, provider:string}>}
     */
    async explain({ crop, overview, question, element, window, signal }) {
      const k = keys();
      const user = prompts.explainText({ question, element, window });
      let raw; let provider; let routing = {};
      if (k.anthropic) {
        const r = await route('explain', { system: prompts.EXPLAIN, user, imageDataUrl: crop, extraImages: overview ? [overview] : [], signal });
        raw = r.text; provider = r.provider; routing = { role: r.role, model: r.model, calls: r.calls, sources: r.sources || [], webUsed: Boolean(r.webUsed) };
      } else if (store.settings().useClaudeCode && await cc.available()) {
        raw = await cc.ask({ prompt: `${prompts.EXPLAIN}\n\n${user}`, images: [crop, overview].filter(Boolean) });
        provider = 'claude-code';
      } else if (k.gemini) {
        raw = await gemini({ apiKey: k.gemini, model: model('gemini'), system: prompts.EXPLAIN, text: user, imageDataUrl: crop, json: true, maxTokens: 600, signal, ...call });
        provider = 'gemini';
      } else {
        throw new AiError('Pointing needs Claude. Add an Anthropic key under Your keys, or sign in to Claude Code.', { code: 'no_key' });
      }
      const obj = parseJson(raw);
      if (!obj || typeof obj.text !== 'string' || !obj.text.trim()) {
        // A model that answers in plain prose is still an answer.
        const plain = String(raw || '').trim();
        if (!plain) throw new AiError('The answer came back empty. Try again.', { code: 'empty' });
        return { kicker: 'Explain', text: plain.slice(0, 500), confidence: 0.5, provider, ...routing };
      }
      const kicker = ['Explain', 'Fix', 'Answer'].includes(obj.kicker) ? obj.kicker : 'Explain';
      return { kicker, text: obj.text.trim().slice(0, 500), confidence: Math.max(0, Math.min(1, Number(obj.confidence) || 0.7)), provider, ...routing };
    },

    /** Gemini as the ear when the on-device recognizer is not there. */
    async transcribe(wav, { signal } = {}) {
      const k = keys();
      if (!k.gemini) throw new AiError('Hearing you needs the Windows speech recognizer, or a Gemini key as a backup.', { code: 'no_key' });
      const out = await gemini({ apiKey: k.gemini, model: model('gemini'), text: 'Transcribe this audio verbatim. Return only the spoken words, no commentary. If there is no clear speech, return nothing.', audio: { mime: 'audio/wav', b64: wav.toString('base64') }, maxTokens: 300, temperature: 0, signal, ...call });
      return out.trim();
    },
  };
}

module.exports = { createAI, NEED_KEY };
