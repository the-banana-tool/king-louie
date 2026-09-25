// src/cases/executors/submit.js
// Executor.submit (cases stage 3 spec §3.5). The first failing check
// returns { ok: false, … }; nothing leaves before the outbound gate, the
// envelope and the caps all pass. submitJob never throws.
const { createLogger } = require('../../logging');
const { canonicalize } = require('../../platform/jcs');
const { JobStore, TERMINAL_STATES } = require('./job-store');
const { EnvelopeStore, envelopeFit } = require('./envelope');
const { PlanStore } = require('./plan');
const { normalizeRecipient, recipientChannel } = require('./normalize');
const { gateLeaves } = require('../gates');
const { DIRECT_TOOLS } = require('./builtins');
const { parseJsonObject, sha256hex, windowInstants, roundUsd } = require('./util');
const { jobSignature, findDuplicateJob } = require('./duplicates');
const jobs = require('./jobs');
const envelopeOps = require('./envelope-ops');
const kinds = require('./kinds');

const log = createLogger('executors/submit');
const EXTERNAL_KEYS = ['recipients', 'text', 'facts', 'attemptsPerContact', 'expect'];
const KIND_KEYS = {
  browser: ['url', 'fields', 'submit', 'waitFor', 'login'],
  workflow: ['tasks'],
  runbook: ['runbook', 'params'],
  owner: ['text']
};
const TASK_ID = /^[A-Za-z0-9_-]{1,40}$/;
const fail = (error) => ({ ok: false, error });
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function validatePayload(entry, kind, p) {
  const allowed = kind === 'external' ? [...EXTERNAL_KEYS, ...Object.keys(entry.payloadSchema || {})] : (KIND_KEYS[kind] || []);
  const unknown = Object.keys(p).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    const names = unknown.map((k) => `"${k}"`).join(', ');
    return `payload field${unknown.length > 1 ? 's' : ''} ${names} ${unknown.length > 1 ? 'are' : 'is'} not accepted by ${entry.id}${kind === 'external' ? ' (not in its payloadSchema)' : ''}`;
  }
  if (kind === 'external') {
    if (!Array.isArray(p.recipients) || !p.recipients.length) return 'payload.recipients must list at least one { address, name? }';
    for (const r of p.recipients) {
      if (!isObj(r) || !isStr(r.address) || Object.keys(r).some((k) => k !== 'address' && k !== 'name') || (r.name !== undefined && typeof r.name !== 'string')) {
        return 'each payload.recipients entry is { address, name? }';
      }
    }
    if (!isStr(p.text)) return 'payload.text is required';
    if (p.facts !== undefined && (!Array.isArray(p.facts) || !p.facts.every((f) => typeof f === 'string'))) return 'payload.facts must be a list of fact ids';
    if (p.attemptsPerContact !== undefined && (!Number.isInteger(p.attemptsPerContact) || p.attemptsPerContact < 1)) return 'payload.attemptsPerContact must be a whole number ≥ 1';
    if (p.expect !== undefined && (!Array.isArray(p.expect) || !p.expect.every((e) => isObj(e) && isStr(e.subject) && isStr(e.attr) && isStr(e.question)))) {
      return 'payload.expect must be a list of { subject, attr, question }';
    }
    for (const [field, spec] of Object.entries(entry.payloadSchema || {})) {
      if (p[field] === undefined) continue;
      const type = spec && spec.type ? spec.type : 'string';
      if (!['string', 'number', 'boolean'].includes(typeof p[field]) || typeof p[field] !== type) return `payload.${field} must be a ${type}`;
    }
    return null;
  }
  if (kind === 'browser') {
    if (!isStr(p.url)) return 'payload.url is required';
    if (!Array.isArray(p.fields) || !p.fields.every((f) => isObj(f) && isStr(f.selector) && typeof f.value === 'string')) return 'payload.fields must be a list of { selector, value }';
    if (!isObj(p.submit) || !isStr(p.submit.selector)) return 'payload.submit must be { selector }';
    if (p.waitFor !== undefined && !isStr(p.waitFor)) return 'payload.waitFor must be a selector';
    if (p.login !== undefined && p.login !== true) return 'payload.login may only be true';
    return null;
  }
  if (kind === 'workflow') {
    if (!Array.isArray(p.tasks) || !p.tasks.length) return 'payload.tasks must list at least one task';
    for (const t of p.tasks) {
      if (!isObj(t) || !TASK_ID.test(String(t.id)) || !isStr(t.title) || typeof t.description !== 'string'
        || (t.dependsOn !== undefined && (!Array.isArray(t.dependsOn) || !t.dependsOn.every((d) => typeof d === 'string')))) {
        return 'each task is { id, title, description, dependsOn? }';
      }
    }
    return null;
  }
  if (kind === 'runbook') {
    if (!isStr(p.runbook)) return 'payload.runbook is required';
    if (p.params !== undefined && !isObj(p.params)) return 'payload.params must be an object';
    return null;
  }
  if (kind === 'owner') return isStr(p.text) ? null : 'payload.text is required';
  return `${entry.id} does not take jobs`;
}

