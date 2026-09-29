#!/usr/bin/env node
// scripts/smoke-providers.js
// Opt-in live check (spec 2026-09-27 §16): for every provider whose key is in
// the environment, stream a short reply and make one tool call against the
// real API. It spends a little real money and is not part of npm test.
//   OPENAI_API_KEY=... npm run smoke:providers
// KL_SMOKE_MODEL_<PROVIDER> picks a provider's model (default: its default
// model). Ollama runs when KL_SMOKE_OLLAMA_URL and KL_SMOKE_MODEL_OLLAMA are set.
const ProviderFactory = require('../src/providers/provider-factory');
const { KL_PROVIDERS } = require('../src/models/provider-ids');
const { runProviderChecks } = require('./lib/provider-checks');

const { PROVIDER_KEY_ENV: KEY_ENV } = require('../src/providers/env-keys');

// Which providers to check, from the environment. Pure, for the tests.
function selectTargets(env = process.env) {
  const targets = [];
  for (const provider of KL_PROVIDERS) {
    const model = env[`KL_SMOKE_MODEL_${provider.toUpperCase()}`] || null;
    if (provider === 'ollama') {
      if (env.KL_SMOKE_OLLAMA_URL && model) targets.push({ provider, key: '', model, options: { serverUrl: env.KL_SMOKE_OLLAMA_URL } });
      continue;
    }
    const name = (KEY_ENV[provider] || []).find((n) => env[n]);
    if (name) targets.push({ provider, key: env[name], model, options: {} });
  }
  return targets;
}

async function main() {
  const targets = selectTargets();
  if (targets.length === 0) {
    process.stdout.write('No provider keys in the environment; nothing to check.\n');
    return;
  }
  let failed = 0;
  for (const target of targets) {
    const provider = ProviderFactory.create(target.provider, target.key, target.options);
    const model = target.model || provider.getDefaultModel();
    const result = await runProviderChecks(provider, { model });
    if (!result.ok) failed += 1;
    const cost = result.costUsd === null ? 'unpriced' : `$${result.costUsd}`;
    process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} ${target.provider} ${model} (${cost})${result.ok ? '' : `: ${result.errors.join('; ')}`}\n`);
  }
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`smoke:providers failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { selectTargets, KEY_ENV };
