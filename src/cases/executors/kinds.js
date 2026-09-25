// src/cases/executors/kinds.js
// How each kind of executor takes a job (cases stage 3 spec §3.5 "Per
// kind"). The job exists in `submitting` before these run. Each returns a
// result, never throws for an executor's answer; submitJob catches the rest.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
const jobs = require('./jobs');
const { normalizeRecipient } = require('./normalize');
const { writeJsonAtomic, cut, CASES_BROWSER_PROFILE } = require('./util');

const log = createLogger('executors/kinds');
const TIMEOUT = Symbol('timeout');
const OTHER_PROFILE = 'the browser is open with another profile; close it or retry';
const MAY_HAVE_BEEN_SENT = 'the form may have been sent';
// Ruling M17: a login runs in this named browser profile (CASES_BROWSER_PROFILE),
// so the vault key fill_credentials reads is `kl-cases@<host>`.
const TASK_ID = /^[A-Za-z0-9_-]{1,40}$/;
const FAILED_STATES = new Set(['failed', 'cancelled', 'unreachable']);
// Executor-sourced text is cut before the model sees it.
const clip = (text) => cut(String(text ?? ''), 300);

// Fails a job that is still `submitting`: nothing charged, its contact
// reservation released only while it is still `submitting` on disk.
async function failJob(reg, caseId, job, reason, options = {}) {
  return jobs.failSubmit(reg, caseId, job, {}, reason, options);
}

// Refusals that must come before a job is written.
function precheck(reg, caseId, entry, kind, payload) {
  if (kind === 'runbook') {
    const engine = reg.getRunbookEngine();
    if (!engine) return 'runbook is unavailable: no runbook engine on this node';
    const rb = engine.getRunbook(payload.runbook);
    if (!rb) return `no runbook named "${payload.runbook}" on this node`;
    if (rb.tier === 'unsafe') return 'unsafe runbooks are not available to cases';
    try {
      engine.validateParameters(payload.runbook, payload.params || {});
    } catch (err) {
      return err.message;
    }
    const rate = engine.checkRateLimit(payload.runbook);
    if (rate && rate.allowed === false) return `runbook ${payload.runbook} is rate limited; retry after ${rate.retryAfterSeconds}s`;
  }
  if (kind === 'workflow' && !reg.getWorkflowEngine()) return 'workflow is unavailable: no workflow engine on this node';
  return null;
}

const withNote = (result, notes) => {
  const all = [result.note, ...(notes || [])].filter(Boolean);
  const { note, ...rest } = result;
  return all.length ? { ...rest, note: all.join(' ') } : rest;
};

// commitSubmit can return a job that is failed or cancelled (a bad state
// from the executor, a cancel that landed meanwhile). → error text | null
function commitProblem(committed, job) {
  if (!committed || typeof committed !== 'object') return `${job.id} was not committed`;
  if (FAILED_STATES.has(committed.state)) return `${committed.id} ${committed.state}${committed.reason ? `: ${clip(committed.reason)}` : ''}`;
  return null;
}

// The first reported contact whose normalized address is not one we sent,
// or null. Every reported contact is checked, before any is stored.
function normalizationMismatch(job, contacts) {
  if (!Array.isArray(contacts)) return null;
  for (const c of contacts) {
    const used = c && typeof c === 'object' ? c.normalizedAddress : undefined;
    if (used === undefined || used === null || used === '') continue;
    if (typeof used === 'string' && job.recipients.includes(used)) continue;
    const sent = typeof c.address === 'string' && job.recipients.includes(c.address) ? c.address : job.recipients[0];
    return { sent, used: clip(typeof used === 'string' ? used : JSON.stringify(used)) };
  }
  return null;
}

