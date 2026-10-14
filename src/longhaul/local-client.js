'use strict';
// The local model client (local inference spec 2026-10-13 §11.1): a fifth
// client role beside answer, judge and summarizer, for the adapters that
// measure recall jobs on a model the owner runs (kl-recall-rewrite,
// kl-recall-abstain-check, kl-recall-llm-rerank, kl-recall-digest).
//
// The base URL is checked and pinned as the app checks a local server's
// (src/models/local-address.js), and every request goes through the pinned
// transport (src/models/local-transport.js) to the app's own local server
// provider, at temperature 0. A base URL that fails the check, or an Ollama
// cloud model id, is refused (LOCAL_REQUIRED, exit 2) before any request.
// A LAN http address is accepted: LongHaul measures, it does not carry the
// app's guarantee; config.json records the address class.
//
// The client is `local: true`, so what LongHaul already does for local
// clients applies: priceCall is 0, the spend guard adds nothing, and
// assertMaySend never asks --send-private for it.
const { resolveAndPin, parseBaseUrl } = require('../models/local-address');
const { createLocalTransport } = require('../models/local-transport');
const { discoverModels } = require('../models/local-probe');
const { isOllamaCloudModelId } = require('../models/provider-ids');
const LocalServerProvider = require('../providers/local-server-provider');
const { oneShot } = require('../providers/one-shot');
const { UsageError } = require('./errors');
const { cacheKey, cachedCall } = require('./model-cache');
const { sha256Text } = require('./files');
const { createLogger } = require('../logging');

const log = createLogger('longhaul/local-client');

const LOCAL_PROVIDERS = Object.freeze(['ollama', 'openai-compatible']);
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
// The server id the client's provider uses for itself; the model a call is
// recorded under is "<id>/<model>", never shown to the server.
const SERVER_ID = 'longhaul';
const LIST_TIMEOUT_MS = 20000;

const required = (message) => new UsageError(message, 'LOCAL_REQUIRED');

/**
 * @param {object} options
 * @param {'ollama'|'openai-compatible'} options.provider
 * @param {string} options.model - the id the server knows the model by
 * @param {string} [options.baseUrl] - the server root (default http://127.0.0.1:11434 for ollama)
 * @param {number|null} [options.context] - the model's window in tokens, when the server does not say
 * @param {Function} [options.lookup] - dns.promises.lookup's shape (tests inject one)
 * @param {object} [options.transportOptions] - extra createLocalTransport options (tests only)
 * @returns {Promise<{ provider: 'local', kind: string, model: string, baseUrl: string, local: true, addressClass: string,
 *   context: number|null, digest: string|null, complete: Function, close: Function }>}
 */
async function createLocalClient({ provider, model, baseUrl = null, context = null, lookup, transportOptions = {} } = {}) {
  if (!LOCAL_PROVIDERS.includes(provider)) {
    throw new UsageError(`--local-provider must be ${LOCAL_PROVIDERS.join(' or ')}, got ${JSON.stringify(provider)}`);
  }
  if (typeof model !== 'string' || !model.trim()) throw new UsageError('--local-model is required with --local-provider.');
  if (context !== null && (!Number.isInteger(context) || context <= 0)) {
    throw new UsageError(`--local-context must be a positive whole number, got ${JSON.stringify(context)}`);
  }
  const url = baseUrl || (provider === 'ollama' ? DEFAULT_OLLAMA_URL : null);
  if (!url) throw new UsageError('--local-base-url is required with --local-provider openai-compatible.');
  if (provider === 'ollama' && isOllamaCloudModelId(model)) {
    throw required(`${model} runs on Ollama's cloud, not on the local server; these adapters measure a local model. Nothing was sent.`);
  }

  let parsed;
  let pinned;
  try {
    parsed = parseBaseUrl(url);
    pinned = await resolveAndPin(parsed.href, lookup ? { lookup } : {});
  } catch (err) {
    throw required(`${url} is not a local server address (${err.code || 'invalid'}). ${err.message} These adapters measure a local model; nothing was sent.`);
  }
  const root = parsed.href.replace(/\/+$/, '');
  const transport = createLocalTransport({ baseUrl: root, addresses: pinned.addresses, ...transportOptions });
  const kind = provider;
  const instance = new LocalServerProvider(null, {
    baseUrl: `${root}/v1`, transport, serverId: SERVER_ID, addressClass: pinned.class, kind: kind === 'ollama' ? 'ollama' : 'openai-compatible'
  });

  // The server-reported digest names the exact model in every cache key (a
  // tag can be pulled again under the same name), so on Ollama the listing
  // must answer and must hold the model. Elsewhere the listing only gives
  // the window, when the server says it and --local-context did not.
  let listed = null;
  try {
    const models = await discoverModels({ kind: kind === 'ollama' ? 'ollama' : 'openai-compatible', baseUrl: root }, { fetch: transport.fetch, timeoutMs: LIST_TIMEOUT_MS });
    listed = models.find((m) => m.id === model) || null;
    if (!listed && kind === 'ollama') {
      transport.close();
      throw new UsageError(`The local server at ${root} does not list ${model}. Pull it first.`, 'LOCAL_MODEL_NOT_LISTED');
    }
  } catch (err) {
    if (err instanceof UsageError) throw err;
    if (kind === 'ollama') {
      transport.close();
      throw new UsageError(`The local server at ${root} did not list its models (${err.code || 'error'}); its digest names the model in the cache keys.`, 'LOCAL_UNREACHABLE');
    }
    log.info('the local server did not list its models; the window is --local-context or unknown', { code: err.code || 'error' });
  }

  const client = {
    provider: 'local',
    kind,
    model,
    baseUrl: root,
    local: true,
    addressClass: pinned.class,
    context: context ?? listed?.context ?? null,
    digest: listed?.digest ?? null,
    async complete(prompt, { maxTokens = 800 } = {}) {
      const { text, llmMetrics } = await oneShot(instance, [{ role: 'user', content: prompt }], {
        model: `${SERVER_ID}/${model}`, temperature: 0, max_tokens: maxTokens
      });
      return { text, llmMetrics };
    },
    close() {
      transport.close();
    }
  };
  log.info('local model client', { kind, addressClass: pinned.class, digest: client.digest !== null, context: client.context });
  return client;
}

