// tests/cases-brief.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseStore } = require('../src/cases/case-store');
const { Brief, BriefError } = require('../src/cases/brief');
const { ScopeStore } = require('../src/cases/scope');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-brief-')); dirs.push(d); return d; };
const newBrief = async () => {
  const info = await new CaseStore({ root: tmp() }).create({ title: 'Lakeside lot', objective: 'Convert the lot to cash' });
  return new Brief(info.dir);
};

describe('Brief', () => {
  it('reads the template written at case creation', async () => {
    const b = await newBrief();
    const { data } = b.read();
    assert.strictEqual(data.objective, 'Convert the lot to cash');
    assert.deepStrictEqual(data.alreadyTried, []);
    assert.strictEqual(b.isGatingComplete(), false);
  });

  it('updates model-settable fields and preserves the prose body', async () => {
    const b = await newBrief();
    fs.appendFileSync(b.path, 'Owner notes stay here.\n');
    b.update('successCriteria', ['Signed contract at or above floor'], { provenance: 'model' });
    const { data, body } = b.read();
    assert.deepStrictEqual(data.successCriteria, ['Signed contract at or above floor']);
    assert.match(body, /Owner notes stay here\./);
  });

  it('refuses owner-only fields without user provenance', async () => {
    const b = await newBrief();
    assert.throws(() => b.update('alreadyTried', ['MLS listing'], { provenance: 'model' }), /owner/);
    assert.throws(() => b.append('hardConstraints', 'Both owners sign', {}), /owner/);
    b.append('alreadyTried', 'Three agents on the MLS over three years', { provenance: 'user' });
    assert.deepStrictEqual(b.read().data.alreadyTried, ['Three agents on the MLS over three years']);
  });

  it('rejects unknown fields and wrong types', async () => {
    const b = await newBrief();
    assert.throws(() => b.update('budget', 5, { provenance: 'user' }), /Unknown brief field/);
    assert.throws(() => b.update('successCriteria', 'not an array', { provenance: 'model' }), /array of strings/);
    assert.throws(() => b.update('deadline', 'next week', { provenance: 'model' }), /YYYY-MM-DD/);
  });

  it('completes gating only when objective, why and success criteria are set', async () => {
    const b = await newBrief();
    assert.deepStrictEqual(b.missingForGating(), ['why', 'successCriteria']);
    assert.throws(() => b.completeGating(), (err) => err instanceof BriefError && /why, successCriteria/.test(err.message));
    b.update('why', 'Need cash to repair the family house', { provenance: 'user' });
    b.append('successCriteria', 'Closed within 90 days', { provenance: 'model' });
    b.completeGating();
    assert.strictEqual(b.isGatingComplete(), true);
  });

  // Cases stage 8 (R-C8-2): with a scope view, a criterion counts for gating
  // only once the owner confirmed it.
  const gated = async () => {
    const b = await newBrief();
    b.update('why', 'Need cash to repair the family house', { provenance: 'user' });
    b.append('successCriteria', 'Closed within 90 days', { provenance: 'model' });
    const scope = new ScopeStore(b.dir);
    return { b, scope, view: () => scope.view(b.read().data) };
  };

  it('gating waits for one confirmed criterion', async () => {
    const { b, scope, view } = await gated();
    assert.deepStrictEqual(b.missingForGating({ scopeView: view() }), ['successCriteria']);
    assert.throws(() => b.completeGating({ scopeView: view() }), (err) => err instanceof BriefError
      && err.message === 'Gating pass incomplete; still missing: successCriteria (no criterion is confirmed by the owner; ask with Progress askScope).');
    assert.strictEqual(b.isGatingComplete(), false);
    const row = scope.reconcile(b.read().data).criteria[0];
    scope.confirm([row.id], { hashes: { [row.id]: row.hash }, by: 'owner-action', channel: 'in-app' });
    assert.deepStrictEqual(b.missingForGating({ scopeView: view() }), []);
    b.completeGating({ scopeView: view() });
    assert.strictEqual(b.isGatingComplete(), true);
  });

  it('a proposed criterion beside a confirmed one does not hold gating back', async () => {
    const { b, scope, view } = await gated();
    const row = scope.reconcile(b.read().data).criteria[0];
    scope.confirm([row.id], { hashes: { [row.id]: row.hash }, by: 'owner-action' });
    b.append('successCriteria', 'Three written offers', { provenance: 'model' });
    assert.deepStrictEqual(view().criteria.map((r) => r.state), ['confirmed', 'proposed']);
    assert.deepStrictEqual(b.missingForGating({ scopeView: view() }), []);
    b.completeGating({ scopeView: view() });
    assert.strictEqual(b.isGatingComplete(), true);
  });

  it('a brief already gating.complete stays complete', async () => {
    const { b, view } = await gated();
    b.completeGating();
    const completedAt = b.read().data.gating.completedAt;
    assert.strictEqual(view().criteria[0].state, 'proposed');
    // No criterion is confirmed: the rule is reported, and the brief is
    // neither refused nor cleared.
    assert.deepStrictEqual(b.missingForGating({ scopeView: view() }), ['successCriteria']);
    b.completeGating({ scopeView: view() });
    assert.strictEqual(b.isGatingComplete(), true);
    assert.strictEqual(b.read().data.gating.completedAt, completedAt);
    b.update('objective', 'Sell the Lakeside lot', { provenance: 'model' });
    assert.strictEqual(b.isGatingComplete(), true);
  });

  it('reports hand-broken YAML as a BriefError', async () => {
    const b = await newBrief();
    fs.writeFileSync(b.path, '---\nobjective: [unclosed\n---\n');
    assert.throws(() => b.read(), (err) => err instanceof BriefError && /not valid YAML/.test(err.message));
  });

  it('treats a brief with no front matter as empty data', async () => {
    const b = await newBrief();
    fs.writeFileSync(b.path, 'Just prose.\r\n');
    const { data, body } = b.read();
    assert.deepStrictEqual(data, {});
    assert.match(body, /Just prose\./);
  });

  it('reads a brief saved with a byte-order mark and does not duplicate its front matter on update', async () => {
    const b = await newBrief();
    fs.writeFileSync(b.path, '\uFEFF---\nobjective: Convert the lot to cash\n---\n\nNotes on the Lakeside lot.\n');
    assert.strictEqual(b.read().data.objective, 'Convert the lot to cash');
    b.update('deadline', '2027-03-01', { provenance: 'user' });
    const text = fs.readFileSync(b.path, 'utf8');
    assert.strictEqual(text.split('\n').filter((l) => l.trim() === '---').length, 2);
    assert.strictEqual(b.read().data.objective, 'Convert the lot to cash');
    assert.match(b.read().body, /Notes on the Lakeside lot\./);
  });
});

describe('Brief front matter goes through parseYaml', () => {
  it('refuses anchors and aliases as a BriefError', async () => {
    const b = await newBrief();
    fs.writeFileSync(b.path, '---\nobjective: &o Sell\nwhy: *o\n---\n\nBody\n');
    assert.throws(() => b.read(), (err) => err instanceof BriefError && /not valid YAML: YAML anchors and aliases are not allowed/.test(err.message));
  });

  it('keeps an unquoted date a string (core schema) and still loads a written brief', async () => {
    const b = await newBrief();
    b.update('deadline', '2026-12-01', { provenance: 'user' });
    assert.strictEqual(b.read().data.deadline, '2026-12-01');
    const text = fs.readFileSync(b.path, 'utf8').replace(/deadline: .*/, 'deadline: 2026-12-02');
    fs.writeFileSync(b.path, text);
    assert.strictEqual(b.read().data.deadline, '2026-12-02');
  });
});
