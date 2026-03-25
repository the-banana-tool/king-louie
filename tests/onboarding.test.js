const { describe, it } = require('node:test');
const assert = require('node:assert');
const { isFirstRun, completeOnboarding, getWizardSteps } = require('../src/wizard/onboarding-wizard');

describe('Onboarding', () => {
  it('detects first run correctly', () => {
    const store = { get: () => false };
    assert.ok(isFirstRun(store));
  });

  it('does not trigger on subsequent runs', () => {
    const store = { get: () => true };
    assert.ok(!isFirstRun(store));
  });

  it('marks onboarding as complete', () => {
    let stored = {};
    const store = { get: (k, d) => stored[k] !== undefined ? stored[k] : d, set: (k, v) => { stored[k] = v; } };
    completeOnboarding(store);
    assert.ok(store.get('onboardingComplete', false));
  });

  it('wizard steps are in correct order', () => {
    const steps = getWizardSteps();
    assert.strictEqual(steps[0].id, 'welcome');
    assert.strictEqual(steps[1].id, 'provider');
    assert.strictEqual(steps[steps.length - 1].id, 'finish');
  });

  it('provider step validates API key presence', () => {
    const step = getWizardSteps().find(s => s.id === 'provider');
    assert.ok(!step.validate({ provider: 'openai', apiKey: '' }));
    assert.ok(step.validate({ provider: 'openai', apiKey: 'sk-test' }));
  });

  it('allows skipping optional steps', () => {
    const steps = getWizardSteps();
    const channelStep = steps.find(s => s.id === 'channels');
    assert.ok(channelStep.optional);
  });

  it('has 5 wizard steps', () => {
    const steps = getWizardSteps();
    assert.strictEqual(steps.length, 5);
  });

  it('non-optional steps are marked correctly', () => {
    const steps = getWizardSteps();
    const nonOptional = steps.filter(s => !s.optional);
    assert.strictEqual(nonOptional.length, 4);
  });

  it('profile step validates name', () => {
    const step = getWizardSteps().find(s => s.id === 'profile');
    assert.ok(!step.validate({ name: '' }));
    assert.ok(step.validate({ name: 'John' }));
  });
});
