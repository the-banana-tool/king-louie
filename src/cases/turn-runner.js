// src/cases/turn-runner.js
// The cases:wakeups sweep and the headless wake-up turn (cases stage 2 spec
// §3.6, §3.7). A cheap orient call decides whether anything changed; only
// then does a judge loop act, confined to the case tools and Read/Glob/Grep.
const crypto = require('crypto');
const {
  CASE_TOOL_NAMES, WAKEUP_BASE_TOOLS, shapeToolDefinitions, buildCaseSystemPrompt, casePrompter
} = require('./chat-integration');
const { NO_RETRY } = require('./roles');
const { createLogger } = require('../logging');

const log = createLogger('cases/wakeups');

const ORIENT_PROMPT = [
  'You are the orient step of an unattended case wake-up. Nobody is watching.',
  'Read the orientation and the due wake-ups. Decide only whether anything changed that needs work now: a new answer or fact, a deadline or budget line, a wake-up that asks for work.',
  'Reply with JSON only: {"changed": true or false, "why": "<one sentence>"}.',
  'When unsure, answer "changed": true.'
].join('\n');

const WAKEUP_PROMPT = [
  'Wake-up mode. Nobody is watching this turn.',
  '- Contact the owner only through the Ask tool, and never assume an answer.',
  "- The brief's materiality decides whether something is worth a briefing: tags in \"tell\" may be briefed, tags in \"ignore\" are only journaled.",
  '- Only the case tools and Read, Glob and Grep are available. Other tools are refused.',
  '- If you are blocked or the approach is a dead end, call Fail with what you tried, and stop.',
  '- End with a short summary of what you did; it is journaled.'
].join('\n');

const oneLine = (s, max = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function textOf(reply) {
  if (typeof reply === 'string') return reply;
  if (reply && typeof reply.content === 'string') return reply.content;
  return '';
}

function parseOrient(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    if (!v || typeof v.changed !== 'boolean') return null;
    return { changed: v.changed, why: typeof v.why === 'string' ? v.why : '' };
  } catch {
    return null;
  }
}

// The orient call goes through sendMessageWithTools (see the comment at its
// call site) precisely so it reports metrics; a bare-text reply (no metrics
// object at all) still charges nothing rather than guessing at a cost.
function recordOneShotUsage(runtime, turn, reply) {
  const m = reply && typeof reply === 'object' ? reply.llmMetrics : null;
  if (!m) return;
  const tracker = typeof runtime.host?.getUsageTracker === 'function' ? runtime.host.getUsageTracker() : null;
  if (!tracker || typeof tracker.record !== 'function') return;
  runtime.usageHook(turn)(tracker.record({
    provider: m.provider, model: m.model, inputTokens: m.inputTokens, outputTokens: m.outputTokens, totalTokens: m.totalTokens, costUsd: m.costUsd
  }));
}

const dueLines = (due) => due.map((w) => `- ${w.id} ${w.kind}${w.payload?.key ? ` (${w.payload.key})` : ''}, due ${w.nextAt}`);

// Every failure path — inside a live turn, inside the sweep, or a case this
// process never managed to lock at all — converges here. Safe to call
// whether or not this process already holds the case's lock: `systemAction`
// runs inline (no extra commit) when it does, and acquires + commits a
// fresh system turn when it does not. Never throws (a wake-up failure must
// never break the tick for other cases).
//
// `ids`, when falsy or empty, falls back to whatever the wake-up store
// currently reports due — the caller may be reporting a failure that
// happened before it had a due list of its own (a sweep that crashed, or a
// turn that never opened).
async function markWakeupsFailed(runtime, caseId, ids, err, title) {
  const message = err?.message || String(err);
  try {
    await runtime.systemAction(caseId, 'wake-up failed', () => {
      const now = runtime.now();
      const store = runtime.wakeups(caseId);
      const targets = Array.isArray(ids) && ids.length ? ids : store.due(now).map((w) => w.id);
      if (!targets.length) return;
      for (const id of targets) store.markRan(id, { outcome: 'failed', error: message, now });
      const attempts = Math.max(0, ...targets.map((id) => store.list().find((w) => w.id === id)?.attempts || 0));
      if (attempts >= 3) {
        try {
          runtime.createQuestion(caseId, {
            kind: 'briefing',
            urgency: 'normal',
            text: `${title}: wake-ups have failed ${attempts} times in a row (${oneLine(message, 160)}). The case keeps retrying with backoff.`,
            payload: { type: 'wakeups-failing', key: 'wakeups-failing', mcpAnswerable: false }
          }, { charge: false });
        } catch (e) {
          log.warn(`Could not brief about failing wake-ups on ${caseId}: ${e.message}`);
        }
      }
    });
  } catch (e) {
    log.warn(`Could not mark failed wake-ups on case ${caseId}: ${e.message}`);
  }
}