function median(xs, p = 0.5) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// The local client an adapter was given; refused (LOCAL_REQUIRED) when there
// is none, or when it is not local.
function requireLocalClient(local, adapterName) {
  const client = local && local.client;
  if (!client || typeof client.complete !== 'function') {
    throw new UsageError(`${adapterName} needs a local model: --local-provider and --local-model, or --fake-models.`, 'LOCAL_REQUIRED');
  }
  if (client.local !== true) {
    throw new UsageError(`${adapterName} measures a local model, and ${client.provider}/${client.model} is not one.`, 'LOCAL_REQUIRED');
  }
  return client;
}

// The answer stage's refusal of a local call that is not cached.
function localCallsMissing(adapterName, what) {
  return new UsageError(`${adapterName}: ${what} is not cached for these settings, and the answer stage makes no call `
    + 'outside its plan; nothing was sent. Run the evidence-only run with the same settings first.', 'LOCAL_CALLS_MISSING');
}

/**
 * The local calls of one adapter (spec §11.2): every call goes through the
 * model cache, keyed by the stage, the client (provider, model, base URL,
 * the server's digest), the prompt file's hash, max tokens and the rendered
 * prompt's hash. With cachedOnly (the answer stage and its dry run) a miss
 * stops the run (LOCAL_CALLS_MISSING) rather than call outside the plan.
 * Counts and latency only, for runStats().
 * @param {object} local - { client, cache, retry?, cachedOnly? }
 * @param {string} adapterName
 */
function createLocalCaller(local, adapterName) {
  const client = requireLocalClient(local, adapterName);
  if (!local.cache) throw new Error(`${adapterName} needs the model cache for its local calls.`);
  const stats = { calls: 0, cacheHits: 0, ms: [] };
  return {
    client,
    stats,
    keyFor({ stage, prompt, promptFile, maxTokens }) {
      return cacheKey({
        stage, provider: client.provider, model: client.model, baseUrl: client.baseUrl, digest: client.digest ?? null,
        promptSha256: promptFile.sha256, maxTokens, inputSha256: sha256Text(prompt)
      });
    },
    async call({ stage, prompt, promptFile, maxTokens, meta = {} }) {
      const key = this.keyFor({ stage, prompt, promptFile, maxTokens });
      if (local.cachedOnly === true && !local.cache.get(stage, key)) throw localCallsMissing(adapterName, `a local ${stage} call`);
      const out = await cachedCall({ cache: local.cache, stage, key, client, prompt, maxTokens, retry: local.retry || {}, meta });
      if (out.cached) {
        stats.cacheHits += 1;
      } else {
        stats.calls += 1;
        if (Number.isFinite(out.latencyMs)) stats.ms.push(out.latencyMs);
      }
      return out;
    },
    summary() {
      return { calls: stats.calls, cacheHits: stats.cacheHits, callMsMedian: median(stats.ms), callMsP90: median(stats.ms, 0.9) };
    }
  };
}

// What config.json and describe() say of the local model.
const localModelLabel = (client) => `${client.kind || client.provider}/${client.model}`;

module.exports = {
  createLocalClient, createLocalCaller, requireLocalClient, localCallsMissing, localModelLabel, median, LOCAL_PROVIDERS, DEFAULT_OLLAMA_URL
};
