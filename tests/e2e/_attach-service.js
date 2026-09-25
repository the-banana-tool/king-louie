// Test-only service host for tests/e2e (fleet stage 7): a stub provider, a
// gated probe tool and runService, with the bound bridge port written into
// the temp desktop-bridge.json. Never used outside the e2e suite.
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const ProviderFactory = require('../../src/providers/provider-factory');
const { buildServicePorts } = require('../../src/service/ports');
const { createCore } = require('../../src/core');
const { CHAT_DATA_DEFAULTS } = require('../../src/core/settings');
const { runService } = require('../../src/service/run');
const { Tool } = require('../../src/tools/tool-schema');
const { toolRegistry } = require('../../src/tools');
const { addSink } = require('../../src/logging');
const { bridgeFileRecord, writeFileAtomic } = require('../../src/desktop-bridge/pairing');

const dataDir = path.resolve(process.argv[process.argv.indexOf('--data-dir') + 1]);
const configDir = path.join(path.dirname(dataDir), 'config');
const PROBE = 'KlE2eGatedProbe';

// If the parent (the e2e harness's test process) goes away without sending
// { type: 'shutdown' } first — a crash, a forced kill that somehow leaves
// this child's IPC channel torn down before the process itself — this must
// not become an orphan service (fix round 1, I1).
process.on('disconnect', () => process.exit(0));

// Registered as `openai`: the chat send path accepts only openai/anthropic/gemini types.
class StubProvider {
  async sendMessage() { return 'Stub chat'; }
  async streamMessage(_messages, _options, onChunk) {
    const text = 'Hello from the stub provider.';
    for (const word of text.split(' ')) onChunk(`${word} `);
    return { content: text, llmMetrics: null };
  }
  async sendMessageWithTools(messages) {
    if (Array.isArray(messages) && messages.some((m) => m && m.role === 'tool')) return { type: 'text', content: 'The probe ran.' };
    return { type: 'tool_use', toolName: PROBE, toolUseId: 'call_1', parameters: {} };
  }
  buildToolMessages(response, toolResult, toolCallId) {
    return [
      { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
    ];
  }
}
ProviderFactory.registerProvider('openai', StubProvider);

// Seed the provider settings through the stores, before the service opens them.
const seed = createCore(buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS }));
const tiers = { provider: 'openai', model: 'stub' };
const settings = seed.getSettings();
seed.context.setSettings({ ...settings, activeProvider: 'openai', inference: { ...settings.inference, llmRouting: { enabled: false }, tierMap: { fast: tiers, standard: tiers, smart: tiers } } });
seed.saveProviderToken('openai', 'sk-e2e-stub-token');

let boundPort = null;
addSink((record) => {
  const m = /desktop bridge listening on 127\.0\.0\.1:(\d+)/.exec(record.message);
  if (m) boundPort = Number(m[1]);
});

const watcher = new Writable({
  write(chunk, _enc, done) {
    const text = chunk.toString();
    process.stdout.write(text);
    if (text.includes('"event":"ready"')) {
      toolRegistry.register(new Tool({
        name: PROBE,
        description: 'E2E-only tool that requires approval.',
        parameters: { type: 'object', properties: {} },
        requiresApproval: true,
        execute: async () => ({ ok: true, ran: true })
      }));
      const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'chat-data.json'), 'utf8'));
      const record = bridgeFileRecord({ publicKey: data.mesh.identity.publicKey, port: boundPort });
      writeFileAtomic(path.join(configDir, 'desktop-bridge.json'), `${JSON.stringify(record, null, 2)}\n`, 0o644);
      process.stdout.write(`KL_ATTACH_SERVICE ${JSON.stringify({ port: boundPort })}\n`);
    }
    done();
  }
});

runService({ dataDir, profile: 'agent', stdout: watcher, adminUid: typeof process.getuid === 'function' ? process.getuid() : undefined })
  .then(() => process.exit(0))
  .catch((err) => { process.stderr.write(`${err.stack || err}\n`); process.exit(1); });
