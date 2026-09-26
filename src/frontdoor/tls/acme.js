// The mcp. certificate from an ACME CA (fleet stage 4 §3.3): TLS-ALPN-01
// only, so port 80 stays closed (trust principle 4); the certificate key is
// ECDSA P-256, generated once, stored encrypted and reused for every renewal
// (R21), because phones pin the leaf SPKI. A key file that cannot be read
// is never replaced by a new key: that would silently cut every phone off.
//
// Key rotation (§3.3.1) is the only way the key changes, and it is ordered so
// a crash at any point leaves one complete key on disk:
//   1. the new key goes to cert-key.next.json (with the SPKI it replaces);
//   2. a certificate is issued for it;
//   3. cert.json is replaced with that certificate;
//   4. cert-key.json is replaced with the new key;
//   5. cert-key.next.json is removed.
// On start, a leftover next key whose certificate is in cert.json (a crash
// after 3) is promoted and 'rotated' is emitted once start() is done (the
// next file is removed only then); any
// other leftover (a crash before 3) is discarded and the old key and
// certificate stay.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { EventEmitter } = require('events');
const { createLogger } = require('../../logging');
const { writeFileAtomic } = require('../../approvals/approver-store');
const { relaySpkiPin } = require('../tls');

const log = createLogger('frontdoor/acme');

const CHECK_EVERY_MS = 12 * 3600000;
const FAILURE_BACKOFF_MS = Object.freeze([3600000, 7200000, 14400000]);
const ALERT_BEFORE_MS = 21 * 86400000;
const HTTP_TIMEOUT_MS = 30000;
const ISSUE_DEADLINE_MS = 10 * 60000;
const MAX_ERROR_CHARS = 300;

function newP256Pem() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
}

function certInfo(chain) {
  const leaf = new crypto.X509Certificate(chain);
  return { leaf, notBefore: Date.parse(leaf.validFrom), notAfter: Date.parse(leaf.validTo), spki: relaySpkiPin(chain) };
}

function keySpki(keyPem) {
  const spki = crypto.createPublicKey(keyPem).export({ type: 'spki', format: 'der' });
  return `sha256/${crypto.createHash('sha256').update(spki).digest('base64url')}`;
}

// Text from the CA, axios or acme-client may carry key authorizations, nonces
// or (from a confused caller) PEM blocks. Only this form reaches logs,
// status() and alerts: one line, no control or format characters, PEM
// blocks and long base64 runs removed.
function redact(text) {
  const s = String(text)
    .replace(/-----BEGIN [^-]*-----[\s\S]*?(?:-----END [^-]*-----|$)/g, '[redacted pem]')
    .replace(/[A-Za-z0-9_\-+/]{32,}={0,2}/g, '[redacted]')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > MAX_ERROR_CHARS ? `${s.slice(0, MAX_ERROR_CHARS)}…` : s;
}

function safeMessage(err) {
  return redact((err && err.message) || err);
}

// The one place acme-client is used. Its own logger goes to ours at debug.
// `acme` is the library itself, injectable so tests drive auto() offline.
function createAcmeAdapter({ directoryUrl, accountKeyPem, email = null, termsAgreed = false, acme = null }) {
  // eslint-disable-next-line global-require -- only the frontdoor profile loads it
  const lib = acme || require('acme-client');
  lib.setLogger((message) => log.debug(`acme-client: ${redact(message)}`));
  // A CA that accepts a connection and never answers must not hold a request forever.
  if (lib.axios && lib.axios.defaults) lib.axios.defaults.timeout = HTTP_TIMEOUT_MS;
  const client = new lib.Client({ directoryUrl, accountKey: accountKeyPem });
  return {
    async issue({ commonName, keyPem, onChallenge, onChallengeDone }) {
      const [, csr] = await lib.crypto.createCsr({ commonName, altNames: [commonName] }, keyPem);
      return client.auto({
        csr,
        ...(email ? { email } : {}),
        termsOfServiceAgreed: termsAgreed === true,
        challengePriority: ['tls-alpn-01'],
        // acme-client would dial our own ALPN responder first; the CA does
        // exactly that next (Deviation 19).
        skipChallengeVerification: true,
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
          if (challenge.type !== 'tls-alpn-01') throw new Error(`refusing the ${challenge.type} challenge: only tls-alpn-01 is served`);
          const [key, cert] = await lib.crypto.createAlpnCertificate(authz, keyAuthorization, newP256Pem());
          onChallenge(authz.identifier.value, { key: key.toString(), cert: cert.toString() });
        },
        challengeRemoveFn: async (authz) => {
          onChallengeDone(authz.identifier.value);
        }
      });
    }
  };
}

