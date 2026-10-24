'use strict';
// One way to call a provider: JSON in, JSON out, a timeout, and errors that
// say what went wrong in words a person can act on.

class AiError extends Error {
  /** @param {string} message @param {{provider?:string, status?:number, code?:string}} [info] */
  constructor(message, info = {}) { super(message); this.name = 'AiError'; Object.assign(this, info); }
}

const NAMES = { gemini: 'Gemini', anthropic: 'Claude', typesafe: 'TypeSafe' };

/** What to tell the person for a failed call. */
function explain(provider, status, detail) {
  const who = NAMES[provider] || provider;
  if (status === 401 || status === 403) return `${who} did not accept your key. Check it under Your keys.`;
  if (status === 400 && /api key|API_KEY/i.test(detail || '')) return `${who} did not accept your key. Check it under Your keys.`;
  if (status === 404) return `${who} does not know that model. Pick another one under Settings.`;
  if (status === 429) return `${who} is busy or your quota is used up. Try again in a moment.`;
  if (status >= 500) return `${who} is having trouble right now. Try again in a moment.`;
  return `${who} could not answer (${status || 'no reply'}).`;
}

/**
 * POST JSON and read JSON back.
 * @returns {Promise<any>}
 */
async function postJson(provider, url, headers, body, { timeoutMs = 45000, fetchImpl = fetch, signal } = {}) {
  let res;
  const abort = AbortSignal.timeout(timeoutMs);
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([abort, signal]) : abort,
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new AiError(`${NAMES[provider] || provider} took too long to answer.`, { provider, code: 'timeout' });
    throw new AiError(`Could not reach ${NAMES[provider] || provider}. Check the connection.`, { provider, code: 'network' });
  }
  let text = '';
  try { text = await res.text(); } catch (_) { /* empty body */ }
  if (!res.ok) throw new AiError(explain(provider, res.status, text), { provider, status: res.status, code: 'http' });
  try { return JSON.parse(text); } catch (_) { throw new AiError(`${NAMES[provider] || provider} sent something that was not JSON.`, { provider, code: 'parse' }); }
}

/** Tolerant JSON: fences and chatter around the object are fine. */
function parseJson(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

function dataUrlParts(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

module.exports = { AiError, postJson, parseJson, explain, dataUrlParts, NAMES };
