// src/cases/playbooks/gating.js
// Gating (cases stage 6 spec §3.6, program §4.11): playbook questions join
// the case's gating pass as code-created question records or ledger
// unknowns. Questions from every source are merged by key; a `sourced` fact
// never satisfies an owner question.
const { norm } = require('../jsonl');
const { BriefError } = require('../brief');
const { caseTypes } = require('./case-types-bridge');

const SENSITIVITY = Object.freeze({ personal: 1, financial: 2, legal: 3, health: 4 });
const OWNER_SOURCE_KINDS = Object.freeze(['question', 'user-message']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Question text comes from third-party playbooks and is shown to the owner:
// data, not instructions. It stays in the record's text (and the ledger's
// stmt/changes/how), folded to one line and capped at the validator's limits.
const MAX_TEXT = 500;
const MAX_NOTE = 300;
// The brief fields an owner's gating answer may fill (spec §3.6). A playbook
// names the field; only the owner's answer fills it. Never resources (R41),
// materiality, safeDefaults or a case type's own fields.
const GATING_BRIEF_FIELDS = Object.freeze(['why', 'hardConstraints', 'alreadyTried', 'successCriteria', 'deadline']);

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]+/g;
const oneLine = (v, max) => String(v ?? '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const labelOf = (origin) => String(origin || '').replace(/^(playbook|case-type):/, '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 48) || 'gating';
const optionSig = (options) => JSON.stringify(options.map((o) => [o.id, o.label]));
const hasOptions = (q) => Array.isArray(q.options) && q.options.length > 0;

function keyOf(q) {
  if (typeof q.field === 'string' && q.field) return `field:${q.field}`;
  if (q.fact && q.fact.subject && q.fact.attr) return `${norm(q.fact.subject)}.${norm(q.fact.attr)}`;
  return null;
}

// Playbook questions from loader entries: state ok, and the on-disk copy is
// the one case.yaml last oriented against (changed copies wait for
// acknowledgePlaybooks).
function playbookGatingQuestions(entries) {
  const out = [];
  for (const e of entries || []) {
    if (e.state !== 'ok' || !e.onDisk || !e.pinned || e.onDisk.contentHash !== e.pinned.contentHash) continue;
    for (const q of e.package.playbook.gatingQuestions) {
      out.push({
        id: `${e.name}:${q.id}`,
        text: q.text,
        required: q.required,
        fact: q.fact,
        answerable: q.answerable,
        ...(q.options ? { options: q.options } : {}),
        ...(q.briefField ? { briefField: q.briefField } : {}),
        ...(q.category ? { category: q.category } : {}),
        ...(q.changes ? { changes: q.changes } : {}),
        ...(q.how ? { how: q.how } : {}),
        origin: `playbook:${e.name}`
      });
    }
  }
  return out;
}

// One merged question per key. The first occurrence wins text and
// briefField; owner if any is owner-answerable; required if any is;
// differing options drop the options; the most sensitive category wins.
function mergeGatingQuestions(questions) {
  const byKey = new Map();
  const warnings = [];
  for (const raw of questions || []) {
    if (!raw || typeof raw !== 'object') continue;
    const key = keyOf(raw);
    const who = `${oneLine(raw.id, 80)} (${oneLine(raw.origin, 80)})`;
    if (!key) {
      warnings.push(`Gating question ${who} names neither a field nor a fact; skipped.`);
      continue;
    }
    let briefField = raw.briefField || null;
    if (briefField && !GATING_BRIEF_FIELDS.includes(briefField)) {
      warnings.push(`Gating question ${who} names brief field "${oneLine(briefField, 40)}", which a gating answer cannot fill; the answer is kept as a fact only.`);
      briefField = null;
    }
    const q = {
      ...raw,
      text: oneLine(raw.text, MAX_TEXT),
      briefField,
      category: typeof raw.category === 'string' && Object.hasOwn(SENSITIVITY, raw.category) ? raw.category : null,
      changes: raw.changes ? oneLine(raw.changes, MAX_NOTE) : null,
      how: raw.how ? oneLine(raw.how, MAX_NOTE) : null
    };
    const m = byKey.get(key);
    if (!m) {
      byKey.set(key, {
        key,
        kind: key.startsWith('field:') ? 'field' : 'fact',
        field: key.startsWith('field:') ? q.field : null,
        fact: key.startsWith('field:') ? null : { subject: q.fact.subject, attr: q.fact.attr },
        text: q.text,
        required: q.required !== false,
        answerable: q.answerable || 'owner',
        options: hasOptions(q) ? q.options : null,
        who,
        sigs: new Set(hasOptions(q) ? [optionSig(q.options)] : []),
        briefField: q.briefField || null,
        category: q.category || null,
        changes: q.changes || null,
        how: q.how || null,
        origins: [q.origin],
        ids: [q.id]
      });
      continue;
    }
    warnings.push(`Gating questions ${m.who} and ${who} ask for the same ${key}; it is asked once.`);
    m.ids.push(q.id);
    if (!m.origins.includes(q.origin)) m.origins.push(q.origin);
    if (q.required !== false) m.required = true;
    if (q.answerable === 'owner') m.answerable = 'owner';
    if (hasOptions(q)) {
      m.sigs.add(optionSig(q.options));
      if (!m.options) m.options = q.options;
    }
    if (q.category && (SENSITIVITY[q.category] || 0) > (SENSITIVITY[m.category] || 0)) m.category = q.category;
    if (!m.changes && q.changes) m.changes = q.changes;
    if (!m.how && q.how) m.how = q.how;
  }
  const merged = [...byKey.values()].map(({ sigs, who, ...m }) => ({ ...m, options: sigs.size > 1 ? null : m.options }));
  return { merged, warnings };
}