class AcmeManager extends EventEmitter {
  constructor({ domain, email = null, directoryUrl, termsAgreed = false, dir, cipher, alerts = null, now = Date.now, adapterFactory = createAcmeAdapter,
    issueDeadlineMs = ISSUE_DEADLINE_MS, timers = { setTimeout, clearTimeout } } = {}) {
    super();
    this.host = `mcp.${domain}`;
    this.email = email;
    this.directoryUrl = directoryUrl;
    this.termsAgreed = termsAgreed;
    this.dir = dir;
    this.cipher = cipher;
    this.alerts = alerts;
    this.now = now;
    this.adapterFactory = adapterFactory;
    this.issueDeadlineMs = issueDeadlineMs;
    this.timers = timers;
    this.files = {
      account: path.join(dir, 'account.json'),
      key: path.join(dir, 'cert-key.json'),
      nextKey: path.join(dir, 'cert-key.next.json'),
      cert: path.join(dir, 'cert.json')
    };
    this.keyPem = null;
    this.cert = null;
    this.context = null;
    this.challenges = new Map();
    this.attempt = null;
    this.failures = 0;
    this.lastError = null;
    this.nextAttemptAt = null;
    this.inFlight = null;
    this.running = false;
    this.starting = false;
    this.timer = null;
    this.adapter = null;
  }

  // Never echoes the file or the error text of a parse: only the reason.
  _readStored(file) {
    if (!fs.existsSync(file)) return null;
    let reason;
    try {
      let stored;
      try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { reason = 'not valid JSON'; throw new Error(reason); }
      if (!stored || stored.v !== 1 || typeof stored.key !== 'string') { reason = 'unexpected format'; throw new Error(reason); }
      let pem;
      try { pem = this.cipher.decryptString(stored.key); } catch (err) { reason = `decryption failed: ${safeMessage(err)}`; throw err; }
      try { crypto.createPrivateKey(pem); } catch { reason = 'not a private key'; throw new Error(reason); }
      return { pem, oldSpki: typeof stored.old_spki === 'string' ? stored.old_spki : null };
    } catch {
      const advice = file === this.files.account
        ? 'Restore the master key or the file, or remove the file to register a new ACME account.'
        : 'Every paired phone pins this key. Restore the master key or the file.';
      throw new Error(`${file} cannot be decrypted (${reason}); refusing to create a new key. ${advice}`);
    }
  }

  _readKey(file) {
    const stored = this._readStored(file);
    return stored ? stored.pem : null;
  }

