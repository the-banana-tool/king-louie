// src/cases/executors/results.js
// Executor.status, Executor.results and Executor.draft (cases stage 3 spec
// §3.5). Results are the only path that writes external-agent facts (R40).
const fs = require('fs');
const path = require('path');
const { FactLedger } = require('../ledger');
const { gateLeaves } = require('../gates');
const { JobStore, readSnapshot } = require('./job-store');
const { EnvelopeStore } = require('./envelope');
const { valueKey } = require('./normalize');
const { valueText, cut } = require('./util');
const jobs = require('./jobs');
const { createLogger } = require('../../logging');

const log = createLogger('executors/results');

const FACTS_BLOCK = /```facts\s*\n([\s\S]*?)```/g;
const RECORD_ID = /^[A-Za-z0-9_.-]{1,80}$/;
const MAX_PAGES = 20;
const fail = (error) => ({ ok: false, error });
const keyOf = (subject, attr) => `${String(subject).trim().toLowerCase()}|${String(attr).trim().toLowerCase()}`;
// Adapter text is cut before it reaches the model, as jobs.js cuts it before
// a job or the journal (300 characters).
const MAX_TEXT = 300;
const MAX_RULES = 20;
// A hostile or broken adapter cannot flood the ledger: facts per record and
// per results call are capped.
const MAX_INPUTS_PER_RECORD = 20;
const MAX_FACTS_PER_CALL = 200;
const clip = (text) => (text === undefined || text === null ? text : cut(String(text), MAX_TEXT));

// A value an adapter reported, bounded: strings cut, a list or object whose
// JSON runs past MAX_TEXT kept as its cut JSON text.
function boundValue(value) {
  if (typeof value === 'string') return clip(value);
  if (value && typeof value === 'object') {
    const json = JSON.stringify(value);
    return json.length > MAX_TEXT ? clip(json) : value;
  }
  return value;
}

