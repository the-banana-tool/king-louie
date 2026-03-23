const path = require('path');
const { MemoryStore, MemoryManager } = require('../../src/memory');

function buildStorageFile() {
  const configured = String(process.env.KING_LOUIE_MEMORY_STORE || '').trim();
  if (configured) {
    return configured;
  }

  return path.join(process.cwd(), '.king-louie-memory', 'memory-store.json');
}

module.exports = async function memoryFailureCapture(context = {}) {
  const result = context?.result || {};
  if (result.success !== false) {
    return { action: 'allow' };
  }

  const toolName = String(context?.toolName || 'unknown-tool');
  const errorText = String(result?.error || 'Unknown error');
  const parameters = context?.parameters && typeof context.parameters === 'object'
    ? context.parameters
    : {};

  const store = new MemoryStore({
    storageFile: buildStorageFile()
  });

  const manager = new MemoryManager({
    store,
    currentSessionId: String(context?.sessionId || context?.runId || '').trim() || 'hook-post-tool'
  });

  manager.captureFailure(
    `Tool execution failed (${toolName})`,
    errorText,
    'Review command/tool parameters, environment assumptions, and retry with safer alternatives.',
    {
      source: String(context?.sessionId || 'tool-hook'),
      metadata: {
        toolName,
        parameters
      }
    }
  );

  return { action: 'allow' };
};