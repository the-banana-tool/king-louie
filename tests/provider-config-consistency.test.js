const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ProviderFactory = require('../src/providers/provider-factory');

/**
 * The provider picker UI is built from `providerLabels` / `providerDefaults`
 * in main.js. Every provider offered there must be creatable by
 * ProviderFactory — otherwise "Set Active" + sending a message blows up with
 * `Unknown provider: "x"` deep in the inference path, and the model dropdown
 * silently shows nothing. This guards that the menu and the factory agree.
 */
function extractObjectKeys(source, varName) {
  const start = source.indexOf(`const ${varName} = {`);
  assert.ok(start !== -1, `Could not find "const ${varName} = {" in main.js`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end !== -1, `Unbalanced braces for ${varName}`);
  const body = source.slice(open + 1, end);
  return [...body.matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)].map((m) => m[1]);
}

describe('Provider config consistency (main.js ↔ ProviderFactory)', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const labelKeys = extractObjectKeys(mainSrc, 'providerLabels');
  const defaultKeys = extractObjectKeys(mainSrc, 'providerDefaults');
  const registered = new Set(ProviderFactory.listRegistered());

  it('finds a realistic provider list (sanity)', () => {
    assert.ok(labelKeys.length >= 8, `expected >=8 providers, got ${labelKeys.length}`);
  });

  it('providerLabels and providerDefaults expose the same providers', () => {
    assert.deepStrictEqual([...labelKeys].sort(), [...defaultKeys].sort());
  });

  it('every provider offered in the UI is registered in ProviderFactory', () => {
    const unregistered = labelKeys.filter((k) => !registered.has(k)).sort();
    assert.deepStrictEqual(
      unregistered,
      [],
      `Providers offered in Settings but NOT creatable (chat will throw "Unknown provider"):\n  ${unregistered.join('\n  ')}`
    );
  });

  it('ollama is registered and needs no API key', () => {
    assert.ok(registered.has('ollama'));
    const provider = ProviderFactory.create('ollama', undefined);
    assert.doesNotThrow(() => provider.validateApiKey());
    assert.strictEqual(provider.getName(), 'ollama');
  });
});
