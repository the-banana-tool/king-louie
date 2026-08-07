const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { toolRegistry } = require('../src/tools');
const { Tool } = require('../src/tools/tool-schema');
const ToolExecutor = require('../src/execution/tool-executor');
const { CheckpointManager } = require('../src/checkpoints/checkpoint-manager');

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

// A tool that writes a file, so we can prove the snapshot captured the
// state *before* it ran rather than after.
toolRegistry.register(new Tool({
  name: 'CheckpointWriteProbe',
  description: 'Writes a file (test double for Write)',
  requiresApproval: false,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } }
  },
  execute: async (params) => {
    fs.writeFileSync(params.path, params.content, 'utf8');
    return { ok: true };
  }
}));

toolRegistry.register(new Tool({
  name: 'CheckpointApprovalProbe',
  description: 'Requires approval; writes a file (test double for Bash)',
  requiresApproval: true,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } }
  },
  execute: async (params) => {
    fs.writeFileSync(params.path, params.content, 'utf8');
    return { ok: true };
  }
}));

// Records what the executor asks for without touching a real store.
const recordingManager = () => {
  const calls = [];
  return {
    calls,
    maybeSnapshot: async (args) => {
      calls.push(args);
      return 'fake-commit-sha';
    }
  };
};

describe('ToolExecutor checkpoint integration', () => {
  let workdir;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ckpt-integ-'));
  });

  afterEach(() => {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('offers every tool call to the checkpoint manager with the turn id', async () => {
    const manager = recordingManager();
    const executor = new ToolExecutor({
      workingDirectory: workdir,
      requireApproval: false,
      checkpointManager: manager
    });

    await executor.execute(
      'CheckpointWriteProbe',
      { path: path.join(workdir, 'f.txt'), content: 'hello' },
      { turnId: 'turn-42' }
    );

    assert.strictEqual(manager.calls.length, 1);
    assert.strictEqual(manager.calls[0].toolName, 'CheckpointWriteProbe');
    assert.strictEqual(manager.calls[0].turnId, 'turn-42');
    assert.strictEqual(manager.calls[0].workdir, workdir);
  });

  it('does not snapshot when the user denies the call', async () => {
    const manager = recordingManager();
    const executor = new ToolExecutor({
      workingDirectory: workdir,
      requireApproval: true,
      approvalRequester: async () => false,
      checkpointManager: manager
    });

    const result = await executor.execute(
      'CheckpointApprovalProbe',
      { path: path.join(workdir, 'f.txt'), content: 'nope' },
      { turnId: 'turn-1' }
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(
      manager.calls.length, 0,
      'a denied call changes nothing, so it must not leave a checkpoint'
    );
  });

  it('does not snapshot when the turn was cancelled before execution', async () => {
    const manager = recordingManager();
    const executor = new ToolExecutor({
      workingDirectory: workdir,
      requireApproval: false,
      checkpointManager: manager
    });

    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute(
      'CheckpointWriteProbe',
      { path: path.join(workdir, 'f.txt'), content: 'nope' },
      { turnId: 'turn-1', signal: controller.signal }
    );

    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(manager.calls.length, 0);
  });

  it('does not snapshot when a hook blocks the call', async () => {
    const manager = recordingManager();
    const executor = new ToolExecutor({
      workingDirectory: workdir,
      requireApproval: false,
      checkpointManager: manager,
      hookExecutor: {
        run: async (event) => (
          event === 'PreToolUse' ? { action: 'deny', message: 'blocked' } : null
        )
      }
    });

    const result = await executor.execute(
      'CheckpointWriteProbe',
      { path: path.join(workdir, 'f.txt'), content: 'nope' },
      { turnId: 'turn-1' }
    );

    assert.strictEqual(result.blockedByHook, true);
    assert.strictEqual(manager.calls.length, 0);
  });

  it('survives a checkpoint manager that throws', async () => {
    const executor = new ToolExecutor({
      workingDirectory: workdir,
      requireApproval: false,
      checkpointManager: {
        maybeSnapshot: async () => { throw new Error('store exploded'); }
      }
    });

    let reported = null;
    executor.on('checkpointFailed', (event) => { reported = event; });

    // The real CheckpointManager swallows its own failures, but the executor
    // must not depend on that — a misconfigured manager should not take the
    // user's turn down with it.
    const target = path.join(workdir, 'f.txt');
    const result = await executor.execute(
      'CheckpointWriteProbe',
      { path: target, content: 'hi' },
      { turnId: 'turn-1' }
    );

    assert.strictEqual(result.ok, true, 'the tool must still run');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'hi');
    assert.match(reported?.error?.message || '', /store exploded/);
  });

  it('runs without a checkpoint manager at all', async () => {
    const executor = new ToolExecutor({
      workingDirectory: workdir,
      requireApproval: false
    });

    const result = await executor.execute(
      'CheckpointWriteProbe',
      { path: path.join(workdir, 'f.txt'), content: 'hi' },
      { turnId: 'turn-1' }
    );
    assert.strictEqual(result.ok, true);
  });

  describe('end to end with a real store', { skip: gitAvailable ? false : 'git is not installed' }, () => {
    it('snapshots pre-turn state so the turn can be rolled back', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ckpt-store-'));
      // The mutating-tool set is name-based, so a test double has to opt in
      // the same way a custom or MCP file-writing tool would.
      const manager = new CheckpointManager({
        rootDir: root,
        mutatingTools: new Set(['CheckpointWriteProbe'])
      });
      const executor = new ToolExecutor({
        workingDirectory: workdir,
        requireApproval: false,
        checkpointManager: manager
      });

      const target = path.join(workdir, 'f.txt');
      fs.writeFileSync(target, 'original', 'utf8');

      await executor.execute(
        'CheckpointWriteProbe',
        { path: target, content: 'modified by the agent' },
        { turnId: 'turn-1' }
      );

      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'modified by the agent');

      const checkpoints = await manager.list(workdir);
      assert.strictEqual(checkpoints.length, 1);

      await manager.restore(workdir, checkpoints[0].id);
      assert.strictEqual(
        fs.readFileSync(target, 'utf8'), 'original',
        'the snapshot must hold state from before the tool ran'
      );

      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    });
  });
});
