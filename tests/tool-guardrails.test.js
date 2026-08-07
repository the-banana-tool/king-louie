const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  ToolGuardrails,
  ACTIONS,
  signatureOf,
  canonicalArgs,
  isFailure,
  mutationLanded
} = require('../src/execution/tool-guardrails');

// Realistic result shapes, matching what the actual tools return.
const ok = (extra = {}) => ({ success: true, ...extra });
const fail = (error = 'boom') => ({ success: false, error });
const readOk = (content) => ({ success: true, content });
const editOk = (added, removed) => ({
  success: true, replacements: 1, filePath: '/x.js', linesAdded: added, linesRemoved: removed
});
const bashOk = (stdout = '') => ({ success: true, stdout, stderr: '', exitCode: 0 });
const bashFail = (code = 1) => ({ success: false, stdout: '', stderr: 'nope', exitCode: code });

describe('canonicalArgs', () => {
  it('is insensitive to key order', () => {
    assert.strictEqual(canonicalArgs({ a: 1, b: 2 }), canonicalArgs({ b: 2, a: 1 }));
  });

  it('sorts nested keys too', () => {
    assert.strictEqual(
      canonicalArgs({ o: { y: 1, x: 2 } }),
      canonicalArgs({ o: { x: 2, y: 1 } })
    );
  });

  it('distinguishes genuinely different arguments', () => {
    assert.notStrictEqual(canonicalArgs({ path: 'a.js' }), canonicalArgs({ path: 'b.js' }));
  });

  it('does not confuse array order', () => {
    assert.notStrictEqual(canonicalArgs({ e: [1, 2] }), canonicalArgs({ e: [2, 1] }));
  });

  it('survives values JSON cannot represent', () => {
    assert.doesNotThrow(() => canonicalArgs({ fn: () => {}, u: undefined }));
  });
});

describe('signatureOf', () => {
  it('matches the same call regardless of key order', () => {
    assert.strictEqual(
      signatureOf('Read', { path: 'a.js', offset: 0 }),
      signatureOf('Read', { offset: 0, path: 'a.js' })
    );
  });

  it('separates different tools with identical args', () => {
    assert.notStrictEqual(signatureOf('Read', { p: 1 }), signatureOf('Grep', { p: 1 }));
  });

  it('does not leak raw argument values', () => {
    const sig = signatureOf('Vault', { key: 'super-secret-token' });
    assert.ok(!sig.includes('super-secret-token'));
  });
});

describe('isFailure', () => {
  it('recognises the shapes tools actually return', () => {
    assert.strictEqual(isFailure(fail()), true);
    assert.strictEqual(isFailure({ ok: false, error: 'x' }), true);
    assert.strictEqual(isFailure(bashFail(127)), true);
    assert.strictEqual(isFailure(ok()), false);
    assert.strictEqual(isFailure(bashOk()), false);
  });

  it('does not count cancellation or denial as model failure', () => {
    // The model didn't cause these, and denial-tracker already owns the
    // repeated-denial case — double-counting would nag about someone
    // else's decision.
    assert.strictEqual(isFailure({ success: false, cancelled: true }), false);
    assert.strictEqual(isFailure({ success: false, deniedBy: 'user' }), false);
    assert.strictEqual(isFailure({ success: false, blockedByHook: true }), false);
  });
});

describe('mutationLanded', () => {
  it('is null for tools where the question does not apply', () => {
    assert.strictEqual(mutationLanded('Read', readOk('x')), null);
    assert.strictEqual(mutationLanded('Bash', bashOk()), null);
  });

  it('detects an Edit that reported success but changed nothing', () => {
    assert.strictEqual(mutationLanded('Edit', editOk(0, 0)), false);
    assert.strictEqual(mutationLanded('Edit', editOk(3, 1)), true);
  });

  it('reads Write and MultiEdit shapes', () => {
    assert.strictEqual(mutationLanded('Write', ok({ filePath: '/a.js' })), true);
    assert.strictEqual(mutationLanded('MultiEdit', ok({ succeeded: 2, failed: 0 })), true);
    assert.strictEqual(mutationLanded('MultiEdit', ok({ succeeded: 0, failed: 0 })), false);
  });
});

