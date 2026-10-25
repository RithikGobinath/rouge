'use strict';
// Gemini and Anthropic over plain HTTPS, no SDKs. Each takes the same few
// things (a system prompt, some text, maybe an image or a sound) and returns
// the model's text. The key goes in a header, never in a URL.

const { postJson, AiError, dataUrlParts, explain } = require('./http');
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
  else if (o.web) body.tools = webTools({ searches: o.webSearches });
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
  return o.details ? { text: result.text, sources: result.sources, found: result.found, webUsed: result.webUsed, trace: result.trace } : result.text;
}

/**
 * Like anthropic() but streams the response via SSE, calling onChunk(text) for
 * each text delta as it arrives.  Only suitable for plain text replies (role A,
 * no web tools, no JSON format schema).  Returns {text, sources, webUsed} when
 * the stream ends so callers can use it as a drop-in after-the-fact for say().
 *
 * @param {{apiKey:string, model:string, system?:string, text:string, imageDataUrl?:string,
 *          extraImages?:string[], maxTokens?:number, effort?:string,
 *          timeoutMs?:number, fetchImpl?:Function, signal?:AbortSignal}} o
 * @param {(chunk:string)=>void} onChunk
 * @returns {Promise<{text:string, sources:object[], webUsed:boolean}>}
 */
async function anthropicStream(o, onChunk) {
  const content = [];
  for (const url of [o.imageDataUrl, ...(o.extraImages || [])]) {
    const img = dataUrlParts(url);
    if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
  }
  content.push({ type: 'text', text: o.text });

  const body = { model: o.model, max_tokens: Number(o.maxTokens) || 700, messages: [{ role: 'user', content }], stream: true };
  if (o.system) body.system = o.system;
  // Match anthropicMessages: send output_config only when effort is present.
  // format is never set here (streaming is incompatible with JSON schema output).
  if (o.effort) body.output_config = { effort: o.effort };

  const timeoutMs = o.timeoutMs || 45000;
  const fetchImpl = o.fetchImpl || fetch;
  const abort = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${anthropicBase()}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: o.signal ? AbortSignal.any([abort, o.signal]) : abort,
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new AiError('Claude took too long to answer.', { provider: 'anthropic', code: 'timeout' });
    throw new AiError('Could not reach Claude. Check the connection.', { provider: 'anthropic', code: 'network' });
  }

  if (!res.ok) {
    let errText = '';
    try { errText = await res.text(); } catch (_) {}
    throw new AiError(explain('anthropic', res.status, errText), { provider: 'anthropic', status: res.status, code: 'http' });
  }
  if (!res.body) throw new AiError('Claude returned no streaming body. Please try again.', { provider: 'anthropic', code: 'stream' });

  const decoder = new TextDecoder();
  let buf = '';
  let accumulated = '';
  let stopReason = null;

  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read(); // eslint-disable-line no-await-in-loop
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Process complete SSE events delimited by double newline.
      let nl;
      while ((nl = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        let evtType = '';
        let dataLine = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) evtType = line.slice(7).trim();
          else if (line.startsWith('data: ')) dataLine = line.slice(6).trim();
        }
        if (!dataLine || dataLine === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(dataLine); } catch (_) { continue; }
        if (evtType === 'content_block_delta' && parsed.delta && parsed.delta.type === 'text_delta' && typeof parsed.delta.text === 'string') {
          accumulated += parsed.delta.text;
          if (onChunk) onChunk(parsed.delta.text);
        } else if (evtType === 'message_delta' && parsed.delta && parsed.delta.stop_reason) {
          stopReason = parsed.delta.stop_reason;
        }
      }
    }
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new AiError('Claude took too long to answer.', { provider: 'anthropic', code: 'timeout' });
    throw new AiError('Could not read the streaming response from Claude. Please try again.', { provider: 'anthropic', code: 'stream' });
  }

  if (stopReason === 'refusal') throw new AiError('Claude declined that request.', { provider: 'anthropic', code: 'refusal' });
  if (stopReason === 'max_tokens') throw new AiError('Claude reached its response limit. Try a smaller request.', { provider: 'anthropic', code: 'output_limit' });
  if (stopReason === 'pause_turn') throw new AiError('The web lookup paused before it finished. Try a more specific question.', { provider: 'anthropic', code: 'web_paused' });
  if (stopReason && !['end_turn', 'stop_sequence'].includes(stopReason)) throw new AiError('Claude did not complete that response. Please try again.', { provider: 'anthropic', code: 'incomplete' });
  if (!accumulated) throw new AiError('Claude returned an empty answer. Please try again.', { provider: 'anthropic', code: 'empty' });
  return { text: accumulated, sources: [], webUsed: false };
}

module.exports = { gemini, anthropic, anthropicMessages, anthropicStream };
