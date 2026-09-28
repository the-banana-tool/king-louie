// src/providers/one-shot.js
// One tool-less model call that reports its usage (models spec 2026-09-27
// §8): a chat title, an advisor review. Plain sendMessage returns bare text
// and no usage, so the call goes through streamMessage, collecting the
// chunks; a provider that answers with a whole string still works.
async function oneShot(provider, messages, options = {}) {
  if (!provider || typeof provider.streamMessage !== 'function') {
    throw new Error('oneShot needs a provider with streamMessage.');
  }
  let streamed = '';
  const result = await provider.streamMessage(messages, options, (chunk) => { streamed += String(chunk ?? ''); });
  const text = streamed || (typeof result === 'string' ? result : String(result?.content ?? ''));
  const llmMetrics = result && typeof result === 'object' && result.llmMetrics ? result.llmMetrics : null;
  return { text, llmMetrics };
}

module.exports = { oneShot };
