'use strict';
// Gemini and Anthropic over plain HTTPS, no SDKs. Each takes the same few
// things (a system prompt, some text, maybe an image or a sound) and returns
// the model's text. The key goes in a header, never in a URL.

const { postJson, AiError, dataUrlParts } = require('./http');
const { webTools, webResponse } = require('./web');

const geminiBase = () => process.env.CLIPPY_GEMINI_BASE || 'https://generativelanguage.googleapis.com';
function anthropicBase() {
  const base = new URL(process.env.CLIPPY_ANTHROPIC_BASE || 'https://api.anthropic.com');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || (!local && base.origin !== 'https://api.anthropic.com') || (local && !['http:', 'https:'].includes(base.protocol))) {
    throw new AiError('Claude must use its official HTTPS endpoint or a local development endpoint.', { provider: 'anthropic', code: 'endpoint' });
  }
  return base.href.replace(/\/+$/, '');
}

/**
 * @param {{apiKey:string, model:string, system?:string, text:string, imageDataUrl?:string, audio?:{mime:string,b64:string},
 *          json?:boolean, maxTokens?:number, temperature?:number, timeoutMs?:number, fetchImpl?:Function, signal?:AbortSignal}} o
 * @returns {Promise<string>}
 */
async function gemini(o) {
  const parts = [{ text: o.text }];
  const img = dataUrlParts(o.imageDataUrl);
  if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
  if (o.audio) parts.push({ inlineData: { mimeType: o.audio.mime, data: o.audio.b64 } });
  const generationConfig = { temperature: o.temperature == null ? 0.3 : o.temperature, maxOutputTokens: Math.max(Number(o.maxTokens) || 0, 1024) };
  // Flash models think by default and the thinking counts against the budget: off for short answers.
  if (/flash/i.test(o.model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  if (o.json) generationConfig.responseMimeType = 'application/json';
  const body = { contents: [{ role: 'user', parts }], generationConfig };
  if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
  const data = await postJson('gemini', `${geminiBase()}/v1beta/models/${encodeURIComponent(o.model)}:generateContent`, { 'x-goog-api-key': o.apiKey }, body, o);
  if (data.promptFeedback && data.promptFeedback.blockReason) throw new AiError('Gemini declined to answer that.', { provider: 'gemini', code: 'blocked' });
  const cand = data.candidates && data.candidates[0];
  const text = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts.map((p) => p.text || '').join('') : '';
  return text.trim();
}

/** Raw Messages response: callers must preserve every content block between tool turns. */
async function anthropicMessages(o) {
  // Web search always has citations, which the API cannot combine with a
  // strict output schema. The router therefore gives web tools only to B/C.
  if (o.web && o.format) throw new AiError('Internet tools cannot use the router response format.', { provider: 'anthropic', code: 'web_format' });
  const body = { model: o.model, max_tokens: Number(o.maxTokens) || 700, messages: o.messages };
  if (o.system) body.system = o.system;
  if (o.tools) body.tools = o.tools;
  else if (o.web) body.tools = webTools();
  if (o.thinking) body.thinking = o.thinking;
  if (o.cacheControl) body.cache_control = o.cacheControl;
  if (o.effort || o.format) {
    body.output_config = {};
    if (o.effort) body.output_config.effort = o.effort;
    if (o.format) body.output_config.format = o.format;
  }
  // The 5.5 models use adaptive thinking by default. Do not send legacy
  // thinking budgets or sampling settings, which some of them reject.
  try {
    return await postJson('anthropic', `${anthropicBase()}/v1/messages`, { 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' }, body, o);
  } catch (error) {
    if (o.web && error.status === 400) throw new AiError('Claude rejected the internet tools for this model or account. Check web search access in the Claude Console.', { provider: 'anthropic', status: 400, code: 'web_access' });
    throw error;
  }
}

/** @param {{apiKey:string, model:string, system?:string, text:string, imageDataUrl?:string, extraImages?:string[], maxTokens?:number, effort?:string, format?:object, web?:boolean, details?:boolean, timeoutMs?:number, fetchImpl?:Function, signal?:AbortSignal}} o @returns {Promise<string|{text:string,sources:object[],webUsed:boolean}>} */
async function anthropic(o) {
  const content = [];
  for (const url of [o.imageDataUrl, ...(o.extraImages || [])]) {
    const img = dataUrlParts(url);
    if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
  }
  content.push({ type: 'text', text: o.text });
  const data = await anthropicMessages({ ...o, messages: [{ role: 'user', content }] });
  if (data.stop_reason === 'refusal') throw new AiError('Claude declined that request.', { provider: 'anthropic', code: 'refusal' });
  if (data.stop_reason === 'max_tokens') throw new AiError('Claude reached its response limit. Try a smaller request.', { provider: 'anthropic', code: 'output_limit' });
  // Continuing a paused server turn would add a third application request.
  if (data.stop_reason === 'pause_turn') throw new AiError('The web lookup paused before it finished. Try a more specific question.', { provider: 'anthropic', code: 'web_paused' });
  if (data.stop_reason && !['end_turn', 'stop_sequence'].includes(data.stop_reason)) throw new AiError('Claude did not complete that response. Please try again.', { provider: 'anthropic', code: 'incomplete' });
  const result = webResponse(data.content);
  if (result.webError && !result.successfulResults) throw new AiError('The internet lookup was unavailable or reached its limit. Please try again.', { provider: 'anthropic', code: 'web_unavailable' });
  if (!result.text) throw new AiError('Claude returned an empty answer. Please try again.', { provider: 'anthropic', code: 'empty' });
  return o.details ? { text: result.text, sources: result.sources, webUsed: result.webUsed } : result.text;
}

module.exports = { gemini, anthropic, anthropicMessages };
