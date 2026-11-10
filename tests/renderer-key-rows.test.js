// tests/renderer-key-rows.test.js
// Providers & keys rows (settings redesign Task 10, spec §5.5, §8.5): the state,
// reason and button of one key row, and the failing-keys banner.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { keyRowState, failingCount, failingBannerText, isNetworkFailure } = require('../renderer-helpers/key-rows.js');

const CHECKED = '2026-11-09T10:00:00.000Z';
const HINT = 'it is the example value from the setup guide';

describe('keyRowState', () => {
  it('no key: No key and Add, even with an old status', () => {
    assert.deepStrictEqual(keyRowState({ hasKey: false, status: null }), { state: 'no-key', reason: '', action: 'Add' });
    assert.deepStrictEqual(
      keyRowState({ hasKey: false, status: { ok: true, message: 'Connected: 3 models.' } }),
      { state: 'no-key', reason: '', action: 'Add' }
    );
  });

  it('a working status gives its message and when it was tested', () => {
    const out = keyRowState({ hasKey: true, status: { ok: true, message: 'Connected: 3 models.', checkedAt: CHECKED } });
    assert.deepStrictEqual(out, {
      state: 'working',
      reason: `Connected: 3 models. · tested ${new Date(CHECKED).toLocaleString()}`,
      action: 'Edit'
    });
  });

  it('a working status with no checkedAt gives the message alone', () => {
    assert.deepStrictEqual(
      keyRowState({ hasKey: true, status: { ok: true, message: 'Connected: 1 model.' } }),
      { state: 'working', reason: 'Connected: 1 model.', action: 'Edit' }
    );
  });

  it('a failing status gives the provider error', () => {
    assert.deepStrictEqual(
      keyRowState({ hasKey: true, status: { ok: false, error: 'Invalid API key', message: 'Invalid API key', httpStatus: 401 } }),
      { state: 'failing', reason: 'Invalid API key', action: 'Edit' }
    );
  });

  it('a failing status with a hint says the key looks like a placeholder', () => {
    const out = keyRowState({ hasKey: true, status: { ok: false, error: 'Invalid API key', message: 'Invalid API key', httpStatus: 401, hint: HINT } });
    assert.deepStrictEqual(out, { state: 'failing', reason: `Looks like a placeholder: ${HINT}`, action: 'Edit' });
  });

  it('a network failure keeps its own message even with a hint (controller ruling)', () => {
    for (const message of ['fetch failed', 'connect ECONNREFUSED 127.0.0.1:443', 'getaddrinfo ENOTFOUND api.example.com',
      'The operation was aborted due to timeout', 'connect ETIMEDOUT 10.0.0.1:443']) {
      const out = keyRowState({ hasKey: true, status: { ok: false, error: message, message, hint: HINT } });
      assert.deepStrictEqual(out, { state: 'failing', reason: message, action: 'Edit' }, message);
    }
  });

  it('an HTTP answer is never a network failure', () => {
    assert.strictEqual(isNetworkFailure({ ok: false, error: 'request timeout', httpStatus: 401 }), false);
    assert.strictEqual(isNetworkFailure({ ok: false, error: 'fetch failed' }), true);
    assert.strictEqual(isNetworkFailure({ ok: false, error: 'Invalid API key' }), false);
  });

  it('a key with no status is Not tested yet', () => {
    assert.deepStrictEqual(keyRowState({ hasKey: true, status: null }), { state: 'not-tested', reason: 'Not tested yet', action: 'Edit' });
    assert.deepStrictEqual(keyRowState({ hasKey: true }), { state: 'not-tested', reason: 'Not tested yet', action: 'Edit' });
  });

  it('a session test result is read like a status', () => {
    assert.deepStrictEqual(
      keyRowState({ hasKey: true, status: null, tested: { ok: true, message: 'Brave Search is working.' } }),
      { state: 'working', reason: 'Brave Search is working.', action: 'Edit' }
    );
    assert.deepStrictEqual(
      keyRowState({ hasKey: true, status: null, tested: { ok: false, error: 'Brave Search answered 401.' } }),
      { state: 'failing', reason: 'Brave Search answered 401.', action: 'Edit' }
    );
  });

  it('a session test result wins over a stored status', () => {
    const out = keyRowState({ hasKey: true, status: { ok: true, message: 'old' }, tested: { ok: false, error: 'new' } });
    assert.strictEqual(out.state, 'failing');
    assert.strictEqual(out.reason, 'new');
  });
});

describe('failingCount and the banner', () => {
  it('counts model providers whose key fails', () => {
    const providers = {
      openai: { hasToken: true, status: { ok: false, error: 'bad' } },
      groq: { hasToken: true, status: { ok: true, message: 'ok' } },
      mistral: { hasToken: false, status: { ok: false, error: 'No token saved.' } },
      gemini: { hasToken: true, status: null },
      cohere: { hasToken: true, status: { ok: false, error: 'bad' } }
    };
    assert.strictEqual(failingCount(providers), 2);
    assert.strictEqual(failingCount({}), 0);
    assert.strictEqual(failingCount(null), 0);
  });

  it('says how many keys fail, in the spec words', () => {
    assert.strictEqual(failingBannerText(1), '1 key is failing. Models from that provider are skipped until you fix or remove the key.');
    assert.strictEqual(failingBannerText(3), '3 keys are failing. Models from those providers are skipped until you fix or remove the key.');
  });
});
