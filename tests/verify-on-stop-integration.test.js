const { describe, it } = require('node:test');
const assert = require('node:assert');
const AgentLoop = require('../src/execution/agent-loop');
const { EvidenceLedger } = require('../src/verification');

require('../src/tools').initializeTools();

/** Provider that plays a scripted sequence of responses. */
function scriptedProvider(script) {
  let i = 0;
  return {
    getProviderName: () => 'test',
    lastMessages: null,
    sendMessageWithTools: async function (messages) {
      this.lastMessages = messages;
      return script[Math.min(i++, script.length - 1)];
    },
    buildToolMessages: (response, toolResult, toolCallId) => [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: toolCallId,
          type: 'function',
          function: { name: response.toolName, arguments: JSON.stringify(response.parameters || {}) }
        }]
      },
      { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
    ]
  };
}

function executorFor(map) {
  return {
    workingDirectory: '/tmp/verify-proj',
    execute: async (toolName, parameters) => map(toolName, parameters)
  };
}

const editThenFinish = [
  { type: 'tool_use', toolName: 'Edit', parameters: { file_path: '/tmp/verify-proj/src/app.js', old_string: 'a', new_string: 'b' } },
  { type: 'text', content: 'Done — the fix is in.' }
];

const baseOptions = () => ({
  maxIterations: 8,
  verifyOnStop: true,
  evidenceLedger: new EvidenceLedger(),
  guardrails: false
});

