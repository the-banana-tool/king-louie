const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FORBIDDEN = ['src/providers/', 'src/execution/agent-loop', 'src/tools/', 'src/browser/', 'src/channels/', 'src/mcp/', 'src/core/create-core'];

describe('runbook profile module graph', () => {
  it('never loads the agent stack', () => {
    const script = `
      const { loadProfile } = require('./src/service/run');
      loadProfile('runbook');
      process.stdout.write(JSON.stringify(Object.keys(require.cache)));
    `;
    const loaded = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: ROOT }).toString())
      .map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
    const bad = loaded.filter((p) => FORBIDDEN.some((f) => p.startsWith(f)));
    assert.deepStrictEqual(bad, []);
  });
});