const activeOn = (facts, key) => [...facts.values()].filter((f) => f.status === 'active' && `${norm(f.subject)}.${norm(f.attr)}` === key);
const gatingRecords = (records, key) => records.filter((r) => r.payload?.type === 'gating' && r.payload?.gating?.key === key);

// The ledger fact the question store asserted for this record's answer, or
// null. The record file is case data and can be edited; the fact is checked
// back to the record (provenance user, source question/<record id>).
function ownerAnswerFact(r, facts) {
  const fact = r.answer && r.answer.factId ? facts.get(r.answer.factId) : null;
  return fact && fact.provenance === 'user' && fact.source?.kind === 'question' && fact.source?.ref === r.id ? fact : null;
}

// Owner questions: only an answered record or a host-verified owner fact.
function ownerSatisfied(m, facts, records) {
  if (gatingRecords(records, m.key).some((r) => ownerAnswerFact(r, facts))) return true;
  return activeOn(facts, m.key).some((f) => f.provenance === 'user' && OWNER_SOURCE_KINDS.includes(f.source?.kind));
}

function otherSatisfied(m, facts) {
  return activeOn(facts, m.key).some((f) => f.provenance === 'user' || f.provenance === 'sourced');
}

function pendingFrom(merged, facts, records) {
  return merged
    .filter((m) => m.kind === 'fact' && m.required && m.answerable === 'owner' && !ownerSatisfied(m, facts, records))
    .map((m) => {
      const open = gatingRecords(records, m.key).find((r) => !r.answer && !r.closed);
      return { key: m.key, text: m.text, origins: m.origins, required: true, recordId: open ? open.id : null };
    });
}

function gatingRecord(m) {
  return {
    kind: 'question',
    text: `[${labelOf(m.origins[0])}] ${m.text}`,
    options: m.options,
    urgency: 'normal',
    expiresAt: null,
    defaultOnSilence: 'hold',
    payload: {
      type: 'gating',
      key: `gating:${m.key}`,
      about: { subject: m.fact.subject, attr: m.fact.attr },
      gating: { key: m.key, origins: m.origins, briefField: m.briefField, category: m.category },
      ...(m.category ? { disclosable: false } : {}),
      mcpAnswerable: true
    }
  };
}

// Code-created gating records never charge questionsPerDay.
function createRecord(runtime, caseId, record) {
  if (typeof runtime.createQuestion === 'function') return runtime.createQuestion(caseId, record, { charge: false });
  return runtime.questions(caseId).create(record);
}

function answerValue(record) {
  const option = record.answer?.optionId ? (record.options || []).find((o) => o.id === record.answer.optionId) : null;
  return option ? option.label : String(record.answer?.text || '').trim();
}

// Writes one answered record's value into its brief field, provenance
// "user": the answer came through a question record. Only the gating set of
// fields, and only a gating record the owner answered: a playbook names the
// field, it never supplies the value.
function applyToBrief(brief, field, record) {
  if (record?.payload?.type !== 'gating') throw new Error('the record is not a gating record');
  // Every write below is provenance "user", which Brief checks against its
  // own isUserOnly (type fields included). That claim rests on this check.
  if (!record.answer || !record.answer.factId) throw new Error('the record has no owner answer');
  const answer = answerValue(record);
  if (!answer) throw new Error('the answer is empty');
  const question = String(record.text || '').replace(/^\[[^\]]*\]\s*/, '');
  if (field === 'hardConstraints') {
    brief.append('hardConstraints', `${question}: ${answer}`, { provenance: 'user' });
  } else if (field === 'alreadyTried' || field === 'successCriteria') {
    brief.append(field, answer, { provenance: 'user' });
  } else if (field === 'why') {
    const current = brief.read().data.why;
    if (typeof current === 'string' && current.trim()) throw new Error('why is already set');
    brief.update('why', answer, { provenance: 'user' });
  } else if (field === 'deadline') {
    if (!DATE_RE.test(answer)) throw new Error(`"${oneLine(answer, 80)}" is not a YYYY-MM-DD date`);
    brief.update('deadline', answer, { provenance: 'user' });
  } else {
    throw new Error(`"${oneLine(field, 40)}" cannot be written from a gating answer`);
  }
}

