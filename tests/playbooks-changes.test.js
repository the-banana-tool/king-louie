// tests/playbooks-changes.test.js
// Playbook changes for C2's re-orientation trigger (cases stage 6 spec §3.9)
// and the .kl/playbooks.json state file (§4.5, §9).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { PlaybookLoader } = require('../src/cases/playbooks/loader');
const { hashPackage } = require('../src/cases/playbooks/format');
const ch = require('../src/cases/playbooks/changes');
const { writePackage, STEPS_MD, PLAYBOOK_YAML } = require('./helpers/playbook-fixture');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-pbchg-')); dirs.push(d); return d; };

// A case dir (no git needed: nothing here is a submodule candidate) with the
// fixture vendored and pinned, and its acknowledged snapshot.
function vendoredCase() {
  const dir = tmp();
  const pb = writePackage(path.join(dir, 'playbooks', 'land-sale'));
  const pin = { name: 'land-sale', version: '1.2.0', source: 'example:land-sale', mode: 'vendored', commit: null, contentHash: hashPackage(pb) };
  fs.writeFileSync(path.join(dir, 'case.yaml'), yaml.dump({ id: 'c-1', type: 'general', playbooks: [pin] }));
  const acknowledged = { 'land-sale': ch.snapshotOf(new PlaybookLoader(dir).get('land-sale')) };
  return { dir, pb, acknowledged };
}
const changesOf = ({ dir, acknowledged }) => ch.computeChanges(new PlaybookLoader(dir).list(), acknowledged);

describe('computeChanges', () => {
  it('reports nothing when disk matches case.yaml and the snapshot', () => {
    assert.deepStrictEqual(changesOf(vendoredCase()), []);
  });

  it('version-changed with a structural diff', () => {
    const c = vendoredCase();
    writePackage(c.pb, {
      'playbook.yaml': PLAYBOOK_YAML.replace('version: "1.2.0"', 'version: "1.3.0"').replace('What is the lowest price you would accept?', 'What is your lowest acceptable price?'),
      'steps.md': STEPS_MD.replace('## 2. Call buyers', '## 2. Call brokers').replace('buyers.interest', 'brokers.interest'),
      'briefRules.md': '- Cite the plat.\n'
    });
    const [x] = changesOf(c);
    assert.strictEqual(x.kind, 'version-changed');
    assert.deepStrictEqual([x.from, x.to], ['1.2.0', '1.3.0']);
    assert.strictEqual(x.key, `playbook:land-sale:${hashPackage(c.pb)}`);
    assert.deepStrictEqual(x.gating, { added: [], removed: [], changed: ['floor-price'] });
    assert.deepStrictEqual(x.steps, { added: ['call-brokers'], removed: ['call-buyers'], changed: [] });
    assert.strictEqual(x.briefRulesChanged, true);
    assert.strictEqual(x.sourcesChanged, false);
    assert.strictEqual(x.detail, 'Playbook land-sale moved from 1.2.0 to 1.3.0: gating ~[floor-price]; steps +[call-brokers] -[call-buyers]; brief rules changed.');
  });

  it('edited: same version, different content', () => {
    const c = vendoredCase();
    fs.appendFileSync(path.join(c.pb, 'sources.md'), '- Another office\n');
    const [x] = changesOf(c);
    assert.strictEqual(x.kind, 'edited');
    assert.deepStrictEqual([x.from, x.to], ['1.2.0', '1.2.0']);
    assert.strictEqual(x.sourcesChanged, true);
    assert.strictEqual(x.detail, 'Playbook land-sale the vendored copy of 1.2.0 was edited: sources changed.');
  });

  it('invalid, missing and unavailable only when the acknowledged state was ok', () => {
    const c = vendoredCase();
    fs.writeFileSync(path.join(c.pb, 'playbook.yaml'), 'name: land-sale\nversion: 1.3\n');
    const [x] = changesOf(c);
    assert.deepStrictEqual([x.kind, x.from, x.to, x.key], ['invalid', '1.2.0', null, 'playbook:land-sale:invalid']);
    assert.strictEqual(x.detail, 'Playbook land-sale is invalid and no longer used (was 1.2.0): gating -[floor-price, financing, parcel-id]; steps -[confirm-parcel, call-buyers]; brief rules changed; sources changed.');
    fs.rmSync(c.pb, { recursive: true, force: true });
    assert.strictEqual(changesOf(c)[0].kind, 'missing');
    assert.deepStrictEqual(ch.computeChanges(new PlaybookLoader(c.dir).list(), { 'land-sale': { state: 'missing' } }), []);
  });

  it('added: an ok playbook with no acknowledged snapshot', () => {
    const c = vendoredCase();
    const [x] = ch.computeChanges(new PlaybookLoader(c.dir).list(), {});
    assert.strictEqual(x.kind, 'added');
    assert.deepStrictEqual(x.steps.added, ['confirm-parcel', 'call-buyers']);
    assert.match(x.detail, /^Playbook land-sale is now in use at 1\.2\.0: gating \+\[floor-price, financing, parcel-id\]/);
  });

  it('ignores unregistered directories', () => {
    const c = vendoredCase();
    writePackage(path.join(c.dir, 'playbooks', 'other'), { 'playbook.yaml': PLAYBOOK_YAML.replace('name: land-sale', 'name: other') });
    assert.deepStrictEqual(changesOf(c), []);
  });
});

