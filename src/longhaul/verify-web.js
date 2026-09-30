'use strict';
// `longhaul verify --web`: a review page served on 127.0.0.1 only. Every API
// request carries a per-run random token (the page reads it from the URL's
// #fragment, which browsers never send), a request for any Host but this
// loopback port is refused (DNS rebinding), and there are no CORS headers.
// Session text goes only into loopback responses; logs carry counts and
// errors, never question or message text. The decisions are review.js's.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { KINDS, computeDistance, bucketFor, isVerified } = require('./questions');
const { messageText, senderLabel } = require('./session-format');
const { createReview } = require('./review');
const { createLogger } = require('../logging');

const log = createLogger('longhaul/verify-web');

const HOST = '127.0.0.1';
const TEXT_CAP = 20000;
const BODY_CAP = 1024 * 1024;
const CONTEXT_MAX = 50;
// The benchmark spec's targets per session (§5).
const TARGETS = Object.freeze({ total: 40, abstain: 5, superseded: 5 });
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const WEB_DIR = path.join(__dirname, 'web');
const STATIC = Object.freeze({
  '/': ['verify.html', 'text/html; charset=utf-8'],
  '/verify.html': ['verify.html', 'text/html; charset=utf-8'],
  '/verify.js': ['verify.js', 'text/javascript; charset=utf-8'],
  '/verify.css': ['verify.css', 'text/css; charset=utf-8']
});

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function baseHeaders(type) {
  return {
    'Content-Type': type,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin'
  };
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { ...baseHeaders('application/json; charset=utf-8'), 'Content-Length': data.length });
  res.end(data);
}

function tokenMatches(header, token) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(header || '');
  if (!m) return false;
  return crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(token));
}