// → { created, unknowns, briefApplied, appliedAnswers, notes, warnings }.
// Idempotent. gatingQuestionsFor defaults to C5's (or the stand-in's).
function syncGating(runtime, caseId, { gatingQuestionsFor = caseTypes().gatingQuestionsFor, appliedAnswers = [] } = {}) {
  const meta = runtime.getCase(caseId);
  const { merged, warnings } = mergeGatingQuestions(gatingQuestionsFor(runtime, meta.id));
  const ledger = runtime.ledger(meta.id);
  let facts = ledger.view().facts;
  const store = runtime.questions(meta.id);
  let records = store.list();
  const created = [];
  const unknowns = [];
  const notes = [];

  for (const m of merged) {
    if (m.kind !== 'fact') continue;
    if (m.answerable === 'owner') {
      if (ownerSatisfied(m, facts, records)) continue;
      const mine = gatingRecords(records, m.key);
      if (mine.some((r) => !r.answer && !r.closed)) continue;
      if (mine.length && !m.required) continue;
      const rec = createRecord(runtime, meta.id, gatingRecord(m));
      if (rec && rec.id) created.push(rec.id);
      records = store.list();
    } else {
      if (otherSatisfied(m, facts)) continue;
      if (activeOn(facts, m.key).some((f) => f.provenance === 'unknown')) continue;
      const label = labelOf(m.origins[0]);
      const u = ledger.unknown({
        stmt: m.text,
        subject: m.fact.subject,
        attr: m.fact.attr,
        changes: m.changes || `Playbook gating: ${label}`,
        answerable: m.answerable,
        how: m.how || `Resolve with ${m.answerable}`,
        loadBearing: m.required,
        addedBy: `gating:${label}`
      });
      unknowns.push(u.id);
      facts = ledger.view().facts;
    }
  }

  const applied = new Set(appliedAnswers);
  const briefApplied = [];
  let brief = null;
  for (const r of store.list()) {
    if (r.payload?.type !== 'gating' || !r.answer || !r.answer.factId || applied.has(r.id)) continue;
    const field = r.payload.gating?.briefField;
    if (!field) continue;
    applied.add(r.id);
    // The value is the owner's answer fact, not the record's own text.
    const fact = ownerAnswerFact(r, facts);
    if (!fact) {
      notes.push(`${r.id}: not written to the brief's ${oneLine(field, 40)} (its fact is not the owner's answer to ${r.id}).`);
      continue;
    }
    try {
      brief = brief || runtime.brief(meta.id);
      applyToBrief(brief, field, { ...r, answer: { ...r.answer, text: String(fact.value ?? ''), optionId: null } });
      briefApplied.push(r.id);
    } catch (err) {
      notes.push(`${r.id}: the answer was kept as a fact but not written to the brief's ${field} (${err.message}).`);
    }
  }

  // Required questions added while active do not refuse anything; the owner
  // is told once per set of keys.
  if (meta.status === 'active') {
    const pending = pendingFrom(merged, facts, store.list());
    if (pending.length) {
      const keys = pending.map((p) => p.key).sort();
      const key = `gating-pending:${keys.join(',')}`;
      if (!store.list().some((r) => r.payload?.key === key)) {
        createRecord(runtime, meta.id, {
          kind: 'briefing',
          urgency: 'low',
          text: `${meta.title}: required gating questions are waiting for your answer (${keys.join(', ')}).`,
          payload: { type: 'gating-pending', key, mcpAnswerable: false }
        });
      }
    }
  }

  return { created, unknowns, briefApplied, appliedAnswers: [...applied], notes, warnings };
}

// Required, owner-answerable, fact-backed questions not yet satisfied.
function pendingGating(runtime, caseId, { gatingQuestionsFor = caseTypes().gatingQuestionsFor } = {}) {
  const meta = runtime.getCase(caseId);
  const { merged } = mergeGatingQuestions(gatingQuestionsFor(runtime, meta.id));
  return pendingFrom(merged, runtime.ledger(meta.id).view().facts, runtime.questions(meta.id).list());
}

function gatingRefusal(pending) {
  return new BriefError(`Gating pass incomplete; playbook questions still unanswered: ${pending.map((p) => p.recordId || p.key).join(', ')}.`);
}

// The one gating source for playbooks, registered once per registry (C5's
// registry is process-wide). It reads each runtime's own manager.
const registeredWith = new WeakSet();
function ensurePlaybookGatingSource(registry = caseTypes()) {
  if (registeredWith.has(registry)) return false;
  registry.registerGatingSource(
    (runtime, id) => (runtime && runtime.playbooks && typeof runtime.playbooks.gatingQuestions === 'function'
      ? runtime.playbooks.gatingQuestions(id)
      : []),
    { origin: 'playbooks' }
  );
  registeredWith.add(registry);
  return true;
}

module.exports = {
  SENSITIVITY,
  MAX_TEXT,
  MAX_NOTE,
  GATING_BRIEF_FIELDS,
  labelOf,
  keyOf,
  playbookGatingQuestions,
  mergeGatingQuestions,
  syncGating,
  pendingGating,
  gatingRefusal,
  applyToBrief,
  ensurePlaybookGatingSource
};