function intentOf(payload, envelope) {
  if (envelope && envelope.intent) return envelope.intent;
  const first = (s) => String(s || '').split('\n')[0].trim();
  return first(payload.text) || first(payload.url) || first(payload.runbook) || first(payload.tasks?.[0]?.title) || '';
}

function estimateFor(entry, kind, recipients, attempts) {
  const c = entry.cost || {};
  const base = Number(c.perJob) || 0;
  if (kind !== 'external') return roundUsd(base);
  return roundUsd(base + recipients.length * ((Number(c.perContact) || 0) + (Number(c.perAttempt) || 0) * attempts));
}

// Why a declared fact may not be sent, or null (same checks as envelopeFit).
function factProblem(f) {
  if (!f) return 'missing';
  if (f.status !== 'active') return f.status;
  if (f.provenance === 'inferred') return 'inferred';
  if (f.provenance === 'unknown') return 'unknown';
  if (!f.disclosable) return 'not disclosable';
  return null;
}

async function submitJob(reg, ctx = {}, params = {}) {
  try {
    return await submitChecked(reg, ctx || {}, params || {});
  } catch (err) {
    log.warn(`Executor submit in ${ctx?.caseId} failed: ${err && err.message}`);
    return fail(`Executor submit failed: ${err && err.message ? err.message : String(err)}`);
  }
}

