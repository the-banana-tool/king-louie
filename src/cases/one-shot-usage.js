// src/cases/one-shot-usage.js
// The reply text and the usage of a case's one-shot model calls (orient,
// classify, verify). Moved here from turn-runner.js, unchanged, so the
// verify pass can charge its call without requiring the wake-up runner.
const UsageTracker = require('../tracking/usage-tracker');

function textOf(reply) {
  if (typeof reply === 'string') return reply;
  if (reply && typeof reply.content === 'string') return reply.content;
  return '';
}

// The orient call goes through sendMessageWithTools (see the comment at its
// call site) precisely so it reports metrics; a bare-text reply (no metrics
// object at all) still charges nothing rather than guessing at a cost. The
// routed case provider stamps the call's model role and pricingUsage on the
// metrics, and eventFromMetrics keeps both, so UsageTracker files orient and
// classify under utility and can reprice them (final review I3).
function recordOneShotUsage(runtime, turn, reply) {
  const m = reply && typeof reply === 'object' ? reply.llmMetrics : null;
  if (!m) return;
  const tracker = typeof runtime.host?.getUsageTracker === 'function' ? runtime.host.getUsageTracker() : null;
  if (!tracker || typeof tracker.record !== 'function') return;
  runtime.usageHook(turn)(tracker.record(UsageTracker.eventFromMetrics(m)));
}

module.exports = { textOf, recordOneShotUsage };