describe('AgentLoop verify-on-stop', () => {
  it('nudges when a turn edits code and runs nothing', async () => {
    const provider = scriptedProvider(editThenFinish);
    const executor = executorFor(() => ({
      success: true, filePath: '/tmp/verify-proj/src/app.js', linesAdded: 1, linesRemoved: 1
    }));

    const loop = new AgentLoop(provider, executor, baseOptions());
    const result = await loop.run([{ role: 'user', content: 'fix it' }], [], {});

    assert.ok(result.verification?.nudged, 'the turn should have been nudged');

    const nudge = provider.lastMessages.find(
      (m) => m.role === 'user' && /nothing was run/.test(m.content || '')
    );
    assert.ok(nudge, 'the nudge should reach the model as a user message');
    assert.match(nudge.content, /src[/\\]app\.js/);
  });

  it('does not nudge when the suite ran and passed', async () => {
    const provider = scriptedProvider([
      { type: 'tool_use', toolName: 'Edit', parameters: { file_path: '/tmp/verify-proj/src/app.js' } },
      { type: 'tool_use', toolName: 'Bash', parameters: { command: 'npm test' } },
      { type: 'text', content: 'Done, tests pass.' }
    ]);
    const executor = executorFor((toolName) => (
      toolName === 'Edit'
        ? { success: true, filePath: '/tmp/verify-proj/src/app.js', linesAdded: 1, linesRemoved: 0 }
        : { success: true, stdout: '42 passing', stderr: '', exitCode: 0 }
    ));

    const loop = new AgentLoop(provider, executor, baseOptions());
    const result = await loop.run([{ role: 'user', content: 'fix it' }], [], {});

    assert.strictEqual(result.type, 'complete');
    assert.strictEqual(result.verification, undefined, 'a verified turn should finish clean');
  });

  it('does not nudge when only documentation changed', async () => {
    const provider = scriptedProvider([
      { type: 'tool_use', toolName: 'Write', parameters: { path: '/tmp/verify-proj/README.md' } },
      { type: 'text', content: 'Docs updated.' }
    ]);
    const executor = executorFor(() => ({
      success: true, filePath: '/tmp/verify-proj/README.md'
    }));

    const loop = new AgentLoop(provider, executor, baseOptions());
    const result = await loop.run([{ role: 'user', content: 'update docs' }], [], {});

    assert.strictEqual(result.type, 'complete');
    assert.strictEqual(result.verification, undefined);
  });

  it('does not nudge when a test already failed — the agent can see that', async () => {
    const provider = scriptedProvider([
      { type: 'tool_use', toolName: 'Edit', parameters: { file_path: '/tmp/verify-proj/src/app.js' } },
      { type: 'tool_use', toolName: 'Bash', parameters: { command: 'npm test' } },
      { type: 'text', content: 'Tests are failing, here is why…' }
    ]);
    const executor = executorFor((toolName) => (
      toolName === 'Edit'
        ? { success: true, filePath: '/tmp/verify-proj/src/app.js', linesAdded: 1, linesRemoved: 0 }
        : { success: false, stdout: '1 failing', stderr: '', exitCode: 1 }
    ));

    const loop = new AgentLoop(provider, executor, baseOptions());
    const result = await loop.run([{ role: 'user', content: 'fix it' }], [], {});

    assert.strictEqual(result.verification, undefined);
  });

  it('nudges at most once, then lets the turn finish', async () => {
    // The model ignores the nudge and repeats itself. The turn must still
    // end rather than looping on the same reminder.
    const provider = scriptedProvider([
      { type: 'tool_use', toolName: 'Edit', parameters: { file_path: '/tmp/verify-proj/src/app.js' } },
      { type: 'text', content: 'Done.' },
      { type: 'text', content: 'Still done.' }
    ]);
    const executor = executorFor(() => ({
      success: true, filePath: '/tmp/verify-proj/src/app.js', linesAdded: 1, linesRemoved: 0
    }));

    const loop = new AgentLoop(provider, executor, baseOptions());
    const result = await loop.run([{ role: 'user', content: 'fix it' }], [], {});

    assert.strictEqual(result.type, 'complete');
    assert.strictEqual(result.content, 'Still done.');

    const nudges = provider.lastMessages.filter(
      (m) => m.role === 'user' && /Before finishing/.test(m.content || '')
    );
    assert.strictEqual(nudges.length, 1, 'exactly one nudge, never a nag loop');
  });

  it('gives the bounded message after a targeted-only run', async () => {
    const provider = scriptedProvider([
      { type: 'tool_use', toolName: 'Edit', parameters: { file_path: '/tmp/verify-proj/src/app.js' } },
      { type: 'tool_use', toolName: 'Bash', parameters: { command: 'node --test tests/app.test.js' } },
      { type: 'text', content: 'Done.' }
    ]);
    const executor = executorFor((toolName) => (
      toolName === 'Edit'
        ? { success: true, filePath: '/tmp/verify-proj/src/app.js', linesAdded: 1, linesRemoved: 0 }
        : { success: true, stdout: 'ok', stderr: '', exitCode: 0 }
    ));

    const loop = new AgentLoop(provider, executor, baseOptions());
    await loop.run([{ role: 'user', content: 'fix it' }], [], {});

    const nudge = provider.lastMessages.find(
      (m) => m.role === 'user' && /Before finishing/.test(m.content || '')
    );
    assert.ok(nudge);
    assert.match(nudge.content, /targeted/);
  });

  it('is inert unless explicitly enabled', async () => {
    const provider = scriptedProvider(editThenFinish);
    const executor = executorFor(() => ({
      success: true, filePath: '/tmp/verify-proj/src/app.js', linesAdded: 1, linesRemoved: 1
    }));

    const loop = new AgentLoop(provider, executor, {
      maxIterations: 8, guardrails: false   // verifyOnStop omitted
    });
    const result = await loop.run([{ role: 'user', content: 'fix it' }], [], {});

    assert.strictEqual(result.type, 'complete');
    assert.strictEqual(result.verification, undefined);
  });

  it('still records evidence while the nudge itself is off', async () => {
    // The ledger is passive bookkeeping and safe to keep running; only the
    // policy is opt-in.
    const ledger = new EvidenceLedger();
    const provider = scriptedProvider([
      { type: 'tool_use', toolName: 'Bash', parameters: { command: 'npm test' } },
      { type: 'text', content: 'Done.' }
    ]);
    const executor = executorFor(() => ({
      success: true, stdout: 'ok', stderr: '', exitCode: 0
    }));

    const loop = new AgentLoop(provider, executor, {
      maxIterations: 8, guardrails: false, evidenceLedger: ledger
    });
    await loop.run([{ role: 'user', content: 'test it' }], [], {});

    assert.strictEqual(ledger.status('/tmp/verify-proj').hasFullPass, true);
  });

  it('does not let a broken ledger stop the turn', async () => {
    const provider = scriptedProvider(editThenFinish);
    const executor = executorFor(() => ({
      success: true, filePath: '/tmp/verify-proj/src/app.js', linesAdded: 1, linesRemoved: 1
    }));

    const brokenLedger = new EvidenceLedger();
    brokenLedger.status = () => { throw new Error('ledger exploded'); };

    const loop = new AgentLoop(provider, executor, {
      maxIterations: 8, verifyOnStop: true, guardrails: false, evidenceLedger: brokenLedger
    });
    const result = await loop.run([{ role: 'user', content: 'fix it' }], [], {});

    assert.strictEqual(result.type, 'complete');
  });
});
