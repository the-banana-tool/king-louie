const { describe, it } = require('node:test');
const assert = require('node:assert');
const InferenceRouter = require('../src/providers/inference-router');

describe('InferenceRouter', () => {
  const mockConfig = (overrides = {}) => {
    const defaultSettings = {
      inference: {
        tierMap: {
          fast: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
          standard: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
          smart: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' }
        },
        activeTier: 'standard'
      },
      activeProvider: 'openai'
    };

    return {
      getSettings: () => ({ ...defaultSettings, ...overrides.settings }),
      getProviderModel: (p) => overrides.models?.[p] || '',
      getProviderToken: (p) => 'fake-token',
      createProvider: (p, t) => overrides.providers?.[p] || {
        getDefaultModel: () => 'default-model',
        sendMessage: async () => `response from ${p}`,
        sendMessageWithTools: async () => `tool response from ${p}`
      }
    };
  };

  it('resolves fast tier to groq', () => {
    const router = new InferenceRouter(mockConfig());
    const resolved = router.getTierConfig('fast');
    assert.strictEqual(resolved.provider, 'groq');
    assert.strictEqual(resolved.model, 'llama-3.3-70b-versatile');
  });

  it('falls back when primary provider fails', async () => {
    let openaiCalled = false;
    let groqCalled = false;

    const router = new InferenceRouter(mockConfig({
      providers: {
        groq: {
          getDefaultModel: () => 'llama-3.3',
          sendMessage: async () => {
            groqCalled = true;
            throw new Error('Groq failed');
          }
        },
        openai: {
          getDefaultModel: () => 'gpt-4o-mini',
          sendMessage: async () => {
            openaiCalled = true;
            return 'openai response';
          }
        }
      }
    }));

    const result = await router.routeWithFallback('fast', [{ role: 'user', content: 'hi' }], {});
    assert.strictEqual(groqCalled, true);
    assert.strictEqual(openaiCalled, true);
    assert.strictEqual(result, 'openai response');
  });

  it('throws when no fallback available', async () => {
    const router = new InferenceRouter(mockConfig({
      providers: {
        anthropic: {
          getDefaultModel: () => 'claude-3',
          sendMessage: async () => {
            throw new Error('Anthropic failed');
          }
        }
      }
    }));

    await assert.rejects(
      async () => router.routeWithFallback('standard', [{ role: 'user', content: 'hi' }], {}),
      /Anthropic failed/
    );
  });

  it('returns capabilities for known models', () => {
    const router = new InferenceRouter(mockConfig());
    const caps = router.getCapabilities('openai', 'gpt-4o');
    assert.strictEqual(caps.vision, true);
    assert.strictEqual(caps.toolCalling, true);
  });

  it('all new providers are valid tier options', () => {
    const providers = ['groq', 'ollama', 'mistral', 'gemini', 'openrouter'];

    for (const p of providers) {
      const router = new InferenceRouter(mockConfig({
        settings: {
          inference: {
            tierMap: { fast: { provider: p, model: 'test-model' } }
          }
        }
      }));
      const resolved = router.getTierConfig('fast');
      assert.strictEqual(resolved.provider, p);
      assert.strictEqual(resolved.model, 'test-model');
    }
  });

  it('resolves Ollama as active provider without a real token', () => {
    const router = new InferenceRouter(mockConfig({
      settings: {
        activeProvider: 'ollama',
        inference: {
          tierMap: {},
          activeTier: 'standard'
        }
      }
    }));
    const resolved = router.resolve({});
    assert.strictEqual(resolved.providerType, 'ollama');
  });

  it('resolves Ollama with dummy token from getProviderToken', () => {
    const router = new InferenceRouter({
      getSettings: () => ({
        activeProvider: 'ollama',
        inference: { tierMap: {}, activeTier: 'standard' }
      }),
      getProviderModel: () => 'llama3',
      getProviderToken: (p) => {
        if (p === 'ollama') return 'not-required';
        throw new Error(`No token for ${p}`);
      },
      createProvider: (p, t) => ({
        getDefaultModel: () => 'llama3',
        sendMessage: async () => `response from ${p}`
      })
    });
    const resolved = router.resolve({});
    assert.strictEqual(resolved.providerType, 'ollama');
    assert.strictEqual(resolved.model, 'llama3');
    assert.ok(resolved.provider);
  });

  it('executes chat through Ollama provider', async () => {
    let receivedToken = null;
    const router = new InferenceRouter({
      getSettings: () => ({
        activeProvider: 'ollama',
        inference: {
          tierMap: { standard: { provider: 'ollama', model: 'llama3' } },
          activeTier: 'standard'
        }
      }),
      getProviderModel: () => '',
      getProviderToken: (p) => {
        if (p === 'ollama') return 'not-required';
        throw new Error(`No token for ${p}`);
      },
      createProvider: (p, t) => {
        receivedToken = t;
        return {
          getDefaultModel: () => 'llama3',
          sendMessage: async () => 'ollama says hi'
        };
      }
    });

    const result = await router.routeWithFallback('standard', [{ role: 'user', content: 'hi' }], {});
    assert.strictEqual(result, 'ollama says hi');
    assert.strictEqual(receivedToken, 'not-required');
  });
});