async function submitExternal(reg, { caseId }, { entry, job, envelope, notes }) {
  const settings = reg.settings();
  const adapter = await reg.adapter(entry.id);
  const envelopeView = envelope
    ? Object.freeze(JSON.parse(JSON.stringify((({ payloads, ...rest }) => rest)(envelope))))
    : null;
  const jobView = Object.freeze(JSON.parse(JSON.stringify({
    id: job.id, caseId, externalRef: `${caseId}/${job.id}`, idempotencyKey: job.idempotencyKey, intent: job.intent,
    recipients: job.recipients, payload: job.payload, facts: job.facts, maxCostUsd: job.maxCostUsd, window: job.window
  })));
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), settings.submitTimeoutMs);
  });
  let submitted;
  try {
    submitted = await Promise.race([Promise.resolve().then(() => adapter.submit(jobView, envelopeView)), timeout]);
  } catch (err) {
    if (err && err.code === 'conflict') {
      await failJob(reg, caseId, job, 'idempotency conflict');
      return { ok: false, error: `${entry.id} refused ${job.id}: its idempotency key was already used with a different body (idempotency conflict)` };
    }
    const message = clip(err && err.message ? err.message : err);
    await failJob(reg, caseId, job, message);
    return { ok: false, error: `${entry.id} refused ${job.id}: ${message}` };
  } finally {
    clearTimeout(timer);
  }
  if (submitted === TIMEOUT) {
    return {
      ok: false,
      error: `${entry.id} did not answer within ${Math.round(settings.submitTimeoutMs / 1000)}s; ${job.id} stays submitting and is reconciled at the next turn start`,
      jobId: job.id
    };
  }
  const answer = submitted && typeof submitted === 'object' && !Array.isArray(submitted) ? submitted : {};
  const mismatch = normalizationMismatch(job, answer.contacts);
  if (mismatch) {
    // failSubmit asks the executor to cancel the job it accepted.
    await jobs.failSubmit(reg, caseId, job, { jobId: answer.jobId }, `recipient normalized differently: sent ${mismatch.sent}, executor used ${mismatch.used}`);
    return { ok: false, error: `recipient normalized differently: sent ${mismatch.sent}, executor used ${mismatch.used}; job cancelled` };
  }
  const committed = await jobs.commitSubmit(reg, caseId, job, { ...answer, contacts: jobs.capContacts(answer.contacts) });
  const problem = commitProblem(committed, job);
  if (problem) return { ok: false, error: problem, jobId: job.id };
  return withNote({ ok: true, jobId: committed.id, externalId: committed.externalId }, notes);
}

