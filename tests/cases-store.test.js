const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { slugify, uniqueSlug } = require('../src/cases/slug');
const git = require('../src/cases/git');
const { CaseStore } = require('../src/cases/case-store');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cases-')); dirs.push(d); return d; };

describe('slug', () => {
  it('lowercases and dashes titles', () => {
    assert.strictEqual(slugify('Sell the Lakeside Lot!'), 'sell-the-lakeside-lot');
  });
  it('never produces path segments', () => {
    assert.strictEqual(slugify('../../etc/passwd'), 'etc-passwd');
    assert.strictEqual(slugify('a/b\\c'), 'a-b-c');
  });
  it('falls back to "case" when nothing survives', () => {
    assert.strictEqual(slugify('🏠🏠'), 'case');
    assert.strictEqual(slugify(''), 'case');
  });
  it('caps length at 48', () => {
    assert.ok(slugify('x'.repeat(200)).length <= 48);
  });
  it('dedupes against existing directories', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'lot-9'));
    fs.mkdirSync(path.join(root, 'lot-9-2'));
    assert.strictEqual(uniqueSlug(root, 'Lot 9'), 'lot-9-3');
  });
});

describe('CaseStore', () => {
  it('creates a committed git repo with the spec layout', async () => {
    const root = tmp();
    const store = new CaseStore({ root });
    const info = await store.create({ title: 'Lakeside lot', type: 'outreach', objective: 'Convert the lot to cash' });
    assert.strictEqual(info.slug, 'lakeside-lot');
    assert.strictEqual(info.status, 'draft');
    assert.ok(info.dir.startsWith(root));
    for (const f of ['case.yaml', 'brief.md', 'facts.jsonl', 'decisions.md', 'open-items.md', '.gitignore']) {
      assert.ok(fs.existsSync(path.join(info.dir, f)), `missing ${f}`);
    }
    for (const d of ['journal', 'sources', 'artifacts', 'playbooks', '.kl']) {
      assert.ok(fs.statSync(path.join(info.dir, d)).isDirectory(), `missing ${d}/`);
    }
    const meta = yaml.load(fs.readFileSync(path.join(info.dir, 'case.yaml'), 'utf8'));
    assert.strictEqual(meta.id, info.id);
    assert.strictEqual(meta.title, 'Lakeside lot');
    assert.strictEqual(await git.isDirty(info.dir), false, 'creation is committed');
    assert.match(fs.readFileSync(path.join(info.dir, '.gitignore'), 'utf8'), /\.kl\/lock/);
  });

  it('lists, gets by id or slug, and updates meta', async () => {
    const store = new CaseStore({ root: tmp() });
    const a = await store.create({ title: 'A' });
    const b = await store.create({ title: 'B' });
    assert.deepStrictEqual(store.list().map((c) => c.slug).sort(), ['a', 'b']);
    assert.strictEqual(store.get(a.id).slug, 'a');
    assert.strictEqual(store.get('b').id, b.id);
    assert.strictEqual(store.get('nope'), null);
    const updated = store.updateMeta(a.id, { status: 'active' });
    assert.strictEqual(updated.status, 'active');
    assert.strictEqual(store.get('a').status, 'active');
  });

  it('refuses unknown status values', async () => {
    const store = new CaseStore({ root: tmp() });
    const a = await store.create({ title: 'A' });
    assert.throws(() => store.updateMeta(a.id, { status: 'finished' }), /Invalid case status/);
  });

  it('creates nothing on disk until the first case is created', () => {
    const root = path.join(tmp(), 'not-yet');
    const store = new CaseStore({ root });
    assert.deepStrictEqual(store.list(), []);
    assert.strictEqual(fs.existsSync(root), false);
  });

  it('ignores directories without a readable case.yaml when listing', async () => {
    const root = tmp();
    const store = new CaseStore({ root });
    await store.create({ title: 'Real' });
    fs.mkdirSync(path.join(root, 'junk'));
    fs.mkdirSync(path.join(root, 'broken'));
    fs.writeFileSync(path.join(root, 'broken', 'case.yaml'), ': : not yaml : :');
    assert.deepStrictEqual(store.list().map((c) => c.slug), ['real']);
  });

  it('fails cleanly and leaves nothing behind when git is unavailable', async (t) => {
    const root = path.join(tmp(), 'cases');
    const store = new CaseStore({ root });
    t.mock.method(git, 'isGitAvailable', async () => false);
    await assert.rejects(store.create({ title: 'X' }), (err) => err instanceof git.GitUnavailableError && /git is required/.test(err.message));
    assert.strictEqual(fs.existsSync(root), false);
  });
});