// Runs inside systemAction('sweep'): housekeeping every case gets each tick,
// then the ids of the due wake-ups that need a turn.
async function sweepCase(runtime, id, now) {
  const meta = runtime.getCase(id);
  const store = runtime.wakeups(meta.id);
  store.reanchor(now);
  runtime.questions(meta.id).expire(now);
  const budget = runtime.budget(meta.id);
  const deadlineNow = budget.charge('deadline', 0).crossedNow;
  if (deadlineNow.length) runtime.onCrossings(meta.id, 'deadline', deadlineNow);
  const reconciled = budget.reconcile();
  for (const [category, crossed] of Object.entries(reconciled)) runtime.onCrossings(meta.id, category, crossed);
  const newDeadline = [...deadlineNow, ...(reconciled.deadline || [])];

  const status = runtime.getCase(meta.id).status;
  if (status === 'done' || status === 'abandoned') {
    store.cancelAll();
    return { due: [], quiet: 0, failed: 0 };
  }
  if (status === 'draft' || status === 'paused') return { due: [], quiet: 0, failed: 0 };

  const registry = typeof runtime.host?.getExecutorRegistry === 'function' ? runtime.host.getExecutorRegistry() : null;
  const due = [];
  let quiet = 0;
  let failed = 0;
  for (const w of store.due(now)) {
    if (w.kind === 'deadline-check') {
      if (newDeadline.some((t) => t >= 80)) due.push(w.id);
      else {
        store.markRan(w.id, { outcome: 'quiet', now });
        quiet += 1;
      }
      continue;
    }
    if (w.kind === 'poll-executor') {
      let material = false;
      if (registry && typeof registry.pollWakeup === 'function') {
        try {
          material = Boolean((await registry.pollWakeup(meta.id, w))?.material);
        } catch (err) {
          await markWakeupsFailed(runtime, meta.id, [w.id], err, meta.title);
          failed += 1;
          continue;
        }
      }
      if (material) due.push(w.id);
      else {
        store.markRan(w.id, { outcome: 'quiet', now });
        quiet += 1;
      }
      continue;
    }
    if (status === 'needs-direction') continue;
    due.push(w.id);
  }
  return { due, quiet, failed };
}

