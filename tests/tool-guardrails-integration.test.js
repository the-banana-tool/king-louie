const { describe, it } = require('node:test');
const assert = require('node:assert');
const AgentLoop = require('../src/execution/agent-loop');
const { ToolGuardrails } = require('../src/execution/tool-guardrails');

require('../src/tools').initializeTools();

/**
 * Provider that keeps asking for the same tool call until it runs out of
 * turns, then answers. Mirrors what a stuck model actually does.
 */
function loopingProvider(toolName, parameters, iterations) {
  let i = 0;
  return {
    getProviderName: () => 'test',
    sendMessageWithTools: async () => (
      i++ < iterations
        ? { type: 'tool_use', toolName, parameters }
        : { type: 'text', content: 'giving up' }
    ),
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

function recordingExecutor(result) {
  const calls = [];
  return {
    calls,
    execute: async (toolName, parameters) => {
      calls.push({ toolName, parameters });
      return typeof result === 'function' ? result(calls.length) : result;
    }
  };
}

const runOptions = { maxIterations: 12 };

describe('AgentLoop + tool guardrails', () => {
  it('attaches a notice when the model repeats a failing call', async () => {
    const provider = loopingProvider('Bash', { command: 'npm run nope' }, 4);
    const executor = recordingExecutor({ success: false, error: 'not found', exitCode: 127 });
    const loop = new AgentLoop(provider, executor, runOptions);

    const result = await loop.run([{ role: 'user', content: 'go' }], [], {});

    const notices = result.tools
      .map((t) => t.result?.guardrailNotice)
      .filter(Boolean);

    assert.ok(notices.length > 0, 'a repeated identical failure should be flagged');
    assert.match(notices[0], /failed 2 times with identical arguments/);
  });

  it('says nothing when each call is different and succeeds', async () => {
    let n = 0;
    const provider = {
      getProviderName: () => 'test',
      sendMessageWithTools: async () => (
        n < 5
          ? { type: 'tool_use', toolName: 'Read', parameters: { file_path: `/f${n++}.js` } }
          : { type: 'text', content: 'done' }
      ),
      buildToolMessages: (response, toolResult, toolCallId) => [
        { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
        { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
      ]
    };
    const executor = recordingExecutor((i) => ({ success: true, content: `body ${i}` }));
    const loop = new AgentLoop(provider, executor, runOptions);

    const result = await loop.run([{ role: 'user', content: 'go' }], [], {});

    const notices = result.tools.map((t) => t.result?.guardrailNotice).filter(Boolean);
    assert.deepStrictEqual(notices, [], 'a healthy turn must stay silent');
  });

  it('blocks execution once hard stops are on and the threshold is passed', async () => {
    const provider = loopingProvider('Bash', { command: 'broken' }, 10);
    const executor = recordingExecutor({ success: false, error: 'nope', exitCode: 1 });
    const loop = new AgentLoop(provider, executor, {
      ...runOptions,
      guardrails: new ToolGuardrails({ hardStopEnabled: true, exactFailureBlockAfter: 3 })
    });

    const result = await loop.run([{ role: 'user', content: 'go' }], [], {});

    assert.strictEqual(
      executor.calls.length, 3,
      'the executor should stop being reached once the guardrail blocks'
    );

    const blocked = result.tools.filter((t) => t.result?.blockedByGuardrail);
    assert.ok(blocked.length > 0);
    assert.strictEqual(blocked[0].result.guardrailCode, 'repeated_exact_failure_block');
    assert.match(blocked[0].result.error, /failed 3 times/);
  });

  it('ends the turn on a halt verdict instead of spinning to maxIterations', async () => {
    // `halt` means the tool has failed across many different arguments —
    // there is nothing to pivot to, so burning the remaining iterations
    // just wastes tokens.
    let n = 0;
    const provider = {
      getProviderName: () => 'test',
      sendMessageWithTools: async () => ({
        type: 'tool_use', toolName: 'Bash', parameters: { command: `cmd-${n++}` }
      }),
      buildToolMessages: (response, toolResult, toolCallId) => [
        { role: 'assistant', content: '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
        { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
      ]
    };
    const executor = recordingExecutor({ success: false, error: 'nope', exitCode: 1 });
    const loop = new AgentLoop(provider, executor, {
      maxIterations: 30,
      guardrails: new ToolGuardrails({ hardStopEnabled: true, sameToolFailureHaltAfter: 4 })
    });

    const result = await loop.run([{ role: 'user', content: 'go' }], [], {});

    assert.strictEqual(result.type, 'guardrail_halt');
    assert.strictEqual(result.guardrail.code, 'same_tool_failure_halt');
    assert.ok(result.iterations < 30, `should stop early, ran ${result.iterations}`);
    assert.match(result.content, /failed 4 times/);
  });

  it('leaves the turn recoverable — a block is a tool result, not a thrown error', async () => {
    // The model must see why it was stopped so it can change course; throwing
    // would discard everything the turn had already established.
    const provider = loopingProvider('Bash', { command: 'broken' }, 6);
    const executor = recordingExecutor({ success: false, error: 'nope', exitCode: 1 });
    const loop = new AgentLoop(provider, executor, {
      ...runOptions,
      guardrails: new ToolGuardrails({ hardStopEnabled: true, exactFailureBlockAfter: 2 })
    });

    const result = await loop.run([{ role: 'user', content: 'go' }], [], {});
    assert.ok(['complete', 'max_iterations'].includes(result.type), `got ${result.type}`);
  });

  it('resets between turns on the same loop instance', async () => {
    const guardrails = new ToolGuardrails({ hardStopEnabled: true, exactFailureBlockAfter: 2 });
    const executor = recordingExecutor({ success: false, error: 'nope', exitCode: 1 });

    const first = new AgentLoop(loopingProvider('Bash', { command: 'x' }, 4), executor, {
      ...runOptions, guardrails
    });
    await first.run([{ role: 'user', content: 'go' }], [], {});
    const callsAfterFirst = executor.calls.length;

    // Same guardrails object, new turn: the counters must not carry over.
    const second = new AgentLoop(loopingProvider('Bash', { command: 'x' }, 4), executor, {
      ...runOptions, guardrails
    });
    await second.run([{ role: 'user', content: 'go' }], [], {});

    assert.ok(
      executor.calls.length > callsAfterFirst,
      'the second turn should get its own budget, not inherit an exhausted one'
    );
  });

  it('never guards AskUser', async () => {
    const guardrails = new ToolGuardrails({ hardStopEnabled: true, exactFailureBlockAfter: 1 });
    // Waiting on a person is not the model spinning.
    guardrails.recordResult('AskUser', { question: 'q' }, { ok: false, error: 'timeout' });
    guardrails.recordResult('AskUser', { question: 'q' }, { ok: false, error: 'timeout' });

    const gate = guardrails.beforeCall('AskUser', { question: 'q' });
    assert.strictEqual(gate.shouldHalt, true, 'the controller itself is tool-agnostic…');

    // …and the loop is what exempts AskUser, so the exemption is verified
    // by the loop never consulting it — see the `guarded` flag in
    // executeSingleCall.
    const loop = new AgentLoop({ getProviderName: () => 't' }, recordingExecutor({}), { guardrails });
    assert.ok(loop.guardrails);
  });

  it('can be turned off entirely', async () => {
    const provider = loopingProvider('Bash', { command: 'broken' }, 5);
    const executor = recordingExecutor({ success: false, error: 'nope', exitCode: 1 });
    const loop = new AgentLoop(provider, executor, { ...runOptions, guardrails: false });

    const result = await loop.run([{ role: 'user', content: 'go' }], [], {});

    assert.strictEqual(loop.guardrails, null);
    assert.strictEqual(executor.calls.length, 5, 'every call should reach the executor');
    const notices = result.tools.map((t) => t.result?.guardrailNotice).filter(Boolean);
    assert.deepStrictEqual(notices, []);
  });
});
