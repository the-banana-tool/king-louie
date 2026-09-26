// tests/examples-playbooks.test.js
// The reference playbooks under examples/playbooks (cases stage 6 spec
// §3.13): valid, invented, placeholder URLs and phones only, and shipped in
// packaged builds (R32).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { validatePackage } = require('../src/cases/playbooks/format');

const ROOT = path.join(__dirname, '..', 'examples', 'playbooks');
// C5's case types and C3's built-in executors (program §4.8, §4.11).
const CASE_TYPES = ['general', 'outreach', 'software-repo'];
const BUILTIN_EXECUTORS = ['bash', 'browser', 'web', 'files', 'workflow', 'runbook', 'owner', 'phone-agent'];
const NAMES = ['contractor-quotes', 'medical-scheduling', 'property-sale'];

const load = (name) => validatePackage(path.join(ROOT, name), { knownCaseTypes: CASE_TYPES });
const allText = (name) => fs.readdirSync(path.join(ROOT, name)).map((f) => fs.readFileSync(path.join(ROOT, name, f), 'utf8')).join('\n');
const gating = (name) => Object.fromEntries(load(name).playbook.gatingQuestions.map((q) => [`${q.fact.subject}.${q.fact.attr}`, q]));

describe('examples/playbooks', () => {
  it('holds exactly the three reference playbooks, four files each', () => {
    assert.deepStrictEqual(fs.readdirSync(ROOT).sort(), NAMES);
    for (const name of NAMES) {
      assert.deepStrictEqual(fs.readdirSync(path.join(ROOT, name)).sort(), ['briefRules.md', 'playbook.yaml', 'sources.md', 'steps.md'], name);
    }
  });

  it('every example validates with zero errors and zero warnings', () => {
    for (const name of NAMES) {
      const r = load(name);
      assert.deepStrictEqual(r.errors, [], name);
      assert.deepStrictEqual(r.warnings, [], name);
      assert.strictEqual(r.playbook.caseType, 'outreach');
    }
  });

  it('uses only built-in executors', () => {
    for (const name of NAMES) {
      for (const e of load(name).playbook.executors) assert.ok(BUILTIN_EXECUTORS.includes(e), `${name}: ${e}`);
    }
  });

  it('uses only example.com URLs and +15550xxx phone numbers', () => {
    for (const name of NAMES) {
      const text = allText(name);
      for (const m of text.matchAll(/https?:\/\/([^/\s)]+)/g)) {
        assert.ok(m[1] === 'example.com' || m[1].endsWith('.example.com'), `${name}: ${m[0]}`);
      }
      for (const m of text.matchAll(/\+\d[\d\s().-]{5,}\d/g)) {
        assert.match(m[0].replace(/[\s().-]/g, ''), /^\+15550\d{3}$/, `${name}: ${m[0]}`);
      }
    }
  });

  it('starts every sources.md with the placeholder notice', () => {
    for (const name of NAMES) {
      const first = fs.readFileSync(path.join(ROOT, name, 'sources.md'), 'utf8').split('\n')[0];
      assert.match(first, /placeholders on example\.com/, name);
    }
  });

  it('sets gating answerable, category and briefField as the spec table says', () => {
    const p = gating('property-sale');
    assert.strictEqual(p['property.owners-of-record'].briefField, 'hardConstraints');
    assert.strictEqual(p['property.floor-price'].category, 'financial');
    assert.strictEqual(p['property.floor-price'].briefField, 'hardConstraints');
    assert.strictEqual(p['property.prior-attempts'].briefField, 'alreadyTried');
    assert.deepStrictEqual(p['property.financing-allowed'].options.map((o) => o.id), ['yes', 'no']);
    assert.strictEqual(p['property.parcel-id'].answerable, 'web');
    const c = gating('contractor-quotes');
    assert.strictEqual(c['job.budget-ceiling'].category, 'financial');
    assert.strictEqual(c['job.budget-ceiling'].briefField, 'hardConstraints');
    assert.ok(c['job.labor-only'].options.length >= 2);
    assert.strictEqual(c['job.license-required'].answerable, 'web');
    const m = gating('medical-scheduling');
    for (const key of ['patient.insurance-plan', 'patient.referral-on-file', 'appointment.specialty']) assert.strictEqual(m[key].category, 'health', key);
    assert.strictEqual(m['appointment.window'].category, null);
    assert.strictEqual(m['provider.in-network'].answerable, 'web');
  });

  it('carries the spec budget defaults', () => {
    assert.deepStrictEqual(load('property-sale').playbook.budgetDefaults, { usd: 40, contactsPerDay: 20, questionsPerDay: 6 });
    assert.deepStrictEqual(load('contractor-quotes').playbook.budgetDefaults, { usd: 25, contactsPerDay: 30, questionsPerDay: 6 });
    assert.deepStrictEqual(load('medical-scheduling').playbook.budgetDefaults, { usd: 20, contactsPerDay: 10, questionsPerDay: 6 });
  });

  it('packaged builds keep examples/playbooks (R32)', () => {
    const files = require('../package.json').build.files;
    const keep = files.indexOf('examples/playbooks/**');
    assert.ok(keep !== -1, 'build.files lists examples/playbooks/**');
    const drop = files.indexOf('!examples/**');
    if (drop !== -1) assert.ok(keep > drop, 'the carve-out comes after !examples/**');
  });
});
