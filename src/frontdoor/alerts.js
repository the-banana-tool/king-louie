// What the front door tells the owner about (fleet stage 4 §3.13): a small
// persisted list the phone polls (GET /v1/alerts) and, when push is set up,
// is pushed as { kind: 'alert', id }. Deduplicated per kind + subject for a
// day, at most 500 kept.
//
// `detail` is caller-supplied and can carry text sourced from the network
// (a CA error, an IP address, a hostile hostname), so it is sanitized before
// it is ever stored: control/format characters are stripped and its
// serialized size is capped. It is always nested under `detail` — never
// spread into the alert itself — so it can never override `id`, `kind`,
// `at` or `acked`.
//
// raise() must never throw into its caller except for the one deliberate
// refusal (an unknown kind). A push that throws, or a failed persist, is
// logged and swallowed; the in-memory alert (already appended before the
// save is attempted) is never lost.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { writeFileAtomic } = require('../approvals/approver-store');

const log = createLogger('frontdoor/alerts');

const ALERT_KINDS = Object.freeze([
  'acme_renewal_failing', 'tls_key_changed', 'audit_chain_break', 'audit_gap', 'refresh_reuse',
  'unknown_node_key', 'dns_probe_failed', 'node_record_invalid', 'node_replaced',
  'node_link_flapping'
]);
const TOP = 5;
const MAX_DETAIL_BYTES = 4096;
// Control and format characters (Cc, Cf) — the kind of thing a hostile CA
// error or bidi-laced hostname can carry.
const CONTROL_FORMAT_RE = /[\p{Cc}\p{Cf}]/gu;

function stripControl(value) {
  if (typeof value === 'string') return value.replace(CONTROL_FORMAT_RE, '');
  if (Array.isArray(value)) return value.map(stripControl);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[stripControl(k)] = stripControl(v);
    return out;
  }
  return value;
}

// Strips control/format characters, then caps the serialized size at
// MAX_DETAIL_BYTES, cutting anything longer down to a short, clearly-marked
// placeholder rather than storing the oversized value whole.
function sanitizeDetail(detail) {
  let cleaned;
  try {
    cleaned = stripControl(detail && typeof detail === 'object' ? detail : {});
  } catch {
    cleaned = {};
  }
  let json;
  try {
    json = JSON.stringify(cleaned);
  } catch {
    return { truncated: true };
  }
  if (Buffer.byteLength(json, 'utf8') <= MAX_DETAIL_BYTES) return cleaned;
  const budget = MAX_DETAIL_BYTES - 64;
  let cut = json;
  while (cut.length > 0 && Buffer.byteLength(cut, 'utf8') > budget) cut = cut.slice(0, Math.floor(cut.length * 0.9));
  return { truncated: true, original_bytes: Buffer.byteLength(json, 'utf8'), preview: cut };
}

class AlertCenter {
  constructor({ file, now = Date.now, push = null, dedupeMs = 86400000, max = 500 } = {}) {
    this.file = file;
    this.now = now;
    this.push = push;
    this.dedupeMs = dedupeMs;
    this.max = max;
    this.alerts = [];
    this.seq = 0;
    this.unknown = null; // { day, alertId, byFingerprint: Map }
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(stored.alerts)) this.alerts = stored.alerts;
      this.seq = Number.isInteger(stored.seq) ? stored.seq : this.alerts.reduce((m, a) => Math.max(m, Number(a.id) || 0), 0);
      if (this.alerts.length > this.max) this.alerts.splice(0, this.alerts.length - this.max);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.warn(`alerts file corrupt, starting empty: ${err.message}`);
        try {
          fs.copyFileSync(file, `${file}.corrupt`);
        } catch (copyErr) {
          log.warn(`failed to keep a .corrupt copy of the alerts file: ${copyErr.message}`);
        }
      }
    }
  }

  // Persist failures are logged, never thrown: the in-memory alert list
  // (already updated by the caller before this runs) is the source of
  // truth for this process either way.
  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.file, `${JSON.stringify({ v: 1, seq: this.seq, alerts: this.alerts }, null, 2)}\n`);
    } catch (err) {
      log.warn(`failed to persist alerts: ${err.message}`);
    }
  }

  _notify(alert) {
    if (!this.push) return;
    Promise.resolve()
      .then(() => this.push(alert))
      .catch((e) => log.warn(`alert push failed: ${e.message}`));
  }

  raise(kind, { subject = null, detail = {} } = {}) {
    if (!ALERT_KINDS.includes(kind)) throw new Error(`unknown alert kind ${kind}`);
    const t = this.now();
    const recent = this.alerts.find((a) => a.kind === kind && a.subject === subject && t - Date.parse(a.at) < this.dedupeMs);
    if (recent) return null;
    this.seq += 1;
    const alert = { id: String(this.seq), kind, subject, detail: sanitizeDetail(detail), at: new Date(t).toISOString(), acked: false };
    this.alerts.push(alert);
    if (this.alerts.length > this.max) this.alerts.splice(0, this.alerts.length - this.max);
    this._save();
    log.warn(`alert ${kind}${subject ? ` (${subject})` : ''}`);
    this._notify(alert);
    return alert;
  }

  list({ since = 0 } = {}) {
    const after = Number(since) || 0;
    return this.alerts.filter((a) => Number(a.id) > after).map((a) => ({ ...a }));
  }

  unacked(kind = null) {
    return this.alerts.filter((a) => !a.acked && (kind === null || a.kind === kind)).map((a) => ({ ...a }));
  }

  ack(id) {
    const a = this.alerts.find((x) => x.id === String(id));
    if (!a) return false;
    a.acked = true;
    this._save();
    return true;
  }

  // §3.13: an unknown certificate on mesh, counted, never more than one
  // alert a day; the day's alert carries a running summary.
  unknownNodeKey({ fingerprint = null, ip = null } = {}) {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (!this.unknown || this.unknown.day !== day) {
      this.unknown = { day, alertId: null, byFingerprint: new Map() };
    }
    // A restart mid-day loses this in-memory summary; recover the id and
    // the counts from the already-persisted alert rather than starting a
    // second one raise()'s own dedupe would just discard, freezing the
    // summary for the rest of the day.
    if (this.unknown.alertId === null) {
      const persisted = this.alerts.find((a) => a.kind === 'unknown_node_key' && a.subject === day);
      if (persisted) {
        this.unknown.alertId = persisted.id;
        const top = persisted.detail && Array.isArray(persisted.detail.top) ? persisted.detail.top : [];
        for (const e of top) this.unknown.byFingerprint.set(e.fingerprint || '(none)', { fingerprint: e.fingerprint, count: e.count, last_ip: e.last_ip });
      }
    }
    const key = fingerprint || '(none)';
    const entry = this.unknown.byFingerprint.get(key) || { fingerprint, count: 0, last_ip: null };
    entry.count += 1;
    entry.last_ip = ip;
    this.unknown.byFingerprint.set(key, entry);
    const all = [...this.unknown.byFingerprint.values()];
    const detail = { count: all.reduce((n, e) => n + e.count, 0), top: all.sort((a, b) => b.count - a.count).slice(0, TOP).map((e) => ({ ...e })) };
    if (this.unknown.alertId === null) {
      const alert = this.raise('unknown_node_key', { subject: day, detail });
      if (alert) this.unknown.alertId = alert.id;
      return;
    }
    const existing = this.alerts.find((a) => a.id === this.unknown.alertId);
    if (existing) {
      existing.detail = sanitizeDetail(detail);
      this._save();
    }
  }
}

module.exports = { AlertCenter, ALERT_KINDS };
