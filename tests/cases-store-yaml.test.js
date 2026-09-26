// tests/cases-store-yaml.test.js
// case.yaml moves to the strict parser (cases stage 6 spec §4.4, program
// §4.11): every key another stage writes still loads, timestamps stay
// strings, and a duplicate key makes the case unreadable with a warning.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const git = require('../src/cases/git');
const { addSink } = require('../src/logging');
const { CaseStore, CASE_YAML_KEYS, parseCaseYaml } = require('../src/cases/case-store');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-caseyaml-')); dirs.push(d); return d; };

// One invented value per key, in the shape the owning stage writes.
const SAMPLES = {
  id: 'mfx1a2b3-0a1b2c3d',
  slug: 'lakeside-lot',
  title: 'Lakeside lot',
  type: 'outreach',
  status: 'active',
  created: '2026-09-23T14:05:00.000Z',
  playbooks: [{
    name: 'property-sale',
    version: '1.2.0',
    source: 'https://example.com/playbooks/property-sale.git',
    mode: 'vendored',
    commit: '4b1e0c9d2f7a8b6e5d4c3b2a1f0e9d8c7b6a5f4e',
    contentHash: 'sha256:9c0f00000000000000000000000000000000000000000000000000000000abcd'
  }],
  related: [{ id: '7ab1-9c3e10f2', relation: 'blocked-by', note: 'Survey is waiting on the county', detour: 'd-0003', at: '2026-09-23T15:02:11Z' }],
  lastTurnAt: '2026-09-23T14:05:00.000Z',
  lastOwnerTurnAt: '2026-09-23T14:05:00.000Z',
  statusReason: { kind: 'failure', by: 'runtime', ref: 'journal/2026-09-23-1405-failure.md', note: '', failureClass: 'dead-end', at: '2026-09-23T14:05:00.000Z' },
  budget: { usd: 40, deadline: '2026-11-30', turnsPerDay: 48, contactsPerDay: 20, questionsPerDay: 6 },
  roles: { judge: { provider: 'openai', model: 'gpt-4o' }, orient: { tier: 'fast' } },
  autonomy: { onExecutorNoAnswer: 'retry-within-envelope', onQuestionSilence: 'stop' },
  channels: { high: ['present', 'sms', { channel: 'voice', afterMin: 20 }], 'urgency.normal': ['present', 'email'] }
};

function writeCase(root, name, text) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'case.yaml'), text);
  return dir;
}

describe('case.yaml keys', () => {
  it('lists exactly the keys the stages write, each with a sample here', () => {
    assert.deepStrictEqual(Object.keys(CASE_YAML_KEYS).sort(), Object.keys(SAMPLES).sort());
    assert.strictEqual(CASE_YAML_KEYS.channels, 'C4');
    assert.strictEqual(CASE_YAML_KEYS.budget, 'C2');
  });

  it('loads every key as written by yaml.dump', () => {
    const root = tmp();
    writeCase(root, 'lakeside-lot', yaml.dump(SAMPLES));
    const meta = new CaseStore({ root }).get(SAMPLES.id);
    for (const [key, value] of Object.entries(SAMPLES)) {
      assert.deepStrictEqual(meta[key], value, `${key} round-trips`);
    }
  });

  it('round-trips each stage key through updateMeta', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const store = new CaseStore({ root: tmp() });
    const info = await store.create({ title: 'Lakeside lot' });
    const owned = ['id', 'slug', 'title', 'type', 'status', 'created'];
    for (const [key, value] of Object.entries(SAMPLES)) {
      if (owned.includes(key)) continue;
      store.updateMeta(info.id, { [key]: value });
      assert.deepStrictEqual(store.get(info.id)[key], value, `${key} survives updateMeta`);
    }
  });
});

describe('parseCaseYaml', () => {
  it('keeps unquoted timestamps and dates as strings', () => {
    const meta = parseCaseYaml([
      'id: c-1',
      'created: 2026-09-23T14:05:00Z',
      'lastTurnAt: 2026-09-23T14:05:00Z',
      'budget: { usd: 40, deadline: 2026-11-30 }',
      'playbooks:',
      '  - { name: property-sale, version: 1.2.0 }'
    ].join('\n'));
    assert.strictEqual(meta.created, '2026-09-23T14:05:00Z');
    assert.strictEqual(meta.lastTurnAt, '2026-09-23T14:05:00Z');
    assert.strictEqual(meta.budget.deadline, '2026-11-30');
    assert.strictEqual(meta.budget.usd, 40);
    assert.strictEqual(meta.playbooks[0].version, '1.2.0');
  });

  it('returns null for a document that is not a mapping or has no id', () => {
    assert.strictEqual(parseCaseYaml('- a\n- b\n'), null);
    assert.strictEqual(parseCaseYaml('title: No id\n'), null);
    assert.strictEqual(parseCaseYaml(''), null);
  });

  it('throws on a duplicate key and on a non-core tag', () => {
    assert.throws(() => parseCaseYaml('id: c-1\nstatus: draft\nstatus: active\n'), /duplicated mapping key/);
    assert.throws(() => parseCaseYaml('id: c-1\nnote: !!binary aGVsbG8=\n'), /unknown tag/);
  });

  it('reads a case.yaml written by create exactly as js-yaml load did', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const store = new CaseStore({ root: tmp() });
    const info = await store.create({ title: 'Lakeside lot', objective: 'Sell the lot' });
    const text = fs.readFileSync(path.join(info.dir, 'case.yaml'), 'utf8');
    assert.deepStrictEqual(parseCaseYaml(text), yaml.load(text));
  });
});

describe('CaseStore on the strict parser', () => {
  it('skips a case.yaml with a duplicate key and warns naming the directory', () => {
    const root = tmp();
    writeCase(root, 'good', 'id: c-good\ntitle: Good\ncreated: "2026-09-23T00:00:00.000Z"\n');
    const bad = writeCase(root, 'bad', 'id: c-bad\ntitle: Bad\ntitle: Twice\n');
    const records = [];
    const remove = addSink((r) => records.push(r));
    let listed;
    try {
      listed = new CaseStore({ root }).list();
    } finally {
      remove();
    }
    assert.deepStrictEqual(listed.map((c) => c.id), ['c-good']);
    const warn = records.find((r) => r.level === 'warn' && r.message.includes(bad));
    assert.ok(warn, 'a warn names the unreadable case directory');
    assert.match(warn.message, /duplicated mapping key/);
  });

  it('gives playbooks and related as arrays even when the file has null', () => {
    const root = tmp();
    writeCase(root, 'c', 'id: c-null\ntitle: Nulls\nplaybooks: null\nrelated:\n');
    const meta = new CaseStore({ root }).get('c-null');
    assert.deepStrictEqual(meta.playbooks, []);
    assert.deepStrictEqual(meta.related, []);
  });
});