  _writeKey(file, pem, extra = {}) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(file, `${JSON.stringify({ v: 1, key: this.cipher.encryptString(pem), ...extra })}\n`);
  }

  _readCert() {
    if (!fs.existsSync(this.files.cert)) return null;
    try {
      const stored = JSON.parse(fs.readFileSync(this.files.cert, 'utf8'));
      const { notBefore, notAfter, spki } = certInfo(stored.chain);
      return { chain: stored.chain, notBefore, notAfter, spki };
    } catch (err) {
      log.warn(`ignoring ${this.files.cert}: ${safeMessage(err)}`);
      return null;
    }
  }

  _writeCert(chain) {
    const info = certInfo(chain);
    writeFileAtomic(this.files.cert, `${JSON.stringify({ v: 1, chain, not_before: new Date(info.notBefore).toISOString(), not_after: new Date(info.notAfter).toISOString(), spki: info.spki }, null, 2)}\n`);
  }

  // `issued` is _issue's result: its SecureContext was built before anything
  // was written, so what is installed is exactly what was accepted.
  _install({ chain, context, notBefore, notAfter, spki }) {
    this.context = context;
    this.cert = { chain, notBefore, notAfter, spki };
  }

  // See the header: finish or discard a rotation a crash interrupted.
  // Returns the 'rotated' event to emit once start() is done, or null.
  _recoverRotation() {
    const next = this._readStored(this.files.nextKey);
    if (!next) return null;
    const nextSpki = keySpki(next.pem);
    const cert = this._readCert();
    const keyExists = fs.existsSync(this.files.key);
    if (cert && cert.spki === nextSpki) {
      let oldSpki = next.oldSpki;
      if (!oldSpki && keyExists) {
        const current = this._readKey(this.files.key);
        oldSpki = keySpki(current) === nextSpki ? null : keySpki(current);
      }
      // The next file stays until start() has emitted 'rotated', so a start
      // that fails later still re-pins phones on the next attempt.
      this._writeKey(this.files.key, next.pem);
      log.warn(`completed an interrupted key rotation: the mcp. key is now ${nextSpki}; every phone must re-pin`);
      return { oldSpki, newSpki: nextSpki };
    }
    if (!keyExists) {
      throw new Error(`${this.files.nextKey} exists but ${this.files.key} does not, and no certificate was issued for the next key; refusing to start or create a key. Restore ${this.files.key}.`);
    }
    fs.rmSync(this.files.nextKey, { force: true });
    log.warn(`discarded an unfinished key rotation (no certificate was issued for ${nextSpki}); the current key stays`);
    return null;
  }

  async start() {
    if (this.running || this.starting) throw new Error('AcmeManager already started');
    this.starting = true;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const recovered = this._recoverRotation();
      this.keyPem = this._readKey(this.files.key);
      if (!this.keyPem && fs.existsSync(this.files.cert)) {
        const cert = this._readCert();
        throw new Error(`${path.basename(this.files.cert)} exists but ${path.basename(this.files.key)} does not in ${this.dir}; refusing to issue with a new key${cert ? ` (phones pin ${cert.spki})` : ''}. Restore the key file, or remove ${this.files.cert} and re-pin every phone.`);
      }
      const cert = this._readCert();
      if (!this.keyPem) {
        this.keyPem = newP256Pem();
        this._writeKey(this.files.key, this.keyPem);
        log.info(`generated the stable mcp. key ${keySpki(this.keyPem)}`);
      }
      if (cert && cert.spki === keySpki(this.keyPem)) {
        try {
          this._install({ ...cert, context: tls.createSecureContext({ key: this.keyPem, cert: cert.chain }) });
        } catch (err) {
          log.warn(`${this.files.cert} cannot be installed (${safeMessage(err)}); a new certificate will be issued with the stable key`);
        }
      } else if (cert) {
        log.warn(`${this.files.cert} does not match the stable key; a new certificate will be issued with the key`);
      }
      let accountKey = this._readKey(this.files.account);
      if (!accountKey) {
        accountKey = newP256Pem();
        this._writeKey(this.files.account, accountKey);
      }
      this.adapter = this.adapterFactory({ directoryUrl: this.directoryUrl, accountKeyPem: accountKey, email: this.email, termsAgreed: this.termsAgreed });
      this.running = true;
      await this.check();
      this._schedule();
      // Listeners attach before start(); phones re-pin from this event.
      if (recovered) {
        // The next file goes only once a listener has taken the event, so a
        // throwing listener means the next start emits it again.
        let delivered = false;
        try {
          this.emit('rotated', recovered);
          delivered = true;
        } catch (err) {
          log.error(`a 'rotated' listener failed (${safeMessage(err)}); ${this.files.nextKey} is kept so the next start emits the new pin again`);
        }
        if (delivered) fs.rmSync(this.files.nextKey, { force: true });
      }
    } finally {
      this.starting = false;
    }
  }

  stop() {
    this.running = false;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  // The next check: every 12 h, sooner when a failure's backoff ends first.
  _schedule() {
    if (!this.running) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    const wait = this.nextAttemptAt === null
      ? CHECK_EVERY_MS
      : Math.min(CHECK_EVERY_MS, Math.max(1000, this.nextAttemptAt - this.now()));
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.check().finally(() => this._schedule());
    }, wait);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  currentContext() {
    return this.context;
  }

  // Only mcp.<domain> ever answers acme-tls/1 (the SNI listener asks for
  // nothing else; this holds even if it did).
  challengeFor(servername) {
    return servername === this.host ? this.challenges.get(servername) || null : null;
  }

  leafSpki() {
    return this.cert ? this.cert.spki : null;
  }

  certificate() {
    return this.cert ? { ...this.cert } : null;
  }

  status() {
    return {
      source: 'acme',
      not_after: this.cert ? new Date(this.cert.notAfter).toISOString() : null,
      spki: this.leafSpki(),
      last_error: this.lastError,
      failures: this.failures,
      next_attempt_at: this.nextAttemptAt === null ? null : new Date(this.nextAttemptAt).toISOString()
    };
  }

  needsRenewal() {
    if (!this.cert) return true;
    const lifetime = this.cert.notAfter - this.cert.notBefore;
    return this.cert.notAfter - this.now() <= lifetime / 3;
  }

  reload() {
    return this.check({ ignoreBackoff: true });
  }

  // Never rejects: a failure is counted, logged and backed off.
  check({ ignoreBackoff = false } = {}) {
    if (this.inFlight) return this.inFlight;
    if (!this.needsRenewal()) return Promise.resolve();
    if (!ignoreBackoff && this.nextAttemptAt !== null && this.now() < this.nextAttemptAt) return Promise.resolve();
    const run = this._issue(this.keyPem, { renewing: this.cert })
      .then((issued) => {
        this._writeCert(issued.chain);
        this._install(issued);
        this._succeeded();
        log.info(`certificate for ${this.host} valid until ${new Date(this.cert.notAfter).toISOString()}`);
      })
      .catch((err) => this._failed(err));
    this.inFlight = run.finally(() => {
      this.inFlight = null;
      this._schedule();
    });
    return this.inFlight;
  }

  _succeeded() {
    this.failures = 0;
    this.lastError = null;
    this.nextAttemptAt = null;
  }

  _failed(err) {
    this.failures += 1;
    this.lastError = safeMessage(err);
    const wait = this.failures <= FAILURE_BACKOFF_MS.length ? FAILURE_BACKOFF_MS[this.failures - 1] : CHECK_EVERY_MS;
    this.nextAttemptAt = this.now() + wait;
    log.warn(`ACME issuance for ${this.host} failed (${this.lastError}); the current certificate stays; next attempt in ${Math.round(wait / 60000)} min`);
    if (this.cert && this.cert.notAfter - this.now() < ALERT_BEFORE_MS && this.alerts) {
      try {
        this.alerts.raise('acme_renewal_failing', { subject: this.host, detail: { not_after: new Date(this.cert.notAfter).toISOString(), error: this.lastError } });
      } catch (alertErr) {
        log.error(`could not raise acme_renewal_failing: ${safeMessage(alertErr)}`);
      }
    }
  }

  // One issuance, bounded by issueDeadlineMs. A chain is accepted only for
  // the key it was requested with, the name phones connect to, valid now,
  // later than the certificate it renews, and loadable as a SecureContext;
  // anything else would change, break or brick the pin. Nothing is written
  // before all of that holds.
  async _issue(keyPem, { renewing = null } = {}) {
    const attempt = {};
    this.attempt = attempt;
    let deadline;
    const expired = new Promise((_, reject) => {
      deadline = this.timers.setTimeout(() => reject(new Error(`ACME issuance did not finish within ${Math.round(this.issueDeadlineMs / 1000)} s`)), this.issueDeadlineMs);
    });
    let chain;
    try {
      chain = await Promise.race([
        this.adapter.issue({
          commonName: this.host,
          keyPem,
          onChallenge: (name, { key, cert }) => {
            if (this.attempt !== attempt) return;
            if (name !== this.host) {
              log.warn(`ignoring an ACME challenge for ${redact(name)}: only ${this.host} is served`);
              return;
            }
            this.challenges.set(name, tls.createSecureContext({ key, cert }));
          },
          onChallengeDone: (name) => { if (this.attempt === attempt) this.challenges.delete(name); }
        }),
        expired
      ]);
    } finally {
      this.timers.clearTimeout(deadline);
      if (this.attempt === attempt) this.attempt = null;
      this.challenges.clear();
    }
    const { leaf, notBefore, notAfter, spki } = certInfo(chain);
    if (spki !== keySpki(keyPem)) throw new Error(`the CA returned a certificate for a different key (${spki})`);
    if (!leaf.checkHost(this.host)) throw new Error(`the CA returned a certificate that does not cover ${this.host}`);
    const now = this.now();
    if (!(notBefore <= now && now < notAfter)) {
      throw new Error(`the CA returned a certificate that is not valid now (${new Date(notBefore).toISOString()} to ${new Date(notAfter).toISOString()})`);
    }
    if (renewing && notAfter <= renewing.notAfter) {
      throw new Error(`the CA returned a certificate that expires no later than the current one (${new Date(notAfter).toISOString()})`);
    }
    const context = tls.createSecureContext({ key: keyPem, cert: chain });
    return { chain, context, notBefore, notAfter, spki };
  }

  // §3.3.1, in the order the header describes.
  async rotateKey() {
    if (!this.adapter) throw new Error('rotateKey needs a started AcmeManager');
    while (this.inFlight) await this.inFlight;
    const run = this._rotate();
    const settled = run.then(() => {}, () => {});
    this.inFlight = settled.then(() => {
      this.inFlight = null;
      this._schedule();
    });
    return run;
  }

  async _rotate() {
    const oldSpki = this.leafSpki() || keySpki(this.keyPem);
    const nextKey = newP256Pem();
    this._writeKey(this.files.nextKey, nextKey, { old_spki: oldSpki });
    let issued;
    try {
      issued = await this._issue(nextKey);
      this._writeCert(issued.chain);
    } catch (err) {
      fs.rmSync(this.files.nextKey, { force: true });
      throw new Error(`rotate-tls-key: no certificate for the new key (${safeMessage(err)}); the old key and certificate stay`);
    }
    // cert.json now holds the new certificate: from here a restart finishes
    // the rotation from cert-key.next.json even if the steps below fail.
    this._writeKey(this.files.key, nextKey);
    fs.rmSync(this.files.nextKey, { force: true });
    this.keyPem = nextKey;
    this._install(issued);
    this._succeeded();
    const event = { oldSpki, newSpki: this.leafSpki() };
    log.warn(`rotated the mcp. key ${oldSpki} → ${event.newSpki}: every phone must re-pin`);
    this.emit('rotated', event);
    return event;
  }
}

module.exports = { AcmeManager, createAcmeAdapter, CHECK_EVERY_MS, FAILURE_BACKOFF_MS, ALERT_BEFORE_MS, ISSUE_DEADLINE_MS };