describe('ToolGuardrails — repeated identical failures', () => {
  let guard;
  beforeEach(() => { guard = new ToolGuardrails(); });

  it('warns on the second identical failure, not the first', () => {
    const args = { command: 'npm run nope' };

    const first = guard.recordResult('Bash', args, bashFail());
    assert.strictEqual(first.action, ACTIONS.ALLOW);

    const second = guard.recordResult('Bash', args, bashFail());
    assert.strictEqual(second.action, ACTIONS.WARN);
    assert.strictEqual(second.code, 'repeated_exact_failure');
    assert.strictEqual(second.count, 2);
  });

  it('does not warn when the arguments actually change', () => {
    assert.strictEqual(guard.recordResult('Bash', { command: 'a' }, bashFail()).action, ACTIONS.ALLOW);
    assert.strictEqual(guard.recordResult('Bash', { command: 'b' }, bashFail()).action, ACTIONS.ALLOW);
  });

  it('clears the streak once the same call succeeds', () => {
    const args = { command: 'npm test' };
    guard.recordResult('Bash', args, bashFail());
    guard.recordResult('Bash', args, bashFail());
    guard.recordResult('Bash', args, bashOk('pass'));

    const after = guard.recordResult('Bash', args, bashFail());
    assert.strictEqual(after.action, ACTIONS.ALLOW, 'a success should reset the counter');
  });

  it('does not block while hard stops are off', () => {
    const args = { command: 'broken' };
    for (let i = 0; i < 10; i += 1) guard.recordResult('Bash', args, bashFail());

    const gate = guard.beforeCall('Bash', args);
    assert.strictEqual(gate.action, ACTIONS.ALLOW);
    assert.strictEqual(gate.allowsExecution, true);
  });

  it('blocks after the threshold when hard stops are on', () => {
    const strict = new ToolGuardrails({ hardStopEnabled: true });
    const args = { command: 'broken' };

    for (let i = 0; i < 5; i += 1) strict.recordResult('Bash', args, bashFail());

    const gate = strict.beforeCall('Bash', args);
    assert.strictEqual(gate.action, ACTIONS.BLOCK);
    assert.strictEqual(gate.code, 'repeated_exact_failure_block');
    assert.strictEqual(gate.shouldHalt, true);
    assert.strictEqual(strict.haltDecision.code, 'repeated_exact_failure_block');
  });
});

describe('ToolGuardrails — same tool failing with varying arguments', () => {
  it('warns once the tool itself looks like the problem', () => {
    const guard = new ToolGuardrails();

    guard.recordResult('Bash', { command: 'a' }, bashFail());
    guard.recordResult('Bash', { command: 'b' }, bashFail());
    const third = guard.recordResult('Bash', { command: 'c' }, bashFail());

    assert.strictEqual(third.action, ACTIONS.WARN);
    assert.strictEqual(third.code, 'same_tool_failure');
  });

  it('forgets the flailing streak once the tool succeeds', () => {
    // "the tool or the environment is broken" is falsified by a success, and
    // fail-fix-fail is what debugging looks like.
    const guard = new ToolGuardrails();

    guard.recordResult('Bash', { command: 'a' }, bashFail());
    guard.recordResult('Bash', { command: 'b' }, bashFail());
    guard.recordResult('Bash', { command: 'c' }, bashOk());

    const next = guard.recordResult('Bash', { command: 'd' }, bashFail());
    assert.strictEqual(next.action, ACTIONS.ALLOW);
  });

  it('halts after sustained flailing when hard stops are on', () => {
    const strict = new ToolGuardrails({ hardStopEnabled: true });
    for (let i = 0; i < 8; i += 1) {
      strict.recordResult('Bash', { command: `cmd-${i}` }, bashFail());
    }

    const gate = strict.beforeCall('Bash', { command: 'cmd-9' });
    assert.strictEqual(gate.action, ACTIONS.HALT);
    assert.strictEqual(gate.code, 'same_tool_failure_halt');
  });
});

