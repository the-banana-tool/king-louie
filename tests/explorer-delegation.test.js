// tests/explorer-delegation.test.js
// The explorer and delegation (models spec 2026-09-27 §8.1): code-explorer
// is a read-only worker agent that returns a capped summary, and main's
// system prompt tells it to delegate reading and searching.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getAgent } = require('../src/agents');
const { DELEGATION_GUIDANCE } = require('../src/context/system-sections');
const ContextAssembler = require('../src/context/context-assembler');
const SpawnAgentTool = require('../src/tools/builtin/spawn-agent-tool');
const { mergeSettings } = require('../src/core/settings');
const { chatHarness } = require('./helpers/chat-harness');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

describe('the explorer', () => {
  it('is a read-only worker agent that returns a summary', () => {
    const explorer = getAgent('code-explorer');
    assert.strictEqual(explorer.name, 'Explorer');
    assert.strictEqual(explorer.role, 'worker');
    assert.deepStrictEqual(explorer.allowedTools, ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);
    assert.strictEqual(explorer.readOnly, true);
    assert.strictEqual(explorer.returnsSummary, true);
    assert.strictEqual(explorer.canUseTool('Bash'), false);
    const template = fs.readFileSync(path.join(__dirname, '..', explorer.systemPromptTemplate), 'utf8');
    assert.doesNotMatch(template, /command-line|Bash/);
    assert.match(template, /paths or URLs/);
  });

  it('models.explorer.summaryMaxTokens defaults to 2000 and merges key by key', () => {
    assert.deepStrictEqual(mergeSettings({}).models.explorer, { summaryMaxTokens: 2000 });
    assert.deepStrictEqual(mergeSettings({ models: { explorer: { summaryMaxTokens: 500 } } }).models.explorer, { summaryMaxTokens: 500 });
  });
});

describe('SpawnAgent caps a summary', () => {
  const run = async (content, settings = {}) => {
    let seen = null;
    const result = await SpawnAgentTool.execute({ task: 'Find every caller of loadConfig', agentId: 'code-explorer' }, {
      agentExecutorAdapter: {
        execute: async (_agent, _msg, opts) => {
          seen = opts;
          return { type: 'complete', content, iterations: 1, tools: [], llm: { calls: [], totals: {} } };
        }
      },
      getAgent: (id) => getAgent(id),
      getSettings: () => settings
    });
    return { result, seen };
  };

  it('tells the explorer its budget and keeps a short answer whole', async () => {
    const { result, seen } = await run('src/config.js calls it twice.');
    assert.match(seen.systemPrompt, /at most about 2000 tokens/);
    assert.strictEqual(result.content, 'src/config.js calls it twice.');
  });

  it('cuts an answer over the cap, saying so', async () => {
    const { result } = await run('x'.repeat(1000), { models: { explorer: { summaryMaxTokens: 100 } } });
    assert.strictEqual(result.content.startsWith('x'.repeat(400)), true);
    assert.strictEqual(result.content.includes('x'.repeat(401)), false);
    assert.match(result.content, /\[Summary cut at about 100 tokens\.\]$/);
  });

  it('never leaves half of an emoji at the cut', async () => {
    const { result } = await run('xyz' + '\u{1F600}'.repeat(200), { models: { explorer: { summaryMaxTokens: 100 } } });
    const body = result.content.slice(0, result.content.indexOf('\n\n[Summary cut'));
    assert.strictEqual(body.length, 399);
    assert.strictEqual(body.isWellFormed(), true);
  });

  it('leaves an agent that returns no summary uncapped', async () => {
    let seen = null;
    const result = await SpawnAgentTool.execute({ task: 'Write it', agentId: 'code-writer' }, {
      agentExecutorAdapter: {
        execute: async (_a, _m, opts) => {
          seen = opts;
          return { type: 'complete', content: 'y'.repeat(20000), iterations: 1, tools: [] };
        }
      },
      getAgent: (id) => getAgent(id),
      getSettings: () => ({ models: { explorer: { summaryMaxTokens: 100 } } })
    });
    assert.strictEqual(result.content.length, 20000);
    assert.strictEqual(seen.systemPrompt, undefined);
  });
});

describe('main is told to delegate', () => {
  const capture = () => {
    const prompts = [];
    const provider = {
      sendMessageWithTools: async (_m, _t, opts) => { prompts.push(opts.systemPrompt); return { type: 'text', content: 'done' }; },
      streamMessage: async (_m, opts, onChunk) => { prompts.push(opts.systemPrompt); onChunk('done'); return {}; }
    };
    return { prompts, h: chatHarness({ provider }) };
  };

  it('puts the delegation guidance first in an agent-mode turn, before everything that changes', async () => {
    const { prompts, h } = capture();
    await h.send({ agentMode: true });
    assert.ok(prompts[0].startsWith(DELEGATION_GUIDANCE), prompts[0]);
    assert.ok(prompts[0].includes('BASE-PROMPT'));
    assert.match(DELEGATION_GUIDANCE, /SpawnAgent/);
    assert.match(DELEGATION_GUIDANCE, /code-explorer/);
  });

  it('leaves a plain chat turn without it', async () => {
    const { prompts, h } = capture();
    await h.send({ agentMode: false });
    assert.strictEqual(prompts[0].includes(DELEGATION_GUIDANCE), false);
  });

  it('keeps SpawnAgent among the always-loaded tools', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-assembler-'));
    try {
      const assembler = new ContextAssembler({ vectorStorePath: path.join(dir, 'vectors.json') });
      const def = (name) => ({ name, description: `${name} tool`, parameters: { type: 'object', properties: {} } });
      await assembler.index([def('Read'), def('SpawnAgent'), def('CronCreate')], []);
      const assembled = await assembler.assemble('hi');
      assert.ok(assembled.tools.some((t) => t.name === 'SpawnAgent'));
      assert.ok(!assembled.availableToolNames.includes('SpawnAgent'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