// Invariant: runDueWakeups is this function's sole caller, so a beginTurn
// error rethrown below (anything but CASE_BUSY/RUNTIME_CLOSING) is left
// unmarked here and still ends up marked failed, by runDueWakeups's own
// try/catch around the call.
async function runWakeupTurn(runtime, caseId, dueIds, now = runtime.now()) {
  const host = runtime.host || {};
  const turnId = `wakeup-${now.getTime()}-${crypto.randomBytes(3).toString('hex')}`;
  let turn;
  try {
    turn = await runtime.beginTurn(caseId, { turnId, source: 'wakeup' });
  } catch (err) {
    // Shutting down is not a failure: nothing to back off or brief about.
    if (err && (err.code === 'CASE_BUSY' || err.code === 'RUNTIME_CLOSING')) return { outcome: 'busy' };
    throw err;
  }
  let closed = false;
  // Hoisted above the inner try, falling back to the caller's due set: a
  // failure before `due`/`ids` are recomputed below (or the outer catch
  // itself) must still have something to mark failed.
  let ids = dueIds;
  const close = async (outcome, journal, summary) => {
    if (closed) return { outcome };
    closed = true;
    try {
      await runtime.endTurn(turn, { summary, journal, journalKind: 'wakeup' });
    } catch (err) {
      log.warn(`Wake-up commit for case ${caseId} failed: ${err.message}`);
    }
    return { outcome };
  };

  try {
    const store = runtime.wakeups(caseId);
    // Another process may have run them while this one waited for the lock.
    const due = store.due(now).filter((w) => dueIds.includes(w.id));
    if (!due.length) return await close('none', null, 'wake-up: nothing due');
    ids = due.map((w) => w.id);
    const mark = (outcome, error = null) => {
      for (const id of ids) store.markRan(id, { outcome, error, now: runtime.now() });
    };
    const skipped = (why) => {
      mark('skipped');
      return close('skipped', `skipped: ${why}`, `wake-up skipped: ${why}`);
    };
    const failed = async (err) => {
      if (turn.signal.aborted) return skipped(String(turn.signal.reason || 'aborted'));
      const message = err?.message || String(err);
      await markWakeupsFailed(runtime, caseId, ids, err, turn.title);
      return close('failed', `failed: ${oneLine(message, 300)}`, 'wake-up failed');
    };

    const status = runtime.getCase(caseId).status;
    if (status !== 'active' && status !== 'needs-direction') return await skipped(`case is ${status}`);
    if (turn.dailyTurnsSpent) return await skipped('daily turn budget spent');

    // The same confined tool list the judge loop below gets. Orient is a
    // one-shot classification call with no executor attached — nothing
    // ever runs a tool it names — but it must go through sendMessageWithTools
    // (the path judge/AgentLoop uses) rather than the plain sendMessage a
    // tool-less call would take, because only that path returns llmMetrics
    // for the providers King Louie ships (sendMessage returns bare text).
    // Without this, orient calls are never charged to the case's usd budget.
    const registry = host.toolRegistry;
    const baseDefs = WAKEUP_BASE_TOOLS.map((n) => registry.get(n)).filter(Boolean).map((t) => t.toFunctionDefinition());
    const toolDefs = shapeToolDefinitions(baseDefs, true, registry);

    let why = null;
    const answered = due.some((w) => w.kind === 'retry' && w.payload?.questionId);
    if (!turn.reorientPending && !answered) {
      let reply;
      try {
        reply = await runtime.routedProvider(turn, { role: 'orient' }).sendMessageWithTools(
          [{ sender: 'user', text: [`Now: ${now.toISOString()}`, '', 'Due wake-ups:', ...dueLines(due), '', turn.orientation].join('\n') }],
          toolDefs,
          { systemPrompt: ORIENT_PROMPT, abortSignal: turn.signal }
        );
      } catch (err) {
        return await failed(err);
      }
      recordOneShotUsage(runtime, turn, reply);
      const parsed = parseOrient(textOf(reply));
      if (parsed && parsed.changed === false) {
        mark('quiet');
        return await close('quiet', `quiet: ${ids.join(', ')} — ${oneLine(parsed.why || 'nothing changed')}`, 'wake-up quiet');
      }
      // parsed.why can itself be '' (a valid reply that just didn't say
      // why): falling through to the "Why now:" line's own default would
      // then claim a re-orientation trigger or owner answer is pending,
      // which is what that default means for the *skipped-orient* case
      // below, not for "orient ran and said something changed" (minor fix,
      // final review).
      why = parsed
        ? (parsed.why || 'The orient step said something changed but gave no reason.')
        : 'The orient step gave no usable answer, so the case acts to be safe.';
    }

    try {
      const cfg = runtime.settings().wakeups;
      const executor = await host.createToolExecutor(null, null, null, {
        workingDirectory: turn.dir,
        allowedDirectories: [],
        caseContext: runtime.caseContext(turn, { ownerMessages: [], ownerMessageTimes: [] }),
        denyAutoApproval: true,
        allowedToolNames: new Set([...CASE_TOOL_NAMES, ...WAKEUP_BASE_TOOLS])
      });
      const Loop = host.AgentLoop;
      const loop = new Loop(runtime.routedProvider(turn, { role: 'judge' }), executor, {
        maxIterations: cfg.maxIterations,
        usageTracker: typeof host.getUsageTracker === 'function' ? host.getUsageTracker() : null,
        onUsageRecorded: runtime.usageHook(turn),
        failoverPolicy: NO_RETRY,
        abortSignal: turn.signal,
        prompter: casePrompter(null)
      });
      const message = [
        'Wake-ups due:',
        ...dueLines(due),
        '',
        `Why now: ${why || 'a re-orientation trigger or an owner answer is pending.'}`,
        'Do what the case needs now, then stop.'
      ].join('\n');
      const result = await loop.run([{ sender: 'user', text: message }], toolDefs, {
        systemPrompt: buildCaseSystemPrompt(turn.orientation, WAKEUP_PROMPT)
      });
      if (turn.signal.aborted) return await skipped(String(turn.signal.reason || 'aborted'));
      mark('acted');
      return await close('acted', `# Wake-up ${ids.join(', ')}\n\n${String(result?.content || '(no summary)').trim()}`, `wake-up ${ids.join(', ')}`);
    } catch (err) {
      return await failed(err);
    }
  } catch (err) {
    log.warn(`Wake-up turn on case ${caseId} failed: ${err.message}`);
    await markWakeupsFailed(runtime, caseId, ids, err, turn.title);
    return close('failed', `failed: ${oneLine(err.message, 300)}`, 'wake-up failed');
  }
}

