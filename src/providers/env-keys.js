'use strict';
// Environment variables that hold each provider's API key, for hosts with no
// vault: scripts/smoke-providers.js and the LongHaul CLI. The first variable
// that is set wins. Ollama needs no key.
const PROVIDER_KEY_ENV = Object.freeze({
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  xai: ['XAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  cohere: ['COHERE_API_KEY', 'CO_API_KEY'],
  copilot: ['GITHUB_TOKEN']
});

function keyFromEnv(provider, env = process.env) {
  const names = PROVIDER_KEY_ENV[String(provider || '').toLowerCase()] || [];
  const name = names.find((n) => typeof env[n] === 'string' && env[n].trim());
  return name ? { name, value: env[name].trim() } : null;
}

module.exports = { PROVIDER_KEY_ENV, keyFromEnv };
