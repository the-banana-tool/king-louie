// tests/longhaul-prompts.test.js
// Versioned prompts (benchmark spec §8.1, §11) and retries (§15).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PROMPTS, loadPrompt, placeholders, fillTemplate } = require('../src/longhaul/prompts');
const { retryable, isAuthFailure, withRetries } = require('../src/longhaul/retry');
const { sha256Text } = require('../src/longhaul/files');

describe('prompts', () => {
  it('loads each versioned prompt with the SHA-256 of its exact bytes', () => {
    for (const name of Object.keys(PROMPTS)) {
      const p = loadPrompt(name);
      assert.strictEqual(p.name, name);
      assert.strictEqual(p.file, PROMPTS[name]);
      assert.strictEqual(p.text, fs.readFileSync(path.join(__dirname, '..', 'src', 'longhaul', 'prompts', PROMPTS[name]), 'utf8'));
      assert.strictEqual(p.sha256, sha256Text(p.text));
    }
    assert.throws(() => loadPrompt('nope'), /unknown prompt/);
  });

  it('gives each prompt exactly its placeholders; the judge never sees a context', () => {
    assert.deepStrictEqual(placeholders(loadPrompt('answer').text), ['context', 'question']);
    assert.deepStrictEqual(placeholders(loadPrompt('judge').text), ['acceptable', 'kind', 'kindRule', 'question', 'reference', 'reply']);
    assert.deepStrictEqual(placeholders(loadPrompt('summarize').text), ['maxWords', 'messages', 'previous']);
  });

  it('fills in one pass, so a value holding "{{question}}" or "$&" is kept verbatim', () => {
    const out = fillTemplate('A {{context}} B {{question}}', { context: 'x {{question}} $& y', question: 'Q?' });
    assert.strictEqual(out, 'A x {{question}} $& y B Q?');
  });

  it('refuses to leave a placeholder unfilled', () => {
    assert.throws(() => fillTemplate('{{a}} {{b}}', { a: 1 }), /prompt needs b/);
  });
});

describe('withRetries', () => {
  const status = (s, extra = {}) => Object.assign(new Error(`status ${s}`), { status: s, ...extra });
  function failing(errors, value = 'ok') {
    const calls = [];
    let i = 0;
    return {
      calls,
      fn: async (attempt) => {
        calls.push(attempt);
        if (i < errors.length) throw errors[i++];
        return value;
      }
    };
  }
  const noWait = { wait: async () => {} };

  it('retries 429, 5xx and transport failures three times, then throws the last error', async () => {
    const f = failing([status(429), status(503), new TypeError('fetch failed'), status(500)]);
    await assert.rejects(withRetries(f.fn, noWait), /status 500/);
    assert.deepStrictEqual(f.calls, [1, 2, 3, 4]);
  });

  it('returns once a retry succeeds, waiting the provider\'s retry-after', async () => {
    const waits = [];
    const f = failing([status(429, { retryAfterMs: 1234 })]);
    assert.strictEqual(await withRetries(f.fn, { wait: async (ms) => { waits.push(ms); } }), 'ok');
    assert.deepStrictEqual(waits, [1234]);
  });

  it('never retries a 400 or a refused key', async () => {
    for (const s of [400, 401, 403]) {
      const f = failing([status(s)]);
      await assert.rejects(withRetries(f.fn, noWait), new RegExp(`status ${s}`));
      assert.deepStrictEqual(f.calls, [1]);
    }
    assert.strictEqual(retryable(status(404)), false);
    assert.strictEqual(retryable(new Error('socket hang up')), true);
    assert.strictEqual(isAuthFailure(status(401)), true);
    assert.strictEqual(isAuthFailure(status(500)), false);
  });
});