describe('.kl/playbooks.json', () => {
  it('reads as empty when missing or unreadable, and writes only on change', () => {
    const dir = tmp();
    assert.deepStrictEqual(ch.readState(dir), ch.emptyState());
    fs.mkdirSync(path.join(dir, '.kl'));
    fs.writeFileSync(path.join(dir, ch.STATE_FILE), '{ not json');
    assert.deepStrictEqual(ch.readState(dir), ch.emptyState());
    const s = { ...ch.emptyState(), appliedAnswers: ['q-0001'] };
    assert.strictEqual(ch.writeState(dir, s), true);
    assert.strictEqual(ch.writeState(dir, s), false);
    assert.deepStrictEqual(ch.readState(dir).appliedAnswers, ['q-0001']);
  });

  // .kl/playbooks.json ships inside the case repo: it arrives un-reviewed
  // with `case import`, and the write guard that protects facts.jsonl
  // covers Write/Edit/MultiEdit, not a Bash command overwriting it directly
  // (CLAUDE.md "Cases"). readState treats it as untrusted input the same
  // way format.js treats a playbook package.
  describe('readState hardening (untrusted file)', () => {
    const writeRaw = (dir, value) => {
      fs.mkdirSync(path.join(dir, '.kl'), { recursive: true });
      fs.writeFileSync(path.join(dir, ch.STATE_FILE), typeof value === 'string' ? value : JSON.stringify(value));
    };

    it('a malformed (non-JSON) file reads as empty, never throws', () => {
      const dir = tmp();
      writeRaw(dir, '{ this is not json at all [[[');
      assert.doesNotThrow(() => ch.readState(dir));
      assert.deepStrictEqual(ch.readState(dir), ch.emptyState());
    });

    it('wrong types at every field read as empty, never throw', () => {
      const dir = tmp();
      writeRaw(dir, { vendored: 'nope', acknowledged: [1, 2, 3], appliedAnswers: { not: 'an array' }, lastUpdateCheck: 42 });
      assert.doesNotThrow(() => ch.readState(dir));
      assert.deepStrictEqual(ch.readState(dir), ch.emptyState());
    });

    it('a top-level array or a bare scalar reads as empty, never throws', () => {
      const dir = tmp();
      writeRaw(dir, [1, 2, 3]);
      assert.deepStrictEqual(ch.readState(dir), ch.emptyState());
      writeRaw(dir, '"just a string"');
      assert.deepStrictEqual(ch.readState(dir), ch.emptyState());
      writeRaw(dir, 'null');
      assert.deepStrictEqual(ch.readState(dir), ch.emptyState());
    });

    it('a __proto__ key is dropped and never pollutes Object.prototype', () => {
      const dir = tmp();
      // Written with computed keys, not object-literal `__proto__: …`
      // syntax: the literal syntax is special-cased by JS itself to set
      // the object's own [[Prototype]] rather than create a "__proto__"
      // property, so it would never reach the JSON file as a real key.
      // This test needs the file to actually contain that key.
      writeRaw(dir, {
        vendored: {
          ['__proto__']: { source: 'https://evil.example.com', ref: 'main', commit: null, vendoredAt: null, contentHash: null, onDiskVersion: null },
          'land-sale': { source: 'example:land-sale', ref: null, commit: null, vendoredAt: '2026-01-01T00:00:00Z', contentHash: 'sha256:abc', onDiskVersion: '1.2.0' }
        },
        acknowledged: {
          ['__proto__']: { version: '9.9.9', state: 'ok', gating: { ['__proto__']: 'sha256:evil' }, steps: {}, briefRules: null, sources: null }
        }
      });
      const state = ch.readState(dir);
      // No global pollution: a brand-new, unrelated object never gains the
      // attacker's property.
      assert.strictEqual(({}).polluted, undefined);
      assert.strictEqual(({}).source, undefined);
      // The malicious key is gone; the legitimate sibling entry survives.
      assert.deepStrictEqual(Object.keys(state.vendored), ['land-sale']);
      assert.deepStrictEqual(Object.keys(state.acknowledged), []);
      assert.strictEqual(Object.getPrototypeOf(state.vendored), Object.prototype);
      assert.strictEqual(Object.getPrototypeOf(state.acknowledged), Object.prototype);
    });

    it('a __proto__ key nested in a gating/steps hash map is dropped without polluting', () => {
      const dir = tmp();
      writeRaw(dir, {
        acknowledged: {
          'land-sale': {
            version: '1.2.0', state: 'ok',
            gating: { ['__proto__']: 'sha256:evil', 'floor-price': 'sha256:abc'.padEnd(71, '0') },
            steps: {}, briefRules: null, sources: null
          }
        }
      });
      const state = ch.readState(dir);
      assert.strictEqual(({}).polluted, undefined);
      assert.deepStrictEqual(Object.keys(state.acknowledged['land-sale'].gating), ['floor-price']);
      assert.strictEqual(Object.getPrototypeOf(state.acknowledged['land-sale'].gating), Object.prototype);
    });

    it('an acknowledged entry with an unknown state is dropped, not guessed at', () => {
      const dir = tmp();
      writeRaw(dir, { acknowledged: { 'land-sale': { version: '1.2.0', state: 'made-up-state' } } });
      assert.deepStrictEqual(ch.readState(dir).acknowledged, {});
    });

    it('a vendored file entry with an oversize key or value is dropped (no id shape to fall back on)', () => {
      const dir = tmp();
      const files = { 'playbook.yaml': 'sha256:abc'.padEnd(71, '0'), [('a/'.repeat(200))]: 'sha256:def'.padEnd(71, '0'), 'steps.md': 'x'.repeat(3000) };
      writeRaw(dir, { vendored: { 'land-sale': { source: 'example:land-sale', ref: null, commit: null, vendoredAt: null, contentHash: null, onDiskVersion: null, files } } });
      const state = ch.readState(dir);
      assert.deepStrictEqual(Object.keys(state.vendored['land-sale'].files), ['playbook.yaml']);
    });

    it('caps the number of gating/step hash values kept, even with well-formed ids', () => {
      const dir = tmp();
      const gating = {};
      for (let i = 0; i < 200; i += 1) gating[`q-${String(i).padStart(3, '0')}`] = 'sha256:abc'.padEnd(71, '0');
      writeRaw(dir, { acknowledged: { 'land-sale': { version: '1.2.0', state: 'ok', gating, steps: {}, briefRules: null, sources: null } } });
      const state = ch.readState(dir);
      assert.ok(Object.keys(state.acknowledged['land-sale'].gating).length <= 30);
    });

    it('caps the number of tracked playbooks', () => {
      const dir = tmp();
      const vendored = {};
      for (let i = 0; i < 500; i += 1) {
        vendored[`pb-${String(i).padStart(3, '0')}`] = { source: 'example:x', ref: null, commit: null, vendoredAt: null, contentHash: null, onDiskVersion: null };
      }
      writeRaw(dir, { vendored });
      const state = ch.readState(dir);
      assert.ok(Object.keys(state.vendored).length < 500);
      assert.ok(Object.keys(state.vendored).length > 0);
    });

    it('caps the number of applied answers and drops non-string entries', () => {
      const dir = tmp();
      const appliedAnswers = [];
      for (let i = 0; i < 20000; i += 1) appliedAnswers.push(`q-${i}`);
      appliedAnswers.push(123, null, { not: 'a string' });
      writeRaw(dir, { appliedAnswers });
      const state = ch.readState(dir);
      assert.ok(state.appliedAnswers.length < 20000, `expected the count cap to apply, got ${state.appliedAnswers.length}`);
      assert.ok(state.appliedAnswers.every((x) => typeof x === 'string'));
    });

    it('drops an oversize string field rather than keep it', () => {
      const dir = tmp();
      writeRaw(dir, { vendored: { 'land-sale': { source: 'x'.repeat(1_000_000), ref: null, commit: null, vendoredAt: null, contentHash: null, onDiskVersion: null } }, lastUpdateCheck: 'y'.repeat(1_000_000) });
      const state = ch.readState(dir);
      assert.strictEqual(state.vendored['land-sale'].source, null);
      assert.strictEqual(state.lastUpdateCheck, null);
    });

    it('drops oversize or malformed keys in a gating/steps hash map', () => {
      const dir = tmp();
      const gating = { 'A_Bad_Key!': 'sha256:x', [('k'.repeat(5000))]: 'sha256:y' };
      writeRaw(dir, { acknowledged: { 'land-sale': { version: '1.2.0', state: 'ok', gating, steps: {}, briefRules: null, sources: null } } });
      const state = ch.readState(dir);
      assert.deepStrictEqual(state.acknowledged['land-sale'].gating, {});
    });
  });
});

