// The front door checks, from outside in, that its names resolve and reach
// it (fleet stage 4 §3.13): mcp. must echo a nonce this probe is waiting for,
// and mesh. must serve the front door's own certificate to an in-memory
// probe certificate (the listener closes such a connection right after the
// handshake, so it is never a link). 60 s after start, then every 6 h.
//
// What the probe trusts:
// - The DNS answer only picks the address to connect to. The TLS name
//   (SNI), the Host header and every check stay the configured names, and
//   the address is never recorded or compared.
// - mcp. must pass WebPKI (or the injected `ca`) for mcp.<domain> and answer
//   200 with exactly our nonce. Redirects are never followed: a 3xx is a
//   failure, so the probe never talks to another host.
// - mesh. is judged only by the SHA-256 fingerprint of the certificate it
//   serves, compared in constant time with the front door's own.
// - The probe endpoint echoes only a nonce this probe issued and is still
//   waiting for (a few at most, each expiring shortly after its run), and
//   each nonce is answered once.
const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const https = require('https');
const path = require('path');
const tls = require('tls');
const { createLogger } = require('../logging');
const { writeFileAtomic } = require('../approvals/approver-store');
const { MeshIdentity } = require('../mesh/mesh-identity');
const { peerCertFingerprint, timingSafeHexEqual } = require('../mesh/mesh-transport');

const log = createLogger('frontdoor/probe');

const PROBE_PATH_RE = /^\/\.well-known\/kl-probe\/([A-Za-z0-9_-]{22,64})$/;
const FAILURES_TO_ALERT = 3;
// One run holds one nonce; runs are serialised, so more than a couple
// pending means something is wrong. The oldest go first.
const MAX_PENDING_NONCES = 4;
// A nonce outlives its run's deadline by this much at most.
const NONCE_SLACK_MS = 5000;
const MAX_BODY_CHARS = 1024;
const MAX_DETAIL_CHARS = 512;
// probe.json is a few hundred bytes; the data dir is service-writable.
const MAX_PROBE_FILE_BYTES = 16 * 1024;
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

function createProbeCertificate() {
  const { cert, key } = MeshIdentity._generateFallbackTlsCert('king-louie-self-probe', 2);
  return { cert, key, fingerprint: MeshIdentity.getCertFingerprint(cert) };
}

function createProbeHandler({ expects }) {
  return (req, res) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'https://frontdoor.invalid').pathname;
    } catch {
      pathname = '';
    }
    const m = PROBE_PATH_RE.exec(pathname);
    let waiting = false;
    if (req.method === 'GET' && m) {
      try {
        waiting = expects(m[1]) === true;
      } catch {
        waiting = false;
      }
    }
    if (waiting) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(m[1]) });
      res.end(m[1]);
      return;
    }
    res.writeHead(404, { 'cache-control': 'no-store', 'content-length': 0 });
    res.end();
  };
}

