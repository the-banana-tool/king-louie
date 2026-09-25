// Hash-chained, append-only audit ledger (program §4.16). One JSON entry per
// line in monthly segments <dir>/ledger-YYYY-MM.jsonl. `hash` is hex SHA-256
// over the JCS form of the entry without `hash`; `prev` is the previous
// entry's hash. The service, `mcp` and the admin CLI all append, so every
// append holds <dir>/ledger.lock. This is not src/events/event-ledger.js,
// which stays what it is (ruling 7).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalize } = require('../platform/jcs');
const { seal, open, verifyEd25519, nodeSigner } = require('../approvals/envelope');
const { validateMessage } = require('../approvals/messages');

const SEGMENT_RE = /^ledger-(\d{4})-(\d{2})\.jsonl$/;
const WRITERS = ['service', 'mcp', 'cli'];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SLICE = 200;
const DEFAULT_MAX_BYTES = 524288;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function entryHash(entryWithoutHash) {
  return crypto.createHash('sha256').update(canonicalize(entryWithoutHash), 'utf8').digest('hex');
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

class AuditLedger {
  constructor({ dir, nodeId, identity = null, writer = 'service', now = () => Date.now(), retentionDays = 365,
    lockTimeoutMs = 2000, staleLockMs = 10000, onPathWritten = null } = {}) {
    if (!dir) throw new TypeError('AuditLedger needs a dir');
    if (!WRITERS.includes(writer)) throw new TypeError(`AuditLedger writer must be one of ${WRITERS.join(', ')}`);
    this.dir = dir;
    this.nodeId = nodeId || (identity && identity.nodeId);
    this.identity = identity;
    this.writer = writer;
    this.now = now;
    this.retentionDays = retentionDays;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
    this.onPathWritten = onPathWritten || (() => {});
    this.lockFile = path.join(dir, 'ledger.lock');
  }

  _ensureDir() {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.onPathWritten(this.dir);
    }
  }

  _segments() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((f) => SEGMENT_RE.test(f)).sort();
  }

  _readSegment(name) {
    const text = fs.readFileSync(path.join(this.dir, name), 'utf8');
    return text.split('\n').filter((line) => line.trim() !== '');
  }

  _allLines() {
    const lines = [];
    for (const seg of this._segments()) for (const line of this._readSegment(seg)) lines.push(line);
    return lines;
  }

  _entries() {
    return this._allLines().map((line) => JSON.parse(line));
  }

  _lastEntry() {
    const segs = this._segments();
    for (let i = segs.length - 1; i >= 0; i -= 1) {
      const lines = this._readSegment(segs[i]);
      if (lines.length) return JSON.parse(lines[lines.length - 1]);
    }
    return null;
  }

  async _lock() {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx', 0o600);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      this._breakStaleLock();
      if (Date.now() >= deadline) throw new Error(`audit_unavailable: could not take ${this.lockFile} within ${this.lockTimeoutMs} ms`);
      await sleep(10 + Math.floor(Math.random() * 15));
    }
  }

  // A lock whose pid is gone, or that is older than staleLockMs, is moved
  // aside with rename (atomic: only one breaker wins) and then deleted.
  _breakStaleLock() {
    let st;
    let pid = null;
    try {
      st = fs.statSync(this.lockFile);
      pid = Number(fs.readFileSync(this.lockFile, 'utf8').trim()) || null;
    } catch {
      return;
    }
    const tooOld = Date.now() - st.mtimeMs > this.staleLockMs;
    const dead = pid !== null && pid !== process.pid && !pidAlive(pid);
    if (!tooOld && !dead) return;
    const aside = `${this.lockFile}.stale-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(this.lockFile, aside);
      fs.unlinkSync(aside);
    } catch {
      // Someone else broke it first.
    }
  }

  _unlock() {
    try {
      fs.unlinkSync(this.lockFile);
    } catch {
      // Already gone.
    }
  }

  async append({ kind, data = {} } = {}) {
    if (typeof kind !== 'string' || !kind) throw new TypeError('audit entry needs a kind');
    canonicalize(data);
    this._ensureDir();
    await this._lock();
    try {
      const last = this._lastEntry();
      const at = new Date(this.now()).toISOString();
      const entry = {
        v: 1,
        seq: last ? last.seq + 1 : 1,
        at,
        node_id: this.nodeId,
        writer: this.writer,
        kind,
        data,
        prev: last ? last.hash : null
      };
      entry.hash = entryHash(entry);
      const file = path.join(this.dir, `ledger-${at.slice(0, 7)}.jsonl`);
      const existed = fs.existsSync(file);
      const fd = fs.openSync(file, 'a', 0o600);
      try {
        fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (!existed) this.onPathWritten(file);
      return entry;
    } finally {
      this._unlock();
    }
  }

  // The oldest retained entry's `prev` is trusted as the anchor, so a pruned
  // ledger still verifies; slices carry the anchor so a mirror can tell a
  // prune gap from a fork.
  verify() {
    const lines = this._allLines();
    let previous = null;
    let count = 0;
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return { ok: false, entries: count, brokenAt: previous ? previous.seq + 1 : 1, reason: 'unparseable' };
      }
      const { hash, ...rest } = entry;
      if (previous) {
        if (entry.seq !== previous.seq + 1) return { ok: false, entries: count, brokenAt: entry.seq, reason: 'seq_gap' };
        if (entry.prev !== previous.hash) return { ok: false, entries: count, brokenAt: entry.seq, reason: 'prev_mismatch' };
      }
      if (entryHash(rest) !== hash) return { ok: false, entries: count, brokenAt: entry.seq, reason: 'hash_mismatch' };
      previous = entry;
      count += 1;
    }
    return { ok: true, entries: count };
  }

  tail(n) {
    const entries = this._entries();
    return n > 0 ? entries.slice(-n) : [];
  }

  // Entries after the one with `hash`, oldest first. null, or a hash no
  // longer retained, starts from the oldest retained entry.
  entriesAfter(hash, limit = MAX_SLICE) {
    const entries = this._entries();
    const i = hash === null || hash === undefined ? -1 : entries.findIndex((e) => e.hash === hash);
    return entries.slice(i + 1, i + 1 + Math.max(0, limit));
  }

  _headOf(entries) {
    const last = entries[entries.length - 1];
    return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: null };
  }

  _signer() {
    if (!this.identity) throw new Error('AuditLedger needs an identity to sign slices');
    return nodeSigner(this.identity);
  }

  // At most `limit` (≤ 200) entries whose JSON fits in max_bytes, but always
  // at least one when any match: before `before_seq` (phone history, newest
  // first when trimming) or after the `after` hash (mirror, oldest first).
  slice({ before_seq, after, limit = MAX_SLICE, max_bytes = DEFAULT_MAX_BYTES } = {}) {
    const all = this._entries();
    const cap = Math.min(MAX_SLICE, Math.max(1, Number.isInteger(limit) ? limit : MAX_SLICE));
    let picked;
    if (after !== undefined) {
      const candidates = this.entriesAfter(after, all.length);
      picked = [];
      let bytes = 0;
      for (const e of candidates) {
        const size = Buffer.byteLength(canonicalize(e));
        if (picked.length >= cap || (picked.length > 0 && bytes + size > max_bytes)) break;
        picked.push(e);
        bytes += size;
      }
    } else {
      const candidates = Number.isInteger(before_seq) ? all.filter((e) => e.seq < before_seq) : all;
      picked = [];
      let bytes = 0;
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const size = Buffer.byteLength(canonicalize(candidates[i]));
        if (picked.length >= cap || (picked.length > 0 && bytes + size > max_bytes)) break;
        picked.unshift(candidates[i]);
        bytes += size;
      }
    }
    const oldest = all[0];
    return seal({
      v: 1,
      type: 'kl.audit.slice',
      node_id: this.nodeId,
      entries: picked,
      head: this._headOf(all),
      anchor: oldest ? { seq: oldest.seq, prev: oldest.prev } : { seq: 0, prev: null },
      created_at: new Date(this.now()).toISOString()
    }, this._signer());
  }

  head() {
    const { seq, hash } = this._headOf(this._entries());
    return seal({ v: 1, type: 'kl.audit.slice.head', node_id: this.nodeId, seq, hash, at: new Date(this.now()).toISOString() }, this._signer());
  }

  // Whole segments whose month ended more than retentionDays ago. The newest
  // segment is never removed, so the chain always has a head.
  prune(now = this.now()) {
    const cutoff = now - this.retentionDays * DAY_MS;
    const segs = this._segments();
    let removedSegments = 0;
    for (const seg of segs.slice(0, -1)) {
      const [, y, mo] = SEGMENT_RE.exec(seg);
      const monthEnd = Date.UTC(Number(y), Number(mo), 1);
      if (monthEnd < cutoff) {
        fs.unlinkSync(path.join(this.dir, seg));
        removedSegments += 1;
      }
    }
    return { removedSegments };
  }
}

// Verifies a node-signed kl.audit.slice: signature, shape, and that each
// entry's hash is right and chains to the one before it. Phones and F4's
// mirror do the same.
function verifyAuditSlice(envelope, nodeKeySpkiHex) {
  if (!verifyEd25519(envelope, nodeKeySpkiHex)) return { ok: false, reason: 'bad_signature' };
  let message;
  try {
    ({ message } = open(envelope));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const shape = validateMessage('kl.audit.slice', message);
  if (shape) return { ok: false, reason: shape };
  if (envelope.kid !== message.node_id) return { ok: false, reason: 'malformed' };
  let previous = null;
  for (const entry of message.entries) {
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'malformed' };
    const { hash, ...rest } = entry;
    if (entryHash(rest) !== hash) return { ok: false, reason: 'hash_mismatch' };
    if (previous && (entry.seq !== previous.seq + 1 || entry.prev !== previous.hash)) return { ok: false, reason: 'broken_chain' };
    previous = entry;
  }
  return { ok: true, reason: null, message };
}

module.exports = { AuditLedger, verifyAuditSlice, entryHash };