// ---- Cases stage 6, Task 12: acknowledgement through the runtime ----
describe('acknowledgePlaybooks through the runtime', () => {
  const pbGit = require('../src/cases/git');
  const { CaseRuntime: PbRuntime } = require('../src/cases');
  const { installPlaybooks: pbInstall } = require('../src/cases/playbooks');
  const fixture = require('./helpers/playbook-fixture');

  const SURVEY = [
    '  - id: survey',
    '    text: Has the lot been surveyed?',
    '    fact: { subject: property, attr: surveyed }',
    '    answerable: owner',
    'materialityDefaults:'
  ].join('\n');

  it('acknowledgePlaybooks bumps case.yaml and only then creates gating records', async (t) => {
    if (!(await pbGit.isGitAvailable())) return t.skip('git is not on PATH');
    const upstream = await fixture.makeGitPackage(path.join(fs.realpathSync(tmp()), 'land-sale'));
    const rt = new PbRuntime({ root: tmp(), getSettings: () => ({}) });
    const mgr = pbInstall(rt, { getSettings: () => ({ playbooks: {} }), tmpRoot: tmp() });
    const { id } = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
    await mgr.attach(id, { source: upstream });
    await fixture.commitPackage(upstream, {
      'playbook.yaml': fixture.PLAYBOOK_YAML.replace('"1.2.0"', '"1.3.0"').replace('materialityDefaults:', SURVEY)
    }, '1.3.0');
    // Ruling T5-recorded: a recorded local path is fetched on update only
    // after the owner re-confirms it (or under a matching path: entry).
    const refused = await mgr.update(id, 'land-sale');
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.code, 'SOURCE_NEEDS_CONFIRM');
    assert.strictEqual((await mgr.update(id, 'land-sale', { confirmSource: true })).ok, true);
    const surveyed = () => rt.questions(id).list().filter((q) => q.payload?.gating?.key === 'property.surveyed');

    const [change] = rt.playbookChanges(id);
    assert.deepStrictEqual([change.name, change.kind, change.from, change.to], ['land-sale', 'version-changed', '1.2.0', '1.3.0']);
    assert.deepStrictEqual(change.gating.added, ['survey']);
    // Ruling M2: C2's detectTriggers uses C6's own key and detail.
    assert.match(change.key, /^playbook:land-sale:sha256:[0-9a-f]{64}$/);

    const turn = await rt.beginTurn(id, { turnId: 'turn-1', source: 'owner', ownerMessage: 'Continue' });
    try {
      const raised = turn.triggers.filter((x) => x.kind === 'playbook-update');
      assert.strictEqual(raised.length, 1, 'C2 raises one playbook trigger');
      assert.strictEqual(raised[0].key, change.key);
      assert.strictEqual(raised[0].detail, change.detail);
      assert.strictEqual(raised[0].blocking, true);
      assert.strictEqual(turn.reorientPending, true);
      assert.match(turn.orientation, /Playbook land-sale moved from 1\.2\.0 to 1\.3\.0: gating \+\[survey\]/);
      assert.deepStrictEqual(surveyed(), [], 'questions from an unacknowledged change wait');
      rt.recordReorientation(id, turn, { changed: 'The playbook moved to 1.3.0', affects: [], action: 'continue', note: 'A survey question was added.' });
    } finally {
      await rt.endTurn(turn, { summary: 're-oriented' });
    }
    assert.strictEqual(rt.getCase(id).playbooks[0].version, '1.3.0');
    assert.strictEqual(rt.getCase(id).playbooks[0].contentHash, ch.readState(rt.getCase(id).dir).vendored['land-sale'].contentHash);
    assert.deepStrictEqual(rt.playbookChanges(id), []);
    assert.strictEqual(surveyed().length, 1, 'acknowledged, then asked');
    assert.strictEqual(ch.readState(rt.getCase(id).dir).acknowledged['land-sale'].version, '1.3.0');
    assert.strictEqual(await pbGit.isDirty(rt.getCase(id).dir), false, 'the turn committed the acknowledgement');

    const next = await rt.beginTurn(id, { turnId: 'turn-2', source: 'owner', ownerMessage: 'And now?' });
    try {
      assert.deepStrictEqual(next.triggers.filter((x) => x.kind === 'playbook-update'), [], 'acknowledged: no trigger again');
    } finally {
      await rt.endTurn(next, { summary: 'checked' });
    }
  });
});
