// tests/cases-index.test.js
// The cross-case index (cases stage 5 spec §3.1): relevance, keys,
// freshness, storage, failure modes and redaction inside the index.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const { CaseStore } = require('../src/cases/case-store');
const { FactLedger } = require('../src/cases/ledger');
const { Brief } = require('../src/cases/brief');
const { CaseRecords } = require('../src/cases/records');
const { QuestionStore } = require('../src/cases/questions');
const git = require('../src/cases/git');
const { CrossCaseIndex } = require('../src/cases/index-store');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-index-')); dirs.push(d); return d; };
const web = (n) => ({ kind: 'url', ref: `https://records.example.org/${n}` });

const CORPUS = [
  ['Sell the lakeside lot', 'Convert the lakeside lot to cash'],
  ['Rear door quotes', 'Three written quotes for replacing the rear door'],
  ['Phone agent maintenance', 'Keep the phone agent answering and reporting call status'],
  ['Website redesign', 'Refresh the public website'],
  ['Household inventory', 'List everything in the house with a value'],
  ['Garage sale', 'Clear the garage before winter'],
  ['Tax filing 2026', 'File the 2026 return on time'],
  ['Roof inspection', 'Get the roof inspected before the rainy season'],
  ['Car registration', 'Renew the car registration'],
  ['Well water test', 'Test the well water for the lakeside lot buyer'],
  ['Insurance renewal', 'Compare home insurance renewals'],
  ['Dentist booking', 'Book the dentist for the family']
];

// The storage tests need only four cases; each case is a git repo to create.
const SMALL = [CORPUS[0], CORPUS[1], CORPUS[2], CORPUS[5]];

async function corpus(rows = CORPUS) {
  const root = tmp();
  const store = new CaseStore({ root });
  const byTitle = {};
  for (const [title, objective] of rows) byTitle[title] = await store.create({ title, objective });
  const lot = byTitle['Sell the lakeside lot'];
  new FactLedger(lot.dir).assert({ stmt: 'County GIS polygon computes 1.85 acres', subject: 'lot', attr: 'acreage', value: 1.85, unit: 'acre', source: web(1) });
  new FactLedger(lot.dir).assert({ stmt: 'Parcel 0412-775 has frontage on the lake', subject: 'lot', attr: 'frontage', value: 'yes', source: web(2) });
  const phone = byTitle['Phone agent maintenance'];
  new FactLedger(phone.dir).assert({ stmt: 'Status polling reports dropped calls as completed', subject: 'phone-agent', attr: 'status-polling', value: 'broken', source: web(3) });
  const house = byTitle['Household inventory'];
  if (house) new FactLedger(house.dir).assert({ stmt: 'Payoff letter for the house loan, good through the 7th', subject: 'house-loan', attr: 'payoff', value: 120000, category: 'financial', source: { kind: 'document', ref: 'sources/payoff-letter.pdf' } });
  const site = byTitle['Website redesign'];
  if (!site) {
    for (const c of Object.values(byTitle)) await git.commitAll(c.dir, 'fixtures');
    return { root, store, byTitle };
  }
  new Brief(site.dir).update('why', 'Customers cannot find the booking page', { provenance: 'user' });
  new Brief(site.dir).update('hardConstraints', ['Keep the hosting bill under 20 dollars'], { provenance: 'user' });
  new QuestionStore(site.dir).create({ kind: 'question', text: 'Which hosting plan should the new site use?', urgency: 'normal', options: [{ id: 'a', label: 'Static hosting' }] });
  new CaseRecords(site.dir).writeJournal('plan', '# Plan\n\nMigrate the booking page to the static generator', new Date('2026-09-20T10:00:00Z'));
  for (const c of Object.values(byTitle)) await git.commitAll(c.dir, 'fixtures');
  return { root, store, byTitle };
}

const allFiles = (dir) => (fs.existsSync(dir)
  ? fs.readdirSync(dir, { recursive: true }).filter((n) => fs.statSync(path.join(dir, n)).isFile()).sort()
  : []);

