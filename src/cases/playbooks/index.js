// src/cases/playbooks/index.js
// Playbooks (cases stage 6). installPlaybooks wires a PlaybookManager into a
// CaseRuntime: the manager on runtime.playbooks, the gating source, the
// turn-start hook and, once an executor registry exists, the brief rules.
const { PlaybookManager, PlaybookError, resolvePlaybookSettings, HOOK_FAILED_NOTE } = require('./manager');
const { formatPlaybookChanges } = require('./changes');
const { caseTypes: defaultCaseTypes } = require('./case-types-bridge');
const { createLogger } = require('../../logging');

const log = createLogger('cases/playbooks');

function installPlaybooks(runtime, { getSettings = () => ({}), examplesDir = null, caseTypes = defaultCaseTypes(), tmpRoot = null, adminPolicy = false } = {}) {
  // The host's getter can throw: in create-core the registry may be a const
  // declared below this call (a TDZ ReferenceError until it runs).
  const getExecutorRegistry = () => {
    try {
      return typeof runtime.host?.getExecutorRegistry === 'function' ? runtime.host.getExecutorRegistry() || null : null;
    } catch {
      return null;
    }
  };
  const manager = new PlaybookManager({ runtime, getSettings, examplesDir, getExecutorRegistry, caseTypes, tmpRoot, adminPolicy });
  runtime.playbooks = manager;

  // R18: fn(executorId, caseId); C3's briefRules(id, { caseId }) calls it.
  const briefRulesSource = (executorId, caseId) => runtime.playbookBriefRules(caseId, executorId);
  // Registered once per registry, at install and again at every turn start,
  // so a registry that did not exist yet at install is never skipped (M5).
  const registered = new WeakSet();
  const ensureBriefRules = () => {
    const registry = getExecutorRegistry();
    if (!registry || (typeof registry !== 'object' && typeof registry !== 'function')) return false;
    if (registered.has(registry)) return true;
    if (typeof registry.registerExtraBriefRules !== 'function') return false;
    try {
      registry.registerExtraBriefRules(briefRulesSource);
    } catch (err) {
      log.warn(`Registering playbook brief rules with the executor registry failed: ${err.message}`);
      return false;
    }
    registered.add(registry);
    return true;
  };
  ensureBriefRules();

  if (typeof runtime.addTurnStartHook === 'function') {
    // A failure here never blocks or fails the turn: it is logged, and the
    // model sees a fixed note instead of the error text (C2's own catch would
    // put err.message, which can quote package text, in the orientation).
    // Keep this hook synchronous and bounded (no network, no git, no waiting
    // on the manager's per-case chain): C2's _runHooks awaits it with no
    // timeout while the turn holds the case lock.
    runtime.addTurnStartHook('playbooks', async (ctx) => {
      try {
        ensureBriefRules();
      } catch (err) {
        log.warn(`Registering playbook brief rules failed: ${err.message}`);
      }
      try {
        return await manager.turnStartHook(ctx);
      } catch (err) {
        log.warn(`Playbook turn-start hook failed on case ${ctx?.caseId}: ${err.message}`);
        return { notes: [HOOK_FAILED_NOTE] };
      }
    });
  }
  return manager;
}

module.exports = { installPlaybooks, PlaybookManager, PlaybookError, resolvePlaybookSettings, formatPlaybookChanges, HOOK_FAILED_NOTE };
