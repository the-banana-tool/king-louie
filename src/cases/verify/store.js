// src/cases/verify/store.js
// Cases stage 8 (spec §6.3, §7.3): <case>/.kl/verification.json. It holds
// the verification records (the newest 5 per criterion), the verify pass's
// newest opinion per criterion, a cache of the last computed states, the
// day's pass count, the last declined close proposal and, once the case is
// closed, the progress it closed with.
//
// Nothing here says whether a criterion is met: that is computed on every
// read by verify/status.js. `cache.states` exists so the turn-start hook can
// see a change and a commit's diff shows it; no reader takes it as truth.
// Writes happen only with the case lock held.
const fs = require('fs');
const path = require('path');
const { writeJson } = require('../jsonfile');
const { createLogger } = require('../../logging');

const log = createLogger('cases/verify-store');

const KEEP_PER_CRITERION = 5;
const ID_RE = /^v-(\d{4,})$/;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const strOrNull = (v) => (typeof v === 'string' && v ? v : null);
const idOf = (n) => `v-${String(n).padStart(4, '0')}`;
const emptyFile = () => ({ version: 1, nextRecord: 1, records: [], opinions: {}, cache: null, passes: null, declinedClose: null, closed: null });

function sameStates(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

class VerificationStore {
  constructor(dir, { now = () => new Date() } = {}) {
    this.dir = dir;
    this.file = path.join(dir, '.kl', 'verification.json');
    this.now = now;
    this._warned = false;
  }

  _warn(what) {
    if (this._warned) return;
    this._warned = true;
    log.warn(`${this.file} ${what}; reading it as empty.`);
  }

  // The file, or the empty shape when it is absent or unreadable. A part
  // that is missing or of the wrong kind reads as empty. Never writes.
  read() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this._warn(`cannot be read (${err.message})`);
      return emptyFile();
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      this._warn(`is not valid JSON (${err.message})`);
      return emptyFile();
    }
    if (!isObject(raw)) {
      this._warn('is not a verification file');
      return emptyFile();
    }
    this._warned = false;
    const records = (Array.isArray(raw.records) ? raw.records : []).filter((r) => isObject(r) && ID_RE.test(String(r.id || '')));
    // Ids only grow: past the stored counter and past every id in the file.
    let nextRecord = Number.isInteger(raw.nextRecord) && raw.nextRecord > 0 ? raw.nextRecord : 1;
    for (const r of records) nextRecord = Math.max(nextRecord, Number(ID_RE.exec(r.id)[1]) + 1);
    const opinions = {};
    if (isObject(raw.opinions)) {
      for (const [id, opinion] of Object.entries(raw.opinions)) if (isObject(opinion)) opinions[id] = opinion;
    }
    return {
      version: 1,
      nextRecord,
      records,
      opinions,
      cache: isObject(raw.cache) && isObject(raw.cache.states) ? raw.cache : null,
      passes: isObject(raw.passes) && typeof raw.passes.day === 'string' && Number.isInteger(raw.passes.count) ? raw.passes : null,
      // Only present once a skip was noted (noteSkip).
      ...(isObject(raw.skipNoted) && typeof raw.skipNoted.day === 'string' && typeof raw.skipNoted.reason === 'string' ? { skipNoted: raw.skipNoted } : {}),
      declinedClose: isObject(raw.declinedClose) && typeof raw.declinedClose.fingerprint === 'string' ? raw.declinedClose : null,
      closed: isObject(raw.closed) ? raw.closed : null
    };
  }

  _write(file) {
    writeJson(this.file, file);
  }

  // Called only by the verify pass after code accepted a verdict (spec
  // §6.3). A record that names no evidence is never written.
  addRecord({ criterion, criterionHash, evidence, note = '', turnId = null, model = null } = {}) {
    if (typeof criterion !== 'string' || !criterion || typeof criterionHash !== 'string' || !criterionHash) {
      throw new Error('A verification record names its criterion and the hash of its text.');
    }
    if (!Array.isArray(evidence) || !evidence.length || evidence.some((id) => typeof id !== 'string' || !id)) {
      throw new Error('A verification record cites at least one evidence id.');
    }
    const file = this.read();
    const record = {
      id: idOf(file.nextRecord),
      kind: 'verify',
      criterion,
      criterionHash,
      evidence: [...evidence],
      note: typeof note === 'string' ? note : '',
      turnId: strOrNull(turnId),
      model: strOrNull(model),
      at: this.now().toISOString(),
      disagreed: null
    };
    file.nextRecord += 1;
    file.records.push(record);
    const mine = file.records.filter((r) => r.criterion === criterion);
    const drop = new Set(mine.slice(0, Math.max(0, mine.length - KEEP_PER_CRITERION)));
    file.records = file.records.filter((r) => !drop.has(r));
    this._write(file);
    return record;
  }

  // A later verify pass no longer agrees with this record. → the record, or
  // null when there is none. The first mark stands.
  markDisagreed(recordId, { turnId = null } = {}) {
    const file = this.read();
    const record = file.records.find((r) => r.id === recordId);
    if (!record) return null;
    if (record.disagreed) return record;
    record.disagreed = { turnId: strOrNull(turnId), at: this.now().toISOString() };
    this._write(file);
    return record;
  }

  // What the verify pass said that code did not accept, or an `unmet`.
  setOpinion(criterionId, opinion) {
    if (typeof criterionId !== 'string' || !criterionId || !isObject(opinion)) throw new Error('An opinion is an object for one criterion id.');
    const file = this.read();
    file.opinions[criterionId] = { ...opinion, at: strOrNull(opinion.at) || this.now().toISOString() };
    this._write(file);
    return file.opinions[criterionId];
  }

  clearOpinion(criterionId) {
    const file = this.read();
    if (!Object.prototype.hasOwnProperty.call(file.opinions, criterionId)) return false;
    delete file.opinions[criterionId];
    this._write(file);
    return true;
  }

  // → true when written. Equal states write nothing, so a quiet turn leaves
  // a clean tree.
  setCache(states) {
    const next = isObject(states) ? { ...states } : {};
    const file = this.read();
    if (sameStates(file.cache ? file.cache.states : {}, next)) return false;
    file.cache = { at: this.now().toISOString(), states: next };
    this._write(file);
    return true;
  }

  // Counts one verify pass on `day` (YYYY-MM-DD). → the day's new count.
  countPass(day) {
    if (typeof day !== 'string' || !day) throw new Error('countPass needs the day.');
    const file = this.read();
    const count = file.passes && file.passes.day === day ? file.passes.count + 1 : 1;
    file.passes = { day, count };
    this._write(file);
    return count;
  }

  passesOn(day) {
    const { passes } = this.read();
    return passes && passes.day === day ? passes.count : 0;
  }

  // A pass skipped for the day's limit or the budget is said in the journal
  // once a day (spec §6.5). → true the first time `reason` is noted on `day`.
  noteSkip(day, reason) {
    if (typeof day !== 'string' || !day || typeof reason !== 'string' || !reason) throw new Error('noteSkip needs the day and the reason.');
    const file = this.read();
    if (file.skipNoted && file.skipNoted.day === day && file.skipNoted.reason === reason) return false;
    file.skipNoted = { day, reason };
    this._write(file);
    return true;
  }

  setDeclinedClose(fingerprint) {
    const file = this.read();
    file.declinedClose = typeof fingerprint === 'string' && fingerprint ? { fingerprint, at: this.now().toISOString() } : null;
    this._write(file);
    return file.declinedClose;
  }

  // The progress a case closed with: { at, status, summary, criteria,
  // readiness }. Every later read of the case returns it as it is.
  freeze(closed) {
    if (!isObject(closed)) throw new Error('freeze needs the closed record.');
    const file = this.read();
    file.closed = closed;
    this._write(file);
    return closed;
  }
}

module.exports = { VerificationStore, KEEP_PER_CRITERION };
