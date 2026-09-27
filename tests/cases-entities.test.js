// tests/cases-entities.test.js
// Entity keys and extraction (cases stage 7 spec §3.6).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { normalizeEntity, keyType } = require('../src/cases/entities/normalize');
const { extractEntities } = require('../src/cases/entities/extract');

describe('normalizeEntity', () => {
  it('lower-cases emails and rejects non-addresses', () => {
    assert.deepStrictEqual(normalizeEntity('email', 'Records@Example.COM'), ['email:records@example.com']);
    assert.deepStrictEqual(normalizeEntity('email', 'not an email'), []);
  });

  it('keys phones with and without the written country code', () => {
    assert.deepStrictEqual(normalizeEntity('phone', '+1 (555) 0100'), ['phone:15550100', 'phone:5550100']);
    assert.deepStrictEqual(normalizeEntity('phone', '555-0100'), ['phone:5550100']);
    assert.deepStrictEqual(normalizeEntity('phone', '+44 20 7946 0000'), ['phone:442079460000', 'phone:2079460000']);
    assert.deepStrictEqual(normalizeEntity('phone', '12345'), []);
  });

  it('keys ids by their token without separators, with or without the label', () => {
    assert.deepStrictEqual(normalizeEntity('id', 'Loan No. 0042-7781'), ['id:00427781']);
    assert.deepStrictEqual(normalizeEntity('id', '0042-7781'), ['id:00427781']);
    assert.deepStrictEqual(normalizeEntity('id', 'Parcel 12-345-678'), ['id:12345678']);
    assert.deepStrictEqual(normalizeEntity('id', 'Invoice #ab.12/3'), ['id:AB123']);
    assert.deepStrictEqual(normalizeEntity('id', 'order ab'), []);
  });

  it('expands street suffixes and collapses whitespace in addresses', () => {
    assert.deepStrictEqual(normalizeEntity('address', '12  Birch St.'), ['address:12 birch street']);
    assert.deepStrictEqual(normalizeEntity('address', '400 Harbor Road'), ['address:400 harbor road']);
    assert.deepStrictEqual(normalizeEntity('address', 'Birch Street'), []);
  });

  it('strips diacritics and punctuation from names, and company suffixes from orgs', () => {
    assert.deepStrictEqual(normalizeEntity('person', 'Zoë  O\'Neil'), ['person:zoe o neil']);
    assert.deepStrictEqual(normalizeEntity('org', 'Example Bank, Inc.'), ['org:example bank']);
    assert.deepStrictEqual(normalizeEntity('org', 'Lakeside Holdings LLC'), ['org:lakeside holdings']);
    assert.strictEqual(keyType('org:example bank'), 'org');
  });

  it('keys documents by sha256', () => {
    const hash = 'a'.repeat(64);
    assert.deepStrictEqual(normalizeEntity('document', hash), [`document:${hash}`]);
    assert.deepStrictEqual(normalizeEntity('document', 'abc'), []);
  });
});

