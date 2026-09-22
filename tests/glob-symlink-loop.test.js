// Grep and Glob are ungated — no approval, reachable from any remote origin
// that can get a tool call executed. A directory symlink loop made them walk
// the cycle without bound until Node died with "Ineffective mark-compacts near
// heap limit ... heap out of memory". Availability only, but killing the
// process or pinning a core is not a thing a chat message should be able to do.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const globTool = require('../src/tools/builtin/glob-tool');
const grepTool = require('../src/tools/builtin/grep-tool');

// Directory symlinks need SeCreateSymbolicLinkPrivilege (admin or developer
// mode) on Windows. The POSIX run in node:22-alpine is what covers this.
let symlinksWork = false;
const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-symprobe-'));
try {
  fs.mkdirSync(path.join(probe, 'real'));
  fs.symlinkSync(path.join(probe, 'real'), path.join(probe, 'link'), 'dir');
  symlinksWork = fs.statSync(path.join(probe, 'link')).isDirectory();
} catch {
  symlinksWork = false;
} finally {
  fs.rmSync(probe, { recursive: true, force: true });
}
const skip = symlinksWork ? false : 'needs directory symlinks (run it in node:22-alpine on Windows)';

// A tree with three ways to loop: a self-link, a link to an ancestor, and a
// link to a link.
function loopingTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-loop-'));
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'b', 'needle.txt'), 'FINDME\n');
  fs.symlinkSync(root, path.join(root, 'a', 'up'), 'dir');
  fs.symlinkSync(path.join(root, 'a'), path.join(root, 'a', 'self'), 'dir');
  fs.symlinkSync(path.join(root, 'a', 'up'), path.join(root, 'a', 'up2'), 'dir');
  return root;
}

// Node's default heap makes "did it OOM" a slow and violent test. A wall clock
// bound plus a bound on the result set is the same signal, cheaply: an
// unbounded walk of a cycle never finishes.
const BUDGET_MS = 20000;

describe('Glob and Grep are bounded on a symlink loop', { timeout: 60000 }, () => {
  it('Glob returns instead of walking the cycle for ever', { skip }, async () => {
    const root = loopingTree();
    try {
      const startedAt = Date.now();
      const result = await globTool.execute(
        { pattern: '**/*', maxResults: 500 },
        { workingDirectory: root }
      );
      const elapsed = Date.now() - startedAt;
      assert.strictEqual(result.ok, true, result.error);
      assert.ok(elapsed < BUDGET_MS, `took ${elapsed}ms`);
      const deepest = Math.max(...result.files.map((f) => f.path.split(/[\\/]/).length), 0);
      assert.ok(deepest <= 12, `walked ${deepest} levels deep into a cycle`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('Grep returns, and still finds what is really there', { skip }, async () => {
    const root = loopingTree();
    try {
      const startedAt = Date.now();
      const result = await grepTool.execute(
        { pattern: 'FINDME', maxResults: 50 },
        { workingDirectory: root }
      );
      const elapsed = Date.now() - startedAt;
      assert.strictEqual(result.ok, true, result.error);
      assert.ok(elapsed < BUDGET_MS, `took ${elapsed}ms`);
      assert.ok(result.matches.length >= 1, 'the real file must still be found');
      assert.ok(result.matches.length < 50, `${result.matches.length} matches: the cycle was walked`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a symlink to a real directory outside the cycle is still followed', { skip }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-link-'));
    try {
      fs.mkdirSync(path.join(root, 'ws'));
      fs.mkdirSync(path.join(root, 'shared'));
      fs.writeFileSync(path.join(root, 'shared', 'note.txt'), 'hello\n');
      fs.symlinkSync(path.join(root, 'shared'), path.join(root, 'ws', 'linked'), 'dir');

      const result = await globTool.execute(
        { pattern: '**/*.txt' },
        { workingDirectory: path.join(root, 'ws'), allowedDirectories: [root] }
      );
      assert.strictEqual(result.ok, true, result.error);
      assert.ok(
        result.files.some((f) => f.path.replace(/\\/g, '/') === 'linked/note.txt'),
        `expected linked/note.txt, got ${JSON.stringify(result.files)}`
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