async function submitBrowser(reg, { caseId }, { entry, job, notes }) {
  const actions = reg.browserActions || require('../../tools/builtin/browser-tool').actions;
  const toolContext = { vault: reg.vault, userDataPath: reg.dataDir };
  const p = job.payload;
  // The page opened is the rendered url; its origin must be the recipient
  // the envelope was fitted against.
  const origin = normalizeRecipient(p.url, { channel: 'url' });
  if (!origin.ok || origin.value !== job.recipients[0]) {
    await failJob(reg, caseId, job, 'the rendered url has a different origin');
    return { ok: false, error: `the rendered url is not on ${job.recipients[0]}; ${job.id} failed`, jobId: job.id };
  }
  const steps = [];
  let clicked = false;
  const run = async (name, params) => {
    const r = await actions[name](params, toolContext);
    const failed = r && r.ok === false;
    steps.push(`${name}${failed ? ` failed: ${clip(r.error)}` : ''}`);
    if (failed) throw new Error(`${name}: ${clip(r.error)}`);
    return r || {};
  };
  // The page the browser is on must stay on the fitted origin: a redirect
  // from the approved page to another site is refused before any
  // credential or field is typed there, and again right before the click.
  const onOrigin = async (when) => {
    const at = (await run('status', {})).currentUrl;
    const n = normalizeRecipient(String(at ?? ''), { channel: 'url' });
    if (!n.ok || n.value !== job.recipients[0]) {
      throw new Error(`${when} the page is ${clip(at ?? 'unknown')}, not on ${job.recipients[0]}`);
    }
  };
  let html = '';
  try {
    // Ruling T11-always-profile: every browser job runs in the cases
    // profile. A running browser in another profile, or one whose profile
    // cannot be read, is refused and never used with its cookies.
    const st = await run('status', {});
    if (st.running) {
      const current = typeof actions.profile_current === 'function' ? await run('profile_current', {}) : null;
      if (!current || current.active !== CASES_BROWSER_PROFILE) {
        await failJob(reg, caseId, job, 'browser: open with another profile');
        return { ok: false, error: OTHER_PROFILE };
      }
    } else {
      await run('start', { profile: CASES_BROWSER_PROFILE });
    }
    await run('navigate', { url: p.url });
    await onOrigin('after navigate');
    if (p.login === true) await run('fill_credentials', { host: new URL(p.url).hostname.toLowerCase(), profile: CASES_BROWSER_PROFILE });
    // Before each fill: a navigation set off by filling one field must not
    // receive the values of the fields after it.
    for (const f of p.fields || []) {
      await onOrigin('before a field fill');
      await run('fill', { selector: f.selector, text: f.value });
    }
    await onOrigin('before the submit click');
    await run('click', { selector: p.submit.selector });
    clicked = true;
    if (p.waitFor) await run('wait_for', { selector: p.waitFor });
    html = (await run('content', {})).html || '';
  } catch (err) {
    const message = clip(err && err.message ? err.message : err);
    // Ruling T11-click: after the click the form may have gone, so the job
    // counts as sent (reservation kept, envelope and case contacts recorded).
    // Before it nothing left, and the reservation is released.
    if (clicked) {
      log.warn(`Browser job ${job.id} in ${caseId} failed after its submit click: ${message}`);
      await failJob(reg, caseId, job, `browser: ${message}; ${MAY_HAVE_BEEN_SENT}`, { keepReservation: true });
      return { ok: false, error: `the ${entry.id} job failed after the submit click: ${message}; ${MAY_HAVE_BEEN_SENT}`, jobId: job.id };
    }
    await failJob(reg, caseId, job, `browser: ${message}`);
    return { ok: false, error: `the ${entry.id} job failed: ${message}`, jobId: job.id };
  }
  // From here the form was sent: a failure keeps what the job counts against.
  const rel = `sources/browser/${job.id}.md`;
  let committed;
  try {
    const file = path.join(reg.caseDir(caseId), ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      `# Browser job ${job.id}`, '', `URL: ${p.url}`, `At: ${reg.now().toISOString()}`, '', '## Steps', '',
      ...steps.map((s) => `- ${s}`), '', '## Page after submit', '', '```html', String(html), '```', ''
    ].join('\n'));
    committed = await jobs.commitSubmit(reg, caseId, job, { jobId: job.id, state: 'done' });
  } catch (err) {
    const message = clip(err && err.message ? err.message : err);
    log.warn(`Browser job ${job.id} in ${caseId} could not be recorded after its submit: ${message}`);
    await failJob(reg, caseId, job, `browser: recording failed: ${message}; ${MAY_HAVE_BEEN_SENT}`, { keepReservation: true });
    return { ok: false, error: `the ${entry.id} job was submitted but could not be recorded: ${message}; ${MAY_HAVE_BEEN_SENT}`, jobId: job.id };
  }
  const problem = commitProblem(committed, job);
  if (problem) return { ok: false, error: problem, jobId: job.id };
  return withNote({ ok: true, jobId: committed.id, externalId: committed.externalId, source: rel }, notes);
}

async function submitRunbook(reg, { caseId }, { job, notes }) {
  const engine = reg.getRunbookEngine();
  const name = job.payload.runbook;
  const params = engine.validateParameters(name, job.payload.params || {});
  const stamp = engine.recordExecution(name);
  const controller = new AbortController();
  const key = `${caseId}/${job.id}`;
  const run = { controller, started: false, name, stamp };
  reg.running.set(key, run);
  const startedAt = reg.now().toISOString();
  let committed;
  try {
    jobs.writeRunStatus(reg, caseId, job.id, { state: 'running', startedAt });
    committed = await jobs.commitSubmit(reg, caseId, job, { jobId: null, state: 'running' });
  } catch (err) {
    reg.running.delete(key);
    engine.releaseExecution(name, stamp);
    throw err;
  }
  const problem = commitProblem(committed, job);
  if (problem) {
    reg.running.delete(key);
    engine.releaseExecution(name, stamp);
    return { ok: false, error: problem, jobId: job.id };
  }
  reg.lastBackgroundRun = new Promise((resolve) => setImmediate(resolve)).then(async () => {
    if (controller.signal.aborted) return;
    run.started = true;
    try {
      const result = await engine.executeRunbook(name, params, { admitted: true, signal: controller.signal });
      writeJsonAtomic(path.join(jobs.runDir(reg, caseId, job.id), 'output.json'), result);
      const state = controller.signal.aborted ? 'cancelled' : (result && result.success === false ? 'failed' : 'done');
      jobs.writeRunStatus(reg, caseId, job.id, { state, startedAt, finishedAt: new Date().toISOString(), error: result?.error || null });
    } catch (err) {
      jobs.writeRunStatus(reg, caseId, job.id, { state: 'failed', startedAt, finishedAt: new Date().toISOString(), error: err.message });
    } finally {
      reg.running.delete(key);
    }
  }).catch((err) => log.warn(`Runbook job ${job.id} in ${caseId} could not record its end: ${err.message}`));
  return withNote({ ok: true, jobId: committed.id, externalId: null, note: 'The runbook runs in the background; its output is copied into sources/runbook/ when it finishes.' }, notes);
}

