// tests/cases-ingest-perf-pages.test.js
// Verify-context timing over five crafted 2 MB pages in turn (residual I1-b).
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

describe('residual I1-b: five pages in turn', () => {
  it('checks and frames 200 proposals round-robin over five crafted 2 MB pages in bounded time (residual I1-b)', { timeout: 180000 }, () => {
    // Five pages, proposals taking turns: a cache of the last four pages
    // missed on every lookup here (28.8 s in checkProposals and 31.3 s in
    // verify at re-review). Each page is now normalised once per run.
    const quote = (k) => `${'a '.repeat(149)}${'bcdef'[k]}`;
    const tail = (k) => `${'a  '.repeat(149)}${'bcdef'[k]}`;
    const pages = [0, 1, 2, 3, 4].map((k) => ({
      n: k + 1, method: 'text', text: 'a '.repeat(Math.floor((2 * 1024 * 1024 - tail(k).length) / 2)) + tail(k)
    }));
    const proposals = Array.from({ length: 200 }, (_, i) => raw({ value: 'b', anchor: { page: (i % 5) + 1, quote: quote(i % 5) } }));
    // ~8 s alone here; generous for a loaded full suite, and well below the
    // four-page cache's ~60 s.
    const bound = 40000; // ~14-16 s in a loaded full suite; still well below the old cache's ~69 s
    const started = process.hrtime.bigint();
    const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
    const checked = checkProposals({ proposals }, pages, new Map());
    assert.strictEqual(checked.proposals.length, 200, JSON.stringify(checked.refused[0]));
    const checkedMs = elapsed();
    assert.ok(checkedMs < bound, `checkProposals took ${checkedMs.toFixed(0)} ms`);
    const anchors = pageAnchors();
    for (const p of checked.proposals) {
      const page = pages[p.anchor.page - 1].text;
      const ctx = verifyContext(page, p.anchor.quote, { pageAnchor: () => anchors(p.anchor.page, page) });
      assert.ok(ctx.endsWith(tail(p.anchor.page - 1)), 'the window holds the quote');
      assert.ok(elapsed() < bound, `stopped after ${elapsed().toFixed(0)} ms`);
    }
    const ms = elapsed();
    console.log(`I1-b timing: checkProposals ${checkedMs.toFixed(0)} ms, then 200 verifyContext, ${ms.toFixed(0)} ms in all over 5 pages of ${pages[0].text.length} characters`);
    assert.ok(ms < bound, `took ${ms.toFixed(0)} ms`);
  });
});
