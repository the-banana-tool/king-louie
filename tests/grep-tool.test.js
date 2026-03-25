const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const grepTool = require('../src/tools/builtin/grep-tool');
const fs = require('fs');

describe('Grep Tool', () => {
  it('finds pattern in files', async () => {
    const result = await grepTool.execute({
      pattern: 'require\\(',
      path: path.join(__dirname, '..', 'src'),
      glob: '**/*.js'
    });
    assert.ok(result.ok);
    assert.ok(result.matches.length > 0);
    assert.ok(result.matches[0].file);
    assert.ok(result.matches[0].lineNumber);
    assert.ok(result.matches[0].line);
  });

  it('supports case-insensitive search', async () => {
    const result = await grepTool.execute({
      pattern: 'MODULE',
      path: path.join(__dirname, '..', 'src'),
      caseSensitive: false
    });
    assert.ok(result.ok);
    // Should find 'module' even though pattern is 'MODULE'
    assert.ok(result.matches.some(m => m.line.toLowerCase().includes('module')));
  });

  it('respects maxResults', async () => {
    const result = await grepTool.execute({
      pattern: 'const',
      path: path.join(__dirname, '..'),
      maxResults: 5
    });
    assert.ok(result.matches.length <= 5);
  });

  it('returns context lines when requested', async () => {
    const result = await grepTool.execute({
      pattern: 'module\\.exports',
      path: path.join(__dirname, '..', 'src'),
      contextLines: 2,
      maxResults: 3
    });
    assert.ok(result.matches.length > 0);
    assert.ok(result.matches[0].context);
    // 2 lines before + matching line + 2 lines after = up to 5 lines
    assert.ok(result.matches[0].context.split('\n').length <= 5);
  });

  it('searches single file', async () => {
    const result = await grepTool.execute({
      pattern: 'dependencies',
      path: path.join(__dirname, '..', 'package.json')
    });
    assert.ok(result.ok);
    assert.ok(result.matches.length > 0);
    assert.ok(result.matches.some(m => m.line.includes('dependencies')));
  });

  it('skips binary files', async () => {
    // Create a temporary dummy binary file
    const binaryFilePath = path.join(__dirname, '..', 'dummy-binary.bin');
    const buffer = Buffer.alloc(1024);
    buffer.fill(0); // fill with null bytes to simulate a binary file
    buffer.write('require("crypto")', 512); // add string that would match if not skipped

    fs.writeFileSync(binaryFilePath, buffer);

    try {
      const result = await grepTool.execute({
        pattern: 'require',
        path: binaryFilePath
      });
      assert.ok(result.ok);
      assert.strictEqual(result.matches.length, 0); // Should be empty because it skips the binary file
    } finally {
      fs.unlinkSync(binaryFilePath);
    }
  });

  it('handles invalid regex gracefully', async () => {
    const result = await grepTool.execute({ pattern: '[invalid' });
    assert.ok(!result.ok || result.error);
    assert.ok(result.error.includes('Invalid regular expression'));
  });

  it('excludes node_modules and .git', async () => {
    const result = await grepTool.execute({
      pattern: 'the',
      path: path.join(__dirname, '..')
    });
    assert.ok(!result.matches.some(m => m.file.includes('node_modules')));
    assert.ok(!result.matches.some(m => m.file.includes('.git')));
  });
});
