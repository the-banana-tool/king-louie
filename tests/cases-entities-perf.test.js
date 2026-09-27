// tests/cases-entities-perf.test.js
// Linear-time checks for entity extraction and the entity index on 400,000-
// character adversarial inputs (cases stage 7 spec §3.6). CPU-heavy timing
// tests live in a file of their own: npm test's 120 s limit applies to a
// whole file (C7 Linux full-suite fixes). Bounds are generous (ruling
// T7-timing) and each time is logged.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractEntities } = require('../src/cases/entities/extract');
const git = require('../src/cases/git');
const { CaseRuntime } = require('../src/cases');
const files = require('../src/cases/ingest/files');

describe('extractEntities — hardening: no catastrophic regex on adversarial input', () => {
  // Generous (ruling T7-timing): a catastrophic pattern takes minutes here,
  // a linear one well under a second alone.
  const MAX_MS = 10000;
  const timed = (label, text, kinds) => {
    const started = process.hrtime.bigint();
    const found = extractEntities(text, { kinds });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`[cases-entities] ${label}: ${text.length} chars, ${found.length} entities, ${ms.toFixed(1)} ms`);
    assert.ok(ms < MAX_MS, `${label} took ${ms.toFixed(1)} ms on a ${text.length}-character adversarial input`);
    return found;
  };

  it('stays fast on a 400,000-character run of digits, spaces and dashes (phone)', () => {
    timed('phone digit run', `${'5'.repeat(200000)}${'-'.repeat(100000)}${' '.repeat(99999)}5`, ['phone']);
  });

  it('stays fast on a 400,000-character run of @ and . characters (email)', () => {
    timed('email symbol run', `${'a@'.repeat(133333)}${'.'.repeat(133334)}`, ['email']);
  });

  it('stays fast on a 400,000-character run of address-like capitalised words (address)', () => {
    timed('address word run', '1 Aa Bb Cc Dd Ee Ff Gg Hh '.repeat(15385), ['address']);
  });

  it('stays fast on a 400,000-character run of labelled id-like tokens (id)', () => {
    timed('id label run', 'account 1234567890-abcdefghij.klmnop/qrstuv '.repeat(9091), ['id']);
  });

  it('stays fast across all kinds together on mixed adversarial input', () => {
    const chunk = `${'5'.repeat(30)} a@${'b'.repeat(30)}. account ${'1'.repeat(30)} 1 Aa Bb Cc Dd `;
    timed('mixed adversarial', chunk.repeat(Math.ceil(400000 / chunk.length)), undefined);
  });
});

describe('EntityIndex (timing)', () => {
  const ZWSP = String.fromCodePoint(0x200b);
  const roots = [];
  after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true }); });

  async function twoCases({ spanNames = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-entities-perf-'));
    roots.push(root);
    const settings = { cases: { ingest: { entities: { spanNames } } } };
    const rt = new CaseRuntime({ root, getSettings: () => settings });
    const a = await rt.createCase({ title: 'Lakeside lot' });
    const b = await rt.createCase({ title: 'Refinance 12 Birch' });
    return { root, rt, a, b, settings };
  }

  // An accepted ingest proposal's traces, as in cases-entities.test.js.
  function ingested(rt, meta, { hash = 'c'.repeat(64), entities = [] } = {}) {
    const fact = rt.ledger(meta.id).assert({
      stmt: 'Payoff amount for loan 0042-7781 is $182,340.17',
      subject: 'loan-0042-7781',
      attr: 'payoff-amount',
      value: 182340.17,
      category: 'financial',
      provenance: 'sourced',
      source: { kind: 'document', ref: 'sources/2026-09/payoff-letter.pdf', docId: 'doc-cccccccccccc' },
      disclosable: false
    });
    files.writeRecord(meta.dir, {
      docId: 'doc-cccccccccccc',
      ref: 'sources/2026-09/payoff-letter.pdf',
      sha256: hash,
      proposals: [{ id: 'p-001', entities, review: { action: 'accepted', factId: fact.id } }]
    });
    files.writeTextStore(meta.dir, { docId: 'doc-cccccccccccc', sha256: hash, pages: [{ n: 1, method: 'text', text: 'Example Bank\nLoan No. 0042-7781\nEscrow desk +1 555 0199' }] });
    return fact;
  }

  it('nonDisclosableSpans stays linear on a 400,000-character adversarial payload', async (t) => {
    const RLO = String.fromCodePoint(0x202e);
    const PDF = String.fromCodePoint(0x202c);
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a, b } = await twoCases({ spanNames: true });
    // Indexed ids of every length 5..40, all made of one digit, and names
    // made of one repeated word: every position of the payload starts a match.
    const lines = [];
    for (let n = 5; n <= 40; n++) lines.push(`Account ${'1'.repeat(n)}`);
    const entities = [];
    for (let n = 2; n <= 12; n++) entities.push({ type: 'person', text: Array(n).fill('ab').join(' ') });
    ingested(rt, a, { entities });
    files.writeTextStore(a.dir, { docId: 'doc-cccccccccccc', sha256: 'c'.repeat(64), pages: [{ n: 1, method: 'text', text: lines.join('\n') }] });
    const idx = rt.entityIndex();
    idx.nonDisclosableSpans('warm up', { caseId: b.id });
    for (const payload of ['1 '.repeat(200000), 'ab '.repeat(133334), '1-'.repeat(100000) + 'ab.'.repeat(66667), `1${ZWSP}${ZWSP} `.repeat(100000), `${RLO}1 ${PDF}`.repeat(100000), `${RLO}1 \n`.repeat(100000)]) {
      const started = process.hrtime.bigint();
      const spans = idx.nonDisclosableSpans(payload, { caseId: b.id });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(spans.length > 0);
      t.diagnostic(`${payload.length} chars, ${spans.length} spans, ${ms.toFixed(1)} ms`);
      assert.ok(ms < 10000, `nonDisclosableSpans took ${ms.toFixed(1)} ms on ${payload.length} characters`);
    }
  });
});
