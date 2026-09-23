// tests/cases-brief.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseStore } = require('../src/cases/case-store');
const { Brief, BriefError } = require('../src/cases/brief');

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
});
