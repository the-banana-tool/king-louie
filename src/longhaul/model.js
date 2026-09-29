'use strict';
// The one model call LongHaul makes in stage B0 (authoring, benchmark spec
// §6): one prompt in, text out, through the regular providers with the key
// from the environment, no vault. Tests pass providerInstance, a fake with
// streamMessage.
const ProviderFactory = require('../providers/provider-factory');
const { oneShot } = require('../providers/one-shot');
const { UsageError } = require('./errors');

function createModelClient({ provider, model, env = process.env, options = {}, providerInstance = null } = {}) {
  if (!model) throw new UsageError('--model is required.');
  let instance = providerInstance;
  if (!instance) {
    if (!provider) throw new UsageError('--provider is required.');
    try {
      instance = ProviderFactory.fromEnv(provider, { env, options });
    } catch (err) {
      if (err.code === 'NO_PROVIDER_KEY' || err.code === 'UNKNOWN_PROVIDER' || /Invalid API key/.test(err.message)) throw new UsageError(err.message);
      throw err;
    }
  }
  return {
    provider: provider || 'injected',
    model,
    async complete(prompt, { maxTokens = 800 } = {}) {
      const { text, llmMetrics } = await oneShot(instance, [{ role: 'user', content: prompt }], { model, temperature: 0, max_tokens: maxTokens });
      return { text, llmMetrics };
    }
  };
}

module.exports = { createModelClient };
