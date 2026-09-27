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
    await Promise.resolve(); // the index refreshes at most once per synchronous frame (fix-T7-r1 I5)
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

  it('nonDisclosableSpans catches spaced, punctuated, hidden-character, mark, lookalike-digit and confusable variants (fix-T7-r1 I2, m2)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a, b } = await twoCases();
    ingested(rt, a);
    files.writeTextStore(a.dir, {
      docId: 'doc-cccccccccccc',
      sha256: 'c'.repeat(64),
      pages: [{ n: 1, method: 'text', text: 'Example Bank\nLoan No. 0042-7781\nAccount AB12CD34\nEscrow desk +1 555 0199\nWrite to pat.doe@example.com' }]
    });
    const idx = rt.entityIndex();
    // Distinct entities: the reversed-groups pass over every line may also
    // report a whole line for the same entity (fix-T7-r3 I1).
    const entities = (spans) => [...new Set(spans.map((s) => s.entity))];
    const cp = (base) => (s) => s.replace(/[0-9]/g, (d) => String.fromCodePoint(base + Number(d)));
    const SUPER = [0x2070, 0xb9, 0xb2, 0xb3, 0x2074, 0x2075, 0x2076, 0x2077, 0x2078, 0x2079];
    const CIRCLED = [0x24ea, 0x2460, 0x2461, 0x2462, 0x2463, 0x2464, 0x2465, 0x2466, 0x2467, 0x2468];
    const table = (t2) => (s) => s.replace(/[0-9]/g, (d) => String.fromCodePoint(t2[Number(d)]));
    const TILDE = String.fromCodePoint(0x0303);
    const MIDDOT = String.fromCodePoint(0xb7);
    const ids = [
      '0042 7781', '0042.7781', '00427781', '0042 - 7781', '0042/7781', `00${ZWSP}42-7781`, `0042${ZWSP}${ZWSP}-7781`,
      fullwidth('0042-7781'), '{{f-0042-7781}}',
      // separators: every punctuation, symbol and space character
      '0042,7781', '0042_7781', '0042:7781', '0042*7781', '0042+7781', "0042'7781", `0042${MIDDOT}7781`,
      // digits of other scripts and compatibility forms
      cp(0x0966)('0042-7781'), cp(0x1d7ce)('0042-7781'), table(SUPER)('0042-7781'), table(CIRCLED)('0042-7781'),
      // a combining mark inside
      `00${TILDE}42-7781`,
      // a letter/digit transition is a unit boundary
      'A0042-7781', 'Loan0042-7781', 'x0042-7781y'
    ];
    for (const v of ids) {
      const text = `Re: ${v}, thanks`;
      const spans = idx.nonDisclosableSpans(text, { caseId: b.id });
      // The value itself; the whole line may be reported too, by the
      // reversed-groups pass that reads every line (fix-T7-r3 I1).
      assert.ok(spans.some((s) => s.entity === 'id:00427781' && s.span.text.length < text.length), v);
      assert.ok(spans.every((s) => s.entity === 'id:00427781' && (s.span.text.length < text.length || s.span.text === text)), v);
      for (const s of spans) assert.strictEqual(text.slice(s.span.start, s.span.end), s.span.text);
    }
    // Cyrillic capitals that look like Latin ones.
    const cyr = `${String.fromCodePoint(0x0410)}${String.fromCodePoint(0x0412)}12${String.fromCodePoint(0x0421)}D34`;
    assert.deepStrictEqual(entities(idx.nonDisclosableSpans(`Account ${cyr}`, { caseId: b.id })), ['id:AB12CD34']);
    // Part of a longer digit run is a different value; four spaces are too wide a gap.
    for (const v of ['100427781', '0042-77810', '0042    7781']) {
      assert.deepStrictEqual(idx.nonDisclosableSpans(`Re: ${v}`, { caseId: b.id }), [], v);
    }
    // A phone number from a text store, written differently.
    for (const v of ['Dial (555) 0199', 'Dial 555,0199']) {
      assert.deepStrictEqual(entities(idx.nonDisclosableSpans(v, { caseId: b.id })), ['phone:5550199'], v);
    }
    // Emails: a line break or spaces around the at sign, a fullwidth at sign.
    for (const v of ['pat.doe@\nexample.com', `pat.doe${String.fromCodePoint(0xff20)}example.com`, 'pat.doe @ example.com']) {
      assert.deepStrictEqual(entities(idx.nonDisclosableSpans(`Mail ${v} today`, { caseId: b.id })), ['email:pat.doe@example.com'], v);
    }
    // The same letters without an at sign, or joined by a comma, are not the email.
    for (const v of ['pat doe example com', 'pat.doe, example.com']) {
      assert.deepStrictEqual(idx.nonDisclosableSpans(`Mail ${v} today`, { caseId: b.id }), [], v);
    }
  });

  it('nonDisclosableSpans reads bidi runs and right-to-left lines in display order too (fix-T7-r1 I3, fix-T7-r2 R1)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a, b } = await twoCases();
    ingested(rt, a);
    const idx = rt.entityIndex();
    const c = (n) => String.fromCodePoint(n);
    const [RLO, LRO, LRE, PDF, RLI, PDI, RLM] = [0x202e, 0x202d, 0x202a, 0x202c, 0x2067, 0x2069, 0x200f].map(c);
    const ALEF = c(0x05d0);
    const BEH = c(0x0628);
    // Controlled runs reach the end of their line, whatever pops they hold.
    for (const run of [`${RLO}1877-2400${PDF}`, `${RLI}7781-0042${PDI}`, `${RLO}${LRE}${PDF}1877-2400`, `${RLO}${LRO}x${PDF}1877-2400`]) {
      const text = `Loan ${run} closes\nNext line`;
      const spans = idx.nonDisclosableSpans(text, { caseId: b.id });
      // The controlled run; the reversed-groups pass over every line may
      // report the whole line as well (fix-T7-r3 I1).
      assert.ok(spans.some((s) => s.entity === 'id:00427781' && s.span.text === `${run} closes`), run);
      assert.ok(spans.every((s) => s.entity === 'id:00427781' && [`${run} closes`, `Loan ${run} closes`].includes(s.span.text)), run);
    }
    // No control at all: a right-to-left letter or mark reorders the line.
    for (const line of [`${ALEF} 7781 0042`, `${BEH} 7781 0042`, `${BEH} 7781-0042`, `7781 ${RLM} 0042`]) {
      const spans = idx.nonDisclosableSpans(`First\n${line}\nLast`, { caseId: b.id });
      assert.deepStrictEqual(spans.map((s) => [s.entity, s.span.text]), [['id:00427781', line]], line);
    }
    assert.deepStrictEqual(idx.nonDisclosableSpans(`Loan ${RLO}1234-5678${PDF}`, { caseId: b.id }), []);
    assert.deepStrictEqual(idx.nonDisclosableSpans(`${ALEF} 1234 5678`, { caseId: b.id }), []);
  });

  it('reads every line with its groups reversed, right-to-left letters or not (fix-T7-r3 I1)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { gateLeaves } = require('../src/cases/gates');
    const { rt, a, b } = await twoCases();
    ingested(rt, a);
    const idx = rt.entityIndex();
    const HEB = [0x05d0, 0x05d1, 0x05d2].map((c) => String.fromCodePoint(c)).join('');
    assert.deepStrictEqual(idx.nonDisclosableSpans('7781 0042', { caseId: b.id }).map((s) => s.entity), ['id:00427781']);
    const r = gateLeaves({ t: `${HEB} hello\n7781 0042` }, { facts: new Map(), caseId: b.id, entityIndex: idx, mode: 'query' });
    assert.ok(r.blocked.some((x) => x.path === 't' && x.reason === 'non-disclosable-entity' && x.span.text === '7781 0042'));
  });

  it('counts cross-field distance in fields, not keys and values (fix-T7-r3 m1)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { gateLeaves } = require('../src/cases/gates');
    const { rt, a, b } = await twoCases();
    ingested(rt, a);
    // 58 fields; the halves sit 8 fields apart (7 fields between them).
    const payload = {};
    for (let i = 0; i < 25; i++) payload[`before${i}`] = `note ${i}`;
    payload.first = 'Loan 0042';
    for (let i = 0; i < 7; i++) payload[`between${i}`] = `note ${i}`;
    payload.second = '7781 due';
    for (let i = 0; i < 24; i++) payload[`after${i}`] = `note ${i}`;
    assert.strictEqual(Object.keys(payload).length, 58);
    const r = gateLeaves(payload, { facts: new Map(), caseId: b.id, entityIndex: rt.entityIndex(), mode: 'query' });
    assert.ok(r.blocked.some((x) => x.path === '' && x.reason === 'non-disclosable-entity' && x.detail.startsWith('id:00427781')));
  });

  it('scans all bidi runs of a text in one batched pass per order (fix-T7-r2 R2)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a, b } = await twoCases();
    ingested(rt, a);
    const idx = rt.entityIndex();
    const RLO = String.fromCodePoint(0x202e);
    let scans = 0;
    const real = idx._scan.bind(idx);
    idx._scan = (...args) => { scans += 1; return real(...args); };
    const text = `${`${RLO}12 34\n`.repeat(1000)}${RLO}1877-2400`;
    const spans = idx.nonDisclosableSpans(text, { caseId: b.id });
    assert.deepStrictEqual(spans.map((s) => s.span.text), [`${RLO}1877-2400`]);
    assert.strictEqual(scans, 3); // the text, the reversed runs, the regrouped runs
  });

  it('private-use and unassigned code points are separators (fix-T7-r2 r3)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a, b } = await twoCases();
    ingested(rt, a);
    for (const cp of [0xe000, 0xf8ff, 0x0378]) {
      const text = `Re 0042${String.fromCodePoint(cp)}7781`;
      assert.deepStrictEqual(rt.entityIndex().nonDisclosableSpans(text, { caseId: b.id }).map((s) => s.entity), ['id:00427781'], cp.toString(16));
    }
  });

  it('the word stream folds Latin look-alikes (fix-T7-r2 r4)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a, b } = await twoCases();
    ingested(rt, a);
    files.writeTextStore(a.dir, { docId: 'doc-cccccccccccc', sha256: 'c'.repeat(64), pages: [{ n: 1, method: 'text', text: 'Office at 12 Birch Street' }] });
    const text = `Meet at 12 B${String.fromCodePoint(0x0456)}rch Street`;
    assert.deepStrictEqual(rt.entityIndex().nonDisclosableSpans(text, { caseId: b.id }).map((s) => s.entity), ['address:12 birch street']);
  });

  it('a decimal amount is not a phone number (fix-T7-r2 r5)', () => {
    assert.deepStrictEqual(extractEntities('Payoff 182340.17 due').filter((e) => e.type === 'phone'), []);
    assert.deepStrictEqual(extractEntities('is $182,340.17\n182340.17').filter((e) => e.type === 'phone'), []);
    assert.deepStrictEqual(extractEntities('call 555.0199').map((e) => e.keys[0]), ['phone:5550199']);
  });

  it('gateLeaves reads keys, numbers and non-neighbouring fields together (fix-T7-r2 r1)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { gateLeaves } = require('../src/cases/gates');
    const { rt, a, b } = await twoCases();
    ingested(rt, a);
    const gate = (payload) => gateLeaves(payload, { facts: new Map(), caseId: b.id, entityIndex: rt.entityIndex(), mode: 'query' });
    for (const payload of [{ a: 'Loan 0042', b: 'hello', c: '7781' }, { '0042': '7781' }, { a: 'Loan 0042', n: 7781 }, { c: '7781 due', b: 'hello', a: 'Loan 0042' }, { 'Loan 0042-7781': 'x' }]) {
      const r = gate(payload);
      assert.ok(r.blocked.some((x) => x.path === '' && x.reason === 'non-disclosable-entity' && x.detail.startsWith('id:00427781')), JSON.stringify(payload));
    }
    assert.strictEqual(gate({ a: 'Loan 0042', b: 'hello', c: 'due 7782' }).ok, true);
  });

  it('gateLeaves blocks on a malformed span from any of its index reads (fix-T7-r2 r2)', () => {
    const { gateLeaves } = require('../src/cases/gates');
    const entityIndex = { nonDisclosableSpans: (text) => (text.includes('\n') ? [{ span: { start: -1, end: 2 }, entity: 'x' }] : []) };
    const r = gateLeaves({ a: 'hello', b: 'world' }, { facts: new Map(), caseId: 'c', entityIndex, mode: 'query' });
    assert.ok(r.blocked.some((x) => x.reason === 'non-disclosable-entity' && x.detail === 'a malformed entity span'));
  });

  it('gateLeaves scans the rendered text: a disclosable value spliced into an entity is blocked (fix-T7-r1 I1)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { gateLeaves } = require('../src/cases/gates');
    const { rt, a, b } = await twoCases();
    ingested(rt, a);
    const part = rt.ledger(b.id).assert({
      stmt: 'The branch code is 0042', subject: 'branch', attr: 'code', value: '0042',
      category: 'other', provenance: 'sourced', source: { kind: 'url', ref: 'https://records.example.org/branch' }
    });
    rt.ledger(b.id).setDisclosable(part.id, true);
    await Promise.resolve();
    const facts = rt.ledger(b.id).view().facts;
    const entityIndex = rt.entityIndex();
    const gate = (payload) => gateLeaves(payload, { facts, caseId: b.id, entityIndex, mode: 'query' });
    for (const text of [`Loan {{${part.id}}}-7781`, `{{${part.id}}}7781`]) {
      const r = gate({ text });
      const hits = r.blocked.filter((x) => x.reason === 'non-disclosable-entity');
      assert.strictEqual(hits.length, 1, text);
      assert.strictEqual(hits[0].path, 'text');
      assert.ok(hits[0].detail.startsWith('id:00427781'), hits[0].detail);
      assert.strictEqual(text.slice(hits[0].span.start, hits[0].span.end), hits[0].span.text);
    }
    assert.strictEqual(gate({ text: `Branch {{${part.id}}} is open.` }).ok, true);
  });

  it('gateLeaves reads string leaves together: an entity split across fields is blocked (fix-T7-r1 m1)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { gateLeaves } = require('../src/cases/gates');
    const { rt, a, b } = await twoCases();
    ingested(rt, a);
    const r = gateLeaves({ subject: 'Loan 0042', body: '7781 due' }, { facts: new Map(), caseId: b.id, entityIndex: rt.entityIndex(), mode: 'query' });
    assert.deepStrictEqual(r.blocked.map((x) => [x.path, x.reason, x.span.text]), [['', 'non-disclosable-entity', '0042\n7781']]);
    assert.strictEqual(gateLeaves({ subject: 'Loan 0042', body: 'due Friday' }, { facts: new Map(), caseId: b.id, entityIndex: rt.entityIndex(), mode: 'query' }).ok, true);
  });

  it('refreshes at most once per synchronous frame, and sees a change after a microtask (fix-T7-r1 I5)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { gateLeaves } = require('../src/cases/gates');
    const { CaseStore } = require('../src/cases/case-store');
    const { root, rt, a, b } = await twoCases();
    const real = new CaseStore({ root });
    let lists = 0;
    const store = { list() { lists += 1; return real.list(); } };
    const idx = new EntityIndex(root, { store });
    idx.nonDisclosableSpans('warm up', { caseId: b.id });
    await Promise.resolve();
    lists = 0;
    const payload = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`field${i}`, `value ${i}`]));
    assert.strictEqual(gateLeaves(payload, { facts: new Map(), caseId: b.id, entityIndex: idx, mode: 'query' }).ok, true);
    assert.strictEqual(lists, 1);
    ingested(rt, a);
    await Promise.resolve();
    assert.deepStrictEqual(idx.nonDisclosableSpans('Re 0042-7781', { caseId: b.id }).map((s) => s.entity), ['id:00427781']);
    assert.strictEqual(lists, 2);
  });

  it('indexes a fact statement and value separately (fix-T7-r1 m5)', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { rt, a } = await twoCases();
    ingested(rt, a);
    const idx = rt.entityIndex();
    idx.rebuild();
    // "…is $182,340.17" then "182340.17": joined by a line break they read
    // as the phone number 3401718234017.
    assert.strictEqual(idx.data.entities['phone:3401718234017'], undefined);
    assert.ok(idx.data.entities['id:00427781']);
  });

  it('refuses a FIFO in place of the index file (fix-T7-r1 m4)', async (t) => {
    if (process.platform === 'win32') return t.skip('no FIFOs on Windows');
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { execFileSync } = require('child_process');
    const { root, rt, a, b } = await twoCases();
    ingested(rt, a);
    fs.mkdirSync(path.join(root, '.index'), { recursive: true });
    const file = path.join(root, '.index', 'entities.json');
    fs.rmSync(file, { force: true });
    execFileSync('mkfifo', ['--', file]);
    const idx = new EntityIndex(root);
    assert.deepStrictEqual(idx.nonDisclosableSpans('Re 0042-7781', { caseId: b.id }).map((s) => s.entity), ['id:00427781']);
    assert.ok(fs.lstatSync(file).isFile());
  });

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
      assert.ok(ms < 3000, `nonDisclosableSpans took ${ms.toFixed(1)} ms on ${payload.length} characters`);
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
      { ...good, entities: {}, extractor: 'rules-of-an-older-build' },
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
