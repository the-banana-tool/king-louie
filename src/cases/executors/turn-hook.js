// src/cases/executors/turn-hook.js
// The `executors` turn-start hook (cases stage 3 spec §3.12) and the
// orientation section it returns.
const { createLogger } = require('../../logging');
const { JobStore, readSnapshot, isOpen } = require('./job-store');
const { EnvelopeStore } = require('./envelope');
const { money, cut } = require('./util');
const jobs = require('./jobs');
const envelopeOps = require('./envelope-ops');
const planOps = require('./plan-ops');

const log = createLogger('executors/hook');

function renderExecutorSection(reg, caseId, { maxChars = 3000 } = {}) {
  const rt = reg.caseRuntime;
  const dir = reg.caseDir(caseId);
  let brief = {};
  try {
    brief = rt.brief(caseId).read().data || {};
  } catch {
    brief = {};
  }
  const jobList = new JobStore(dir).list();
  const envelopes = new EnvelopeStore(dir).list();
  const ids = [...new Set([
    ...(Array.isArray(brief.resources?.executors) ? brief.resources.executors : []),
    ...jobList.map((j) => j.executor),
    ...envelopes.map((e) => e.executor)
  ])];
  if (!ids.length) return '';
  const snapshot = readSnapshot(dir);
  const lines = ['## Executors', ''];
  for (const id of ids) {
    const e = reg.get(id, { caseId });
    if (!e) lines.push(`- ${id}: not a known executor`);
    else lines.push(`- ${id} (${e.kind}, authority ${e.authority}${e.available ? '' : `, unavailable: ${e.reason}`})`);
  }
  const open = jobList.filter((j) => isOpen(j.state));
  if (open.length) {
    lines.push('', 'Open jobs:');
    for (const j of open) {
      const stale = j.stale ? ` — STALE since ${snapshot[j.executor]?.fetchedAt || 'the first poll'}: ${j.error}` : '';
      lines.push(`- ${j.id} ${j.executor} ${j.state}${j.lastChange ? ` (last change ${j.lastChange})` : ''}${stale}`);
    }
  }
  const active = envelopes.filter((e) => e.status === 'active');
  if (active.length) {
    lines.push('', 'Active envelopes:');
    for (const e of active) {
      const usedContacts = (e.usage?.contacts || []).length;
      lines.push(`- ${e.id} ${e.executor}: ${money(e.caps.usd - (Number(e.usage?.usd) || 0))} of ${money(e.caps.usd)} left, ${e.caps.contacts - usedContacts} of ${e.caps.contacts} contacts left, window ${e.window.start} to ${e.window.end} (${e.window.tz})`);
    }
  }
  // Playbook rules (the registry's extra sources) are third-party text: the
  // orientation gives only their count and where to read them framed; the
  // draft prompt still carries them for the executor (final review I2).
  const rules = ids.map((id) => [id, reg.briefRulesBySource(id, { caseId })]).filter(([, r]) => r.own.length || r.extra.length);
  if (rules.length) {
    lines.push('', 'Brief rules for executors:');
    for (const [id, { own, extra }] of rules) {
      for (const rule of own) lines.push(`- ${id}: ${rule}`);
      if (extra.length) lines.push(`- ${id}: ${extra.length} playbook brief rule${extra.length === 1 ? '' : 's'} (third-party; Playbook.read section briefRules)`);
    }
  }
  const notes = typeof reg.opsNotes === 'function' ? reg.opsNotes(caseId, ids) : '';
  if (notes) lines.push('', notes);
  return cut(lines.join('\n'), maxChars);
}

// Runs inside beginTurn with the case lock held (C2 §4.20). Never throws:
// C2 turns a hook failure into a note, but a partial refresh is better.
async function turnStartHook(reg, { caseId } = {}) {
  const steps = [
    ['signed grants', () => envelopeOps.applyPendingSignedGrants(reg, caseId)],
    ['background output', () => jobs.copyBackgroundOutput(reg, caseId)],
    ['reconcile', () => jobs.reconcileSubmitting(reg, caseId)],
    ['plan', () => planOps.syncPlan(reg, caseId)],
    ['envelopes', () => envelopeOps.syncEnvelopes(reg, caseId)],
    ['refresh', () => jobs.refreshCase(reg, caseId, { budgetMs: reg.settings().refreshBudgetMs })]
  ];
  for (const [label, run] of steps) {
    try {
      await run();
    } catch (err) {
      log.warn(`Executor turn start (${label}) failed for ${caseId}: ${err.message}`);
    }
  }
  try {
    const section = renderExecutorSection(reg, caseId, { maxChars: 3000 });
    return section ? { notes: [section] } : {};
  } catch (err) {
    log.warn(`Executor section for ${caseId} failed: ${err.message}`);
    return {};
  }
}

module.exports = { renderExecutorSection, turnStartHook };
