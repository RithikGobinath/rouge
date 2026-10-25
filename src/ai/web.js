'use strict';
// Public source metadata only. No HTML, encrypted tool payload, user prompt,
// or credential is passed from this module to the renderer or to a log.
const net = require('net');

/** A bounded public http(s) URL, or '' for a local/credential-bearing link. */
function publicWebUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return '';
  let url;
  try { url = new URL(value); } catch (_) { return ''; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|home|invalid|test|onion)$/.test(host)) return '';
  const ip = net.isIP(host);
  if (ip === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19) || a >= 224) return '';
  } else if (ip === 6) {
    // Public global unicast only: exclude loopback, link-local, private, and
    // IPv4-mapped alternatives to a private address.
    const prefix = parseInt(host.split(':')[0], 16);
    if (!(prefix >= 0x2000 && prefix <= 0x3fff) || host.startsWith('2001:db8:')) return '';
  } else if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return '';
  for (const name of url.searchParams.keys()) {
    if (/^(api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|secret|session(?:id)?|auth[-_]?token)$/i.test(name)) return '';
  }
  return url.href;
}

/** Basic server tools need no client tool loop or browser session. */
function webTools({ searches = 3 } = {}) {
  return [
    { type: 'web_search_20250305', name: 'web_search', max_uses: searches },
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 2, max_content_tokens: 12000, citations: { enabled: true } },
  ];
}

/** Final text and actual provider-backed citations from a Messages response. */
function webResponse(content) {
  const blocks = Array.isArray(content) ? content : [];
  let lastResult = -1;
  let webUsed = false;
  let webError = false;
  let successfulResults = 0;
  const documents = [];
  const fetched = [];
  const found = [];            // every page a search returned, so a caller can check a link it was given
  const sources = [];
  const seen = new Set();
  function source(url, title) {
    const safe = publicWebUrl(url);
    if (!safe || seen.has(safe) || sources.length >= 8) return;
    seen.add(safe);
    const label = typeof title === 'string' ? title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 180) : '';
    sources.push({ type: 'web', url: safe, title: label || new URL(safe).hostname });
  }
  function results(value) {
    for (const result of Array.isArray(value) ? value : value ? [value] : []) {
      if (!result || typeof result !== 'object') continue;
      if (result.type === 'web_search_tool_result_error' || result.type === 'web_fetch_tool_result_error') { webError = true; continue; }
      if (result.type === 'web_search_result') { successfulResults += 1; if (found.length < 40) found.push({ url: result.url, title: result.title }); continue; }
      if (result.type === 'web_fetch_result') {
        successfulResults += 1;
        const document = { url: result.url, title: result.content && result.content.title || result.title || '' };
        if (result.content && result.content.type === 'document') documents.push(document);
        fetched.push(document);
      }
    }
  }
  // What the tools did, in short: each query or address, then how many results or which error. For logs only.
  const trace = [];
  const hostOnly = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return '?'; } };
  blocks.forEach((block, index) => {
    if (!block || typeof block !== 'object') return;
    if (block.type === 'server_tool_use' && ['web_search', 'web_fetch'].includes(block.name)) {
      webUsed = true;
      trace.push(`${block.name} ${String(block.input && (block.input.query || block.input.url) || '').slice(0, 80)}`);
    }
    if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
      webUsed = true; lastResult = index; results(block.content);
      const c = block.content;
      trace.push(Array.isArray(c) ? `-> ${c.length} results: ${c.slice(0, 6).map((r) => hostOnly(r && r.url)).join(',')}` : `-> ${c && (c.error_code || c.type) || 'result'}`);
    }
  });
  // Preambles such as "I'll search" must never corrupt a final JSON plan.
  const finalBlocks = blocks.slice(lastResult + 1).filter((block) => block && block.type === 'text' && typeof block.text === 'string');
  for (const block of finalBlocks) {
    for (const citation of Array.isArray(block.citations) ? block.citations : []) {
      if (!citation || typeof citation !== 'object') continue;
      if (citation.type === 'web_search_result_location') { source(citation.url, citation.title); continue; }
      if (['char_location', 'page_location', 'content_block_location'].includes(citation.type)) {
        let document = Number.isInteger(citation.document_index) ? documents[citation.document_index] : null;
        if (typeof citation.document_title === 'string') {
          const named = fetched.filter((entry) => entry.title && entry.title === citation.document_title);
          if (named.length === 1) document = named[0];
        }
        if (document) source(document.url, citation.document_title || document.title);
      }
    }
  }
  return { text: finalBlocks.map((block) => block.text).join('').trim(), sources, found, webUsed, webError, successfulResults, trace };
}

module.exports = { publicWebUrl, webTools, webResponse };
