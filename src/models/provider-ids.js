// src/models/provider-ids.js
// King Louie's provider keys and how they map onto the models.dev and
// OpenRouter namespaces (spec 2026-09-27 §4.3). The one place this map lives.

const KL_PROVIDERS = Object.freeze([
  'openai', 'anthropic', 'gemini', 'groq', 'mistral', 'ollama', 'openrouter',
  'xai', 'deepseek', 'qwen', 'together', 'fireworks', 'cohere', 'copilot'
]);

// King Louie key → models.dev provider id. Keys not listed map to themselves.
// Ollama's catalog entries are Ollama Cloud's; local models come from the
// Ollama server itself (src/models/ollama.js).
const MODELS_DEV_IDS = Object.freeze({
  gemini: 'google',
  qwen: 'alibaba',
  together: 'togetherai',
  fireworks: 'fireworks-ai',
  copilot: 'github-copilot',
  ollama: 'ollama-cloud'
});

// King Louie key → the vendor prefix OpenRouter uses in its model ids, for
// attaching Artificial Analysis scores to the vendor's own models.
const OPENROUTER_VENDORS = Object.freeze({
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  xai: 'x-ai',
  deepseek: 'deepseek',
  mistral: 'mistralai',
  qwen: 'qwen',
  cohere: 'cohere'
});

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

// An Ollama Cloud model says so in its own id (Ollama's own naming); every
// other id is a local model, priced at zero regardless of whether an Ollama
// Cloud model happens to share the exact id (for example gpt-oss:20b) —
// only an explicit -cloud/:cloud id prices against the Cloud catalog
// entries (spec §4.1 item 4, final review I4).
function isOllamaCloudModelId(id) {
  const s = String(id || '');
  return s.endsWith('-cloud') || s.endsWith(':cloud');
}

function modelsDevIdFor(provider) {
  const p = normalizeProvider(provider);
  return MODELS_DEV_IDS[p] || p;
}

function providerForModelsDevId(id) {
  const wanted = String(id || '').trim().toLowerCase();
  return KL_PROVIDERS.find((p) => modelsDevIdFor(p) === wanted) || null;
}

module.exports = {
  KL_PROVIDERS,
  MODELS_DEV_IDS,
  OPENROUTER_VENDORS,
  DEFAULT_OLLAMA_BASE_URL,
  normalizeProvider,
  modelsDevIdFor,
  providerForModelsDevId,
  isOllamaCloudModelId
};
