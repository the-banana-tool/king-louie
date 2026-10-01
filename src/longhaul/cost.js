'use strict';
// Pricing a run before its first call (benchmark spec §8.1, B-D7). Every
// planned call that is not already cached is priced from the catalog
// (Catalog#price, the only price source) on a close bound of its tokens:
// input at 3 characters a token (high for prose, about right for code and
// JSON, low for denser text), plus any input not written yet (a judge's
// reply, a summary's previous summary) at its call's maxTokens, and output
// at maxTokens. It is not a guarantee: dense text or billed reasoning can
// exceed it, and the spend guard is the backstop that stops at the cap. A
// model the catalog does not price leaves the estimate unknown, never $0,
// and the run refuses unless --allow-unpriced. The built-in fake models
// (client.local, --fake-models) cost nothing.
const { UsageError } = require('./errors');
const { byCodePoint } = require('./files');

const EST_CHARS_PER_TOKEN = 3;
const DEFAULT_MAX_USD = 50;
const ROLE_ORDER = Object.freeze(['summary', 'answer', 'judge']);
const round8 = (n) => Number(n.toFixed(8));

function estInputTokens(chars, extraTokens = 0) {
  return Math.ceil(Math.max(0, chars) / EST_CHARS_PER_TOKEN) + Math.max(0, extraTokens || 0);
}

function priceCall(catalog, model, usage) {
  if (model.local) return 0;
  const priced = catalog.price(model.provider, model.model, usage);
  return priced && Number.isFinite(priced.usd) ? priced.usd : null;
}

function estimateCalls(calls, catalog) {
  const lines = new Map();
  for (const c of calls) {
    const id = [c.role, c.adapter, c.provider, c.model].join('\u0000');
    if (!lines.has(id)) lines.set(id, { role: c.role, adapter: c.adapter, provider: c.provider, model: c.model, calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
    const line = lines.get(id);
    const input = estInputTokens(c.inputChars, c.extraInputTokens);
    // Priced per call: a long-context tier applies per request.
    const usd = priceCall(catalog, c, { input, output: c.maxTokens });
    line.calls += 1;
    line.inputTokens += input;
    line.outputTokens += c.maxTokens;
    line.usd = line.usd === null || usd === null ? null : line.usd + usd;
  }
  const sorted = [...lines.values()].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)
    || byCodePoint(a.adapter, b.adapter) || byCodePoint(a.provider, b.provider) || byCodePoint(a.model, b.model));
  for (const l of sorted) if (l.usd !== null) l.usd = round8(l.usd);
  const knownUsd = round8(sorted.reduce((n, l) => n + (l.usd ?? 0), 0));
  const unpriced = [...new Set(sorted.filter((l) => l.usd === null).map((l) => `${l.provider}/${l.model}`))].sort();
  return { lines: sorted, calls: calls.length, knownUsd, totalUsd: unpriced.length ? null : knownUsd, unpriced };
}

function checkBudget(estimate, { maxUsd = DEFAULT_MAX_USD, allowUnpriced = false } = {}) {
  if (estimate.unpriced.length && !allowUnpriced) {
    throw new UsageError(`The catalog has no price for ${estimate.unpriced.join(', ')}, so the run cannot be priced; nothing was sent. `
      + 'Pass --allow-unpriced to run anyway (that cost is reported as unknown, never $0).', 'UNPRICED');
  }
  if (estimate.knownUsd > maxUsd) {
    throw new UsageError(`The estimate $${estimate.knownUsd.toFixed(4)} is over the $${maxUsd} cap; nothing was sent. `
      + 'Raise it with --max-usd, or run fewer questions or adapters (--dry-run shows the plan).', 'OVER_BUDGET');
  }
}

class OverBudgetError extends Error {
  constructor(maxUsd, spentUsd) {
    super(`the $${maxUsd} cap was reached ($${spentUsd.toFixed(4)} spent)`);
    this.name = 'OverBudgetError';
    this.code = 'OVER_BUDGET';
  }
}

