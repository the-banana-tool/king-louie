// tests/wizard-steps.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { getWizardSteps } = require('../src/wizard/onboarding-wizard');

const ids = (steps) => steps.map((s) => s.id);

describe('getWizardSteps', () => {
  it('standalone: today\'s five', () => {
    assert.deepStrictEqual(ids(getWizardSteps()), ['welcome', 'provider', 'profile', 'channels', 'finish']);
    assert.deepStrictEqual(ids(getWizardSteps({})), ['welcome', 'provider', 'profile', 'channels', 'finish']);
    assert.deepStrictEqual(ids(getWizardSteps({ attached: false })), ['welcome', 'provider', 'profile', 'channels', 'finish']);
  });

  it('attached: provider, profile, an optional phone step, finish', () => {
    const steps = getWizardSteps({ attached: true });
    assert.deepStrictEqual(ids(steps), ['provider', 'profile', 'phone', 'finish']);
    assert.strictEqual(steps.find((s) => s.id === 'phone').optional, true);
    assert.strictEqual(steps.find((s) => s.id === 'provider').optional, false);
    assert.strictEqual(steps.find((s) => s.id === 'phone').validate({}), true);
    assert.strictEqual(steps.find((s) => s.id === 'provider').validate({ provider: 'openai', apiKey: '' }), false);
    assert.ok(steps.every((s) => s.title && s.description));
  });
});
