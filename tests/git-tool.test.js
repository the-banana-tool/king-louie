const { describe, it } = require('node:test');
const assert = require('node:assert');
const gitTool = require('../src/tools/builtin/git-tool');

describe('Git Tool', () => {
  it('runs git status', async () => {
    const result = await gitTool.execute({ command: 'status' });
    assert.ok(result.ok);
    assert.ok(typeof result.output === 'string');
  });

  it('runs git log with args', async () => {
    const result = await gitTool.execute({ command: 'log', args: ['--oneline', '-5'] });
    assert.ok(result.ok);
  });

  it('runs git diff', async () => {
    const result = await gitTool.execute({ command: 'diff' });
    assert.ok(result.ok);
  });

  it('blocks disallowed commands', async () => {
    const result = await gitTool.execute({ command: 'rebase' });
    assert.ok(!result.ok);
    assert.ok(result.error.includes('not allowed'));
  });

  it('blocks --force flag', async () => {
    const result = await gitTool.execute({ command: 'push', args: ['--force'] });
    assert.ok(!result.ok);
    assert.ok(result.error.includes('blocked'));
  });

  it('blocks --hard flag', async () => {
    const result = await gitTool.execute({ command: 'checkout', args: ['--hard'] });
    assert.ok(!result.ok);
    assert.ok(result.error.includes('blocked'));
  });

  it('blocks -D flag', async () => {
    const result = await gitTool.execute({ command: 'branch', args: ['-D', 'some-branch'] });
    assert.ok(!result.ok);
    assert.ok(result.error.includes('blocked'));
  });

  it('handles non-git directory gracefully', async () => {
    const result = await gitTool.execute({ command: 'status', cwd: '/tmp' });
    // Should return error about not being a git repo
    assert.ok(!result.ok || result.stderr);
  });

  it('requires approval', () => {
    assert.strictEqual(gitTool.requiresApproval, true);
  });
});