describe('extractEntities', () => {
  it('finds emails, phones, ids and addresses with exact offsets', () => {
    const text = 'Call +1 555 0100 or write records@example.com about Loan No. 0042-7781 at 12 Birch St.';
    const found = extractEntities(text);
    assert.deepStrictEqual(found.map((e) => [e.type, e.text, e.keys]), [
      ['phone', '+1 555 0100', ['phone:15550100', 'phone:5550100']],
      ['email', 'records@example.com', ['email:records@example.com']],
      ['id', '0042-7781', ['id:00427781']],
      ['address', '12 Birch St', ['address:12 birch street']]
    ]);
    for (const e of found) assert.strictEqual(text.slice(e.start, e.end), e.text);
  });

  it('does not read dates or money as phone numbers, and prefers an id over a phone for a labelled number', () => {
    const found = extractEntities('Payoff amount for loan 0042-7781 is $182,340.17 good through 2026-10-15');
    assert.deepStrictEqual(found.map((e) => e.keys[0]), ['id:00427781']);
  });

  it('does not read a spaced currency amount as a phone number (fix-T6-r1 I1)', () => {
    assert.deepStrictEqual(extractEntities('Total: $ 5551234567 due', { kinds: ['phone'] }), []);
    assert.deepStrictEqual(extractEntities('€ 5551234567', { kinds: ['phone'] }), []);
    assert.deepStrictEqual(extractEntities('£ 5551234567', { kinds: ['phone'] }), []);
    assert.deepStrictEqual(extractEntities('¥ 5551234567', { kinds: ['phone'] }), []);
    // a few spaces still count, but a run of ordinary text before the
    // digits is a real phone number, not a currency amount
    const found = extractEntities('call me at 5551234567 today', { kinds: ['phone'] });
    assert.strictEqual(found.length, 1);
  });

  it('treats a tab, newline or NBSP the same as a space in the currency gap (fix-T6-r1 fix round 2)', () => {
    const TAB = String.fromCharCode(0x09);
    const NEWLINE = String.fromCharCode(0x0a);
    const NBSP = String.fromCodePoint(0x00a0);
    assert.deepStrictEqual(extractEntities(`Total: $${TAB}5551234567 due`, { kinds: ['phone'] }), []);
    assert.deepStrictEqual(extractEntities(`Total: $${NEWLINE}5551234567 due`, { kinds: ['phone'] }), []);
    assert.deepStrictEqual(extractEntities(`Total: $${NBSP}5551234567 due`, { kinds: ['phone'] }), []);
  });

  it('never guesses people or organisations from text', () => {
    assert.deepStrictEqual(extractEntities('Pat Doe of Example Bank called.'), []);
  });
});

describe('normalizeEntity — hardening: hidden characters and lookalike digits', () => {
  // Built from code points (not literal invisible characters in this
  // source file): ZWSP, RLO, RLM, LRI, PDI.
  const ZWSP = String.fromCodePoint(0x200b);
  const RLO = String.fromCodePoint(0x202e);
  const RLM = String.fromCodePoint(0x200f);
  const LRI = String.fromCodePoint(0x2066);
  const PDI = String.fromCodePoint(0x2069);
  const HIDDEN_OR_BIDI_RE = new RegExp(
    `[${String.fromCodePoint(0x0000)}-${String.fromCodePoint(0x0008)}${String.fromCodePoint(0x000b)}${String.fromCodePoint(0x000c)}${String.fromCodePoint(0x000e)}-${String.fromCodePoint(0x001f)}${String.fromCodePoint(0x007f)}-${String.fromCodePoint(0x009f)}${String.fromCodePoint(0x200b)}-${String.fromCodePoint(0x200f)}${String.fromCodePoint(0x202a)}-${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2060)}-${String.fromCodePoint(0x2069)}${String.fromCodePoint(0xfeff)}]`
  );

  it('strips control, zero-width and bidi-format characters before building a key', () => {
    assert.deepStrictEqual(normalizeEntity('email', `a${ZWSP}b@example.com`), ['email:ab@example.com']);
    assert.deepStrictEqual(normalizeEntity('address', `12 Bi${ZWSP}rch St.`), ['address:12 birch street']);
    const [key] = normalizeEntity('person', `Zoe${RLO}${RLM} reverse${LRI}${PDI}`);
    assert.doesNotMatch(key, HIDDEN_OR_BIDI_RE);
  });

  it('ignores Arabic-Indic and fullwidth lookalike digits consistently rather than partially normalising them', () => {
    // Arabic-Indic 555-0100
    assert.deepStrictEqual(normalizeEntity('phone', '٥٥٥-٠١٠٠'), []);
    // fullwidth 0042-7781 after a real id label: the label strips, but the
    // fullwidth digits are not ASCII `\d` so the id is rejected, not folded.
    assert.deepStrictEqual(normalizeEntity('id', 'Loan No. ００４２-７７８１'), []);
    // extraction is consistent with normalizeEntity: a fullwidth digit run
    // after a real label is not recognised as an id at all.
    assert.deepStrictEqual(extractEntities('Loan No. ００４２-７７８１ today'), []);
  });

  it('strips the Arabic letter mark and soft hyphen from a key instead of rejecting it (fix-T6-r1 M2)', () => {
    const ALM = String.fromCodePoint(0x061c);
    const SOFT_HYPHEN = String.fromCodePoint(0x00ad);
    assert.deepStrictEqual(normalizeEntity('id', `Loan No. 0042${ALM}7781`), ['id:00427781']);
    assert.deepStrictEqual(normalizeEntity('id', `Loan No. 0042${SOFT_HYPHEN}7781`), ['id:00427781']);
  });
});

