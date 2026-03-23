const assert = require('assert');

const { applyActiveProviderUpdate } = require('../src/ipc/settings-provider');

function run(name, fn) {
  try {
    fn();
    console.log(`✔ ${name}`);
  } catch (error) {
    console.error(`✖ ${name}`);
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }
}

run('applyActiveProviderUpdate rejects unknown providers', () => {
  let setSettingsCalls = 0;
  let resetCalls = 0;

  const result = applyActiveProviderUpdate({
    provider: 'unknown',
    providerLabels: { openai: 'OpenAI' },
    getSettings: () => ({ activeProvider: 'openai' }),
    setSettings: () => {
      setSettingsCalls += 1;
    },
    resetRuntimeEnvironmentCache: () => {
      resetCalls += 1;
    }
  });

  assert.deepStrictEqual(result, { ok: false, error: 'Unknown provider.' });
  assert.strictEqual(setSettingsCalls, 0);
  assert.strictEqual(resetCalls, 0);
});

run('applyActiveProviderUpdate persists provider and resets runtime cache', () => {
  let nextSettings = null;
  let resetCalls = 0;

  const result = applyActiveProviderUpdate({
    provider: 'anthropic',
    providerLabels: { openai: 'OpenAI', anthropic: 'Anthropic Claude' },
    getSettings: () => ({ activeProvider: 'openai', inference: { activeTier: 'standard' } }),
    setSettings: (settings) => {
      nextSettings = settings;
    },
    resetRuntimeEnvironmentCache: () => {
      resetCalls += 1;
    }
  });

  assert.deepStrictEqual(result, { ok: true, activeProvider: 'anthropic' });
  assert.ok(nextSettings);
  assert.strictEqual(nextSettings.activeProvider, 'anthropic');
  assert.strictEqual(nextSettings.inference.activeTier, 'standard');
  assert.strictEqual(resetCalls, 1);
});

run('applyActiveProviderUpdate succeeds without reset callback', () => {
  let nextSettings = null;

  const result = applyActiveProviderUpdate({
    provider: 'openai',
    providerLabels: { openai: 'OpenAI' },
    getSettings: () => ({ activeProvider: 'anthropic' }),
    setSettings: (settings) => {
      nextSettings = settings;
    }
  });

  assert.deepStrictEqual(result, { ok: true, activeProvider: 'openai' });
  assert.strictEqual(nextSettings.activeProvider, 'openai');
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}

console.log('Settings provider tests completed.');