describe('InferenceRouter failover policy', () => {
  const { ProviderError } = require('../src/providers/provider-error');

  // Fails `failures` times with `error`, then succeeds. Records every call.
  const flakyProvider = (failures, error, response = 'recovered') => {
    const calls = [];
    return {
      calls,
      provider: {
        getDefaultModel: () => 'test-model',
        sendMessage: async () => {
          calls.push(Date.now());
          if (calls.length <= failures) throw error;
          return response;
        }
      }
    };
  };

  const routerFor = (providers, overrides = {}) => {
    const waits = [];
    const router = new InferenceRouter({
      getSettings: () => ({
        inference: {
          tierMap: { fast: { provider: 'groq', model: 'llama-3.3-70b-versatile' } },
          activeTier: 'fast'
        },
        activeProvider: 'groq'
      }),
      getProviderModel: () => '',
      getProviderToken: () => 'fake-token',
      createProvider: (p) => providers[p] || {
        getDefaultModel: () => 'default-model',
        sendMessage: async () => `response from ${p}`
      },
      sleep: async (ms) => { waits.push(ms); },
      ...overrides
    });
    return { router, waits };
  };

  it('retries a rate limit on the same provider instead of burning the fallback', async () => {
    const groq = flakyProvider(
      2,
      new ProviderError('Rate limit exceeded', { status: 429, provider: 'groq' })
    );
    let openaiCalled = false;

    const { router, waits } = routerFor({
      groq: groq.provider,
      openai: {
        getDefaultModel: () => 'gpt-4o-mini',
        sendMessage: async () => { openaiCalled = true; return 'openai response'; }
      }
    });

    const result = await router.routeWithFallback('fast', [{ role: 'user', content: 'hi' }], {});

    assert.strictEqual(result, 'recovered');
    assert.strictEqual(groq.calls.length, 3, 'should retry the primary twice');
    assert.strictEqual(openaiCalled, false, 'must not fall back for a rate limit');
    assert.deepStrictEqual(waits, [2000, 4000], 'exponential backoff between retries');
  });

  it('waits exactly as long as a retry-after header asks', async () => {
    const err = new ProviderError('Rate limit exceeded', {
      status: 429, provider: 'groq', retryAfterMs: 7500
    });
    const groq = flakyProvider(1, err);

    const { router, waits } = routerFor({ groq: groq.provider });
    await router.routeWithFallback('fast', [{ role: 'user', content: 'hi' }], {});

    assert.deepStrictEqual(waits, [7500]);
  });

  it('escalates to the fallback once the retry budget is spent', async () => {
    const groq = flakyProvider(
      99,
      new ProviderError('Rate limit exceeded', { status: 429, provider: 'groq' })
    );
    let openaiCalled = false;

    const { router } = routerFor({
      groq: groq.provider,
      openai: {
        getDefaultModel: () => 'gpt-4o-mini',
        sendMessage: async () => { openaiCalled = true; return 'openai response'; }
      }
    });

    const result = await router.routeWithFallback('fast', [{ role: 'user', content: 'hi' }], {});

    assert.strictEqual(result, 'openai response');
    assert.strictEqual(openaiCalled, true);
    assert.strictEqual(groq.calls.length, 3, 'two retries then escalate');
  });

  it('falls back immediately on an upstream-model rate limit', async () => {
    const openrouter = flakyProvider(
      99,
      new ProviderError('Provider returned error: upstream model is rate limited', {
        status: 429, provider: 'openrouter'
      })
    );

    const { router, waits } = routerFor(
      {
        openrouter: openrouter.provider,
        openai: {
          getDefaultModel: () => 'gpt-4o-mini',
          sendMessage: async () => 'openai response'
        }
      }
    );
    router.fallbacks.openrouter = { provider: 'openai', model: 'gpt-4o-mini' };
    router.getTierConfig = () => ({ provider: 'openrouter', model: 'anthropic/claude-3', tier: 'fast' });

    const result = await router.routeWithFallback('fast', [{ role: 'user', content: 'hi' }], {});

    assert.strictEqual(result, 'openai response');
    assert.strictEqual(openrouter.calls.length, 1, 'the throttled model must not be retried');
    assert.deepStrictEqual(waits, [], 'no point waiting on someone else’s quota');
  });

  it('aborts immediately on a permanent failure without touching the fallback', async () => {
    const groq = flakyProvider(
      99,
      new ProviderError('Invalid value for tool_choice', { status: 400, provider: 'groq' })
    );
    let openaiCalled = false;

    const { router } = routerFor({
      groq: groq.provider,
      openai: {
        getDefaultModel: () => 'gpt-4o-mini',
        sendMessage: async () => { openaiCalled = true; return 'openai response'; }
      }
    });

    await assert.rejects(
      () => router.routeWithFallback('fast', [{ role: 'user', content: 'hi' }], {}),
      /Invalid value for tool_choice/
    );
    assert.strictEqual(groq.calls.length, 1);
    assert.strictEqual(openaiCalled, false, 'a malformed request fails the same way anywhere');
  });

  it('compresses and retries a context overflow when a hook is available', async () => {
    const overflow = new ProviderError('prompt is too long: 210000 tokens > 200000 maximum', {
      status: 400, provider: 'groq'
    });
    const groq = flakyProvider(1, overflow);

    let compressCalls = 0;
    const { router } = routerFor({ groq: groq.provider }, {
      compressContext: async (messages) => {
        compressCalls += 1;
        return messages.slice(-1);
      }
    });

    const result = await router.routeWithFallback(
      'fast',
      [{ role: 'user', content: 'old' }, { role: 'user', content: 'new' }],
      {}
    );

    assert.strictEqual(result, 'recovered');
    assert.strictEqual(compressCalls, 1);
  });

  it('degrades to a model fallback when no compression hook is wired', async () => {
    const overflow = new ProviderError('prompt is too long', { status: 400, provider: 'groq' });
    const groq = flakyProvider(99, overflow);

    const { router } = routerFor({
      groq: groq.provider,
      openai: {
        getDefaultModel: () => 'gpt-4o-mini',
        sendMessage: async () => 'openai response'
      }
    });

    const result = await router.routeWithFallback('fast', [{ role: 'user', content: 'hi' }], {});
    assert.strictEqual(result, 'openai response');
  });

  it('rotates the credential when a hook is available instead of failing over', async () => {
    const authError = new ProviderError('Incorrect API key provided', {
      status: 401, provider: 'groq'
    });
    const groq = flakyProvider(1, authError);

    let rotations = 0;
    const { router } = routerFor({ groq: groq.provider }, {
      rotateCredential: async () => { rotations += 1; return true; }
    });

    const result = await router.routeWithFallback('fast', [{ role: 'user', content: 'hi' }], {});
    assert.strictEqual(result, 'recovered');
    assert.strictEqual(rotations, 1);
  });

  it('does not loop between two targets that both keep failing', async () => {
    const err = new ProviderError('Service unavailable', { status: 503, provider: 'groq' });
    const groq = flakyProvider(99, err);
    const openai = flakyProvider(99, new ProviderError('Service unavailable', {
      status: 503, provider: 'openai'
    }));

    const { router } = routerFor({ groq: groq.provider, openai: openai.provider });

    await assert.rejects(
      () => router.routeWithFallback('fast', [{ role: 'user', content: 'hi' }], {}),
      /Service unavailable/
    );
    // Ceiling reached rather than ping-ponging forever.
    assert.ok(groq.calls.length + openai.calls.length <= router.policy.maxTotalAttempts + 1);
  });

  it('never retries or fails over on user cancellation', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const groq = flakyProvider(99, abort);
    let openaiCalled = false;

    const { router } = routerFor({
      groq: groq.provider,
      openai: {
        getDefaultModel: () => 'gpt-4o-mini',
        sendMessage: async () => { openaiCalled = true; return 'openai response'; }
      }
    });

    await assert.rejects(
      () => router.routeWithFallback('fast', [{ role: 'user', content: 'hi' }], {}),
      /aborted/
    );
    assert.strictEqual(groq.calls.length, 1);
    assert.strictEqual(openaiCalled, false);
  });
});
