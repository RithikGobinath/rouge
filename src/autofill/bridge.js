'use strict';
// src/autofill/bridge.js
// Local HTTP server that the Chrome extension talks to.
// POST /api/form        — extension reports a form; returns {id} immediately
// GET  /api/poll/:id    — extension polls; returns pending/fill/cancelled/skip
// POST /api/done/:id    — extension reports how many fields it filled
//
// The orchestrator calls bridge.sendFill(id, plan) or bridge.cancel(id) after
// the user has gone through the "Fill it?" + review flow.

const http = require('http');

const PORT = 7432;
const CORS = {
  'Access-Control-Allow-Origin': '127.0.0.1',  // only localhost
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 64 * 1024) reject(new Error('body too large')); });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

/**
 * @param {{
 *   onFormDetected: (info:{id:string, url:string, title:string, fields:object[]}) => void,
 *   log?: Function,
 * }} opts
 */
function createBridge({ onFormDetected, log }) {
  const _log = log || (() => {});
  let nextId = 1;
  // id → { status: 'pending'|'fill'|'cancelled'|'skip', plan: Array|null }
  const sessions = new Map();
  // url → id: prevent the extension from firing twice for the same page
  const activeUrls = new Map();

  const server = http.createServer(async (req, res) => {
    // Reject non-localhost connections
    const remote = req.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      res.writeHead(403); res.end('{}'); return;
    }

    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const path = req.url || '/';

    // ── POST /api/form ────────────────────────────────────────────────────
    if (req.method === 'POST' && path === '/api/form') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (_) { res.writeHead(400); res.end('{}'); return; }
      const url = body.url || '';
      // Dedup: if there is already an active session for this URL, reuse it.
      if (activeUrls.has(url)) {
        const existingId = activeUrls.get(url);
        _log(`autofill/bridge: duplicate form event for ${url}, reusing id=${existingId}`);
        res.writeHead(200); res.end(JSON.stringify({ id: existingId })); return;
      }
      const id = String(nextId++);
      sessions.set(id, { status: 'pending', plan: null });
      activeUrls.set(url, id);
      _log(`autofill/bridge: form from extension id=${id} fields=${(body.fields||[]).length} url=${url}`);
      // Notify orchestrator asynchronously — don't block the HTTP response.
      setImmediate(() => onFormDetected({ id, url, title: body.title || '', fields: body.fields || [] }));
      res.writeHead(200); res.end(JSON.stringify({ id })); return;
    }

    // ── GET /api/poll/:id ─────────────────────────────────────────────────
    const pollMatch = path.match(/^\/api\/poll\/(\d+)$/);
    if (req.method === 'GET' && pollMatch) {
      const id = pollMatch[1];
      const session = sessions.get(id);
      if (!session) { res.writeHead(404); res.end(JSON.stringify({ status: 'not_found' })); return; }
      const { status, plan } = session;
      if (status === 'fill') {
        for (const [u, i] of activeUrls) if (i === id) { activeUrls.delete(u); break; }
        sessions.delete(id);
        res.writeHead(200); res.end(JSON.stringify({ status: 'fill', plan })); return;
      }
      if (status === 'cancelled' || status === 'skip') {
        for (const [u, i] of activeUrls) if (i === id) { activeUrls.delete(u); break; }
        sessions.delete(id);
        res.writeHead(200); res.end(JSON.stringify({ status })); return;
      }
      res.writeHead(200); res.end(JSON.stringify({ status: 'pending' })); return;
    }

    // ── POST /api/done/:id ────────────────────────────────────────────────
    const doneMatch = path.match(/^\/api\/done\/(\d+)$/);
    if (req.method === 'POST' && doneMatch) {
      const id = doneMatch[1];
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch (_) {}
      _log(`autofill/bridge: fill done id=${id} filled=${body.filled ?? '?'}`);
      for (const [u, i] of activeUrls) if (i === id) { activeUrls.delete(u); break; }
      sessions.delete(id);
      res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }));
  });

  server.on('error', (e) => _log(`autofill/bridge: server error: ${e.message}`));

  return {
    start() {
      server.listen(PORT, '127.0.0.1', () => _log(`autofill/bridge: listening on 127.0.0.1:${PORT}`));
    },
    stop() { server.close(); },

    /** Tell the extension to fill with this plan. */
    sendFill(id, plan) {
      const s = sessions.get(id);
      if (s) { s.status = 'fill'; s.plan = plan; }
    },

    /** Tell the extension the user skipped. */
    cancel(id) {
      const s = sessions.get(id);
      if (s) s.status = 'cancelled';
    },

    get port() { return PORT; },
  };
}

module.exports = { createBridge, PORT };