describe('ToolGuardrails — idempotent no-progress', () => {
  let guard;
  beforeEach(() => { guard = new ToolGuardrails(); });

  it('warns when the same read keeps returning the same bytes', () => {
    const args = { file_path: '/src/app.js' };

    assert.strictEqual(guard.recordResult('Read', args, readOk('same')).action, ACTIONS.ALLOW);
    const second = guard.recordResult('Read', args, readOk('same'));

    assert.strictEqual(second.action, ACTIONS.WARN);
    assert.strictEqual(second.code, 'idempotent_no_progress');
  });

  it('stays quiet when the file changed between reads', () => {
    const args = { file_path: '/src/app.js' };

    guard.recordResult('Read', args, readOk('before'));
    const second = guard.recordResult('Read', args, readOk('after'));

    assert.strictEqual(
      second.action, ACTIONS.ALLOW,
      're-reading a file the agent just edited is progress, not a loop'
    );
  });

  it('restarts the streak after a changed result', () => {
    const args = { file_path: '/src/app.js' };
    guard.recordResult('Read', args, readOk('v1'));
    guard.recordResult('Read', args, readOk('v1'));   // would warn
    guard.recordResult('Read', args, readOk('v2'));   // progress — reset

    const next = guard.recordResult('Read', args, readOk('v2'));
    assert.strictEqual(next.action, ACTIONS.WARN, 'a new streak builds from the new result');
    assert.strictEqual(next.count, 2);
  });

  it('does not apply the no-progress rule to mutating tools', () => {
    // Writing the same content twice is redundant but not a read loop, and
    // Bash returning identical stdout twice is often perfectly correct.
    const args = { command: 'git status' };
    guard.recordResult('Bash', args, bashOk('clean'));
    const second = guard.recordResult('Bash', args, bashOk('clean'));
    assert.strictEqual(second.action, ACTIONS.ALLOW);
  });

  it('blocks a stuck read when hard stops are on', () => {
    const strict = new ToolGuardrails({ hardStopEnabled: true });
    const args = { file_path: '/src/app.js' };
    for (let i = 0; i < 5; i += 1) strict.recordResult('Read', args, readOk('same'));

    const gate = strict.beforeCall('Read', args);
    assert.strictEqual(gate.action, ACTIONS.BLOCK);
    assert.strictEqual(gate.code, 'idempotent_no_progress_block');
  });
});

describe('ToolGuardrails — no-op mutations', () => {
  let guard;
  beforeEach(() => { guard = new ToolGuardrails(); });

  it('warns about an edit that succeeds without changing anything', () => {
    const args = { file_path: '/x.js', old_string: 'foo', new_string: 'foo' };

    assert.strictEqual(guard.recordResult('Edit', args, editOk(0, 0)).action, ACTIONS.ALLOW);
    const second = guard.recordResult('Edit', args, editOk(0, 0));

    assert.strictEqual(second.action, ACTIONS.WARN);
    assert.strictEqual(second.code, 'noop_mutation');
  });

  it('stays quiet when the edit really lands', () => {
    const args = { file_path: '/x.js', old_string: 'a', new_string: 'b' };
    guard.recordResult('Edit', args, editOk(1, 1));
    const second = guard.recordResult('Edit', args, editOk(2, 1));
    assert.strictEqual(second.action, ACTIONS.ALLOW);
  });

  it('blocks a repeatedly no-op edit when hard stops are on', () => {
    const strict = new ToolGuardrails({ hardStopEnabled: true });
    const args = { file_path: '/x.js', old_string: 'foo', new_string: 'foo' };
    for (let i = 0; i < 4; i += 1) strict.recordResult('Edit', args, editOk(0, 0));

    const gate = strict.beforeCall('Edit', args);
    assert.strictEqual(gate.action, ACTIONS.BLOCK);
    assert.strictEqual(gate.code, 'noop_mutation_block');
  });
});