describe('CrossCaseIndex relevance and keys', () => {
  let c;
  before(async () => { c = await corpus(); });

  it('ranks the case that is about the query first', () => {
    const idx = new CrossCaseIndex(c.root);
    const hits = idx.search({ text: 'lakeside lot acres' });
    assert.strictEqual(hits[0].title, 'Sell the lakeside lot');
    assert.strictEqual(hits.find((h) => h.kind === 'fact').id, 'f-0001');
    assert.strictEqual(idx.search({ text: 'acreage polygon' })[0].id, 'f-0001');
    const cases = idx.searchCases({ text: 'phone agent status polling dropped calls' });
    assert.strictEqual(cases[0].title, 'Phone agent maintenance');
    assert.deepStrictEqual(Object.keys(cases[0]).sort(), ['caseId', 'created', 'hits', 'score', 'slug', 'status', 'title']);
    assert.strictEqual(idx.searchCases({ text: 'dentist' }).length, 0, 'one matched token is not enough');
    assert.deepStrictEqual(idx.searchCases({ text: 'book the dentist for the family' }).map((r) => r.title), ['Dentist booking']);
  });

  it('returns a same subject-and-attribute fact at zero text overlap', () => {
    const idx = new CrossCaseIndex(c.root);
    const hits = idx.search({ text: 'zzz qqq', subject: 'LOT', attr: 'Acreage' });
    assert.deepStrictEqual(hits.map((h) => [h.title, h.id]), [['Sell the lakeside lot', 'f-0001']]);
    assert.strictEqual(hits[0].score, 5);
  });

  it('filters by kind, excluded case and status after scoring', () => {
    const idx = new CrossCaseIndex(c.root);
    const lot = c.byTitle['Sell the lakeside lot'];
    const hits = idx.search({ text: 'lakeside lot', kinds: ['brief'], excludeCaseId: lot.id });
    assert.ok(hits.length > 0);
    assert.ok(hits.every((h) => h.kind === 'brief' && h.caseId !== lot.id));
    assert.deepStrictEqual(idx.search({ text: 'lakeside lot', statuses: ['active'] }), []);
  });

  it('hides other cases\' private text inside the index and shows the caller its own', () => {
    const idx = new CrossCaseIndex(c.root);
    const house = c.byTitle['Household inventory'];
    const lot = c.byTitle['Sell the lakeside lot'];
    const [asOther] = idx.search({ text: 'house loan payoff letter', forCaseId: lot.id, kinds: ['fact'] });
    assert.deepStrictEqual([asOther.caseId, asOther.text, asOther.redacted, asOther.disclosable], [house.id, null, true, false]);
    assert.deepStrictEqual([asOther.subject, asOther.attr], [null, null], 'a redacted fact keeps its private slugs');
    assert.ok(!JSON.stringify(asOther).includes('house-loan'));
    assert.ok(!JSON.stringify(asOther).includes('payoff'));
    const [byKey] = idx.search({ text: 'zzz', subject: 'house-loan', attr: 'payoff', forCaseId: lot.id });
    assert.deepStrictEqual([byKey.caseId, byKey.text, byKey.subject, byKey.attr], [house.id, null, 'house-loan', 'payoff'], 'the caller named this pair');
    const [asOwner] = idx.search({ text: 'house loan payoff letter', forCaseId: house.id, kinds: ['fact'] });
    assert.match(asOwner.text, /Payoff letter/);
    assert.strictEqual(asOwner.redacted, false);
    const [noCaller] = idx.search({ text: 'house loan payoff letter', kinds: ['fact'] });
    assert.strictEqual(noCaller.text, null, 'a missing forCaseId treats every hit as cross-case');
    const [publicFact] = idx.search({ text: 'county gis polygon', forCaseId: house.id });
    assert.match(publicFact.text, /1\.85 acres/);
  });

  it('owner-only brief fields of B are redacted', () => {
    const idx = new CrossCaseIndex(c.root);
    const lot = c.byTitle['Sell the lakeside lot'];
    const hits = idx.search({ text: 'booking page hosting bill dollars website', forCaseId: lot.id, kinds: ['brief'] });
    const byId = Object.fromEntries(hits.filter((h) => h.title === 'Website redesign').map((h) => [h.id, h]));
    assert.strictEqual(byId.why.text, null);
    assert.strictEqual(byId.why.redacted, true);
    assert.strictEqual(byId.hardConstraints.text, null);
    assert.strictEqual(byId.title.text, 'Website redesign');
    assert.strictEqual(byId.objective.text, 'Refresh the public website');
    assert.ok(!JSON.stringify(hits).includes('Customers cannot find'));
    assert.ok(!JSON.stringify(hits).includes('under 20 dollars'));
  });

  it('questions and journal titles of B are redacted', () => {
    const idx = new CrossCaseIndex(c.root);
    const lot = c.byTitle['Sell the lakeside lot'];
    const hits = idx.search({ text: 'hosting plan static booking page generator migrate', forCaseId: lot.id });
    const q = hits.find((h) => h.kind === 'question');
    const j = hits.find((h) => h.kind === 'journal');
    assert.deepStrictEqual([q.text, q.redacted, q.attr, q.id], [null, true, 'open', 'q-0001']);
    // A journal file name (and its kind) can be hand-written and carry
    // private words, so a redacted journal hit names neither.
    assert.deepStrictEqual([j.text, j.redacted, j.id, j.attr], [null, true, null, null]);
    const site = c.byTitle['Website redesign'];
    const own = idx.search({ text: 'migrate booking page static generator', forCaseId: site.id, kinds: ['journal'] })[0];
    assert.match(own.id, /-plan\.md$/);
    assert.strictEqual(own.attr, 'plan');
    const blob = JSON.stringify([hits, idx.searchCases({ text: 'hosting plan static booking page generator', forCaseId: lot.id })]);
    assert.ok(!blob.includes('Which hosting plan'));
    assert.ok(!blob.includes('Static hosting'));
    assert.ok(!blob.includes('Migrate the booking page'));
  });

  it('no caller outside index-store passes includePrivate', () => {
    const srcRoot = path.join(__dirname, '..', 'src');
    const offenders = fs.readdirSync(srcRoot, { recursive: true })
      .filter((n) => n.endsWith('.js'))
      .filter((n) => path.basename(n) !== 'index-store.js')
      .filter((n) => fs.readFileSync(path.join(srcRoot, n), 'utf8').includes('includePrivate'));
    assert.deepStrictEqual(offenders, []);
  });

  it('leaves every case repository clean after a build', () => {
    const idx = new CrossCaseIndex(c.root);
    idx.rebuild();
    for (const meta of c.store.list()) {
      assert.strictEqual(execFileSync('git', ['-C', meta.dir, 'status', '--porcelain'], { encoding: 'utf8' }), '', meta.title);
    }
    assert.strictEqual(fs.readFileSync(path.join(c.root, '.index', '.gitignore'), 'utf8'), '*\n');
  });
});

