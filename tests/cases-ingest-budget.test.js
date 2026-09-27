// tests/cases-ingest-budget.test.js
// Ingest and the case budget (cases stage 7 spec §3.4; program §4.4): every
// charge is followed by onCrossings, and the pipeline stops after the call
// that crosses 100 %, in whichever stage it is.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const files = require('../src/cases/ingest/files');
const { ingestHarness, cleanup, defaultModel, usage, NEEDS_GIT } = require('./helpers/ingest-harness');
const { makePdf, PAYOFF_LINES } = require('./helpers/ingest-fixtures');

after(cleanup);

describe('ingest budget stops', { skip: NEEDS_GIT }, () => {
  it('crossing 100 % pauses the case and creates the budget question', async () => {
    const h = await ingestHarness({ budgets: { usd: 0.03 }, ingest: { ocrUsdPerPageEstimate: 0.005 }, model: (req) => ({ ...defaultModel(req), usage: usage(0.02) }) });
    const out = await h.svc.store(h.caseId, { name: 'plat.pdf', bytes: await makePdf({ pages: [{ scan: true }, { scan: true }, { scan: true }] }), origin: { kind: 'owner-drop' } });
    await h.svc.drain();
    const meta = h.runtime.getCase(h.caseId);
    assert.strictEqual(meta.status, 'paused');
    const grant = h.runtime.questions(h.caseId).open().find((q) => q.payload?.type === 'budget-grant');
    assert.ok(grant, 'a budget-grant question is open');
    assert.strictEqual(grant.payload.mcpAnswerable, false);
    const rec = files.readRecord(h.dir, out.docId);
    // Page 1 fits, page 2 crosses 100 % and stops the read; page 3 waits.
    assert.deepStrictEqual(rec.pages.map((p) => [p.method, p.error || null]), [['ocr', null], ['ocr', null], ['pending-ocr', 'budget']]);
    assert.strictEqual(rec.status, 'ready-for-review');
    assert.ok(rec.failedChunks.every((c) => c.reason === 'budget'));
  });

  it('stops in proposing: remaining chunks join failedChunks with reason budget', async () => {
    const pages = [1, 2, 3].map((n) => ({ lines: [`Invented ledger page ${n} with ordinary words for the Lakeside lot.`, ...PAYOFF_LINES] }));
    const h = await ingestHarness({ budgets: { usd: 0.05 }, ingest: { chunkChars: 250 }, model: (req) => ({ ...defaultModel(req), usage: usage(0.05) }) });
    const out = await h.svc.store(h.caseId, { name: 'ledger.pdf', bytes: await makePdf({ pages }), origin: { kind: 'owner-drop' } });
    await h.svc.drain();
    const rec = files.readRecord(h.dir, out.docId);
    assert.strictEqual(h.calls.filter((c) => c.purpose === 'extract').length, 1);
    assert.deepStrictEqual(rec.failedChunks.map((c) => [c.fromPage, c.reason]), [[2, 'budget'], [3, 'budget']]);
    assert.deepStrictEqual(rec.proposedPages, [1]);
    assert.strictEqual(rec.status, 'ready-for-review');
    assert.deepStrictEqual(rec.proposals.map((p) => p.checks.verify), [{ agrees: null, note: 'budget', sawImage: false }]);
  });

  it('stops in checking: unverified proposals get verify { agrees: null, note: budget }', async () => {
    const two = [...PAYOFF_LINES, 'Total payoff amount: $182,340.17 repeated for the escrow desk.'].join('\n');
    const model = (req) => {
      if (req.purpose === 'extract') {
        const base = JSON.parse(defaultModel(req).text).proposals[0];
        return { text: JSON.stringify({ proposals: [base, { ...base, attr: 'payoff-escrow', anchor: { page: 1, quote: 'repeated for the escrow desk' } }] }), usage: usage(0.001) };
      }
      return { ...defaultModel(req), usage: usage(req.purpose === 'verify' ? 0.05 : 0.001) };
    };
    const h = await ingestHarness({ budgets: { usd: 0.05 }, model });
    const out = await h.svc.store(h.caseId, { name: 'payoff.txt', bytes: Buffer.from(two), origin: { kind: 'owner-drop' } });
    await h.svc.drain();
    const rec = files.readRecord(h.dir, out.docId);
    assert.strictEqual(h.calls.filter((c) => c.purpose === 'verify').length, 1);
    assert.deepStrictEqual(rec.proposals.map((p) => p.checks.verify.note), ['matches the page', 'budget']);
    assert.strictEqual(h.runtime.getCase(h.caseId).status, 'paused');
    // Once the owner raises the limit and the case is active, Extract
    // verifies what the budget stop left.
    h.settings.cases.budgets.usd = 5;
    h.runtime.store.updateMeta(h.caseId, { status: 'active' });
    await h.svc.extract(h.caseId, out.docId, { by: 'owner' });
    assert.deepStrictEqual(files.readRecord(h.dir, out.docId).proposals.map((p) => p.checks.verify.agrees), [true, true]);
  });
});

