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
const { createLogger } = require('../logging');

const log = createLogger('audit-ledger');

const SEGMENT_RE = /^ledger-(\d{4})-(\d{2})\.jsonl$/;
const WRITERS = ['service', 'mcp', 'cli'];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SLICE = 200;
const WIN32_BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
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
    lockTimeoutMs = 2000, staleLockMs = 10000, onPathWritten = null, platform = process.platform,
    lockOpen = (file) => fs.openSync(file, 'wx', 0o600) } = {}) {
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
    this.platform = platform;
    this.lockOpen = lockOpen;
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

  _segmentNameFor(atIso) {
    return `ledger-${atIso.slice(0, 7)}.jsonl`;
  }

  // The auditor's view: every non-blank raw line, including a trailing
  // fragment left by a write that never returned. verify() uses this so an
  // unhealed tear is surfaced as a problem, not quietly skipped.
  _rawSegmentLines(name) {
    const text = fs.readFileSync(path.join(this.dir, name), 'utf8');
    return text.split('\n').filter((line) => line.trim() !== '');
  }

  // The convenience readers' view: the same lines, minus a trailing
  // fragment that isn't newline-terminated. That fragment was never an
  // acknowledged append, so tail/slice/head/entriesAfter treat it as absent
  // rather than throwing on it.
  _completeSegmentLines(name) {
    const filePath = path.join(this.dir, name);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    if (raw === '') return [];
    const parts = raw.split('\n');
    if (!raw.endsWith('\n')) parts.pop();
    return parts.filter((line) => line !== '');
  }

  _allRawLines() {
    const lines = [];
    for (const seg of this._segments()) for (const line of this._rawSegmentLines(seg)) lines.push(line);
    return lines;
  }

  _allCompleteLines() {
    const lines = [];
    for (const seg of this._segments()) for (const line of this._completeSegmentLines(seg)) lines.push(line);
    return lines;
  }

  _entries() {
    return this._allCompleteLines().map((line) => JSON.parse(line));
  }

  // Moves a trailing, non-newline-terminated fragment of `segmentName` aside
  // to `<segment>.torn-<ms>` and truncates it off the live segment. Called
  // only under the append lock, on the segment we are about to extend, so
  // there is no writer racing us for it.
  _healTornTail(segmentName) {
    const filePath = path.join(this.dir, segmentName);
    let buf;
    try {
      buf = fs.readFileSync(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    if (buf.length === 0 || buf[buf.length - 1] === 0x0a) return;
    const lastNewline = buf.lastIndexOf(0x0a);
    const torn = buf.subarray(lastNewline + 1);
    const tornPath = `${filePath}.torn-${Date.now()}`;
    fs.writeFileSync(tornPath, torn);
    fs.truncateSync(filePath, lastNewline + 1);
    log.warn(`healed a torn tail in ${segmentName}`, { tornFile: path.basename(tornPath), tornBytes: torn.length });
  }

  // The last entry in `segmentName`, having first stripped any torn tail. A
  // complete line that still fails to parse is corruption, not a crash
  // artifact, and fails the append closed.
  _lastValidEntry(segmentName) {
    let last = null;
    for (const line of this._completeSegmentLines(segmentName)) {
      try {
        last = JSON.parse(line);
      } catch {
        throw new Error(`audit_unavailable: unparseable ledger line in ${segmentName}`);
      }
    }
    return last;
  }

  async _lock() {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      const token = crypto.randomBytes(8).toString('hex');
      let busy = false;
      try {
        const fd = this.lockOpen(this.lockFile);
        fs.writeSync(fd, `${process.pid}:${token}`);
        fs.closeSync(fd);
        return token;
      } catch (err) {
        // On Windows, creating the lock while another process's unlink of
        // it is still pending fails with EPERM (or EBUSY/EACCES), not
        // EEXIST. The service and `mcp` share this lock, so that is a
        // lock held for a moment longer: wait for it inside the deadline.
        busy = this.platform === 'win32' && WIN32_BUSY_CODES.has(err.code);
        if (err.code !== 'EEXIST' && !busy) throw err;
      }
      // A lock mid-delete has nothing stale to break.
      if (!busy) this._breakStaleLock();
      if (Date.now() >= deadline) throw new Error(`audit_unavailable: could not take ${this.lockFile} within ${this.lockTimeoutMs} ms`);
      await sleep(10 + Math.floor(Math.random() * 15));
    }
  }

  // A lock whose pid is gone, or that is older than staleLockMs, is a
  // candidate to break. We rename it aside — a losing racer's rename fails
  // with ENOENT and does nothing — then re-read the token we just moved: if
  // it still matches what we inspected, the break is safe and we delete the
  // aside file; if it changed, someone re-acquired a fresh lock in the gap
  // between our inspection and our rename, and we restore it (when the path
  // is free) instead of taking over, then back off and let the caller retry.
  _breakStaleLock() {
    let st;
    let content;
    try {
      st = fs.statSync(this.lockFile);
      content = fs.readFileSync(this.lockFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      log.warn(`failed to inspect ${this.lockFile}`, { error: err.message });
      throw err;
    }
    const [pidStr] = content.split(':');
    const pid = Number(pidStr) || null;
    const tooOld = Date.now() - st.mtimeMs > this.staleLockMs;
    const dead = pid !== null && pid !== process.pid && !pidAlive(pid);
    if (!tooOld && !dead) return;
    const aside = `${this.lockFile}.stale-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(this.lockFile, aside);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      log.warn(`failed to rename ${this.lockFile} aside`, { error: err.message });
      throw err;
    }
    let asideContent;
    try {
      asideContent = fs.readFileSync(aside, 'utf8');
    } catch {
      asideContent = content;
    }
    if (asideContent !== content) {
      try {
        fs.renameSync(aside, this.lockFile);
      } catch {
        // The path is occupied again, or the aside file is already gone;
        // either way we leave it and simply back off.
      }
      return;
    }
    try {
      fs.unlinkSync(aside);
    } catch {
      // Already gone.
    }
  }

  // Unlinks the lock only if it still holds the token we wrote when we
  // acquired it. If a stale-break has since handed the lock to someone
  // else, their token is there instead and we must never delete it.
  //
  // This only ever runs after append() has already durably written the
  // entry (byte-count-verified and fsynced), so a rejection here would
  // discard a return value for an entry that genuinely exists on disk. A
  // rejection from append() must mean the entry was not written, so a
  // failure past this point is logged at error level and swallowed rather
  // than thrown; the lock either clears now or is broken by the next
  // acquisition attempt (see _breakStaleLock), and the ledger itself is
  // unaffected either way.
  _unlock(token) {
    let current;
    try {
      current = fs.readFileSync(this.lockFile, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.error(`failed to read ${this.lockFile} during unlock`, { error: err.message, code: err.code });
      }
      return;
    }
    if (current.split(':')[1] !== token) return;
    try {
      fs.unlinkSync(this.lockFile);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.error(`failed to remove ${this.lockFile} during unlock`, { error: err.message, code: err.code });
      }
    }
  }

  async append({ kind, data = {} } = {}) {
    if (typeof kind !== 'string' || !kind) throw new TypeError('audit entry needs a kind');
    canonicalize(data);
    this._ensureDir();
    const token = await this._lock();
    try {
      const segs = this._segments();
      const lastExisting = segs.length ? segs[segs.length - 1] : null;
      let last = null;
      if (lastExisting) {
        this._healTornTail(lastExisting);
        last = this._lastValidEntry(lastExisting);
      }
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
      // Write into whichever of "the segment `at` names" and "the segment we
      // were already writing" sorts later, so a clock that runs backwards
      // never starts an earlier-named file once a later one exists (that
      // would put entries out of the order verify() reads segments in).
      const candidate = this._segmentNameFor(at);
      const targetName = lastExisting && lastExisting > candidate ? lastExisting : candidate;
      const file = path.join(this.dir, targetName);
      const existed = fs.existsSync(file);
      const line = `${JSON.stringify(entry)}\n`;
      const expectedBytes = Buffer.byteLength(line, 'utf8');
      const fd = fs.openSync(file, 'a', 0o600);
      try {
        const written = fs.writeSync(fd, line);
        fs.fsyncSync(fd);
        if (written !== expectedBytes) {
          throw new Error(`audit_unavailable: short write (${written} of ${expectedBytes} bytes) to ${targetName}`);
        }
      } finally {
        fs.closeSync(fd);
      }
      if (!existed) this.onPathWritten(file);
      return entry;
    } finally {
      this._unlock(token);
    }
  }

  // The oldest retained entry's `prev` is trusted as the anchor, so a pruned
  // ledger still verifies; slices carry the anchor so a mirror can tell a
  // prune gap from a fork. Unlike the convenience readers, verify() looks at
  // every raw line — an unhealed torn tail is exactly the kind of problem
  // this function exists to surface.
  verify() {
    const lines = this._allRawLines();
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
  // (last, by name) segment is never removed, so the chain always has a
  // head; append()'s I3 fix keeps "last by name" and "current" in sync even
  // across a backwards clock jump.
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

// Verifies a node-signed kl.audit.slice: signature, shape, that every entry
// belongs to the claimed node and its hash/chain are right, and that the
// entries are consistent with the slice's own signed head and anchor.
// Phones and F4's mirror do the same.
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
    if (entry.node_id !== message.node_id) return { ok: false, reason: 'foreign_entry' };
    const { hash, ...rest } = entry;
    if (entryHash(rest) !== hash) return { ok: false, reason: 'hash_mismatch' };
    if (previous && (entry.seq !== previous.seq + 1 || entry.prev !== previous.hash)) return { ok: false, reason: 'broken_chain' };
    previous = entry;
  }
  if (previous) {
    if (previous.seq > message.head.seq) return { ok: false, reason: 'exceeds_head' };
    if (previous.seq === message.head.seq && previous.hash !== message.head.hash) return { ok: false, reason: 'head_mismatch' };
  }
  const first = message.entries[0];
  if (first && first.seq < message.anchor.seq) return { ok: false, reason: 'before_anchor' };
  return { ok: true, reason: null, message };
}

module.exports = { AuditLedger, verifyAuditSlice, entryHash };