describe('CrossCaseIndex storage and freshness', () => {
  // Each case is a git repo, slow to create on Windows: build the small
  // corpus once and give every test that mutates it its own copy.
  let template;
  before(async () => { template = await corpus(SMALL); });
  const smallCorpus = () => {
    const root = tmp();
    fs.cpSync(template.root, root, { recursive: true });
    const byTitle = Object.fromEntries(Object.entries(template.byTitle)
      .map(([title, meta]) => [title, { ...meta, dir: path.join(root, path.basename(meta.dir)) }]));
    return { root, store: new CaseStore({ root }), byTitle };
  };

  it('sees a retracted fact and an owner edit to brief.md without a manual upsert', async () => {
    const { root, byTitle } = smallCorpus();
    const idx = new CrossCaseIndex(root);
    const lot = byTitle['Sell the lakeside lot'];
    assert.strictEqual(idx.search({ text: 'frontage lake parcel' })[0].id, 'f-0002');
    new FactLedger(lot.dir).retract('f-0002', 'wrong parcel');
    assert.ok(!idx.search({ text: 'frontage lake parcel' }).some((h) => h.id === 'f-0002'));
    const brief = path.join(lot.dir, 'brief.md');
    fs.writeFileSync(brief, fs.readFileSync(brief, 'utf8').replace('objective: Convert the lakeside lot to cash', 'objective: Auction the waterfront parcel'));
    const [hit] = idx.search({ text: 'auction waterfront', kinds: ['brief'] });
    assert.deepStrictEqual([hit.caseId, hit.id, hit.text], [lot.id, 'objective', 'Auction the waterfront parcel']);
    assert.strictEqual(idx.openCaseHeads().find((h) => h.caseId === lot.id).objective, 'Auction the waterfront parcel');
  });

  it('rebuild gives byte-identical files to incremental upserts', async () => {
    const { root, byTitle } = smallCorpus();
    const idx = new CrossCaseIndex(root);
    idx.rebuild();
    const lot = byTitle['Sell the lakeside lot'];
    new FactLedger(lot.dir).assert({ stmt: 'Survey stakes found at all four corners', subject: 'lot', attr: 'survey', value: 'found', source: web(4) });
    assert.deepStrictEqual(idx.upsertCase(lot.id), { docs: 5 });
    const read = () => Object.fromEntries(allFiles(path.join(root, '.index', 'cases')).map((n) => [n, fs.readFileSync(path.join(root, '.index', 'cases', n), 'utf8')]));
    const incremental = read();
    const result = new CrossCaseIndex(root).rebuild();
    assert.strictEqual(result.cases, 4);
    assert.deepStrictEqual(read(), incremental);
    const file = JSON.parse(incremental[`${lot.id}.json`]);
    assert.deepStrictEqual(Object.keys(file), ['caseId', 'slug', 'title', 'objective', 'type', 'status', 'created', 'keys', 'fingerprint', 'docs']);
    assert.deepStrictEqual(Object.keys(file.fingerprint), ['case.yaml', 'facts.jsonl', 'brief.md', '.kl/questions', 'journal', '.kl/case-type.json']);
  });

  it('rebuilds when meta.json is of another version, and a corrupt case file self-heals', async () => {
    const { root, byTitle } = smallCorpus();
    new CrossCaseIndex(root).rebuild();
    const meta = path.join(root, '.index', 'meta.json');
    fs.writeFileSync(meta, JSON.stringify({ version: 0, tokenizer: 'old', builtAt: '2026-01-01T00:00:00Z' }));
    const stray = path.join(root, '.index', 'cases', 'gone-1234.json');
    fs.writeFileSync(stray, '{}');
    const idx = new CrossCaseIndex(root);
    assert.ok(idx.search({ text: 'lakeside' }).length > 0);
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    assert.deepStrictEqual([m.version, m.tokenizer], [1, 'kl-bm25-v1']);
    assert.strictEqual(fs.existsSync(stray), false);

    const lot = byTitle['Sell the lakeside lot'];
    const file = path.join(root, '.index', 'cases', `${lot.id}.json`);
    fs.writeFileSync(file, 'not json{');
    const fresh = new CrossCaseIndex(root);
    assert.strictEqual(fresh.search({ text: 'county gis polygon' })[0].caseId, lot.id);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).caseId, lot.id);
    fs.writeFileSync(file, JSON.stringify({ caseId: 'someone-else', docs: [] }));
    const again = new CrossCaseIndex(root);
    assert.strictEqual(again.search({ text: 'county gis polygon' })[0].caseId, lot.id);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).caseId, lot.id);
  });

  it('runs in memory when .index cannot be written', async () => {
    const root = tmp();
    const store = new CaseStore({ root });
    const lot = await store.create({ title: 'Sell the lakeside lot', objective: 'Convert the lakeside lot to cash' });
    fs.writeFileSync(path.join(root, '.index'), 'a file where the directory should be');
    const idx = new CrossCaseIndex(root);
    assert.strictEqual(idx.search({ text: 'lakeside lot' })[0].caseId, lot.id);
    assert.strictEqual(idx.memoryOnly, true);
    assert.deepStrictEqual(idx.upsertCase(lot.id), { docs: 2 });
  });

  it('caps text at 2,000 characters and a case at 5,000 documents, newest first', async () => {
    const root = tmp();
    const store = new CaseStore({ root });
    const big = await store.create({ title: 'Big case', objective: 'Hold many facts' });
    new FactLedger(big.dir).assert({ stmt: `Long statement ${'word '.repeat(700)}`, subject: 'x', attr: 'long', source: web(5) });
    const lines = [];
    for (let n = 2; n <= 5010; n += 1) {
      const id = `f-${String(n).padStart(4, '0')}`;
      lines.push(JSON.stringify({ kind: 'fact', id, stmt: `Fact number ${n}`, subject: 's', attr: `a${n}`, value: null, unit: null, provenance: 'sourced', source: web(n), confidence: null, category: null, disclosable: true, loadBearing: false, supersedes: null, basis: [], changes: null, answerable: null, how: null, addedBy: null, at: new Date(Date.now() + n * 1000).toISOString() }));
    }
    fs.appendFileSync(path.join(big.dir, 'facts.jsonl'), `${lines.join('\n')}\n`);
    const idx = new CrossCaseIndex(root);
    idx.rebuild();
    const rec = JSON.parse(fs.readFileSync(path.join(root, '.index', 'cases', `${big.id}.json`), 'utf8'));
    assert.strictEqual(rec.docs.length, 5000);
    assert.ok(rec.docs.some((d) => d.id === 'f-5010'), 'the newest fact is kept');
    assert.ok(!rec.docs.some((d) => d.id === 'f-0001'), 'the oldest fact is dropped');
    assert.ok(rec.docs.every((d) => d.text.length <= 2000));
    assert.ok(rec.docs.some((d) => d.id === 'title'));
  });

  it('id traversal: a case.yaml id outside the pattern is skipped and writes nothing outside .index', async () => {
    const root = tmp();
    const store = new CaseStore({ root });
    const bad = await store.create({ title: 'Odd case', objective: 'Nothing' });
    const file = path.join(bad.dir, 'case.yaml');
    fs.writeFileSync(file, yaml.dump({ ...yaml.load(fs.readFileSync(file, 'utf8')), id: '../x' }));
    const idx = new CrossCaseIndex(root);
    const before = allFiles(root).filter((n) => !n.startsWith('.index'));
    idx.rebuild();
    assert.deepStrictEqual(idx.upsertCase('../x'), { skipped: 'bad-id' });
    assert.deepStrictEqual(idx.search({ text: 'odd case' }), []);
    assert.deepStrictEqual(allFiles(root).filter((n) => !n.startsWith('.index')), before);
    assert.deepStrictEqual(allFiles(path.join(root, '.index', 'cases')), []);
    assert.strictEqual(fs.existsSync(path.join(root, 'x.json')), false);
  });

  it('deleted case: no hit, and its index file is gone', async () => {
    const { root, byTitle } = smallCorpus();
    const idx = new CrossCaseIndex(root);
    const garage = byTitle['Garage sale'];
    assert.strictEqual(idx.search({ text: 'garage winter' })[0].caseId, garage.id);
    fs.rmSync(garage.dir, { recursive: true, force: true });
    assert.ok(!idx.search({ text: 'garage winter' }).some((h) => h.caseId === garage.id));
    assert.strictEqual(fs.existsSync(path.join(root, '.index', 'cases', `${garage.id}.json`)), false);
    assert.deepStrictEqual(idx.upsertCase(garage.id), { removed: true });
  });

  it('two instances on one root converge', async () => {
    const { root, byTitle } = smallCorpus();
    const a = new CrossCaseIndex(root);
    const b = new CrossCaseIndex(root);
    a.search({ text: 'x' });
    b.search({ text: 'x' });
    const lot = byTitle['Sell the lakeside lot'];
    new FactLedger(lot.dir).assert({ stmt: 'Buyer asked about the boat dock', subject: 'lot', attr: 'dock', source: web(6) });
    a.upsertCase(lot.id);
    assert.strictEqual(b.search({ text: 'boat dock' })[0].caseId, lot.id);
    const snapshot = () => allFiles(path.join(root, '.index', 'cases')).map((n) => fs.readFileSync(path.join(root, '.index', 'cases', n), 'utf8'));
    const converged = snapshot();
    new CrossCaseIndex(root).rebuild();
    assert.deepStrictEqual(snapshot(), converged);
  });

  it('delegates rebuild, upsertCase and removeCase to an attached entity index', async () => {
    const root = tmp();
    const store = new CaseStore({ root });
    const one = await store.create({ title: 'Sell the lakeside lot' });
    const idx = new CrossCaseIndex(root);
    assert.strictEqual(idx.entities, null);
    const calls = [];
    idx.attachEntities({
      rebuild: () => calls.push(['rebuild']),
      upsertCase: (id) => calls.push(['upsertCase', id]),
      removeCase: (id) => { calls.push(['removeCase', id]); throw new Error('entity store down'); }
    });
    idx.rebuild();
    idx.upsertCase(one.id);
    idx.removeCase(one.id);
    assert.deepStrictEqual(calls, [['rebuild'], ['upsertCase', one.id], ['removeCase', one.id]]);
  });

  it('an unreadable case directory skips that part and leaves the other cases searchable', async () => {
    const { root, byTitle } = smallCorpus();
    const garage = byTitle['Garage sale'];
    const lot = byTitle['Sell the lakeside lot'];
    const realReaddir = fs.readdirSync;
    fs.readdirSync = function readdirSync(p, ...rest) {
      if (String(p).startsWith(garage.dir)) throw Object.assign(new Error(`EACCES: permission denied, scandir '${p}'`), { code: 'EACCES' });
      return realReaddir.call(fs, p, ...rest);
    };
    try {
      const idx = new CrossCaseIndex(root);
      assert.strictEqual(idx.search({ text: 'county gis polygon' })[0].caseId, lot.id);
      assert.strictEqual(idx.search({ text: 'garage winter' })[0].caseId, garage.id);
      assert.ok('docs' in idx.upsertCase(garage.id));
      assert.ok(idx.rebuild().cases >= 4);
    } finally {
      fs.readdirSync = realReaddir;
    }
  });

  it('a stored record of the wrong shape is stale and rebuilt', async () => {
    const { root, byTitle } = smallCorpus();
    new CrossCaseIndex(root).rebuild();
    const lot = byTitle['Sell the lakeside lot'];
    const file = path.join(root, '.index', 'cases', `${lot.id}.json`);
    const good = fs.readFileSync(file, 'utf8');
    const rec = JSON.parse(good);
    for (const broken of [
      { ...rec, docs: rec.docs.map((d, i) => (i === 0 ? { ...d, tf: null } : d)) },
      { ...rec, docs: [null] },
      { ...rec, keys: 'repo:x' },
      { ...rec, created: 7 },
      { ...rec, title: null }
    ]) {
      fs.writeFileSync(file, JSON.stringify(broken));
      const idx = new CrossCaseIndex(root);
      assert.strictEqual(idx.search({ text: 'county gis polygon' })[0].caseId, lot.id);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), good);
    }
  });

  it('Windows reserved device names are bad ids', () => {
    const idx = new CrossCaseIndex(tmp());
    for (const id of ['CON', 'prn', 'Aux', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9']) {
      assert.deepStrictEqual(idx.upsertCase(id), { skipped: 'bad-id' }, id);
    }
    assert.deepStrictEqual(idx.upsertCase('console'), { removed: true });
  });

  it('drops index keys with an empty value', async () => {
    const root = tmp();
    const one = await new CaseStore({ root }).create({ title: 'Sell the lakeside lot', objective: 'Convert the lakeside lot to cash' });
    const general = require('../src/cases/case-types/general');
    const real = general.indexKeys;
    general.indexKeys = () => ['repo:', 'repo:  ', 'repo:x'];
    try {
      new CrossCaseIndex(root).rebuild();
    } finally {
      if (real === undefined) delete general.indexKeys; else general.indexKeys = real;
    }
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, '.index', 'cases', `${one.id}.json`), 'utf8')).keys, ['repo:x']);
    assert.deepStrictEqual(new CrossCaseIndex(root).searchCases({ text: 'anything at all' }), []);
  });

  it('never throws from search: an internal error logs and returns []', async () => {
    const root = tmp();
    const idx = new CrossCaseIndex(root, { store: { list: () => { throw new Error('disk gone'); } } });
    assert.deepStrictEqual(idx.search({ text: 'anything' }), []);
    assert.deepStrictEqual(idx.searchCases({ text: 'anything' }), []);
    assert.deepStrictEqual(idx.casesWithKey('repo:x'), []);
    assert.deepStrictEqual(idx.openCaseHeads(), []);
  });

  it('indexes software-repo keys and live-state documents', async () => {
    const root = tmp();
    const store = new CaseStore({ root });
    const repoCase = await store.create({ title: 'Phone agent maintenance', type: 'software-repo', objective: 'Keep the phone agent healthy' });
    new Brief(repoCase.dir).update('objective', 'Keep the phone agent healthy', { provenance: 'model' });
    const b = new Brief(repoCase.dir);
    const { data, body } = b.read();
    fs.writeFileSync(b.path, `---\n${yaml.dump({ ...data, repo: 'https://github.com/example/phone-agent.git' }).trimEnd()}\n---\n\n${body}`);
    fs.writeFileSync(path.join(repoCase.dir, '.kl', 'case-type.json'), JSON.stringify({
      type: 'software-repo', fetchedAt: '2026-09-23T15:00:00.000Z', stale: false,
      state: { repo: 'https://github.com/example/phone-agent.git', branch: null, head: null, dirty: null, branches: ['fix/status-poll'], remoteKey: 'github.com/example/phone-agent', openPrs: [{ number: 12, title: 'Fix status polling', headRefName: 'fix/status-poll', url: 'https://github.com/example/phone-agent/pull/12', isDraft: false }] },
      notes: []
    }));
    const idx = new CrossCaseIndex(root);
    assert.deepStrictEqual(idx.casesWithKey('repo:github.com/example/phone-agent'), [{ caseId: repoCase.id, title: 'Phone agent maintenance', status: 'draft' }]);
    const hits = idx.search({ text: 'status polling', forCaseId: repoCase.id });
    assert.deepStrictEqual(hits.map((h) => h.id).sort(), ['branch:fix/status-poll', 'pr:12']);
    const other = idx.search({ text: 'status polling' });
    assert.ok(other.length > 0);
    assert.ok(other.every((h) => h.text === null && h.redacted === true && h.id === null));
    assert.ok(!JSON.stringify(other).includes('fix/status-poll'));
  });
});