// A small, regular (never a link), well-formed JSON file from the data dir,
// or null. Used for the service's status files that doctor reads as admin.
function readStatusJson(file, maxBytes) {
  let fd;
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    fd = fs.openSync(file, OPEN_FLAGS);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(maxBytes + 1);
    let size = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, size, buf.length - size, null);
      if (n === 0) break;
      size += n;
      if (size > maxBytes) return null;
    }
    return JSON.parse(buf.subarray(0, size).toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

const cut = (text) => {
  const s = String(text);
  return s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS - 1)}…` : s;
};

function validHalf(h) {
  return h !== null && typeof h === 'object' && !Array.isArray(h) && typeof h.ok === 'boolean'
    && typeof h.detail === 'string' && h.detail.length <= MAX_DETAIL_CHARS;
}

class SelfProbe {
  constructor({ domain, port = 443, file, ownMeshFingerprint, probeCert = createProbeCertificate(), alerts = null, lookup = dns.lookup, ca = null,
    timeoutMs = 10000, firstDelayMs = 60000, everyMs = 6 * 60 * 60 * 1000, now = Date.now } = {}) {
    this.domain = domain;
    this.port = port;
    this.file = file;
    this.ownMeshFingerprint = ownMeshFingerprint;
    this.probeCert = probeCert;
    this.alerts = alerts;
    this.lookup = lookup;
    this.ca = ca;
    this.timeoutMs = timeoutMs;
    this.firstDelayMs = firstDelayMs;
    this.everyMs = everyMs;
    this.now = now;
    this.pending = new Map(); // nonce → expires at (this.now clock)
    this.failures = 0;
    this.lastResult = null;
    this.timer = null;
    this.interval = null;
    this._inflight = null;
  }

  // The last recorded result, or null when there is none or it is not a
  // well-formed result (probe.json lives in the service-writable data dir).
  static readLast(file) {
    const r = readStatusJson(file, MAX_PROBE_FILE_BYTES);
    if (r === null || typeof r !== 'object' || Array.isArray(r)) return null;
    if (typeof r.at !== 'string' || r.at.length > 40 || Number.isNaN(Date.parse(r.at)) || typeof r.ok !== 'boolean') return null;
    if (!validHalf(r.mcp) || !validHalf(r.mesh)) return null;
    return { at: r.at, ok: r.ok, mcp: { ok: r.mcp.ok, detail: r.mcp.detail }, mesh: { ok: r.mesh.ok, detail: r.mesh.detail } };
  }

  isProbeCert(fp) {
    return Boolean(this.probeCert) && timingSafeHexEqual(fp, this.probeCert.fingerprint);
  }

  _prune() {
    const t = this.now();
    for (const [nonce, expiresAt] of this.pending) if (expiresAt <= t) this.pending.delete(nonce);
  }

  _issueNonce() {
    this._prune();
    while (this.pending.size >= MAX_PENDING_NONCES) this.pending.delete(this.pending.keys().next().value);
    const nonce = crypto.randomBytes(24).toString('base64url');
    this.pending.set(nonce, this.now() + this.timeoutMs + NONCE_SLACK_MS);
    return nonce;
  }

  // True once for a nonce this probe issued and is still waiting for.
  expects(nonce) {
    if (typeof nonce !== 'string' || nonce.length > 64) return false;
    this._prune();
    if (!this.pending.has(nonce)) return false;
    this.pending.delete(nonce);
    return true;
  }

  last() {
    return this.lastResult;
  }

  start() {
    if (this.timer || this.interval) return this;
    const run = () => this.runOnce().catch((err) => log.warn(`self-probe failed to run: ${err.message}`));
    this.timer = setTimeout(() => {
      this.timer = null;
      run();
      this.interval = setInterval(run, this.everyMs);
      if (typeof this.interval.unref === 'function') this.interval.unref();
    }, this.firstDelayMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
  }

  // One overall deadline per half (a socket's own timeout is only idle time).
  _deadline(onExpire) {
    const t = setTimeout(onExpire, this.timeoutMs);
    if (typeof t.unref === 'function') t.unref();
    return t;
  }

  _mcp(nonce) {
    const host = `mcp.${this.domain}`;
    return new Promise((resolve) => {
      let settled = false;
      let req = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (req) req.destroy();
        resolve(result);
      };
      const deadline = this._deadline(() => finish({ ok: false, detail: `${host} timed out` }));
      try {
        req = https.request({
          host, port: this.port, servername: host, path: `/.well-known/kl-probe/${nonce}`, method: 'GET', agent: false,
          lookup: this.lookup, timeout: this.timeoutMs, ...(this.ca ? { ca: this.ca } : {})
        }, (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            finish({ ok: false, detail: `${host} answered ${res.statusCode} without our nonce${res.statusCode >= 300 && res.statusCode < 400 ? ' (redirects are not followed)' : ''}` });
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
            if (body.length > MAX_BODY_CHARS) finish({ ok: false, detail: `${host} answered 200 without our nonce` });
          });
          res.on('end', () => {
            const ok = body === nonce;
            finish({ ok, detail: ok ? `${host} answered` : `${host} answered 200 without our nonce` });
          });
          res.on('error', (err) => finish({ ok: false, detail: `${host}: ${err.message}` }));
        });
      } catch (err) {
        finish({ ok: false, detail: `${host}: ${err.message}` });
        return;
      }
      req.on('timeout', () => finish({ ok: false, detail: `${host} timed out` }));
      req.on('error', (err) => finish({ ok: false, detail: `${host}: ${err.message}` }));
      req.end();
    });
  }

  _mesh() {
    const host = `mesh.${this.domain}`;
    return new Promise((resolve) => {
      let settled = false;
      let socket = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (socket) socket.destroy();
        resolve(result);
      };
      const deadline = this._deadline(() => finish({ ok: false, detail: `${host} timed out` }));
      try {
        // rejectUnauthorized: false because the mesh certificate is
        // self-signed; it is accepted only by the fingerprint check below.
        socket = tls.connect({
          host, port: this.port, servername: host, cert: this.probeCert.cert, key: this.probeCert.key,
          rejectUnauthorized: false, ALPNProtocols: ['http/1.1'], lookup: this.lookup, timeout: this.timeoutMs
        });
      } catch (err) {
        finish({ ok: false, detail: `${host}: ${err.message}` });
        return;
      }
      socket.once('secureConnect', () => {
        try {
          const served = peerCertFingerprint(socket);
          let own = null;
          try {
            own = this.ownMeshFingerprint();
          } catch (err) {
            finish({ ok: false, detail: `${host}: this front door's own certificate is unavailable (${err.message})` });
            return;
          }
          if (timingSafeHexEqual(served, own)) finish({ ok: true, detail: `${host} served this front door's certificate` });
          else finish({ ok: false, detail: `${host} served ${served}, which is not this front door's (${own})` });
        } catch (err) {
          finish({ ok: false, detail: `${host}: ${err.message}` });
        }
      });
      socket.once('timeout', () => finish({ ok: false, detail: `${host} timed out` }));
      socket.once('error', (err) => finish({ ok: false, detail: `${host}: ${err.message}` }));
    });
  }

  // Runs are serialised: a call while one is in flight gets that run.
  runOnce() {
    if (!this._inflight) {
      this._inflight = this._run().finally(() => { this._inflight = null; });
    }
    return this._inflight;
  }

  async _run() {
    const nonce = this._issueNonce();
    let mcp;
    let mesh;
    try {
      [mcp, mesh] = await Promise.all([this._mcp(nonce), this._mesh()]);
    } finally {
      this.pending.delete(nonce);
    }
    mcp = { ok: mcp.ok === true, detail: cut(mcp.detail) };
    mesh = { ok: mesh.ok === true, detail: cut(mesh.detail) };
    const result = { at: new Date(this.now()).toISOString(), ok: mcp.ok && mesh.ok, mcp, mesh };
    this.lastResult = result;
    if (result.ok) {
      this.failures = 0;
    } else {
      this.failures += 1;
      log.warn(`self-probe failed (${this.failures} in a row): ${[mcp, mesh].filter((x) => !x.ok).map((x) => x.detail).join('; ')}`);
      // The alert goes out before the file write that can throw.
      if (this.failures >= FAILURES_TO_ALERT && this.alerts) {
        try {
          this.alerts.raise('dns_probe_failed', { subject: this.domain, detail: { mcp: mcp.detail, mesh: mesh.detail, failures: this.failures } });
        } catch (err) {
          log.error(`could not raise dns_probe_failed: ${err.message}`);
        }
      }
    }
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        writeFileAtomic(this.file, `${JSON.stringify(result, null, 2)}\n`);
      } catch (err) {
        log.warn(`could not record the self-probe result: ${err.message}`);
      }
    }
    return result;
  }
}

module.exports = { SelfProbe, createProbeHandler, createProbeCertificate, readStatusJson, MAX_PENDING_NONCES };
