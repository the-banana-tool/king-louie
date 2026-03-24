const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const globTool = require('../src/tools/builtin/glob-tool');

describe('Glob Tool', () => {
  it('finds JavaScript files', async () => {
    const result = await globTool.execute({ pattern: '**/*.js', cwd: path.join(__dirname, '..') });
    assert.ok(result.ok);
    assert.ok(result.files.length > 0);
    assert.ok(result.files[0].path.endsWith('.js'));
  });

  it('respects maxResults', async () => {
    const result = await globTool.execute({ pattern: '**/*', cwd: path.join(__dirname, '..'), maxResults: 3 });
    assert.ok(result.files.length <= 3);
    if (result.total > 3) assert.ok(result.truncated);
  });

  it('excludes node_modules by default', async () => {
    const result = await globTool.execute({ pattern: '**/*.js', cwd: path.join(__dirname, '..') });
    assert.ok(!result.files.some(f => f.path.includes('node_modules')));
  });

  it('excludes .git by default', async () => {
    const result = await globTool.execute({ pattern: '**/*', cwd: path.join(__dirname, '..') });
    assert.ok(!result.files.some(f => f.path.includes('.git')));
  });

  it('returns empty array for no matches', async () => {
    const result = await globTool.execute({ pattern: '**/*.nonexistent_extension_xyz' });
    assert.ok(result.ok);
    assert.strictEqual(result.files.length, 0);
  });

  it('sorts by modification time (newest first)', async () => {
    const result = await globTool.execute({ pattern: '**/*.js', cwd: path.join(__dirname, '..'), maxResults: 10 });
    if (result.files.length >= 2) {
      const times = result.files.map(f => new Date(f.modified).getTime());
      for (let i = 1; i < times.length; i++) {
        assert.ok(times[i - 1] >= times[i], 'Results should be sorted newest first');
      }
    }
  });

  it('handles invalid pattern gracefully', async () => {
    const result = await globTool.execute({ pattern: '[' }); // fast-glob treats unclosed bracket as error
    assert.ok(!result.ok || result.error || result.files.length === 0);
  });
});