// A record's time as ISO 8601, or null when it does not parse.
function isoOrNull(value) {
  const d = new Date(typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function boundInput(input) {
  const out = { ...input };
  for (const k of ['stmt', 'subject', 'attr', 'unit', 'category']) if (typeof out[k] === 'string') out[k] = clip(out[k]);
  if ('value' in out) out.value = boundValue(out.value);
  return out;
}

async function jobStatus(reg, { caseId } = {}, { jobId } = {}) {
  await jobs.copyBackgroundOutput(reg, caseId);
  await jobs.refreshCase(reg, caseId, { force: true, jobIds: jobId ? [jobId] : null });
  const list = reg.jobs(caseId).list().filter((j) => !jobId || j.id === jobId);
  if (jobId && !list.length) return fail(`${jobId} was not found in this case.`);
  const snapshot = readSnapshot(reg.caseDir(caseId));
  return {
    ok: true,
    jobs: list.map((j) => ({
      jobId: j.id, executor: j.executor, state: j.state, stale: Boolean(j.stale),
      ...(j.stale ? { staleSince: clip(snapshot[j.executor]?.fetchedAt || null), error: clip(j.error) } : {}),
      lastChange: clip(j.lastChange), contacts: jobs.capContacts(j.contacts), planStepId: j.planStepId, envelopeId: j.envelopeId, reason: clip(j.reason)
    }))
  };
}

// An executor's value never supersedes an active user or sourced fact on the
// same (subject, attr); a differing value becomes a load-bearing conflict.
function assertExternal(ledger, input, { executor, rel, record, turnId }) {
  const { facts } = ledger.view();
  const k = keyOf(input.subject, input.attr);
  const same = [...facts.values()].filter((f) => f.status === 'active' && keyOf(f.subject, f.attr) === k);
  const owned = same.find((f) => f.provenance === 'user' || f.provenance === 'sourced');
  const earlier = same.find((f) => f.provenance === 'external-agent');
  const fields = {
    stmt: clip(input.stmt || `${executor} reported ${valueText(input.value)}`),
    subject: input.subject,
    attr: input.attr,
    value: input.value ?? null,
    unit: input.unit || null,
    category: input.category || null,
    provenance: 'external-agent',
    source: { kind: record.kind === 'call' || record.kind === 'voicemail' ? 'call' : 'api', ref: rel, at: record.at || null },
    addedBy: turnId || null
  };
  if (owned && valueKey(owned.value) !== valueKey(input.value)) {
    const fact = ledger.assert(fields);
    const unknown = ledger.unknown({
      stmt: `Conflict: ${owned.stmt} vs ${executor} reported ${valueText(input.value)}${input.unit ? ` ${input.unit}` : ''}`,
      subject: input.subject, attr: input.attr, changes: 'which value is true', answerable: 'owner', how: 'ask the owner or re-source',
      loadBearing: true, addedBy: turnId || null
    });
    return { fact, conflict: { factId: owned.id, reported: input.value ?? null, reportedFactId: fact.id, unknownId: unknown.id } };
  }
  return { fact: ledger.assert({ ...fields, ...(earlier && !owned ? { supersedes: earlier.id } : {}) }) };
}

// An adapter's fact inputs for one record: at most MAX_INPUTS_PER_RECORD,
// each an object with a non-blank string subject and attr. A throwing
// recordToFacts falls back to the record summary.
function recordInputs(adapter, record, job, recordId) {
  let inputs = [{
    stmt: `${job.executor} reported: ${record.summary || JSON.stringify(record)}`,
    subject: `job:${job.id}`, attr: `record-${recordId}`, value: record.outcome || record.summary || null
  }];
  if (typeof adapter.recordToFacts === 'function') {
    try {
      const mapped = adapter.recordToFacts(record, job);
      inputs = Array.isArray(mapped) ? mapped : [];
    } catch (err) {
      log.warn(`${job.executor} recordToFacts failed on ${job.id}/${recordId}; keeping the record summary: ${clip(err && err.message ? err.message : err)}`);
    }
  }
  if (inputs.length > MAX_INPUTS_PER_RECORD) {
    log.warn(`${job.executor} gave ${inputs.length} facts for ${job.id}/${recordId}; keeping the first ${MAX_INPUTS_PER_RECORD}`);
  }
  return inputs.slice(0, MAX_INPUTS_PER_RECORD);
}

const isText = (v) => typeof v === 'string' && v.trim() !== '';

async function externalResults(reg, { caseId, turnId }, job, store) {
  const dir = reg.caseDir(caseId);
  const adapter = await reg.adapter(job.executor);
  const ledger = new FactLedger(dir, { executorIds: new Set(reg.ids()) });
  const saved = [];
  const asserted = [];
  const conflicts = [];
  let more = false;
  let cursor = job.resultsCursor || null;
  pages: for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await adapter.results(job.externalId, cursor ? { after: cursor } : {});
    const records = Array.isArray(res?.records) ? res.records : [];
    for (const record of records) {
      const recordId = String(record?.id ?? '');
      if (!RECORD_ID.test(recordId)) continue;
      if ((job.recordsSaved || []).includes(recordId)) {
        cursor = recordId;
        continue;
      }
      const inputs = recordInputs(adapter, record, job, recordId);
      // The per-call cap: a record that does not fit waits, unsaved, for the
      // next call (the saved cursor still points before it).
      if (asserted.length + inputs.length > MAX_FACTS_PER_CALL) {
        more = true;
        break pages;
      }
      cursor = recordId;
      const rel = `sources/${job.executor}/${job.id}/${recordId}.json`;
      const file = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(record, null, 2));
      const at = isoOrNull(record.at);
      for (const raw of inputs) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isText(raw.subject) || !isText(raw.attr)) {
          log.warn(`${job.executor} gave a fact without a subject and attr for ${job.id}/${recordId}; skipped`);
          continue;
        }
        try {
          const r = assertExternal(ledger, boundInput(raw), { executor: job.executor, rel, record: { kind: record.kind, at }, turnId });
          asserted.push(r.fact.id);
          if (r.conflict) conflicts.push(r.conflict);
        } catch (err) {
          log.warn(`A fact from ${job.executor} for ${job.id}/${recordId} was not recorded: ${clip(err && err.message ? err.message : err)}`);
        }
      }
      // Saved even when inputs were skipped, so a retry never asserts this
      // record's facts (or its conflict unknowns) twice.
      job.recordsSaved = [...(job.recordsSaved || []), recordId];
      job.resultsCursor = recordId;
      store.write(job);
      saved.push(rel);
    }
    if (!res?.next || !records.length) break;
    cursor = res.next;
  }
  const notes = [
    ...(conflicts.length ? ['Some reports contradict facts you hold; each is recorded as a load-bearing unknown for the owner.'] : []),
    ...(more ? [`More results are waiting (at most ${MAX_FACTS_PER_CALL} facts per call); call results again.`] : [])
  ];
  return {
    ok: true, jobId: job.id, state: job.state, saved, facts: asserted, conflicts,
    ...(more ? { more: true } : {}),
    ...(notes.length ? { note: notes.join(' ') } : {})
  };
}