describe('extractEntities — hardening: bounded output', () => {
  it('caps a single entity\'s recorded text and keeps the start/end offsets consistent', () => {
    // The email regex alone can match up to ~345 characters (a generous
    // but still bounded local/domain/tld length); MAX_ENTITY_CHARS (200)
    // is the backstop that caps the *recorded* text regardless. Chosen so
    // the '.' before the tld falls before the 200-character cut, so the
    // truncated text is still a syntactically valid (capped) email.
    const longEmail = `${'a'.repeat(50)}@${'b'.repeat(130)}.${'c'.repeat(24)}`;
    const text = `contact ${longEmail} today`;
    const [found] = extractEntities(text, { kinds: ['email'] });
    assert.ok(longEmail.length > 200, 'fixture must exceed the cap to exercise it');
    assert.ok(found, 'expected one (capped) email entity');
    assert.strictEqual(found.text.length, 200);
    assert.strictEqual(text.slice(found.start, found.end), found.text);
  });

  it('caps the number of entities returned per call', () => {
    const text = Array.from({ length: 600 }, (_, i) => `a${i}@example.com`).join(' ');
    const found = extractEntities(text, { kinds: ['email'] });
    assert.strictEqual(found.length, 500);
  });

  it('caps the whole key, prefix included, not just the part after the colon (fix-T6-r1 M1)', () => {
    // "email:" is 6 characters; the entity's recorded text is already
    // capped to 200 by extractEntities, so drive normalizeEntity directly
    // with a 199-character local part to prove the *key* (prefix + value)
    // is what MAX_KEY_CHARS bounds, not just the value.
    const longRaw = `${'a'.repeat(194)}@example.com`; // > MAX_KEY_CHARS once prefixed
    const [key] = normalizeEntity('email', longRaw);
    assert.ok(`email:${longRaw}`.length > 200, 'fixture must exceed the cap once prefixed');
    assert.strictEqual(key.length, 200);
    assert.ok(key.startsWith('email:'));
  });
});

