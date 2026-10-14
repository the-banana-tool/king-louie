// src/tracking/llm-totals.js
// Totals over one reply's model calls. A call cut off by Stop (usagePartial)
// or one without a known price (costUsd null) marks the totals partial or
// unpriced, so a reply never shows an incomplete cost as complete.

// The server a local call ran on, or null. Only the local server provider
// puts `local` on a call's metrics (spec 2026-10-13 §9.1); such a call is
// free and is never unpriced.
function localServerOf(call) {
  const local = call && call.local;
  return local && typeof local === 'object' && typeof local.server === 'string' && local.server ? local.server : null;
}
const isUnpriced = (call) => !localServerOf(call) && (call.costUsd === null || call.unpriced === true);

function sumLlmCalls(calls = []) {
  const list = Array.isArray(calls) ? calls.filter(Boolean) : [];
  const totals = list.reduce((acc, call) => ({
    inputTokens: acc.inputTokens + (Number(call.inputTokens) || 0),
    outputTokens: acc.outputTokens + (Number(call.outputTokens) || 0),
    totalTokens: acc.totalTokens + (Number(call.totalTokens) || 0),
    costUsd: Number((acc.costUsd + (Number(call.costUsd) || 0)).toFixed(8))
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });
  if (list.some((call) => call.usagePartial)) totals.partial = true;
  if (list.some(isUnpriced)) totals.unpriced = true;
  // Local calls (§9.2), counted only when there are any.
  const local = list.filter(localServerOf);
  if (local.length) {
    totals.localCalls = local.length;
    totals.localTokens = local.reduce((n, call) => n + (Number(call.totalTokens) || 0), 0);
  }
  return totals;
}

// Cost by role over a reply's calls (models spec 2026-09-27 §10). A call
// with no role (an untagged caller) counts as "other".
function costByRole(calls = []) {
  const out = {};
  for (const call of (Array.isArray(calls) ? calls : []).filter(Boolean)) {
    const role = typeof call.role === 'string' && call.role ? call.role : 'other';
    const entry = out[role] || (out[role] = { calls: 0, totalTokens: 0, costUsd: 0 });
    entry.calls += 1;
    entry.totalTokens += Number(call.totalTokens) || 0;
    entry.costUsd = Number((entry.costUsd + (Number(call.costUsd) || 0)).toFixed(8));
    if (isUnpriced(call)) entry.unpriced = true;
    if (call.usagePartial) entry.partial = true;
    const server = localServerOf(call);
    if (server) {
      entry.localCalls = (entry.localCalls || 0) + 1;
      entry.localTokens = (entry.localTokens || 0) + (Number(call.totalTokens) || 0);
      entry.localServers = entry.localServers || [];
      if (!entry.localServers.includes(server)) entry.localServers.push(server);
    }
    // A role with no models of its own ran on the role it borrowed from
    // (spec §6.4); the cost line says so (final review m3).
    if (typeof call.borrowedFrom === 'string' && call.borrowedFrom && !entry.borrowedFrom) entry.borrowedFrom = call.borrowedFrom;
  }
  return out;
}

// A reply's llm record: the parent's own calls, each sub-agent run kept
// apart, and totals and cost by role over both (spec §10).
function summarizeTurnLlm({ calls = [], subagents = [] } = {}) {
  const own = (Array.isArray(calls) ? calls : []).filter(Boolean);
  const runs = (Array.isArray(subagents) ? subagents : [])
    .filter((r) => r && Array.isArray(r.calls) && r.calls.length)
    .map((r) => {
      const runCalls = r.calls.filter(Boolean);
      // A run that failed mid-call (fix round 1) still reports what it
      // billed before failing; the marker survives the roll-up.
      return { agentId: r.agentId || null, role: r.role || null, calls: runCalls, totals: sumLlmCalls(runCalls), ...(r.failed ? { failed: true } : {}) };
    });
  const all = [...own, ...runs.flatMap((r) => r.calls)];
  const out = { calls: own, totals: sumLlmCalls(all) };
  if (runs.length) out.subagents = runs;
  if (all.length) out.byRole = costByRole(all);
  return out;
}

module.exports = { sumLlmCalls, costByRole, summarizeTurnLlm, localServerOf };