function workflowResults(reg, caseId, job) {
  const rel = `sources/workflow/${job.id}`;
  const base = path.join(reg.caseDir(caseId), 'sources', 'workflow', job.id);
  if (!fs.existsSync(base)) return { ok: true, jobId: job.id, state: job.state, files: [], proposedFacts: [], note: 'The research has not finished yet.' };
  const files = fs.readdirSync(base).filter((n) => n.endsWith('.md')).sort();
  const proposedFacts = [];
  for (const name of files) {
    const sourceRef = `${rel}/${name}`;
    const text = fs.readFileSync(path.join(base, name), 'utf8');
    for (const m of text.matchAll(FACTS_BLOCK)) {
      try {
        const list = JSON.parse(m[1]);
        if (Array.isArray(list)) for (const f of list) if (f && typeof f === 'object' && !Array.isArray(f)) proposedFacts.push({ ...f, sourceRef });
      } catch {
        proposedFacts.push({ error: 'unreadable facts block', sourceRef });
      }
    }
  }
  return {
    ok: true, jobId: job.id, state: job.state, files: files.map((n) => `${rel}/${n}`), proposedFacts,
    note: 'Proposed facts are not asserted. Check each source, then assert what you accept with the Ledger tool.'
  };
}

async function fetchResults(reg, { caseId, turnId = null } = {}, { jobId } = {}) {
  if (!jobId) return fail('results needs "jobId".');
  const dir = reg.caseDir(caseId);
  const store = new JobStore(dir);
  let job = store.get(jobId);
  if (!job) return fail(`${jobId} was not found in this case.`);
  const snap = readSnapshot(dir)[job.executor];
  if (job.stale || snap?.stale) {
    return fail(`${job.executor} is unreachable since ${snap?.fetchedAt || job.lastPolledAt || 'its first poll'}; results cannot be trusted until it answers`);
  }
  await jobs.copyBackgroundOutput(reg, caseId);
  job = store.get(jobId);
  if (job.kind === 'external') {
    if (!job.externalId) return fail(`${jobId} was never accepted by ${job.executor}.`);
    return externalResults(reg, { caseId, turnId }, job, store);
  }
  if (job.kind === 'workflow') return workflowResults(reg, caseId, job);
  if (job.kind === 'runbook') {
    const base = path.join(dir, 'sources', 'runbook', job.id);
    const files = fs.existsSync(base) ? fs.readdirSync(base).sort().map((n) => `sources/runbook/${job.id}/${n}`) : [];
    return { ok: true, jobId, state: job.state, files };
  }
  if (job.kind === 'browser') return { ok: true, jobId, state: job.state, source: `sources/browser/${job.id}.md` };
  if (job.kind === 'owner') {
    const q = job.questionId ? reg.caseRuntime.questions(caseId).get(job.questionId) : null;
    return { ok: true, jobId, state: job.state, factId: job.resultFactId || q?.answer?.factId || null };
  }
  return fail(`${jobId} has no results.`);
}

