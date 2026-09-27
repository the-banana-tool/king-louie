// src/models/ollama.js
// Local Ollama discovery (spec 2026-09-27 §5.4): /api/tags lists installed
// models; /api/show gives each one's context length and capabilities (tool
// calling and image input where Ollama reports them).
const { createLogger } = require('../logging');

const log = createLogger('models/ollama');
const root = (baseUrl) => String(baseUrl || '').replace(/\/+$/, '');

async function showModel(fetchImpl, base, name, signal) {
  try {
    const res = await fetchImpl(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
      ...(signal ? { signal } : {})
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const info = await res.json();
    const capabilities = Array.isArray(info?.capabilities) ? info.capabilities : null;
    const modelInfo = info?.model_info && typeof info.model_info === 'object' ? info.model_info : {};
    const contextKey = Object.keys(modelInfo).find((k) => k.endsWith('.context_length'));
    const context = contextKey && Number.isFinite(modelInfo[contextKey]) ? modelInfo[contextKey] : null;
    return {
      id: name,
      context,
      toolCall: capabilities ? capabilities.includes('tools') : null,
      imageInput: capabilities ? capabilities.includes('vision') : false
    };
  } catch (err) {
    log.warn(`Ollama /api/show for ${name} failed: ${err.message}`);
    return { id: name, context: null, toolCall: null, imageInput: false };
  }
}

async function discoverOllama({ baseUrl, fetch: fetchImpl = globalThis.fetch, signal = null } = {}) {
  const base = root(baseUrl);
  let res;
  try {
    res = await fetchImpl(`${base}/api/tags`, signal ? { signal } : {});
  } catch (err) {
    const e = new Error(`Ollama at ${base} did not answer: ${err.message}`);
    e.cause = err;
    throw e;
  }
  if (!res.ok) throw new Error(`Ollama at ${base} returned ${res.status} for /api/tags.`);
  const body = await res.json();
  const names = (Array.isArray(body?.models) ? body.models : [])
    .map((m) => m?.name || m?.model)
    .filter((n) => typeof n === 'string' && n);
  const found = [];
  for (const name of names) found.push(await showModel(fetchImpl, base, name, signal));
  return found;
}

module.exports = { discoverOllama };
