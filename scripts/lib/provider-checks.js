// scripts/lib/provider-checks.js
// The provider checks shared by the fake-server test
// (tests/providers-fake-server.test.js) and the opt-in live check
// (npm run smoke:providers): stream a short reply, and make one tool call.
const LOOKUP_TOOL = Object.freeze({
  name: 'Lookup',
  description: 'Look up a fact. Call it with q set to the word weather.',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
});

async function checkStreaming(provider, { model, abortSignal = null } = {}) {
  let text = '';
  const result = await provider.streamMessage(
    [{ role: 'user', content: 'Reply with exactly: Hello there' }],
    { model, max_tokens: 50, ...(abortSignal ? { abortSignal } : {}) },
    (chunk) => { text += chunk; }
  );
  return { text, llmMetrics: result?.llmMetrics || null };
}

async function checkToolCall(provider, { model } = {}) {
  return provider.sendMessageWithTools(
    [{ role: 'user', content: 'Call the Lookup tool with q set to weather. Do not answer in text.' }],
    [LOOKUP_TOOL],
    { model, max_tokens: 200 }
  );
}

// Both checks, never throwing: ok when text streamed and the tool was called.
async function runProviderChecks(provider, { model } = {}) {
  const out = { ok: false, text: '', toolName: null, parameters: null, costUsd: null, errors: [] };
  try {
    const streamed = await checkStreaming(provider, { model });
    out.text = streamed.text;
    out.costUsd = streamed.llmMetrics?.costUsd ?? null;
    if (!streamed.text.trim()) out.errors.push('stream: no text');
  } catch (err) {
    out.errors.push(`stream: ${err.message}`);
  }
  try {
    const response = await checkToolCall(provider, { model });
    out.toolName = response?.type === 'tool_use' ? response.toolName : null;
    out.parameters = response?.type === 'tool_use' ? response.parameters : null;
    if (out.toolName !== LOOKUP_TOOL.name) out.errors.push(`tool: expected a ${LOOKUP_TOOL.name} call, got ${response?.type || 'nothing'}`);
  } catch (err) {
    out.errors.push(`tool: ${err.message}`);
  }
  out.ok = out.errors.length === 0;
  return out;
}

module.exports = { LOOKUP_TOOL, checkStreaming, checkToolCall, runProviderChecks };
