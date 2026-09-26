// src/cases/contact-state.js
// The owner-wide contact files under <dataDir>/contact/ (cases stage 4 spec
// §4.2, §4.3): ladder.json, deliveries.json, inbox.jsonl and the relay
// cursors. Loaded once, changed in memory with synchronous read-modify-write
// steps, written atomically (tmp + rename, via jsonfile.js) after every change.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { newToken } = require('./contact-format');
const { writeAtomic } = require('./jsonfile');
const { createLogger } = require('../logging');

const PRUNE_AFTER_MS = 30 * 24 * 3600 * 1000;
const SEEN_EVENTS = 2000;

function parseInbox(text) {
  return text.split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function emptyLadder() {
  return { version: 1, entries: {}, digest: { lastSentDay: null }, pins: {} };
}

class ContactState {
  constructor({ dir, clock = () => new Date(), log = createLogger('contact/state'), readOnly = false } = {}) {
    this.dir = dir;
    this.clock = clock;
    this.log = log;
    this.readOnly = readOnly;
    this._ladder = null;
    this._deliveries = null;
    this._seen = null;
  }

  file(name) {
    return path.join(this.dir, name);
  }

  // An unreadable file is renamed <name>.corrupt-<ts> and rebuilt. In
  // readOnly mode the file is left alone (no rename, no write) and the
  // caller just gets the fallback for this call.
  _read(name, fallback) {
    const file = this.file(name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return fallback();
      throw err;
    }
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      throw new Error('not an object');
    } catch (err) {
      if (!this.readOnly) {
        const moved = `${file}.corrupt-${this.clock().getTime()}`;
        fs.renameSync(file, moved);
        this.log.warn(`${name} was unreadable (${err.message}); moved it to ${path.basename(moved)} and started over`);
      }
      return fallback();
    }
  }

  ladder() {
    if (!this._ladder) {
      const l = this._read('ladder.json', emptyLadder);
      this._ladder = { ...emptyLadder(), ...l, entries: l.entries || {}, digest: l.digest || { lastSentDay: null }, pins: l.pins || {} };
    }
    return this._ladder;
  }

  saveLadder() {
    if (this.readOnly) return;
    writeAtomic(this.file('ladder.json'), `${JSON.stringify(this.ladder(), null, 2)}\n`);
  }

  deliveries() {
    if (!this._deliveries) this._deliveries = this._read('deliveries.json', () => ({}));
    return this._deliveries;
  }

  saveDeliveries() {
    if (this.readOnly) return;
    writeAtomic(this.file('deliveries.json'), `${JSON.stringify(this.deliveries(), null, 2)}\n`);
  }

  // Unique across ladder.json and deliveries.json (question and batch tokens)
  // until the delivery that used it is pruned.
  newToken(randomBytes) {
    const used = new Set();
    for (const e of Object.values(this.ladder().entries)) used.add(e.token);
    for (const d of Object.values(this.deliveries())) {
      used.add(d.batchToken);
      for (const it of d.items || []) used.add(it.token);
    }
    for (let i = 0; i < 1000; i += 1) {
      const t = newToken(randomBytes);
      if (!used.has(t)) return t;
    }
    throw new Error('could not find an unused contact token');
  }

  newDeliveryId() {
    return `d-${this.clock().getTime().toString(36).toUpperCase()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  }

  recordDelivery(id, delivery) {
    this.deliveries()[id] = delivery;
    this.saveDeliveries();
  }

  // Resolves a question token, batch token, delivery id or channel message
  // reference to { delivery, deliveryId, item? }. A question token is the
  // same on every channel: this prefers a delivery on `channel`, else the
  // newest delivery that carried it. A batch token, delivery id or channel
  // reference is only ever meaningful for the delivery it belongs to; when
  // `channel` is given, a channel reference (externalRef/relayId) must match
  // on that same channel — an SMS delivery's externalRef never resolves from
  // an email reply.
  // ref: true — correlationId is a channel message reference (a reply-to id,
  // an In-Reply-To): it matches only externalRef/relayId on that channel and
  // never a token, a batch token or a delivery id (review T10 I1: a Telegram
  // message id can equal an all-digit token).
  resolve(correlationId, { channel = null, ref = false } = {}) {
    const key = String(correlationId ?? '').trim();
    if (!key) return null;
    if (ref) {
      if (!channel) return null;
      const hit = Object.entries(this.deliveries()).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)))
        .find(([, d]) => d.channel === channel && (d.externalRef === key || d.relayId === key));
      return hit ? { deliveryId: hit[0], delivery: hit[1], item: null } : null;
    }
    const upper = key.toUpperCase();
    const all = Object.entries(this.deliveries()).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
    const withToken = all.filter(([, d]) => (d.items || []).some((it) => it.token === upper));
    const hit = withToken.find(([, d]) => !channel || d.channel === channel) || withToken[0];
    if (hit) return { deliveryId: hit[0], delivery: hit[1], item: hit[1].items.find((it) => it.token === upper) };
    for (const [id, d] of all) {
      if (id === key || d.batchToken === upper) return { deliveryId: id, delivery: d, item: null };
      if ((!channel || d.channel === channel) && (d.externalRef === key || d.relayId === key)) return { deliveryId: id, delivery: d, item: null };
    }
    return null;
  }

  isKnownToken(token) {
    return Boolean(this.resolve(token));
  }

  // `channels`: only deliveries on these channels may match (a relay may
  // only touch what it carries; recordStatus only its own channel).
  setDeliveryStatus(match, status, error = null, { channels = null } = {}) {
    for (const [id, d] of Object.entries(this.deliveries())) {
      if (channels && !channels.includes(d.channel)) continue;
      if (id === match || (match && (d.externalRef === match || d.relayId === match))) {
        d.status = status;
        if (error) d.error = String(error);
        d.statusAt = this.clock().toISOString();
        this.saveDeliveries();
        return id;
      }
    }
    return null;
  }

  // Drops deliveries older than 30 days whose every item is closed.
  pruneDeliveries(isOpen) {
    const cutoff = this.clock().getTime() - PRUNE_AFTER_MS;
    let pruned = 0;
    for (const [id, d] of Object.entries(this.deliveries())) {
      if (Date.parse(d.at) < cutoff && !(d.items || []).some((it) => isOpen(it.caseId, it.questionId))) {
        delete this.deliveries()[id];
        pruned += 1;
      }
    }
    if (pruned) this.saveDeliveries();
    return pruned;
  }

  pin(key, channel) {
    this.ladder().pins[key] = channel;
    this.saveLadder();
  }

  takePin(key) {
    const pins = this.ladder().pins;
    const channel = pins[key] || null;
    if (channel) {
      delete pins[key];
      this.saveLadder();
    }
    return channel;
  }

  // ---- inbox.jsonl: answers that waited behind a busy case ----

  appendInbox(line) {
    if (this.readOnly) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file('inbox.jsonl'), `${JSON.stringify(line)}\n`);
  }

  _inboxBytes() {
    try {
      return fs.readFileSync(this.file('inbox.jsonl'));
    } catch (err) {
      if (err.code === 'ENOENT') return Buffer.alloc(0);
      throw err;
    }
  }

  readInbox() {
    return parseInbox(this._inboxBytes().toString('utf8'));
  }

  // The inbox as { lines, size }: rewriteInbox(keep, size) later keeps
  // whatever was appended after this snapshot (a drain awaits between the
  // two; appendInbox only ever appends).
  inboxSnapshot() {
    const buf = this._inboxBytes();
    return { lines: parseInbox(buf.toString('utf8')), size: buf.length };
  }

  rewriteInbox(keep, since) {
    if (this.readOnly) return;
    const buf = this._inboxBytes();
    const tail = buf.length > since ? buf.subarray(since).toString('utf8') : '';
    const text = keep.map((l) => `${JSON.stringify(l)}\n`).join('') + tail;
    if (!text) {
      fs.rmSync(this.file('inbox.jsonl'), { force: true });
      return;
    }
    writeAtomic(this.file('inbox.jsonl'), text);
  }

  writeInbox(lines) {
    if (this.readOnly) return;
    if (!lines.length) {
      fs.rmSync(this.file('inbox.jsonl'), { force: true });
      return;
    }
    writeAtomic(this.file('inbox.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  }

  // ---- relay cursors and event ids ----

  readCursor(name) {
    try {
      return fs.readFileSync(this.file(`relay-${name}.cursor`), 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  writeCursor(name, cursor) {
    if (this.readOnly) return;
    if (cursor === null || cursor === undefined) return;
    writeAtomic(this.file(`relay-${name}.cursor`), `${cursor}\n`);
  }

  _seenIds() {
    if (!this._seen) {
      const data = this._read('relay-events.json', () => ({ ids: [] }));
      this._seen = Array.isArray(data.ids) ? data.ids : [];
    }
    return this._seen;
  }

  // Final review M2: an event is claimed (in memory, synchronously, so two
  // concurrent pushes of one id apply it once) before it is handled, and
  // persisted as seen only after. A crash in between leaves it unseen, so a
  // re-poll or retried push applies it again (the answer path is idempotent).
  claimEvent(id) {
    if (!this._claimed) this._claimed = new Set();
    if (this._claimed.has(id) || this._seenIds().includes(id)) return false;
    this._claimed.add(id);
    return true;
  }

  // done: true persists the id as seen; false releases the claim.
  settleEvent(id, done) {
    if (this._claimed) this._claimed.delete(id);
    if (done) this.markEventSeen(id);
  }

  // true the first time an event id is seen; the last 2000 ids are kept.
  markEventSeen(id) {
    const ids = this._seenIds();
    if (ids.includes(id)) return false;
    ids.push(id);
    if (ids.length > SEEN_EVENTS) ids.splice(0, ids.length - SEEN_EVENTS);
    if (!this.readOnly) writeAtomic(this.file('relay-events.json'), `${JSON.stringify({ ids })}\n`);
    return true;
  }
}

module.exports = { ContactState, emptyLadder, writeAtomic };