describe('extractEntities — hardening: no catastrophic regex on adversarial input', () => {
  const MAX_MS = 1000;
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

describe('EntityIndex', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { after } = require('node:test');
  const git = require('../src/cases/git');
  const { CaseRuntime } = require('../src/cases');
  const { EntityIndex } = require('../src/cases/entities');
  const files = require('../src/cases/ingest/files');

  const roots = [];
  after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true }); });

  async function twoCases({ spanNames = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-entities-'));
    roots.push(root);
    const settings = { cases: { ingest: { entities: { spanNames } } } };
    const rt = new CaseRuntime({ root, getSettings: () => settings });
    const a = await rt.createCase({ title: 'Lakeside lot' });
    const b = await rt.createCase({ title: 'Refinance 12 Birch' });
    return { root, rt, a, b, settings };
  }

  // What an accepted ingest proposal leaves behind: a sourced, private fact,
  // the record whose proposal points at it, and the text store.
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

  it('searchEntities finds another case by title and id only', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a, b } = await twoCases();
    const fact = ingested(rt, a);
    const idx = rt.entityIndex();
    const hits = idx.searchEntities('Loan No. 0042-7781', { excludeCaseId: b.id });
    assert.deepStrictEqual(hits.find((h) => h.kind === 'fact'), { caseId: a.id, title: 'Lakeside lot', kind: 'fact', id: fact.id, score: 1, entity: 'id:00427781' });
    assert.ok(hits.some((h) => h.kind === 'document' && h.id === 'doc-cccccccccccc'));
    for (const h of hits) assert.deepStrictEqual(Object.keys(h).sort(), ['caseId', 'entity', 'id', 'kind', 'score', 'title']);
    assert.deepStrictEqual(idx.searchEntities('0042-7781', { excludeCaseId: a.id }), []);
  });

  it('matchText finds indexed surface forms without a label', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a, b } = await twoCases();
    ingested(rt, a);
    const hits = rt.entityIndex().matchText('What is the balance on 0042-7781?', { excludeCaseId: b.id });
    assert.ok(hits.some((h) => h.caseId === a.id && h.entity === 'id:00427781'));
  });

  it('casesWithDocument returns title, id and docId, never the file name', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a, b } = await twoCases();
    ingested(rt, a, { hash: 'd'.repeat(64) });
    assert.deepStrictEqual(rt.entityIndex().casesWithDocument('d'.repeat(64), { excludeCaseId: b.id }), [{ caseId: a.id, title: 'Lakeside lot', docId: 'doc-cccccccccccc' }]);
    assert.deepStrictEqual(rt.entityIndex().casesWithDocument('d'.repeat(64), { excludeCaseId: a.id }), []);
  });

  it('nonDisclosableSpans reports indexed private entities with offsets in the original text', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a, b } = await twoCases();
    ingested(rt, a);
    const text = 'Per {{f-0001}}, loan 0042-7781 closes; call 555-0199 or other@example.com.';
    const spans = rt.entityIndex().nonDisclosableSpans(text, { caseId: b.id });
    assert.deepStrictEqual(spans.map((s) => s.span.text), ['0042-7781', '555-0199']);
    for (const s of spans) assert.strictEqual(text.slice(s.span.start, s.span.end), s.span.text);
    assert.deepStrictEqual(spans[0], {
      span: { start: text.indexOf('0042-7781'), end: text.indexOf('0042-7781') + 9, text: '0042-7781' },
      entity: 'id:00427781',
      reason: 'entity id:00427781 is known only from non-disclosable records'
    });
    // A {{f-…}} reference is never itself a span, and an email nobody
    // indexed is not reported.
    assert.deepStrictEqual(rt.entityIndex().nonDisclosableSpans('{{f-0042}} other@example.com', { caseId: b.id }), []);
  });

  it('setDisclosable propagates: a disclosable fact link in this case clears the span', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a, b } = await twoCases();
    const fact = rt.ledger(a.id).assert({
      stmt: 'The listing agent phone is +1 555 0100',
      subject: 'agent',
      attr: 'phone',
      value: '+1 555 0100',
      category: 'personal',
      provenance: 'sourced',
      source: { kind: 'url', ref: 'https://records.example.org/listing' }
    });
    const idx = rt.entityIndex();
    assert.strictEqual(idx.nonDisclosableSpans('Ring 555-0100.', { caseId: a.id }).length, 1);
    rt.ledger(a.id).setDisclosable(fact.id, true);
    assert.deepStrictEqual(idx.nonDisclosableSpans('Ring 555-0100.', { caseId: a.id }), []);
    assert.strictEqual(idx.nonDisclosableSpans('Ring 555-0100.', { caseId: b.id }).length, 1);
  });

  it('reports people and organisations only with cases.ingest.entities.spanNames', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const off = await twoCases();
    ingested(off.rt, off.a, { entities: [{ type: 'person', text: 'Pat Doe' }] });
    assert.deepStrictEqual(off.rt.entityIndex().nonDisclosableSpans('Ask Pat Doe.', { caseId: off.b.id }), []);
    const on = await twoCases({ spanNames: true });
    ingested(on.rt, on.a, { entities: [{ type: 'person', text: 'Pat Doe' }] });
    const spans = on.rt.entityIndex().nonDisclosableSpans('Ask Pat Doe.', { caseId: on.b.id });
    assert.deepStrictEqual(spans.map((s) => [s.span.text, s.entity]), [['Pat Doe', 'person:pat doe']]);
    assert.deepStrictEqual(on.rt.entityIndex().searchEntities({ type: 'person', text: 'Pat  Doe' }).map((h) => h.caseId), [on.a.id]);
  });

  it('standalone and attached (C5 attachEntities) use the same file', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { root, rt, a } = await twoCases();
    ingested(rt, a);
    const standalone = rt.entityIndex();
    assert.ok(standalone instanceof EntityIndex);
    assert.strictEqual(rt.entityIndex(), standalone);
    standalone.rebuild();
    const file = path.join(root, '.index', 'entities.json');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
    assert.strictEqual(fs.readFileSync(path.join(root, '.index', '.gitignore'), 'utf8'), '*\n');

    const attached = new CaseRuntime({ root });
    const crossCase = { entities: null, attachEntities(e) { this.entities = e; } };
    Object.defineProperty(attached, 'index', { value: crossCase });
    const viaIndex = attached.entityIndex();
    assert.ok(viaIndex instanceof EntityIndex);
    assert.strictEqual(crossCase.entities, viaIndex);
    assert.strictEqual(attached.entityIndex(), viaIndex);
    assert.strictEqual(viaIndex.file, file);
    assert.ok(viaIndex.searchEntities('0042-7781').length > 0);
  });

  it('rebuilds a corrupt index file and drops removed cases', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { root, rt, a } = await twoCases();
    ingested(rt, a);
    fs.mkdirSync(path.join(root, '.index'), { recursive: true });
    fs.writeFileSync(path.join(root, '.index', 'entities.json'), '{not json');
    const idx = new EntityIndex(root);
    assert.ok(idx.searchEntities('0042-7781').length > 0);
    idx.removeCase(a.id);
    assert.deepStrictEqual(Object.keys(idx.data.cases).includes(a.id), false);
  });

  // ---- hardening (task 7 dispatch: M8, M12, untrusted index, variants, linear time) ----

  const ZWSP = String.fromCodePoint(0x200b);
  const fullwidth = (s) => s.replace(/[0-9]/g, (d) => String.fromCodePoint(0xff10 + Number(d)));

  it('files.js refuses a bad docId or page number before touching a file (M8)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ingest-files-'));
    roots.push(dir);
    const caseDir = path.join(dir, 'case');
    fs.mkdirSync(caseDir);
    const bad = ['../../outside', 'doc-CCCCCCCCCCCC', 'doc-ccc', '', null, 'doc-cccccccccccc/../x', 'doc-cccccccccccc\n'];
    for (const docId of bad) {
      assert.throws(() => files.readRecord(caseDir, docId), { code: 'BAD_DOC_ID' });
      assert.throws(() => files.writeRecord(caseDir, { docId }), { code: 'BAD_DOC_ID' });
      assert.throws(() => files.readTextStore(caseDir, docId), { code: 'BAD_DOC_ID' });
      assert.throws(() => files.writeTextStore(caseDir, { docId, pages: [] }), { code: 'BAD_DOC_ID' });
      assert.throws(() => files.readCachedPage(caseDir, docId, 1), { code: 'BAD_DOC_ID' });
      assert.throws(() => files.writeCachedPage(caseDir, docId, { n: 1 }), { code: 'BAD_DOC_ID' });
      assert.throws(() => files.readPendingPublish(caseDir, docId), { code: 'BAD_DOC_ID' });
      assert.throws(() => files.writePendingPublish(caseDir, docId, {}), { code: 'BAD_DOC_ID' });
      assert.throws(() => files.clearPendingPublish(caseDir, docId), { code: 'BAD_DOC_ID' });
    }
    for (const n of [0, -1, 1.5, '1', '../1', 1e9, NaN]) {
      assert.throws(() => files.readCachedPage(caseDir, 'doc-cccccccccccc', n), { code: 'BAD_PAGE' });
      assert.throws(() => files.writeCachedPage(caseDir, 'doc-cccccccccccc', { n }), { code: 'BAD_PAGE' });
    }
    assert.deepStrictEqual(fs.readdirSync(caseDir), []);
    assert.deepStrictEqual(fs.readdirSync(dir), ['case']);
    for (const id of ['p-001', 'p-1234']) assert.ok(files.PROPOSAL_ID.test(id));
    for (const id of ['p-01', 'p-001x', 'x-001', '../p-001']) assert.ok(!files.PROPOSAL_ID.test(id));
  });

  it('files.js writes atomically, reads back, and lists only well-formed records', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ingest-files-'));
    roots.push(dir);
    const rec = { docId: 'doc-aaaaaaaaaaaa', ref: 'sources/2026-09/a.pdf', sha256: 'a'.repeat(64), proposals: [] };
    files.writeRecord(dir, rec);
    files.writeTextStore(dir, { docId: rec.docId, sha256: rec.sha256, pages: [] });
    files.writeCachedPage(dir, rec.docId, { n: 3, text: 'x' });
    files.writePendingPublish(dir, rec.docId, { stage: 'read' });
    assert.deepStrictEqual(files.readRecord(dir, rec.docId), rec);
    assert.strictEqual(files.readTextStore(dir, rec.docId).docId, rec.docId);
    assert.deepStrictEqual(files.readCachedPage(dir, rec.docId, 3), { n: 3, text: 'x' });
    assert.deepStrictEqual(files.pendingPublishes(dir), [rec.docId]);
    files.clearPendingPublish(dir, rec.docId);
    assert.deepStrictEqual(files.pendingPublishes(dir), []);
    // A record file whose content names another docId, a stray directory in
    // the cache and a malformed record are ignored, not trusted.
    const ingest = files.ingestDir(dir);
    fs.writeFileSync(path.join(ingest, 'doc-bbbbbbbbbbbb.json'), JSON.stringify({ docId: 'doc-aaaaaaaaaaaa' }));
    fs.writeFileSync(path.join(ingest, 'doc-dddddddddddd.json'), '{nope');
    fs.mkdirSync(path.join(ingest, 'cache', '..evil'), { recursive: true });
    fs.writeFileSync(path.join(ingest, 'cache', '..evil', 'publish.json'), '{}');
    assert.strictEqual(files.readRecord(dir, 'doc-bbbbbbbbbbbb'), null);
    assert.deepStrictEqual(files.listRecords(dir).map((r) => r.docId), [rec.docId]);
    assert.deepStrictEqual(files.pendingPublishes(dir), []);
    const leftovers = (d) => fs.readdirSync(d, { recursive: true }).filter((n) => /tmp/.test(n));
    assert.deepStrictEqual(leftovers(ingest), []);
    assert.strictEqual(files.ensureCacheIgnored(dir), true);
    assert.strictEqual(files.ensureCacheIgnored(dir), false);
    assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), `${files.CACHE_IGNORE}\n`);
    assert.match(files.ingestMtime(dir), /^\d{4}-\d\d-\d\dT/);
  });

  it('upsertCase re-indexes a case only when its facts or ingest files changed (M12)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a } = await twoCases();
    const idx = rt.entityIndex();
    idx.rebuild();
    ingested(rt, a);
    let calls = 0;
    const original = idx._index.bind(idx);
    idx._index = (meta) => { calls += 1; return original(meta); };
    idx.upsertCase(a.id);
    idx.upsertCase(a.id);
    assert.strictEqual(calls, 1);
    assert.ok(idx.searchEntities('0042-7781').length > 0);
    assert.strictEqual(calls, 1);
  });

  it('the standalone entityIndex() is the fallback when the cross-case index cannot attach', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { root, a, rt } = await twoCases();
    ingested(rt, a);
    const bare = new CaseRuntime({ root });
    Object.defineProperty(bare, 'index', { value: {} });
    const idx = bare.entityIndex();
    assert.ok(idx instanceof EntityIndex);
    assert.strictEqual(bare.entityIndex(), idx);
    assert.ok(idx.searchEntities('0042-7781').length > 0);
    // The real runtime attaches to C5's CrossCaseIndex.
    const attached = rt.entityIndex();
    assert.strictEqual(rt.index.entities, attached);
  });

  it('nonDisclosableSpans catches spaced, punctuated, hidden-character and fullwidth variants of an indexed id', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a, b } = await twoCases();
    ingested(rt, a);
    const idx = rt.entityIndex();
    const variants = ['0042 7781', '0042.7781', '00427781', '0042 - 7781', '0042/7781', `00${ZWSP}42-7781`, `0042${ZWSP}${ZWSP}-7781`, fullwidth('0042-7781'), '{{f-0042-7781}}'];
    for (const v of variants) {
      const text = `Re: ${v}, thanks`;
      const spans = idx.nonDisclosableSpans(text, { caseId: b.id });
      assert.deepStrictEqual(spans.map((s) => s.entity), ['id:00427781'], v);
      for (const s of spans) assert.strictEqual(text.slice(s.span.start, s.span.end), s.span.text);
    }
    // Part of a longer token is a different value; a comma is not a separator.
    for (const v of ['100427781', '0042-77810', 'A0042-7781', '0042,7781', '0042 _ 7781']) {
      assert.deepStrictEqual(idx.nonDisclosableSpans(`Re: ${v}`, { caseId: b.id }), [], v);
    }
    // A phone number from a text store, written differently.
    assert.deepStrictEqual(idx.nonDisclosableSpans('Dial (555) 0199', { caseId: b.id }).map((s) => s.entity), ['phone:5550199']);
  });

  it('nonDisclosableSpans stays linear on a 400,000-character adversarial payload', async (t) => {
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
    for (const payload of ['1 '.repeat(200000), 'ab '.repeat(133334), '1-'.repeat(100000) + 'ab.'.repeat(66667), `1${ZWSP}${ZWSP} `.repeat(100000)]) {
      const started = process.hrtime.bigint();
      const spans = idx.nonDisclosableSpans(payload, { caseId: b.id });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(spans.length > 0);
      t.diagnostic(`${payload.length} chars, ${spans.length} spans, ${ms.toFixed(1)} ms`);
      assert.ok(ms < 1000, `nonDisclosableSpans took ${ms.toFixed(1)} ms on ${payload.length} characters`);
    }
  });

  it('a cross-case name hit carries the searched key, never the other case\'s spelling', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a, b } = await twoCases({ spanNames: true });
    ingested(rt, a, { entities: [{ type: 'person', text: 'Pat Quincy Rowan Doe Smith' }] });
    const hits = rt.entityIndex().searchEntities({ type: 'person', text: 'Pat Quincy Rowan Doe' }, { excludeCaseId: b.id });
    assert.ok(hits.length > 0);
    for (const h of hits) {
      assert.deepStrictEqual(Object.keys(h).sort(), ['caseId', 'entity', 'id', 'kind', 'score', 'title']);
      assert.strictEqual(h.entity, 'person:pat quincy rowan doe');
      assert.ok(!JSON.stringify(h).includes('smith'));
      assert.ok(!JSON.stringify(h).includes('payoff'));
    }
  });

  it('a forged record cannot borrow a disclosable fact that did not come from its document', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a } = await twoCases();
    const fact = rt.ledger(a.id).assert({
      stmt: 'The owner email is owner@example.com', subject: 'owner', attr: 'email', value: 'owner@example.com',
      category: 'personal', provenance: 'sourced', source: { kind: 'url', ref: 'https://records.example.org/owner' }
    });
    rt.ledger(a.id).setDisclosable(fact.id, true);
    files.writeRecord(a.dir, {
      docId: 'doc-eeeeeeeeeeee', ref: 'sources/2026-09/x.pdf', sha256: 'e'.repeat(64),
      proposals: [{ id: 'p-001', entities: [{ type: 'id', text: 'Loan 0042-7781' }], review: { action: 'accepted', factId: fact.id } }]
    });
    files.writeTextStore(a.dir, { docId: 'doc-eeeeeeeeeeee', sha256: 'e'.repeat(64), pages: [{ n: 1, method: 'text', text: 'Loan No. 0042-7781' }] });
    assert.deepStrictEqual(rt.entityIndex().nonDisclosableSpans('0042-7781', { caseId: a.id }).map((s) => s.entity), ['id:00427781']);
  });

  it('finds an entity after more than one extraction call worth of other entities, when indexing and when scanning', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a, b } = await twoCases();
    // 600 labelled ids fill extractEntities' per-call cap (500) before the
    // one that matters; a three-digit id is too short for the stream scan,
    // so only extraction can find it.
    const filler = (from) => Array.from({ length: 600 }, (_, i) => `Ref ${from + i}`).join('; ');
    files.writeRecord(a.dir, { docId: 'doc-ffffffffffff', ref: 'sources/2026-09/f.pdf', sha256: 'f'.repeat(64), proposals: [] });
    files.writeTextStore(a.dir, { docId: 'doc-ffffffffffff', sha256: 'f'.repeat(64), pages: [{ n: 1, method: 'text', text: `${filler(5000)}; Account 777` }] });
    const spans = rt.entityIndex().nonDisclosableSpans(`${filler(7000)}; see acct 777`, { caseId: b.id });
    assert.deepStrictEqual(spans.map((s) => s.entity), ['id:777']);
  });

  it('fails closed when the cases cannot be listed', () => {
    const idx = new EntityIndex(os.tmpdir(), { store: { list() { throw new Error('EACCES'); } } });
    assert.throws(() => idx.nonDisclosableSpans('0042-7781', { caseId: 'x' }), /EACCES/);
  });

  it('treats .index/entities.json as untrusted: bad shape, version or size means a rebuild', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { root, rt, a, b } = await twoCases();
    ingested(rt, a);
    const built = rt.entityIndex();
    built.rebuild();
    const file = built.file;
    const good = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(good.entities['id:00427781']);
    const forgeries = [
      { ...good, entities: {} , version: 2 },
      { ...good, entities: [] },
      { ...good, entities: { 'id:00427781': { type: 'id', display: 'x', links: [{ caseId: 'no-such-case', factId: null, docId: 'doc-cccccccccccc', disclosable: false }] } } },
      { ...good, entities: { 'id:00427781': { ...good.entities['id:00427781'], type: 'phone' } } },
      { ...good, cases: { [a.id]: good.cases[a.id], [b.id]: 'nope' }, entities: {} },
      { ...good, entities: { 'id:00427781': { type: 'id', display: 'x', links: [{ caseId: a.id, factId: null, docId: '../x', disclosable: false }] } } }
    ];
    const check = (text, opts = {}) => {
      fs.writeFileSync(file, text);
      const idx = new EntityIndex(root, opts);
      assert.deepStrictEqual(idx.nonDisclosableSpans('Re 0042-7781', { caseId: b.id }).map((s) => s.entity), ['id:00427781']);
      // Rebuilt from the cases: exactly what a clean rebuild holds.
      assert.deepStrictEqual(JSON.parse(JSON.stringify(idx.data.entities)), good.entities);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).entities, good.entities);
    };
    for (const f of forgeries) check(JSON.stringify(f));
    // A well-formed but oversized file (it would otherwise hide the entity).
    check(JSON.stringify({ ...good, entities: {} }) + ' '.repeat(4096), { maxFileBytes: 2048 });
    // __proto__ keys neither pollute nor survive as entities.
    check(`{"version":1,"__proto__":{"polluted":1},"cases":{"__proto__":{}},"entities":{"__proto__":{"type":"id"}}}`);
    assert.strictEqual({}.polluted, undefined);
    assert.deepStrictEqual(fs.readdirSync(path.join(root, '.index')).filter((n) => /tmp/.test(n)), []);
  });
});