async function submitChecked(reg, ctx, params) {
  const { caseId, turnId = null } = ctx;
  const rt = reg.caseRuntime;
  const meta = rt.getCase(caseId);
  const dir = meta.dir;
  const settings = reg.settings();
  const now = reg.now();

  // 2. The executor.
  const entry = reg.get(params.executor, { caseId });
  if (!entry) return fail(`unknown executor "${params.executor}"`);
  if (entry.direct) return fail(`${entry.id} is done with its own tools in this turn (${DIRECT_TOOLS[entry.id] || 'its own tools'})`);
  if (!entry.available) return fail(`${entry.id} is unavailable: ${entry.reason}`);
  const kind = jobs.kindOf(entry);

  // 3. The payload.
  const parsed = parseJsonObject(params.payload, 'payload');
  if (!parsed.ok) return fail(parsed.error);
  const payload = parsed.value;
  const bad = validatePayload(entry, kind, payload);
  if (bad) return fail(bad);

  // 4. The plan step, and owner consent (R41).
  let step = null;
  if (params.planStepId) {
    const plan = new PlanStore(dir).read();
    if (!plan || plan.status !== 'approved') return fail(`there is no approved plan with step ${params.planStepId}`);
    step = (plan.steps || []).find((s) => s.id === params.planStepId) || null;
    if (!step) return fail(`step ${params.planStepId} is not in ${plan.id}`);
    if (step.executor !== entry.id) return fail(`step ${step.id} runs on ${step.executor}, not ${entry.id}`);
    if (step.state === 'done' || step.state === 'cancelled') return fail(`step ${step.id} is already ${step.state}`);
    if (entry.id === 'owner' && !String(step.check?.consent || '').startsWith('recorded:')) {
      return fail(`the owner has not agreed to do ${step.capability}; plan it onto another executor or ask`);
    }
  } else if (entry.id === 'owner') {
    return fail('the owner has not agreed to do this work; plan it onto another executor or ask');
  }
  const pre = kinds.precheck(reg, caseId, entry, kind, payload);
  if (pre) return fail(pre);

  // 5. Recipients (spec §3.8), through the same normalizeRecipient call the
  // envelope request used, so the fit compares like with like. The browser
  // recipient is the origin of its url.
  let recipients = [];
  if (kind === 'external' || kind === 'browser') {
    const channel = recipientChannel(entry.capabilities);
    const addresses = kind === 'external' ? payload.recipients.map((r) => r.address) : [payload.url];
    for (const address of addresses) {
      const n = normalizeRecipient(address, { channel, defaultCountryCode: settings.defaultCountryCode });
      if (!n.ok) return fail(n.error);
      if (!recipients.includes(n.value)) recipients.push(n.value);
    }
  }

  // needs-direction: only a retry of a finished job's unanswered contacts,
  // and only when the owner's autonomy allows it.
  const store = new JobStore(dir);
  const retryOf = params.retryOf ? store.get(params.retryOf) : null;
  if (params.retryOf && !retryOf) return fail(`${params.retryOf} was not found in this case`);
  if (meta.status === 'needs-direction') {
    if (!rt.autonomyAllows(caseId, 'retry-within-envelope')) {
      return fail('in needs-direction a job may be submitted only when the owner allows retries within the envelope');
    }
    if (!retryOf || !TERMINAL_STATES.includes(retryOf.state) || retryOf.executor !== entry.id || (retryOf.envelopeId || null) !== (params.envelopeId || null)) {
      return fail('in needs-direction only a retry of a finished job in the same envelope may be submitted; name it in retryOf');
    }
    const retryable = new Set((retryOf.contacts || [])
      .filter((c) => c && (c.state === 'no-answer' || c.state === 'voicemail'))
      .map((c) => c.normalizedAddress || c.address));
    if (!recipients.length || recipients.some((r) => !retryable.has(r))) {
      return fail(`a retry may call only ${retryOf.id}'s no-answer and voicemail contacts`);
    }
  }

  // The envelope, when one is named: it must be this executor's.
  const envelope = params.envelopeId ? new EnvelopeStore(dir).get(params.envelopeId) : null;
  if (params.envelopeId && !envelope) return fail(`${params.envelopeId} was not found in this case`);
  if (envelope && envelope.executor !== entry.id) return fail(`${envelope.id} is for ${envelope.executor}, not ${entry.id}`);

  // 6. Duplicates (R36): refused in this case, noted across cases.
  const intent = intentOf(payload, envelope);
  const signature = jobSignature(entry.id, { kind: entry.kind, recipients, intent });
  const dup = findDuplicateJob({
    executorId: entry.id,
    job: { kind: entry.kind, recipients, intent, signature },
    liveJobs: reg.liveState({ caseId }).filter((r) => r.jobId !== params.retryOf)
  });
  if (dup) return fail(`this duplicates ${dup.jobId} (${dup.state}); wait for it or cancel it`);
  const notes = [];
  for (const row of reg.liveState()) {
    if (row.caseId === caseId || row.executorId !== entry.id || !row.recipients.some((r) => recipients.includes(r))) continue;
    let title = row.caseId;
    try {
      title = rt.getCase(row.caseId).title;
    } catch {
      title = row.caseId;
    }
    const note = `also contacted by case "${title}" (${row.caseId})`;
    if (!notes.includes(note)) notes.push(note);
  }

  // 7. Detour gate (C5), once per new job.
  if (!retryOf && typeof rt.detourGate === 'function') {
    const g = await rt.detourGate(caseId, { source: 'executor', serves: params.serves || step?.serves || '', text: intent, turnId });
    if (g && g.ok === false) return { ...g, ok: false, error: g.error || 'refused by the detour gate' };
    if (g && g.note) notes.push(g.note);
  }

  // 8. The outbound gate over every leaf (R38). An external agent's payload
  // leaves the node whatever its `outbound` mode, so with 'none' it still
  // takes the value rules ('query').
  const facts = rt.ledger(caseId).view().facts;
  let rendered = payload;
  let gateBlocked = [];
  const mode = entry.outbound !== 'none' ? entry.outbound : (kind === 'external' ? 'query' : null);
  if (mode) {
    const gl = gateLeaves(payload, {
      recipients, envelope, facts, mode, caseId,
      entityIndex: typeof rt.entityIndex === 'function' ? rt.entityIndex() : null, categoryKeywords: settings.outbound.categoryKeywords
    });
    const hard = gl.blocked.filter((b) => b.reason !== 'not-in-envelope');
    if (hard.length) {
      return {
        ok: false,
        error: 'blocked by the outbound gate',
        blocked: hard.map((b) => ({ path: b.path, text: b.span.text, reason: b.reason, ...(b.factId ? { factId: b.factId } : {}), detail: b.detail }))
      };
    }
    gateBlocked = gl.blocked.filter((b) => b.reason === 'not-in-envelope');
    rendered = gl.rendered;
  }

  // 9. Envelope fit (§3.6), whenever the executor needs an envelope or one
  // is named. `signed` (the higher of the recorded and current authority)
  // also needs the phone grant.
  const attempts = Number(payload.attemptsPerContact) || 1;
  const estimateUsd = estimateFor(entry, kind, recipients, attempts);
  if (entry.authority !== 'none' && !envelope) return fail(`${entry.id} needs an approved envelope; request one with action "envelope"`);
  if (envelope) {
    const fit = envelopeFit(envelope, payload, { facts, recipients, now, estimateUsd, gateBlocked, executorId: entry.id });
    if (fit.refusals.length) return fail(`outside envelope ${envelope.id}: ${fit.refusals.join('; ')}`);
    if (fit.deltas.length) {
      const questionId = envelopeOps.requestDelta(reg, caseId, envelope, fit.deltas);
      const texts = fit.deltas.map((d) => d.text);
      return { ok: false, needsApproval: true, deltas: texts, questionId, error: `the owner must approve: ${texts.join('; ')}` };
    }
    if (envelopeOps.effectiveAuthority(reg, caseId, envelope) === 'signed') {
      const v = envelopeOps.verifyEnvelopeGrant(reg, caseId, envelope);
      if (!v.ok) return fail(v.error);
    }
  } else {
    if (gateBlocked.length) return fail('blocked by the outbound gate: a fact outside the envelope');
    for (const id of Array.isArray(payload.facts) ? payload.facts : []) {
      const why = factProblem(facts.get(id));
      if (why) return fail(`${id} cannot be disclosed (${why})`);
    }
  }

  // 10. Caps: the case budget, the case's contacts today, the global cap.
  const budget = rt.budget(caseId);
  const remUsd = budget.remaining('usd');
  if (remUsd !== null && remUsd < estimateUsd) return fail(`estimate $${estimateUsd.toFixed(2)} exceeds the case's remaining $${remUsd.toFixed(2)}`);
  const known = new Set(envelope?.usage?.contacts || []);
  const newContacts = recipients.filter((r) => !known.has(r)).length;
  const remContacts = budget.remaining('contactsPerDay');
  if (newContacts && remContacts !== null && remContacts < newContacts) return fail(`the case has ${remContacts} contacts left today; this job needs ${newContacts}`);
  let reserved = 0;
  if (newContacts) {
    const res = await reg.reserveContacts(entry.id, newContacts, { caseId });
    if (!res.ok) return fail(res.error);
    reserved = newContacts;
  }

  // 11. The job, in `submitting`, then the executor.
  let job;
  try {
    let n = null;
    if (envelope) {
      n = (Number(envelope.nextN) || (envelope.payloads || []).length) + 1;
      const envelopes = new EnvelopeStore(dir);
      const fresh = envelopes.get(envelope.id);
      fresh.nextN = n;
      envelopes.write(fresh);
    }
    const maxCosts = [envelope ? roundUsd(envelope.caps.usd - (Number(envelope.usage?.usd) || 0)) : null, remUsd].filter((x) => x !== null);
    job = store.create({
      caseId, executor: entry.id, kind, envelopeId: envelope ? envelope.id : null, planStepId: step ? step.id : null, retryOf: params.retryOf || null,
      n, signature, payloadHash: sha256hex(canonicalize(rendered)), intent, state: 'submitting', recipients,
      payload: rendered, originalPayload: payload, createdAt: now.toISOString(), estimateUsd, reservedContacts: reserved, newContacts,
      facts: (Array.isArray(payload.facts) ? payload.facts : []).map((id) => {
        const f = facts.get(id);
        return f ? { id, stmt: f.stmt, value: f.value } : { id, stmt: '', value: null };
      }),
      window: envelope ? { ...windowInstants(envelope.window.start, envelope.window.end, envelope.window.tz), tz: envelope.window.tz } : null,
      maxCostUsd: maxCosts.length ? Math.max(0, Math.min(...maxCosts)) : null
    });
    job.idempotencyKey = sha256hex(canonicalize(envelope ? { caseId, envelopeId: envelope.id, n } : { caseId, jobId: job.id }));
    store.write(job);
    await reg.indexJob(caseId, job);
  } catch (err) {
    // No job holds the reservation yet (or its file cannot be trusted to).
    if (reserved && !job) await reg.releaseContacts(entry.id, reserved, { caseId });
    if (job) await kinds.failJob(reg, caseId, job, `could not be written: ${err.message}`);
    throw err;
  }

  const key = `${caseId}/${job.id}`;
  reg.inFlight.add(key);
  try {
    const args = { entry, job, envelope, step, notes };
    if (kind === 'external') return await kinds.submitExternal(reg, ctx, args);
    if (kind === 'browser') return await kinds.submitBrowser(reg, ctx, args);
    if (kind === 'runbook') return await kinds.submitRunbook(reg, ctx, args);
    if (kind === 'workflow') return await kinds.submitWorkflow(reg, ctx, args);
    if (kind === 'owner') return await kinds.submitOwner(reg, ctx, args);
    await kinds.failJob(reg, caseId, job, `${entry.id} does not take jobs`);
    return fail(`${entry.id} does not take jobs`);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    log.warn(`Submitting ${job.id} to ${entry.id} in ${caseId} failed: ${message}`);
    try {
      await kinds.failJob(reg, caseId, job, message);
    } catch (e) {
      log.warn(`Failing ${job.id} after its submit error failed too: ${e.message}`);
    }
    return { ok: false, error: `${entry.id} could not take ${job.id}: ${message}`, jobId: job.id };
  } finally {
    reg.inFlight.delete(key);
  }
}

module.exports = { submitJob, validatePayload, estimateFor, intentOf };
