'use strict';
// src/autofill/bridge.js
// Local HTTP server that the Chrome extension talks to.
// POST /api/form           — extension reports a form; returns {id} immediately
// GET  /api/poll/:id       — extension polls; returns pending/fill/cancelled/skip
// POST /api/done/:id       — extension reports how many fields it filled
// POST /api/upload-file    — extension sends raw PDF bytes; cached by filename+size
// POST /api/upload         — extension reports a PDF the page will not take
// GET  /api/ping           — which build is answering (open it in the browser to check)
// POST /api/trace          — the extension's short notes on what it saw, for the log
//
// The orchestrator calls bridge.sendFill(id, plan) or bridge.cancel(id) after
// the user has gone through the "Fill it?" + review flow.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 7432;

function corsHeaders(req) {
  // Accept requests from localhost and from Chrome extension service workers.
  const origin = req.headers['origin'] || '';
  const allowed = /^(chrome-extension:\/\/|http:\/\/127\.0\.0\.1|http:\/\/localhost)/.test(origin)
    ? origin : 'http://127.0.0.1';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Filename, X-Filesize',
    'Access-Control-Allow-Credentials': 'true',
    'Content-Type': 'application/json',
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 64 * 1024) reject(new Error('body too large')); });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function readBinaryBody(req, maxBytes = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => { total += c.length; if (total > maxBytes) reject(new Error('body too large')); else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Temp dir for cached PDF uploads; cleaned on startup and after use.
const UPLOAD_TMP = path.join(os.tmpdir(), 'rouge-uploads');
fs.mkdirSync(UPLOAD_TMP, { recursive: true });
// Clean up stale files from previous runs.
try {
  const stale = fs.readdirSync(UPLOAD_TMP);
  for (const f of stale) { try { fs.unlinkSync(path.join(UPLOAD_TMP, f)); } catch (_) {} }
} catch (_) {}

const CACHE_TTL_MS = 10 * 60 * 1000;   // a copied PDF nobody claimed is removed after this

const asBytes = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);
const asText = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * @param {{
 *   onFormDetected: (info:{id:string, url:string, title:string, fields:object[]}) => void,
 *   onUploadRejection?: (info:{url:string, title:string, errorText:string, limitBytes:number|null, filename:string|null, fileSize:number|null, why:string, tempPath:string|null}) => void,
 *   log?: Function,
 *   info?: object,    what GET /api/ping reports about this build
 *   port?: number,
 * }} opts
 */
function createBridge({ onFormDetected, onUploadRejection, log, info, port }) {
  const _log = log || (() => {});
  const listenPort = port || PORT;
  let lastSeenAt = 0;
  let lastExtension = null;
  let nextId = 1;
  // id → { status: 'pending'|'fill'|'cancelled'|'skip', plan: Array|null }
  const sessions = new Map();
  // url → id: prevent the extension from firing twice for the same page
  const activeUrls = new Map();
  // `${filename}:${size}` → temp file path (cleared after use)
  const cachedUploads = new Map();

  const handle = async (req, res) => {
    // Reject non-localhost connections
    const remote = req.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      res.writeHead(403); res.end('{}'); return;
    }

    const headers = corsHeaders(req);
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const route = req.url || '/';

    // The extension names its version on every request. Seeing a new one (or none, which means an
    // old extension that cannot report uploads) in the log tells which extension is really loaded.
    lastSeenAt = Date.now();
    if (route !== '/api/ping') {
      const ext = req.headers['x-rouge-extension'] || 'unversioned (old build)';
      if (ext !== lastExtension) { lastExtension = ext; _log(`autofill/bridge: extension ${ext} is talking to this Rouge`); }
    }

    // ── GET /api/ping ─────────────────────────────────────────────────────
    if (req.method === 'GET' && route === '/api/ping') {
      res.writeHead(200); res.end(JSON.stringify({ ok: true, app: 'rouge', ...info, extension: lastExtension })); return;
    }

    // ── POST /api/form ────────────────────────────────────────────────────
    if (req.method === 'POST' && route === '/api/form') {
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
    const pollMatch = route.match(/^\/api\/poll\/(\d+)$/);
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
    const doneMatch = route.match(/^\/api\/done\/(\d+)$/);
    if (req.method === 'POST' && doneMatch) {
      const id = doneMatch[1];
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch (_) {}
      _log(`autofill/bridge: fill done id=${id} filled=${body.filled ?? '?'}`);
      for (const [u, i] of activeUrls) if (i === id) { activeUrls.delete(u); break; }
      sessions.delete(id);
      res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
    }

    // ── POST /api/upload-file ─────────────────────────────────────────────
    if (req.method === 'POST' && route === '/api/upload-file') {
      const rawName = req.headers['x-filename'] || '';
      const size = parseInt(req.headers['x-filesize'] || '0', 10);
      let filename;
      try { filename = decodeURIComponent(rawName); } catch (_) { filename = rawName; }
      if (!filename || !filename.toLowerCase().endsWith('.pdf') || !size) {
        res.writeHead(400); res.end('{}'); return;
      }
      let buf;
      try { buf = await readBinaryBody(req); } catch (_) { res.writeHead(413); res.end('{}'); return; }
      // Validate PDF header.
      if (!buf.slice(0, 5).equals(Buffer.from('%PDF-'))) { res.writeHead(400); res.end('{}'); return; }
      const key = `${filename}:${size}`;
      const tmpPath = path.join(UPLOAD_TMP, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
      try { await fs.promises.writeFile(tmpPath, buf); } catch (_) { res.writeHead(500); res.end('{}'); return; }
      // Clean up any previous temp file for this key.
      const prev = cachedUploads.get(key);
      if (prev) fs.unlink(prev, () => {});
      cachedUploads.set(key, tmpPath);
      // A copy nobody asked for is not kept around.
      setTimeout(() => { if (cachedUploads.get(key) === tmpPath) { cachedUploads.delete(key); fs.unlink(tmpPath, () => {}); } }, CACHE_TTL_MS).unref();
      _log(`autofill/bridge: cached a PDF copy (${size} bytes)`);
      res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
    }

    // ── POST /api/trace ───────────────────────────────────────────────────
    if (req.method === 'POST' && route === '/api/trace') {
      let text = '';
      try { text = await readBody(req); } catch (_) { res.writeHead(400); res.end('{}'); return; }
      _log(`autofill/bridge: extension saw: ${text.replace(/[^ -~]/g, '').slice(0, 300)}`);
      res.writeHead(200); res.end('{}'); return;
    }

    // ── POST /api/upload ──────────────────────────────────────────────────
    if (req.method === 'POST' && route === '/api/upload') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (_) { res.writeHead(400); res.end('{}'); return; }
      if (!body || typeof body !== 'object') { res.writeHead(400); res.end('{}'); return; }
      // Everything here came from a web page: keep only plain, bounded values.
      const upload = {
        url: asText(body.url, 500),
        title: asText(body.title, 300),
        errorText: asText(body.errorText, 500),
        limitBytes: asBytes(body.limitBytes),
        filename: asText(body.filename, 200) || null,
        fileSize: asBytes(body.fileSize),
        why: body.why === 'size' ? 'size' : 'error',
      };
      // Attach cached temp path if we have the file already.
      const key = `${upload.filename || ''}:${upload.fileSize || ''}`;
      const tempPath = cachedUploads.get(key) || null;
      if (tempPath) cachedUploads.delete(key); // hand off ownership; caller cleans up
      _log(`autofill/bridge: upload problem (${upload.why}) size=${upload.fileSize || '?'} limit=${upload.limitBytes || '?'} cached=${!!tempPath}`);
      if (onUploadRejection) setImmediate(() => onUploadRejection({ ...upload, tempPath }));
      res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }));
  };

  // A request that throws must still be answered; a hung request would stall the extension's whole upload report.
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      _log(`autofill/bridge: request failed: ${e.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end('{}');
    });
  });

  server.on('error', (e) => _log(`autofill/bridge: server error: ${e.message}`));

  return {
    start() {
      server.listen(listenPort, '127.0.0.1', () => _log(`autofill/bridge: listening on 127.0.0.1:${listenPort}`));
    },
    stop() { server.close(); },

    /** When the extension last spoke to this bridge (ms since epoch, 0 if never). */
    get lastSeen() { return lastSeenAt; },

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

    get port() { return listenPort; },
  };
}

module.exports = { createBridge, PORT };