// A strict whole number: digits only (an optional leading minus), so '1e1',
// '1.5' and '' are refused.
function intParam(raw, name, { min, max, fallback }) {
  if (raw === null && fallback !== undefined) return fallback;
  if (typeof raw !== 'string' || !/^-?\d{1,9}$/.test(raw)) throw new HttpError(400, `${name} must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return n;
}

function messageView(m) {
  const full = messageText(m);
  const truncated = full.length > TEXT_CAP;
  return {
    seq: m.seq,
    sender: m.sender,
    label: senderLabel(m),
    timestamp: m.timestamp,
    text: truncated ? full.slice(0, TEXT_CAP) : full,
    chars: full.length,
    truncated
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') { reject(new HttpError(415, 'send application/json')); req.resume(); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_CAP) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new HttpError(400, 'body must be a JSON object'));
      }
    });
    req.on('error', reject);
  });
}

// [command, args, spawn options] that open url in the default browser; url is
// built here (loopback, port, hex token), never from session or user input.
function openCommand(platform, url) {
  if (platform === 'win32') return ['cmd', ['/d', '/c', 'start', '""', url], { windowsVerbatimArguments: true }];
  if (platform === 'darwin') return ['open', [url], {}];
  return ['xdg-open', [url], {}];
}

function openBrowser(url, platform = process.platform) {
  try {
    const [cmd, args, opts] = openCommand(platform, url);
    const child = spawn(cmd, args, { ...opts, stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', (err) => log.warn('could not open a browser', { error: err.message }));
    child.unref();
  } catch (err) {
    log.warn('could not open a browser', { error: err.message });
  }
}

async function startVerifyWeb({ session, questions, reviewer, onSave, now, port = 0 }) {
  const review = createReview({ session, questions, reviewer, onSave, now });
  const { index, manifest } = session;
  const token = crypto.randomBytes(32).toString('hex');
  const sockets = new Set();
  let boundPort = null;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  let stopping = null;
  let quitRequested = false;

  const finalCounts = () => {
    const unfinished = review.pending().some((q) => q.status !== 'accepted' && q.status !== 'rejected');
    return { ...review.counts(), stopped: unfinished };
  };

  const state = () => {
    const verified = review.current().filter(isVerified);
    const byKind = Object.fromEntries(KINDS.map((k) => [k, verified.filter((q) => q.kind === k).length]));
    return {
      sessionId: manifest.sessionId,
      title: typeof manifest.title === 'string' ? manifest.title : manifest.sessionId,
      reviewer,
      counts: review.counts(),
      verified: { total: verified.length, byKind },
      unverified: review.current().length - verified.length,
      targets: TARGETS,
      queue: review.pending()
    };
  };

  const questionView = (id) => {
    const q = review.get(id);
    if (!q) throw new HttpError(404, 'no such question');
    const seqs = Array.isArray(q.evidenceSeqs) ? q.evidenceSeqs : [];
    const distance = seqs.length && seqs.every(Number.isInteger) ? computeDistance(index, q) : null;
    const at = index.get(q.askAtSeq);
    const status = review.status(id);
    return {
      question: q,
      status,
      errors: status === 'rejected' ? [] : review.validate(id),
      distance,
      bucket: bucketFor(distance),
      evidence: seqs.map((s) => {
        const m = index.get(s);
        return m ? messageView(m) : { seq: s, missing: true };
      }),
      askAt: at ? messageView(at) : { seq: q.askAtSeq, missing: true }
    };
  };

  const decide = (result) => {
    if (result.ok) return { ...result, state: state() };
    const status = { 'not-found': 404, decided: 409 }[result.code] || 422;
    throw new HttpError(status, result.errors[0], { errors: result.errors });
  };

  const needId = (body) => {
    if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'id is required');
    return body.id;
  };

  async function api(req, url) {
    const route = url.pathname;
    if (req.method === 'GET') {
      if (route === '/api/state') return state();
      if (route.startsWith('/api/question/')) {
        let id;
        try { id = decodeURIComponent(route.slice('/api/question/'.length)); } catch { throw new HttpError(400, 'bad id'); }
        return questionView(id);
      }
      if (route === '/api/context') {
        const q = url.searchParams;
        const around = intParam(q.get('around'), 'around', { min: 1, max: index.maxSeq });
        const before = intParam(q.get('before'), 'before', { min: 0, max: CONTEXT_MAX, fallback: 5 });
        const afterN = intParam(q.get('after'), 'after', { min: 0, max: CONTEXT_MAX, fallback: 2 });
        const messages = [];
        for (let s = Math.max(1, around - before); s <= Math.min(index.maxSeq, around + afterN); s++) messages.push(messageView(index.get(s)));
        return { around, messages };
      }
    }
    const mutations = ['/api/accept', '/api/reject', '/api/skip', '/api/edit', '/api/quit'];
    if (!mutations.includes(route)) throw new HttpError(404, 'not found');
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const body = await readBody(req);
    switch (route) {
      case '/api/accept': return decide(review.accept(needId(body)));
      case '/api/skip': return decide(review.skip(needId(body)));
      case '/api/reject': {
        const reason = body.reason === undefined || body.reason === null ? '' : body.reason;
        if (typeof reason !== 'string' || reason.length > 2000) throw new HttpError(400, 'reason must be text (at most 2000 characters)');
        return decide(review.reject(needId(body), reason.trim()));
      }
      case '/api/edit': return decide(review.edit(needId(body), body.fields));
      case '/api/quit': {
        quitRequested = true;
        return { ok: true, counts: finalCounts() };
      }
      default: throw new HttpError(404, 'not found');
    }
  }

  async function handle(req, res) {
    const allowed = [`${HOST}:${boundPort}`, `localhost:${boundPort}`];
    if (!allowed.includes(String(req.headers.host || '').toLowerCase())) {
      sendJson(res, 421, { error: 'wrong host' });
      return;
    }
    let url;
    try { url = new URL(req.url, `http://${HOST}:${boundPort}`); } catch { sendJson(res, 400, { error: 'bad url' }); return; }
    if (url.pathname.startsWith('/api/')) {
      if (!tokenMatches(req.headers.authorization, token)) { sendJson(res, 401, { error: 'missing or wrong token' }); return; }
      try {
        sendJson(res, 200, await api(req, url));
        // Stop once the quit reply has reached the socket.
        if (quitRequested) { if (res.writableFinished) stop(); else res.once('finish', () => { stop(); }); }
      } catch (err) {
        if (err instanceof HttpError) sendJson(res, err.status, { error: err.message, ...err.extra });
        else {
          log.error('request failed', { route: url.pathname, error: err.message });
          sendJson(res, 500, { error: 'internal error' });
        }
      }
      return;
    }
    const file = req.method === 'GET' ? STATIC[url.pathname] : null;
    if (!file) { sendJson(res, 404, { error: 'not found' }); return; }
    const data = fs.readFileSync(path.join(WEB_DIR, file[0]));
    res.writeHead(200, { ...baseHeaders(file[1]), 'Content-Length': data.length });
    res.end(data);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error('request failed', { error: err.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  function stop() {
    if (stopping) return stopping;
    stopping = new Promise((resolve) => {
      server.close(() => resolve());
      for (const s of sockets) s.destroy();
    }).then(() => { finish(finalCounts()); });
    return stopping;
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => { server.off('error', reject); resolve(); });
  });
  const addr = server.address();
  boundPort = addr.port;
  return {
    address: addr.address,
    port: boundPort,
    token,
    url: `http://${HOST}:${boundPort}/#${token}`,
    done,
    stop,
    counts: finalCounts
  };
}

module.exports = { startVerifyWeb, openCommand, openBrowser, TEXT_CAP, TARGETS };
