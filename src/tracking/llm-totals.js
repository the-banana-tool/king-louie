// src/tracking/llm-totals.js
// Totals over one reply's model calls. A call cut off by Stop (usagePartial)
// or one without a known price (costUsd null) marks the totals partial or
// unpriced, so a reply never shows an incomplete cost as complete.
function sumLlmCalls(calls = []) {
  const list = Array.isArray(calls) ? calls.filter(Boolean) : [];
  const totals = list.reduce((acc, call) => ({
    inputTokens: acc.inputTokens + (Number(call.inputTokens) || 0),
    outputTokens: acc.outputTokens + (Number(call.outputTokens) || 0),
    totalTokens: acc.totalTokens + (Number(call.totalTokens) || 0),
    costUsd: Number((acc.costUsd + (Number(call.costUsd) || 0)).toFixed(8))
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });
  if (list.some((call) => call.usagePartial)) totals.partial = true;
  if (list.some((call) => call.costUsd === null || call.unpriced === true)) totals.unpriced = true;
  return totals;
}

module.exports = { sumLlmCalls };
