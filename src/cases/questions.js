// src/cases/questions.js
// Question records under .kl/questions/<id>.json (cases stage 2 spec §3.9,
// program §4.3). An answer becomes exactly one host-verified `user` fact;
// a `<id>.claim` marker made with O_EXCL decides who answered first.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { readJson, writeJson } = require('./jsonfile');
const { FactLedger } = require('./ledger');
const { CaseRecords } = require('./records');

const KINDS = Object.freeze(['question', 'approval', 'briefing']);
const URGENCIES = Object.freeze(['low', 'normal', 'high']);
const CLOSED_BY = Object.freeze(['panel', 'expiry', 'system']);
const ID_PATTERN = /^q-\d{4,}$/;
const FILE_PATTERN = /^q-\d{4,}\.json$/;
const OPTION_ID = /^[a-z0-9-]{1,16}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_EXPIRY_MS = 30 * 24 * 3600 * 1000;

const HANDLERS = new Map();

class QuestionError extends Error {
  constructor(code, message, record = null) {
    super(message);
    this.name = 'QuestionError';
    this.code = code;
    this.record = record;
  }
}

const normText = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const oneLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const valueText = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));

function alreadyAnswered(rec) {
  let how = 'another surface';
  if (rec.answer) how = `${rec.answer.channel} at ${rec.answer.at}`;
  else if (rec.closed) how = `a close (${rec.closed.by}) at ${rec.closed.at}`;
  return new QuestionError('ALREADY_ANSWERED', `${rec.id} was already answered via ${how}.`, rec);
}

function defaultFactInput(rec, answer, option) {
  const about = rec.payload?.about && typeof rec.payload.about === 'object' ? rec.payload.about : {};
  const value = option ? option.label : answer.text;
  return {
    stmt: `Owner answered ${rec.id} ("${oneLine(rec.text, 80)}"): ${value}`,
    subject: typeof about.subject === 'string' && about.subject.trim() ? about.subject : 'question',
    attr: typeof about.attr === 'string' && about.attr.trim() ? about.attr : rec.id,
    value,
    ...(rec.payload?.resolves ? { supersedes: rec.payload.resolves } : {})
  };
}

class QuestionStore {
  constructor(dir, { now = () => new Date(), caseId = null } = {}) {
    this.dir = dir;
    this.qdir = path.join(dir, '.kl', 'questions');
    this.now = now;
    this._caseId = caseId;
  }

  static registerAnswerHandler(type, { toFact = null, onAnswered = null } = {}) {
    if (typeof type !== 'string' || !type) throw new Error('registerAnswerHandler needs a payload type.');
    HANDLERS.set(type, {
      toFact: typeof toFact === 'function' ? toFact : null,
      onAnswered: typeof onAnswered === 'function' ? onAnswered : null
    });
  }

  static answerHandler(type) {
    return HANDLERS.get(type) || null;
  }

  get caseId() {
    if (this._caseId) return this._caseId;
    try {
      this._caseId = yaml.load(fs.readFileSync(path.join(this.dir, 'case.yaml'), 'utf8'))?.id || null;
    } catch {
      this._caseId = null;
    }
    return this._caseId;
  }

  _path(id) {
    return path.join(this.qdir, `${id}.json`);
  }

  _write(rec) {
    writeJson(this._path(rec.id), rec);
  }

  get(id) {
    if (!ID_PATTERN.test(String(id))) return null;
    return readJson(this._path(id), null);
  }

  _require(id) {
    const rec = this.get(id);
    if (!rec) throw new QuestionError('NOT_FOUND', `Question ${id} was not found in this case.`);
    return rec;
  }

