// frontdoor.tls: the operator supplies the mcp. certificate and key (§3.3).
// The files are re-read on SIGHUP and every 12 h; a new leaf key means every
// phone must re-pin, so it is logged at error and raised as tls_key_changed.
const fs = require('fs');
const tls = require('tls');
const crypto = require('crypto');
const { createLogger } = require('../../logging');
const { relaySpkiPin } = require('../tls');
const { CHECK_EVERY_MS } = require('./acme');

const log = createLogger('frontdoor/operator-tls');

class OperatorTls {
  constructor({ host, certFile, keyFile, alerts = null, readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
    this.host = host;
    this.certFile = certFile;
    this.keyFile = keyFile;
    this.alerts = alerts;
    this.readFile = readFile;
    this.context = null;
    this.cert = null;
    this.timer = null;
  }

  _load() {
    const chain = this.readFile(this.certFile);
    const key = this.readFile(this.keyFile);
    const context = tls.createSecureContext({ cert: chain, key });
    const leaf = new crypto.X509Certificate(chain);
    const spki = relaySpkiPin(chain);
    const oldSpki = this.cert ? this.cert.spki : null;
    // The operator replaced the files: serve them, then say so loudly.
    this.context = context;
    this.cert = { chain, notBefore: Date.parse(leaf.validFrom), notAfter: Date.parse(leaf.validTo), spki };
    if (oldSpki && oldSpki !== spki) {
      log.error(`the mcp. certificate key changed (${oldSpki} → ${spki}): every phone must re-pin (relay qr, or rotate-tls-key under ACME)`);
      if (this.alerts) {
        try {
          this.alerts.raise('tls_key_changed', { subject: this.host, detail: { old_spki: oldSpki, new_spki: spki } });
        } catch (err) {
          log.error(`could not raise tls_key_changed: ${err.message}`);
        }
      }
    }
  }

  start() {
    if (this.timer) throw new Error('OperatorTls already started');
    this._load();
    this.timer = setInterval(() => this.reload(), CHECK_EVERY_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  reload() {
    try {
      this._load();
    } catch (err) {
      log.error(`could not re-read ${this.certFile} / ${this.keyFile}: ${err.message}; the loaded certificate stays`);
    }
    return Promise.resolve();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  currentContext() {
    return this.context;
  }

  challengeFor() {
    return null;
  }

  leafSpki() {
    return this.cert ? this.cert.spki : null;
  }

  certificate() {
    return this.cert ? { ...this.cert } : null;
  }

  status() {
    return { source: 'operator', not_after: this.cert ? new Date(this.cert.notAfter).toISOString() : null, spki: this.leafSpki(), last_error: null, failures: 0, next_attempt_at: null };
  }

  async rotateKey() {
    throw new Error('rotate-tls-key needs frontdoor.acme; with frontdoor.tls, replace the files, then give phones the new pin with `relay qr`');
  }
}

module.exports = { OperatorTls };