async function submitWorkflow(reg, { caseId }, { job, notes }) {
  const engine = reg.getWorkflowEngine();
  const runs = jobs.runDir(reg, caseId, job.id);
  fs.mkdirSync(runs, { recursive: true });
  const graph = {
    goal: job.intent,
    summary: job.intent,
    tasks: job.payload.tasks.map((t) => ({
      id: t.id, title: t.title, description: t.description, dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [], agentId: 'case-researcher'
    }))
  };
  const wf = await engine.create(graph, {
    chatId: null,
    workingDirectory: runs,
    modeSnapshot: { sandboxMode: true, allowedDirectories: [runs] },
    executeExtras: { isolatedContext: true, guardContext: { caseId } }
  });
  const startedAt = reg.now().toISOString();
  jobs.writeRunStatus(reg, caseId, job.id, { state: 'running', startedAt });
  const committed = await jobs.commitSubmit(reg, caseId, job, { jobId: wf.id, state: 'running' });
  const problem = commitProblem(committed, job);
  if (problem) {
    try {
      engine.cancel(wf.id);
    } catch (err) {
      log.warn(`Cancelling workflow ${wf.id} failed: ${err.message}`);
    }
    return { ok: false, error: problem, jobId: job.id };
  }
  reg.lastBackgroundRun = Promise.resolve()
    .then(() => engine.run(wf.id))
    .then((done) => {
      for (const t of done?.tasks || []) {
        // Task ids name files; one the engine made up is not written.
        if (!TASK_ID.test(String(t?.id))) continue;
        fs.writeFileSync(path.join(runs, `${t.id}.md`), `# ${t.title}\n\n${t.result || t.error || ''}\n`);
      }
      const status = done?.status;
      const state = status === 'completed' ? 'done' : (status === 'cancelled' ? 'cancelled' : 'failed');
      const errors = (done?.tasks || []).map((t) => t?.error).filter(Boolean).join('; ');
      jobs.writeRunStatus(reg, caseId, job.id, { state, startedAt, finishedAt: new Date().toISOString(), error: state === 'done' ? null : (errors || status || 'failed') });
    })
    .catch((err) => {
      try {
        jobs.writeRunStatus(reg, caseId, job.id, { state: 'failed', startedAt, finishedAt: new Date().toISOString(), error: err.message });
      } catch (e) {
        log.warn(`Workflow job ${job.id} in ${caseId} could not record its failure: ${e.message}`);
      }
    });
  return withNote({ ok: true, jobId: committed.id, externalId: wf.id, note: 'Research runs in the background; results arrive with action "results".' }, notes);
}

async function submitOwner(reg, { caseId }, { job, step, notes }) {
  const q = reg.caseRuntime.createQuestion(caseId, {
    kind: 'question', urgency: 'normal', defaultOnSilence: 'hold',
    text: `Owner task ${job.id} (${step.capability}) for plan step ${step.id}: ${job.payload.text}`,
    payload: { type: 'owner-task', jobId: job.id, planStepId: step.id, capability: step.capability, mcpAnswerable: false }
  }, { charge: false });
  job.questionId = q.id;
  const committed = await jobs.commitSubmit(reg, caseId, job, { jobId: q.id, state: 'waiting' });
  const problem = commitProblem(committed, job);
  if (problem) return { ok: false, error: problem, jobId: job.id };
  return withNote({ ok: true, jobId: committed.id, externalId: committed.externalId, note: 'The owner was asked; their answer is the result.' }, notes);
}

module.exports = {
  CASES_BROWSER_PROFILE, precheck, failJob, submitExternal, submitBrowser, submitRunbook, submitWorkflow, submitOwner
};