// Spend during a run. Each call reserves its own estimate (prompt characters
// / 3, output at maxTokens) before it goes out and settles at its real cost
// after, so concurrent calls cannot pass the cap together. A priced model
// whose reply reports no usage (no tokens, zero tokens or no cost, as from a
// server that omits stream usage) settles at its reservation and counts in
// estimatedCalls, never at $0. Once tripped it never resets: every later
// call in this run is refused (recorded as over-budget), and a rerun, which
// starts a new guard, finishes the rest.
class SpendGuard {
  constructor({ maxUsd = DEFAULT_MAX_USD, catalog }) {
    this.maxUsd = maxUsd;
    this.catalog = catalog;
    this.spentUsd = 0;
    this.reservedUsd = 0;
    this.calls = 0;
    this.unpricedCalls = 0;
    this.estimatedCalls = 0;
    this.tripped = false;
  }

  hooks() {
    return {
      beforeCall: ({ client, promptChars, maxTokens }) => {
        const price = priceCall(this.catalog, client, { input: estInputTokens(promptChars), output: maxTokens });
        const usd = price ?? 0;
        if (this.tripped || this.spentUsd + this.reservedUsd + usd > this.maxUsd) {
          this.tripped = true;
          throw new OverBudgetError(this.maxUsd, this.spentUsd);
        }
        this.reservedUsd += usd;
        return { usd, priced: price !== null, local: Boolean(client.local) };
      },
      afterCall: (ticket, { inputTokens = null, outputTokens = null, costUsd }) => {
        this.reservedUsd -= ticket.usd;
        this.calls += 1;
        const noUsage = !((inputTokens || 0) + (outputTokens || 0) > 0) || typeof costUsd !== 'number';
        if (ticket.local) return; // the built-in fakes cost nothing, whatever they report
        if (ticket.priced && noUsage) {
          this.spentUsd += ticket.usd;
          this.estimatedCalls += 1;
        } else if (typeof costUsd === 'number') {
          this.spentUsd += costUsd;
        } else {
          this.unpricedCalls += 1;
        }
      },
      cancel: (ticket) => { this.reservedUsd -= ticket.usd; }
    };
  }

  totals() {
    return {
      spentUsd: round8(this.spentUsd), calls: this.calls, unpricedCalls: this.unpricedCalls, estimatedCalls: this.estimatedCalls, overBudget: this.tripped
    };
  }
}

const usd = (x) => (x === null ? 'price unknown' : `$${x.toFixed(4)}`);

function formatEstimate(estimate, { maxUsd = DEFAULT_MAX_USD, counts = null } = {}) {
  const out = [];
  if (counts) {
    out.push(`plan: ${counts.answers} answers (${counts.answersCached} cached), ${counts.judgments} judgments (${counts.judgmentsCached} cached), `
      + `${counts.summaries} summaries (${counts.summariesCached} cached)`);
  }
  for (const l of estimate.lines) {
    out.push(`  ${l.role.padEnd(8)}${l.adapter.padEnd(22)}${`${l.provider}/${l.model}`.padEnd(34)}${String(l.calls).padStart(6)} calls  `
      + `~${l.inputTokens} in  <=${l.outputTokens} out  ${usd(l.usd)}`);
  }
  const total = estimate.totalUsd === null ? `${usd(estimate.knownUsd)} priced + unknown for ${estimate.unpriced.join(', ')}` : usd(estimate.totalUsd);
  // An unpriced call reserves nothing against the cap (--allow-unpriced).
  const unpricedCalls = estimate.lines.filter((l) => l.usd === null).reduce((n, l) => n + l.calls, 0);
  const uncovered = unpricedCalls ? `; the cap does not cover ${unpricedCalls} unpriced calls` : '';
  out.push(`estimate: ${total} (a close bound: input at ${EST_CHARS_PER_TOKEN} characters a token, output at the max tokens; the spend guard stops at the cap); `
    + `cap $${maxUsd} (--max-usd)${uncovered}`);
  return `${out.join('\n')}\n`;
}

module.exports = {
  EST_CHARS_PER_TOKEN, DEFAULT_MAX_USD, estInputTokens, priceCall, estimateCalls, checkBudget, OverBudgetError, SpendGuard, formatEstimate
};