describe('ingest budget failures fail closed', { skip: NEEDS_GIT }, () => {
  it('stops at 100 % even when onCrossings throws, and still calls it after every charge', async () => {
    const pages = [1, 2, 3].map((n) => ({ lines: [`Invented ledger page ${n} with ordinary words for the Lakeside lot.`, ...PAYOFF_LINES] }));
    const h = await ingestHarness({ budgets: { usd: 0.05 }, ingest: { chunkChars: 250 }, model: (req) => ({ ...defaultModel(req), usage: usage(0.05) }) });
    let crossings = 0;
    h.runtime.onCrossings = () => {
      crossings += 1;
      throw new Error('question store unavailable');
    };
    const out = await h.svc.store(h.caseId, { name: 'ledger.pdf', bytes: await makePdf({ pages }), origin: { kind: 'owner-drop' } });
    await h.svc.drain();
    assert.strictEqual(h.calls.filter((c) => c.purpose === 'extract').length, 1);
    assert.strictEqual(crossings, 1);
    const rec = files.readRecord(h.dir, out.docId);
    assert.deepStrictEqual(rec.failedChunks.map((c) => c.reason), ['budget', 'budget']);
  });

  it('a charge that cannot be recorded stops the pipeline', async () => {
    const h = await ingestHarness();
    const budget = h.runtime.budget.bind(h.runtime);
    h.runtime.budget = (id) => {
      const b = budget(id);
      b.charge = () => { throw new Error('disk full'); };
      return b;
    };
    const two = [...PAYOFF_LINES, 'Total payoff amount: $182,340.17 repeated for the escrow desk.'].join('\n');
    const out = await h.svc.store(h.caseId, { name: 'payoff.txt', bytes: Buffer.from(two), origin: { kind: 'owner-drop' } });
    await h.svc.drain();
    assert.deepStrictEqual(h.calls.map((c) => c.purpose), ['extract']);
    const rec = files.readRecord(h.dir, out.docId);
    assert.deepStrictEqual(rec.proposals.map((p) => p.checks.verify.note), ['budget']);
  });

  it('makes no extract or verify call while the usd budget is already used up', async () => {
    const h = await ingestHarness({ budgets: { usd: 0.01 } });
    h.runtime.budget(h.caseId).charge('usd', 0.02, {});
    const out = await h.svc.store(h.caseId, { name: 'payoff.txt', bytes: Buffer.from(PAYOFF_LINES.join('\n')), origin: { kind: 'owner-drop' } });
    await h.svc.drain();
    assert.deepStrictEqual(h.calls, []);
    const rec = files.readRecord(h.dir, out.docId);
    assert.deepStrictEqual(rec.failedChunks.map((c) => c.reason), ['budget']);
  });
});