// Executor.draft: a `draft` role call writes the text; nothing is sent.
async function draftPayload(reg, { caseId } = {}, { executor, envelopeId = null, instructions = '' } = {}) {
  const rt = reg.caseRuntime;
  const entry = reg.get(executor, { caseId });
  if (!entry) return fail(`unknown executor "${executor}"`);
  const envelope = envelopeId ? new EnvelopeStore(reg.caseDir(caseId)).get(envelopeId) : null;
  if (envelopeId && !envelope) return fail(`${envelopeId} was not found in this case.`);
  const turn = rt.turns.get(caseId);
  if (!turn) return fail('No case turn is running for this case; draft runs inside a case turn.');
  if (entry.kind === 'external-agent') {
    try {
      await reg.adapter(executor);
    } catch {
      // brief rules then come from the override and extra sources only
    }
  }
  const facts = rt.ledger(caseId).view().facts;
  const allowed = envelope
    ? envelope.facts
    : [...facts.values()].filter((f) => f.status === 'active' && f.disclosable && (f.provenance === 'user' || f.provenance === 'sourced')).map((f) => f.id);
  const rules = reg.briefRules(executor, { caseId }).slice(0, MAX_RULES).map(clip);
  const prompt = [
    `Draft the text ${executor} will say or send. Reply with the text only.`,
    `Intent: ${envelope?.intent || '(none given)'}`,
    'Quote facts only as {{f-…}} references from the list below. State no date, price, deadline or promise that no listed fact backs. Say nothing else about the owner.',
    ...(envelope?.rules?.length ? ['Owner rules:', ...envelope.rules.map((r) => `- ${r}`)] : []),
    ...(rules.length ? ['Executor rules:', ...rules.map((r) => `- ${r}`)] : []),
    'Facts you may reference:',
    ...(allowed.length ? allowed.map((id) => `- {{${id}}}: ${facts.get(id)?.stmt || ''}`) : ['- none']),
    ...(instructions ? ['Instructions:', String(instructions)] : [])
  ].join('\n');
  const provider = rt.routedProvider(turn, { role: 'draft' });
  const started = Date.now();
  const result = await provider.sendMessage([{ role: 'user', content: prompt }], {});
  const payloadText = typeof result === 'string' ? result : String(result?.content ?? '');
  const metrics = result && typeof result === 'object' ? result.llmMetrics : null;
  const event = {
    provider: provider.getProviderName(),
    model: provider.getDefaultModel(),
    inputTokens: Number(metrics?.inputTokens) || Math.ceil(prompt.length / 4),
    outputTokens: Number(metrics?.outputTokens) || Math.ceil(payloadText.length / 4),
    ...(Number.isFinite(metrics?.costUsd) ? { costUsd: metrics.costUsd } : {}),
    durationMs: Date.now() - started
  };
  const tracker = reg.getUsageTracker();
  const recorded = tracker && typeof tracker.record === 'function'
    ? tracker.record(event)
    : { ...event, totalTokens: event.inputTokens + event.outputTokens, cost: Number.isFinite(event.costUsd) ? event.costUsd : null };
  rt.usageHook(turn)(recorded);
  const settings = reg.settings();
  const gate = gateLeaves({ text: payloadText }, {
    recipients: envelope?.recipients?.allow || [], envelope, facts, mode: entry.outbound === 'none' ? 'message' : entry.outbound, caseId,
    entityIndex: typeof rt.entityIndex === 'function' ? rt.entityIndex() : null, categoryKeywords: settings.outbound.categoryKeywords
  });
  return {
    ok: true,
    payloadText,
    gate: {
      ok: gate.ok,
      blocked: gate.blocked.map((b) => ({ text: b.span.text, reason: b.reason, ...(b.factId ? { factId: b.factId } : {}), detail: b.detail })),
      rendered: gate.rendered.text
    }
  };
}

module.exports = { jobStatus, fetchResults, assertExternal, draftPayload };