async function runDueWakeups(runtime, now = runtime.now()) {
  const counts = { ran: 0, quiet: 0, skipped: 0, busy: 0, failed: 0 };
  const cfg = runtime.settings().wakeups;
  if (!cfg.enabled || !runtime.host) return counts;
  // A case being created has no first commit; sweeping it now would break `createCase`.
  if (runtime.creating) return counts;
  const cases = runtime.listCases();
  if (!cases.length) return counts;
  // Rotate the starting case each tick so that when more cases are due than
  // `maxCasesPerTick`, the same handful at the front of the list cannot
  // starve the rest forever: the cursor persists on the runtime across
  // ticks and always starts just past whichever case last used a turn slot.
  const cursor = Number.isInteger(runtime._wakeupCursor) ? ((runtime._wakeupCursor % cases.length) + cases.length) % cases.length : 0;
  const ordered = [...cases.slice(cursor), ...cases.slice(0, cursor)];
  let turns = 0;
  let lastServed = -1;
  for (let i = 0; i < ordered.length; i += 1) {
    // Shutdown began mid-sweep: stop picking up new cases. abortUnattended()
    // handles whichever turn is already running.
    if (runtime.closing) break;
    const meta = ordered[i];
    // An owner is mid-turn on this case in this process: leave it alone.
    if (runtime.turns.has(meta.id)) {
      counts.busy += 1;
      continue;
    }
    let sweep;
    try {
      sweep = await runtime.systemAction(meta.id, 'sweep', () => sweepCase(runtime, meta.id, now));
    } catch (err) {
      if (err && err.code === 'CASE_BUSY') { counts.busy += 1; continue; }
      log.warn(`Wake-up sweep failed for case ${meta.slug}: ${err.message}`);
      await markWakeupsFailed(runtime, meta.id, null, err, meta.title);
      counts.failed += 1;
      continue;
    }
    counts.quiet += sweep.quiet;
    counts.failed += sweep.failed || 0;
    if (!sweep.due.length || turns >= cfg.maxCasesPerTick) continue;
    turns += 1;
    lastServed = i;
    try {
      const { outcome } = await runWakeupTurn(runtime, meta.id, sweep.due, now);
      if (outcome === 'acted') counts.ran += 1;
      else if (Object.prototype.hasOwnProperty.call(counts, outcome)) counts[outcome] += 1;
    } catch (err) {
      log.warn(`Wake-up turn failed for case ${meta.slug}: ${err.message}`);
      await markWakeupsFailed(runtime, meta.id, sweep.due, err, meta.title);
      counts.failed += 1;
    }
  }
  if (lastServed >= 0) runtime._wakeupCursor = (cursor + lastServed + 1) % cases.length;
  return counts;
}

module.exports = { ORIENT_PROMPT, WAKEUP_PROMPT, parseOrient, sweepCase, runWakeupTurn, runDueWakeups };
