// tests/cases-ingest-perf.test.js
// Verify-context timing on one crafted 2 MB page (final review I1).
// A CPU-heavy timing test in a file of its own: npm test's 120 s limit
// applies to a whole file, and under full-suite load this test would push a
// larger file over it (C7 Linux full-suite fixes). Bounds are generous
// (ruling T7-timing) and the time is logged.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { checkProposals, verifyContext, pageAnchors } = require('../src/cases/ingest/review');

const raw = (over = {}) => ({
  stmt: 'Payoff amount for loan 0042-7781 is $182,340.17',
  subject: 'loan-0042-7781',
  attr: 'payoff-amount',
  value: '182340.17',
  unit: 'usd',
  category: 'financial',
  confidence: 0.9,
  anchor: { page: 1, quote: 'Total payoff amount: $182,340.17' },
  entities: [{ type: 'org', text: 'Example Bank' }, { type: 'id', text: 'Loan No. 0042-7781' }, { type: 'person', text: 'Pat Doe' }],
  ...over
});

describe('final review I1: one crafted page', () => {
  it('checks and frames 200 proposals on a crafted 2 MB page in bounded time', { timeout: 180000 }, () => {
    // The review's page: "a " repeated to 2 MB, ending in the quote with
    // double spaces, so the exact match misses and the loose path runs for
    // every proposal. Unfixed, one verifyContext took ~1.1 s here and
    // checkProposals re-normalised the page twice per proposal.
    const quote = `${'a '.repeat(149)}b`;
    const tail = `${'a  '.repeat(149)}b`;
    const page = 'a '.repeat(Math.floor((2 * 1024 * 1024 - tail.length) / 2)) + tail;
    const proposals = Array.from({ length: 200 }, () => raw({ value: 'b', anchor: { page: 1, quote } }));
    // ~4 s alone here; generous for a loaded full suite, and still far
    // below the unfixed cost (over 250 s).
    const bound = 90000;
    const started = process.hrtime.bigint();
    const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
    const checked = checkProposals({ proposals }, [{ n: 1, method: 'text', text: page }], new Map());
    assert.strictEqual(checked.proposals.length, 200, JSON.stringify(checked.refused[0]));
    const checkedMs = elapsed();
    // As IngestService._check runs verify: one pageAnchors() per run.
    const anchors = pageAnchors();
    for (const p of checked.proposals) {
      const ctx = verifyContext(page, p.anchor.quote, { pageAnchor: () => anchors(p.anchor.page, page) });
      assert.ok(ctx.endsWith(tail), 'the window holds the quote');
      assert.ok(elapsed() < bound, `stopped after ${elapsed().toFixed(0)} ms`);
    }
    const ms = elapsed();
    console.log(`I1 timing: checkProposals ${checkedMs.toFixed(0)} ms, then 200 verifyContext, ${ms.toFixed(0)} ms in all on a ${page.length}-character page`);
    assert.ok(ms < bound, `took ${ms.toFixed(0)} ms`);
  });
});