  list() {
    let names = [];
    try {
      names = fs.readdirSync(this.qdir);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return names
      .filter((n) => FILE_PATTERN.test(n))
      .sort((a, b) => Number(a.slice(2, -5)) - Number(b.slice(2, -5)))
      .map((n) => readJson(path.join(this.qdir, n), null))
      .filter(Boolean);
  }

  open() {
    return this.list().filter((r) => r.answer === null && !r.closed);
  }

  _nextId() {
    const max = this.list().reduce((m, r) => Math.max(m, Number(String(r.id).slice(2)) || 0), 0);
    return `q-${String(max + 1).padStart(4, '0')}`;
  }

  findDuplicate(record) {
    const text = normText(record?.text);
    const key = record?.payload?.key;
    return this.open().find((r) => r.kind === record?.kind && (
      normText(r.text) === text || (Boolean(key) && r.payload?.key === key)
    )) || null;
  }

  _validate(record) {
    const bad = (message) => { throw new QuestionError('INVALID', message); };
    if (!record || typeof record !== 'object') bad('A question record is required.');
    if (!KINDS.includes(record.kind)) bad(`kind must be one of ${KINDS.join(', ')}.`);
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (text.length < 1 || text.length > 2000) bad('text must be 1 to 2000 characters.');
    let options = [];
    if (record.options !== undefined && record.options !== null) {
      if (!Array.isArray(record.options)) bad('options must be a list of { id, label }.');
      if (record.kind === 'briefing' && record.options.length) bad('A briefing takes no options.');
      if (record.options.length > 6) bad('A question takes at most 6 options.');
      const seen = new Set();
      options = record.options.map((o) => {
        const id = String(o?.id ?? '');
        const label = typeof o?.label === 'string' ? o.label.trim() : '';
        if (!OPTION_ID.test(id)) bad(`Option id "${id}" must match ^[a-z0-9-]{1,16}$.`);
        if (seen.has(id)) bad(`Option id "${id}" is used twice.`);
        seen.add(id);
        if (label.length < 1 || label.length > 200) bad(`Option "${id}" needs a label of 1 to 200 characters.`);
        return { id, label };
      });
    }
    if (!URGENCIES.includes(record.urgency)) bad(`urgency must be one of ${URGENCIES.join(', ')}.`);
    let expiresAt = null;
    if (record.expiresAt !== undefined && record.expiresAt !== null) {
      const t = Date.parse(record.expiresAt);
      if (typeof record.expiresAt !== 'string' || !RFC3339.test(record.expiresAt) || !Number.isFinite(t)) {
        bad('expiresAt must be an RFC3339 date-time or null.');
      }
      const now = this.now().getTime();
      if (t <= now) bad('expiresAt must be in the future.');
      if (t - now > MAX_EXPIRY_MS) bad('expiresAt must be at most 30 days out.');
      expiresAt = new Date(t).toISOString();
    }
    const defaultOnSilence = record.defaultOnSilence ?? 'hold';
    if (defaultOnSilence !== 'hold') {
      if (record.kind === 'briefing') bad('A briefing can only hold on silence.');
      if (!options.some((o) => o.id === defaultOnSilence)) bad(`defaultOnSilence "${defaultOnSilence}" is not one of the options.`);
    }
    const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
      ? { ...record.payload }
      : {};
    if (payload.type === undefined) payload.type = 'ask';
    else if (typeof payload.type !== 'string' || !payload.type) bad('payload.type must be a non-empty string.');
    if (payload.mcpAnswerable === undefined) payload.mcpAnswerable = true;
    else if (typeof payload.mcpAnswerable !== 'boolean') bad('payload.mcpAnswerable must be true or false.');
    return { kind: record.kind, text, options, urgency: record.urgency, expiresAt, defaultOnSilence, payload };
  }

  create(record) {
    const clean = this._validate(record);
    const dup = this.findDuplicate(clean);
    if (dup) return dup;
    fs.mkdirSync(this.qdir, { recursive: true });
    const rec = {
      id: this._nextId(),
      kind: clean.kind,
      caseId: this.caseId,
      text: clean.text,
      options: clean.options,
      urgency: clean.urgency,
      createdAt: this.now().toISOString(),
      expiresAt: clean.expiresAt,
      defaultOnSilence: clean.defaultOnSilence,
      deliveries: [],
      payload: clean.payload,
      answer: null,
      closed: null,
      notes: []
    };
    this._write(rec);
    return rec;
  }

  _claim(rec) {
    fs.mkdirSync(this.qdir, { recursive: true });
    try {
      fs.closeSync(fs.openSync(path.join(this.qdir, `${rec.id}.claim`), 'wx'));
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      throw alreadyAnswered(this.get(rec.id) || rec);
    }
  }

  _tryClaim(rec) {
    try {
      this._claim(rec);
      return true;
    } catch (err) {
      if (err.code === 'ALREADY_ANSWERED') return false;
      throw err;
    }
  }

  _unclaim(id) {
    fs.rmSync(path.join(this.qdir, `${id}.claim`), { force: true });
  }

  answer(id, { channel = 'in-app', text = null, optionId = null } = {}) {
    const rec = this._require(id);
    if (rec.kind === 'briefing') throw new QuestionError('IS_BRIEFING', `${id} is a briefing; acknowledge it instead of answering.`, rec);
    if (rec.answer || rec.closed) throw alreadyAnswered(rec);
    const wantsOption = optionId !== null && optionId !== undefined;
    const option = wantsOption ? rec.options.find((o) => o.id === optionId) : null;
    if (wantsOption && !option) throw new QuestionError('INVALID', `Option "${optionId}" is not one of ${id}'s options.`, rec);
    const answerText = typeof text === 'string' && text.trim() ? text.trim() : null;
    if (!option && !answerText) throw new QuestionError('INVALID', 'An answer needs text or an option.', rec);
    this._claim(rec);
    try {
      const at = this.now().toISOString();
      const answer = { channel: String(channel), at, text: answerText, optionId: option ? option.id : null };
      const handler = HANDLERS.get(rec.payload?.type);
      const input = handler?.toFact ? handler.toFact(rec, answer) : defaultFactInput(rec, answer, option);
      const fact = new FactLedger(this.dir).assert({
        ...input,
        ...(rec.payload?.disclosable === false ? { disclosable: false } : {}),
        ...(rec.payload?.gating?.category ? { category: rec.payload.gating.category } : {}),
        provenance: 'user',
        source: { kind: 'question', ref: rec.id, channel: answer.channel, at },
        addedBy: `question:${rec.id}`
      });
      rec.answer = { ...answer, factId: fact.id };
      this._write(rec);
      new CaseRecords(this.dir).writeJournal('question', `${rec.id} answered via ${answer.channel}: ${valueText(fact.value)} (fact ${fact.id})`, this.now());
      return rec;
    } catch (err) {
      if (!rec.answer) this._unclaim(rec.id);
      throw err;
    }
  }

  acknowledge(id, { channel = 'in-app' } = {}) {
    const rec = this._require(id);
    if (rec.kind !== 'briefing') throw new QuestionError('NOT_BRIEFING', `${id} is a ${rec.kind}; answer it instead.`, rec);
    if (rec.answer || rec.closed) throw alreadyAnswered(rec);
    this._claim(rec);
    rec.answer = { channel: String(channel), at: this.now().toISOString(), text: null, optionId: null, factId: null };
    this._write(rec);
    return rec;
  }

  recordDelivery(id, { channel, at = null, deliveryId }) {
    const rec = this._require(id);
    if (!rec.deliveries.some((d) => d.deliveryId === deliveryId)) {
      rec.deliveries.push({ channel: String(channel), at: at || this.now().toISOString(), deliveryId: String(deliveryId) });
      this._write(rec);
    }
    return rec;
  }

  note(id, text) {
    const rec = this._require(id);
    rec.notes = [...(Array.isArray(rec.notes) ? rec.notes : []), { at: this.now().toISOString(), text: String(text) }];
    this._write(rec);
    return rec;
  }

  expire(now = this.now()) {
    const t = now.getTime();
    const expired = [];
    const overdue = [];
    for (const rec of this.open()) {
      if (!rec.expiresAt || Date.parse(rec.expiresAt) > t) continue;
      if (rec.kind === 'briefing') {
        if (this._tryClaim(rec)) {
          rec.answer = { channel: 'expired', at: now.toISOString(), text: null, optionId: null, factId: null };
          this._write(rec);
          expired.push(rec.id);
        }
        continue;
      }
      if (rec.defaultOnSilence === 'hold') {
        overdue.push(rec.id);
        continue;
      }
      if (this._tryClaim(rec)) {
        rec.answer = { channel: 'default', at: now.toISOString(), text: null, optionId: rec.defaultOnSilence, factId: null };
        this._write(rec);
        new CaseRecords(this.dir).writeJournal('question', `${rec.id} expired: default ${rec.defaultOnSilence} applied`, now);
        expired.push(rec.id);
      }
    }
    return { expired, overdue };
  }

  close(id, { reason = '', by = 'system' } = {}) {
    if (!CLOSED_BY.includes(by)) throw new QuestionError('INVALID', `by must be one of ${CLOSED_BY.join(', ')}.`);
    const rec = this._require(id);
    if (rec.answer || rec.closed) throw alreadyAnswered(rec);
    this._claim(rec);
    rec.closed = { at: this.now().toISOString(), reason: String(reason), by };
    this._write(rec);
    new CaseRecords(this.dir).writeJournal('question', `${rec.id} closed by ${by}: ${reason || 'no reason given'}`, this.now());
    return rec;
  }
}

module.exports = { QuestionStore, QuestionError, KINDS, URGENCIES };
