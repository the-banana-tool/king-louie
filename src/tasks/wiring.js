'use strict';

// A TaskManager on a running agent node (spec docs/superpowers/specs/2026-11-03-tasks-stage1-design.md
// §4.3, §4.5, §4.6): the store, the grants when there is a lease manager, the utility call the
// proposal makes and the page the policy reads. Only src/fleet/start.js loads this, on the agent
// branch: the manager loads src/gui/leases.js, which is off the other profiles' graphs.

const { TaskManager } = require('./manager');
const { TaskStore } = require('./store');
const { TaskGrants } = require('./grants');
const { oneShot } = require('../providers/one-shot');
const { roleTimeoutMs } = require('../models/resolver');
const { KL_PROVIDERS } = require('../models/provider-ids');
const UsageTracker = require('../tracking/usage-tracker');
const browserRegistry = require('../tools/builtin/browser-registry');

const PROPOSAL_MAX_TOKENS = 400;

// → callUtility(prompt, { chatId, signal, onUsage }): the task's text to the utility role, under
// the chat's policy, as a chat title is made. No usable model throws, and the task runs with no
// proposal.
function utilityCaller(context) {
  return async (prompt, { chatId = null, signal = null, onUsage = null } = {}) => {
    const turnModels = context.snapshotModels({ chatId });
    const availability = typeof context.getAvailability === 'function' ? context.getAvailability() : null;
    if (availability && typeof availability.refreshForUse === 'function') {
      const providers = [...new Set(turnModels.candidatesFor('utility').map((x) => x.provider))].filter((p) => KL_PROVIDERS.includes(p));
      await Promise.all(providers.map((p) => availability.refreshForUse(p)));
    }
    const utility = turnModels.resolve('utility');
    if (!utility.targets.length) throw Object.assign(new Error('no usable utility model'), { code: 'no_model' });
    const provider = context.routedProvider({
      targets: utility.targets,
      signal,
      meta: { role: 'utility', profileId: turnModels.profileId || null, borrowedFrom: utility.borrowedFrom || null },
      egress: utility.egress ?? null,
    });
    const { text, llmMetrics } = await oneShot(provider, [{ sender: 'user', text: prompt }], {
      temperature: 0,
      max_tokens: PROPOSAL_MAX_TOKENS,
      timeoutMs: roleTimeoutMs(context.getSettings(), 'utility'),
    });
    if (llmMetrics) {
      const event = UsageTracker.eventFromMetrics(llmMetrics);
      const tracker = typeof context.getUsageTracker === 'function' ? context.getUsageTracker() : null;
      if (tracker && typeof tracker.record === 'function') tracker.record(event);
      if (onUsage) onUsage(event);
    }
    return text;
  };
}

// The page a task's browser shows, or null. A task runs on the default browser; reading it starts
// none, and getBrowser would.
function defaultBrowserUrl() {
  const browser = browserRegistry.registry.default;
  return browser && browser.isRunning && browser.page ? browser.page.url() : null;
}

function createNodeTasks({ core, nodeConfig, dataDir, leaseManager = null, pushQueue = null, audit = null }) {
  return new TaskManager({
    core,
    nodeConfig,
    dataDir,
    store: new TaskStore({ dataDir }),
    // Without one no card can go: every acting call asks for itself (spec §4.6).
    grants: leaseManager ? new TaskGrants({ leases: leaseManager }) : null,
    push: pushQueue,
    audit,
    currentUrl: defaultBrowserUrl,
    callUtility: utilityCaller(core.context),
  });
}

module.exports = { createNodeTasks, utilityCaller, defaultBrowserUrl };