describe('ToolGuardrails — loop caps', () => {
  it('enforces the cap even with hard stops off', () => {
    // Caps bound cost rather than correcting behavior, so they are not part
    // of the opt-in circuit breaker.
    const guard = new ToolGuardrails({ loopCaps: { WebSearch: 3 } });

    for (let i = 0; i < 3; i += 1) {
      const gate = guard.beforeCall('WebSearch', { query: `q${i}` });
      assert.strictEqual(gate.action, ACTIONS.ALLOW);
      guard.recordResult('WebSearch', { query: `q${i}` }, ok({ results: [] }));
    }

    const blocked = guard.beforeCall('WebSearch', { query: 'q4' });
    assert.strictEqual(blocked.action, ACTIONS.BLOCK);
    assert.strictEqual(blocked.code, 'loop_cap_exceeded');
  });

  it('caps each tool independently', () => {
    const guard = new ToolGuardrails({ loopCaps: { WebSearch: 1 } });
    guard.recordResult('WebSearch', { q: 'a' }, ok());

    assert.strictEqual(guard.beforeCall('WebSearch', { q: 'b' }).action, ACTIONS.BLOCK);
    assert.strictEqual(guard.beforeCall('Read', { p: 'x' }).action, ACTIONS.ALLOW);
  });

  it('leaves uncapped tools alone', () => {
    const guard = new ToolGuardrails();
    for (let i = 0; i < 100; i += 1) guard.recordResult('Read', { p: `f${i}` }, readOk(`${i}`));
    assert.strictEqual(guard.beforeCall('Read', { p: 'next' }).action, ACTIONS.ALLOW);
  });
});

describe('ToolGuardrails — quiet on healthy turns', () => {
  it('says nothing across a realistic 20-call turn', () => {
    const guard = new ToolGuardrails({ hardStopEnabled: true });
    const decisions = [];

    for (let i = 0; i < 6; i += 1) {
      decisions.push(guard.recordResult('Read', { file_path: `/src/f${i}.js` }, readOk(`body ${i}`)));
    }
    for (let i = 0; i < 4; i += 1) {
      decisions.push(guard.recordResult('Grep', { pattern: `sym${i}` }, ok({ matches: [i] })));
    }
    for (let i = 0; i < 5; i += 1) {
      const args = { file_path: `/src/f${i}.js`, old_string: 'a', new_string: 'b' };
      decisions.push(guard.beforeCall('Edit', args));
      decisions.push(guard.recordResult('Edit', args, editOk(1, 1)));
    }
    for (let i = 0; i < 5; i += 1) {
      const args = { command: `npm test -- t${i}` };
      decisions.push(guard.beforeCall('Bash', args));
      decisions.push(guard.recordResult('Bash', args, bashOk('ok')));
    }

    const noisy = decisions.filter((d) => d.action !== ACTIONS.ALLOW);
    assert.deepStrictEqual(noisy, [], 'a healthy turn must produce no guidance at all');
  });

  it('tolerates one failure followed by a fix', () => {
    const guard = new ToolGuardrails();
    const args = { command: 'npm test' };

    assert.strictEqual(guard.recordResult('Bash', args, bashFail()).action, ACTIONS.ALLOW);
    assert.strictEqual(guard.recordResult('Bash', args, bashOk()).action, ACTIONS.ALLOW);
  });
});

describe('ToolGuardrails — turn scoping', () => {
  it('forgets everything on reset', () => {
    const guard = new ToolGuardrails({ hardStopEnabled: true });
    const args = { command: 'broken' };
    for (let i = 0; i < 6; i += 1) guard.recordResult('Bash', args, bashFail());

    assert.strictEqual(guard.beforeCall('Bash', args).action, ACTIONS.BLOCK);

    guard.resetForTurn();

    assert.strictEqual(guard.beforeCall('Bash', args).action, ACTIONS.ALLOW);
    assert.strictEqual(guard.haltDecision, null);
  });

  it('reports its counters for logging', () => {
    const guard = new ToolGuardrails();
    guard.recordResult('Read', { p: 'a' }, readOk('x'));
    guard.recordResult('Bash', { c: 'z' }, bashFail());

    const stats = guard.stats();
    assert.strictEqual(stats.calls.Read, 1);
    assert.strictEqual(stats.calls.Bash, 1);
    assert.strictEqual(stats.toolFailures.Bash, 1);
  });
});
