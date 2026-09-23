// src/cases/ledger.js
// Append-only fact ledger (spec §4.4). Every change is a new line; the
// current state of each fact is derived by replaying the file.
const path = require('path');
const { createLogger } = require('../logging');
const { appendJsonl, readJsonl, norm } = require('./jsonl');

const log = createLogger('cases/ledger');

const SENSITIVE_CATEGORIES = new Set(['personal', 'financial', 'legal', 'health']);
const ASSERT_PROVENANCE = new Set(['sourced', 'user', 'external-agent']);

class LedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerError';
  }
}


function requireText(input, field) {
  if (typeof input[field] !== 'string' || !input[field].trim()) {
    throw new LedgerError(`"${field}" is required.`);
  }
}

class FactLedger {
  constructor(dir) {
    this.dir = dir;
    this.path = path.join(dir, 'facts.jsonl');
  }

  _entries() {
    const { entries, errors } = readJsonl(this.path, (entry) => {
      if (!entry || typeof entry !== 'object' || !entry.kind) throw new Error('missing "kind"');
    });
    if (errors.length) log.warn(`${this.path}: skipped ${errors.length} malformed line(s)`);
    return { entries, errors };
  }

  view() {
    const { entries, errors } = this._entries();
    const facts = new Map();
    for (const e of entries) {
      if (e.kind === 'fact') {
        const { kind, ...rest } = e;
        facts.set(e.id, { ...rest, status: 'active', supersededBy: null, loadBearing: Boolean(e.loadBearing) });
        if (e.supersedes && facts.has(e.supersedes)) {
          const old = facts.get(e.supersedes);
          old.status = 'superseded';
          old.supersededBy = e.id;
        }
      } else if (facts.has(e.target)) {
        const f = facts.get(e.target);
        if (e.kind === 'retract') f.status = 'retracted';
        if (e.kind === 'disclosable') f.disclosable = Boolean(e.value);
        if (e.kind === 'loadBearing') f.loadBearing = true;
      }
    }
    return { facts, errors };
  }

  _append(entry) {
    appendJsonl(this.path, entry);
  }

  _nextId(facts) {
    let max = 0;
    for (const id of facts.keys()) {
      const n = Number(String(id).replace(/^f-/, ''));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `f-${String(max + 1).padStart(4, '0')}`;
  }

  _requireActive(facts, id, role) {
    const f = facts.get(id);
    if (!f) throw new LedgerError(`${role} references ${id}, which does not exist.`);
    if (f.status !== 'active') throw new LedgerError(`${role} references ${id}, which is not active (${f.status}).`);
    return f;
  }

  _write(fields) {
    const { facts } = this.view();
    if (fields.supersedes) this._requireActive(facts, fields.supersedes, 'supersedes');
    const entry = {
      kind: 'fact',
      id: this._nextId(facts),
      stmt: fields.stmt.trim(),
      subject: fields.subject.trim(),
      attr: fields.attr.trim(),
      value: fields.value === undefined ? null : fields.value,
      unit: fields.unit || null,
      provenance: fields.provenance,
      source: fields.source || null,
      confidence: typeof fields.confidence === 'number' ? fields.confidence : null,
      category: fields.category || null,
      disclosable: !(
        fields.provenance === 'inferred'
        || fields.provenance === 'unknown'
        || SENSITIVE_CATEGORIES.has(fields.category)
      ),
      loadBearing: Boolean(fields.loadBearing),
      supersedes: fields.supersedes || null,
      basis: Array.isArray(fields.basis) ? fields.basis : [],
      changes: fields.changes || null,
      answerable: fields.answerable || null,
      how: fields.how || null,
      addedBy: fields.addedBy || null,
      at: new Date().toISOString()
    };
    this._append(entry);
    const { kind, ...fact } = entry;
    return { ...fact, status: 'active', supersededBy: null };
  }

  assert(input = {}) {
    for (const f of ['stmt', 'subject', 'attr']) requireText(input, f);
    const provenance = input.provenance || 'sourced';
    if (!ASSERT_PROVENANCE.has(provenance)) {
      throw new LedgerError(`assert provenance must be one of ${[...ASSERT_PROVENANCE].join(', ')}; use infer or unknown instead.`);
    }
    if (!input.source || typeof input.source !== 'object' || !input.source.kind) {
      throw new LedgerError('assert requires a source { kind, ref }. If you have no source, record an unknown or an inference.');
    }
    // A user-message source is what the verified owner-quote path writes; no
    // other provenance may claim the owner as its source.
    if (input.source.kind === 'user-message' && provenance !== 'user') {
      throw new LedgerError('A "user-message" source is only valid with provenance "user". Use provenance "user" with a "quote" of the owner\'s words.');
    }
    return this._write({ ...input, provenance });
  }

  infer(input = {}) {
    for (const f of ['stmt', 'subject', 'attr']) requireText(input, f);
    if (!Array.isArray(input.basis) || input.basis.length === 0) {
      throw new LedgerError('infer requires a non-empty "basis" listing the fact ids it rests on.');
    }
    const { facts } = this.view();
    for (const id of input.basis) {
      const f = this._requireActive(facts, id, 'basis');
      if (f.provenance === 'unknown') throw new LedgerError(`basis ${id} is an open unknown; an inference cannot rest on it.`);
    }
    return this._write({ ...input, provenance: 'inferred', source: null });
  }

  unknown(input = {}) {
    for (const f of ['stmt', 'subject', 'attr', 'changes', 'answerable', 'how']) requireText(input, f);
    return this._write({ ...input, provenance: 'unknown', value: null, source: null });
  }

  retract(id, reason) {
    const { facts } = this.view();
    this._requireActive(facts, id, 'retract');
    this._append({ kind: 'retract', target: id, reason: String(reason || ''), at: new Date().toISOString() });
    return this.view().facts.get(id);
  }

  // Owner-only: callers must not expose this to the model (spec §4.4).
  setDisclosable(id, value) {
    const { facts } = this.view();
    if (!facts.has(id)) throw new LedgerError(`setDisclosable references ${id}, which does not exist.`);
    this._append({ kind: 'disclosable', target: id, value: Boolean(value), at: new Date().toISOString() });
    return this.view().facts.get(id);
  }

  markLoadBearing(ids = []) {
    const { facts } = this.view();
    for (const id of ids) {
      const f = facts.get(id);
      if (f && !f.loadBearing) this._append({ kind: 'loadBearing', target: id, at: new Date().toISOString() });
    }
  }

  query({ subject, attr, provenance, status = 'active', text } = {}) {
    return [...this.view().facts.values()].filter((f) => (
      (!subject || norm(f.subject) === norm(subject))
      && (!attr || norm(f.attr) === norm(attr))
      && (!provenance || f.provenance === provenance)
      && (status === 'any' || f.status === status)
      && (!text || norm(f.stmt).includes(norm(text)))
    ));
  }
}

module.exports = { FactLedger, LedgerError, SENSITIVE_CATEGORIES };
