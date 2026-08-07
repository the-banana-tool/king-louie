const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { CheckpointManager } = require('../src/checkpoints/checkpoint-manager');
const { ShadowGit, projectKey } = require('../src/checkpoints/shadow-git');

// These tests drive a real git binary against real temp directories —
// the whole point of the module is its interaction with git plumbing, and
// a mocked git would only prove the mock works.
let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

const skip = gitAvailable ? false : 'git is not installed';

describe('CheckpointManager', { skip }, () => {
  let root;      // checkpoint store
  let workdir;   // simulated user project
  let manager;

  const write = (rel, content) => {
    const target = path.join(workdir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  };

  const read = (rel) => fs.readFileSync(path.join(workdir, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(workdir, rel));

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-checkpoint-'));
    root = path.join(base, 'checkpoints');
    workdir = path.join(base, 'project');
    fs.mkdirSync(workdir, { recursive: true });
    manager = new CheckpointManager({ rootDir: root });
  });

  afterEach(() => {
    try {
      fs.rmSync(path.dirname(root), { recursive: true, force: true });
    } catch { /* Windows can hold git object handles briefly; ignore. */ }
  });

  describe('snapshot and restore', () => {
    it('restores files edited across multiple turns', async () => {
      write('a.txt', 'a1');
      write('b.txt', 'b1');
      write('src/c.js', 'c1');

      const turn1 = await manager.maybeSnapshot({
        toolName: 'Write', workdir, turnId: 'turn-1'
      });
      assert.ok(turn1, 'first mutating tool should snapshot');

      write('a.txt', 'a2');
      write('b.txt', 'b2');

      await manager.maybeSnapshot({ toolName: 'Edit', workdir, turnId: 'turn-2' });

      write('src/c.js', 'c3');

      await manager.restore(workdir, turn1);

      assert.strictEqual(read('a.txt'), 'a1');
      assert.strictEqual(read('b.txt'), 'b1');
      assert.strictEqual(read('src/c.js'), 'c1');
    });

    it('deletes files created after the snapshot', async () => {
      write('keep.txt', 'keep');
      const checkpoint = await manager.snapshot(workdir, { message: 'base' });

      write('added.txt', 'should not survive');
      write('nested/also-added.txt', 'nor this');

      await manager.restore(workdir, checkpoint);

      assert.strictEqual(exists('added.txt'), false);
      assert.strictEqual(exists('nested/also-added.txt'), false);
      assert.strictEqual(read('keep.txt'), 'keep');
    });

    it('restores a file the turn deleted', async () => {
      write('victim.txt', 'still here');
      const checkpoint = await manager.snapshot(workdir, { message: 'base' });

      fs.rmSync(path.join(workdir, 'victim.txt'));
      assert.strictEqual(exists('victim.txt'), false);

      await manager.restore(workdir, checkpoint);
      assert.strictEqual(read('victim.txt'), 'still here');
    });

    it('takes a safety snapshot so a restore is itself undoable', async () => {
      write('f.txt', 'v1');
      const first = await manager.snapshot(workdir, { message: 'v1' });

      write('f.txt', 'v2');
      await manager.snapshot(workdir, { message: 'v2' });

      const { safetyCheckpoint } = await manager.restore(workdir, first);
      assert.strictEqual(read('f.txt'), 'v1');

      assert.ok(safetyCheckpoint, 'restore should record where we came from');
      await manager.restore(workdir, safetyCheckpoint);
      assert.strictEqual(read('f.txt'), 'v2', 'undoing the undo returns to v2');
    });

    it('returns null when nothing changed since the last snapshot', async () => {
      write('f.txt', 'unchanged');
      const first = await manager.snapshot(workdir, { message: 'one' });
      const second = await manager.snapshot(workdir, { message: 'two' });

      assert.ok(first);
      assert.strictEqual(second, null, 'an identical tree should not add noise');
    });
  });

  describe('per-turn latching', () => {
    it('snapshots once per turn no matter how many mutating tools run', async () => {
      write('f.txt', 'v1');

      const first = await manager.maybeSnapshot({
        toolName: 'Write', workdir, turnId: 'turn-1'
      });
      write('f.txt', 'v2');
      const second = await manager.maybeSnapshot({
        toolName: 'Edit', workdir, turnId: 'turn-1'
      });
      const third = await manager.maybeSnapshot({
        toolName: 'Bash', workdir, turnId: 'turn-1'
      });

      assert.ok(first);
      assert.strictEqual(second, null);
      assert.strictEqual(third, null);

      // The snapshot must hold PRE-turn state, so restoring undoes the turn.
      await manager.restore(workdir, first);
      assert.strictEqual(read('f.txt'), 'v1');
    });

    it('does not double-snapshot when mutating tools run concurrently', async () => {
      write('f.txt', 'v1');

      const results = await Promise.all([
        manager.maybeSnapshot({ toolName: 'Write', workdir, turnId: 'turn-1' }),
        manager.maybeSnapshot({ toolName: 'Edit', workdir, turnId: 'turn-1' }),
        manager.maybeSnapshot({ toolName: 'Bash', workdir, turnId: 'turn-1' })
      ]);

      const taken = results.filter(Boolean);
      assert.strictEqual(taken.length, 1, 'exactly one snapshot should win the race');
    });

    it('snapshots again on a new turn', async () => {
      write('f.txt', 'v1');
      const t1 = await manager.maybeSnapshot({ toolName: 'Write', workdir, turnId: 'turn-1' });
      write('f.txt', 'v2');
      const t2 = await manager.maybeSnapshot({ toolName: 'Write', workdir, turnId: 'turn-2' });

      assert.ok(t1);
      assert.ok(t2);
      assert.notStrictEqual(t1, t2);
    });

    it('costs nothing on a read-only turn', async () => {
      write('f.txt', 'v1');

      for (const toolName of ['Read', 'Grep', 'Glob', 'WebSearch', 'Skill']) {
        const taken = await manager.maybeSnapshot({ toolName, workdir, turnId: 'turn-1' });
        assert.strictEqual(taken, null, `${toolName} must not trigger a snapshot`);
      }

      assert.deepStrictEqual(await manager.list(workdir), []);
    });
  });

  describe('isolation from the user’s repo', () => {
    it('leaves no git state in the working directory', async () => {
      write('f.txt', 'v1');
      await manager.snapshot(workdir, { message: 'one' });

      assert.strictEqual(fs.existsSync(path.join(workdir, '.git')), false);
      assert.strictEqual(fs.existsSync(path.join(workdir, '.gitignore')), false);

      const entries = fs.readdirSync(workdir);
      assert.deepStrictEqual(entries.sort(), ['f.txt']);
    });

    it('keeps the user’s own git status clean', async () => {
      execFileSync('git', ['init', '--quiet'], { cwd: workdir });
      execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: workdir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workdir });
      write('tracked.txt', 'committed');
      execFileSync('git', ['add', '.'], { cwd: workdir });
      execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: workdir });

      const before = execFileSync('git', ['status', '--porcelain'], {
        cwd: workdir, encoding: 'utf8'
      });

      await manager.snapshot(workdir, { message: 'shadow snapshot' });

      const after = execFileSync('git', ['status', '--porcelain'], {
        cwd: workdir, encoding: 'utf8'
      });

      assert.strictEqual(before.trim(), '');
      assert.strictEqual(after.trim(), '', 'shadow snapshot must not dirty the real repo');

      // And the real repo's HEAD is untouched.
      const log = execFileSync('git', ['log', '--oneline'], { cwd: workdir, encoding: 'utf8' });
      assert.strictEqual(log.trim().split('\n').length, 1);
    });

    it('does not snapshot the working directory’s .git or node_modules', async () => {
      execFileSync('git', ['init', '--quiet'], { cwd: workdir });
      write('src/app.js', 'code');
      write('node_modules/big/index.js', 'x'.repeat(1000));

      const commit = await manager.snapshot(workdir, { message: 'excludes' });
      const git = new ShadowGit({ rootDir: root });
      const files = (await git._run(['ls-tree', '-r', '--name-only', commit])).split('\n');

      assert.ok(files.includes('src/app.js'));
      assert.ok(
        !files.some((f) => f.startsWith('node_modules/')),
        'node_modules must be excluded'
      );
      assert.ok(
        !files.some((f) => f.startsWith('.git/')),
        'the user’s .git must never be snapshotted'
      );
    });
  });

  describe('store sharing', () => {
    it('dedupes objects across two worktrees of the same content', async () => {
      const second = path.join(path.dirname(workdir), 'project-2');
      fs.mkdirSync(second, { recursive: true });

      const payload = 'shared content\n'.repeat(500);
      write('big.txt', payload);
      fs.writeFileSync(path.join(second, 'big.txt'), payload, 'utf8');

      await manager.snapshot(workdir, { message: 'first worktree' });
      await manager.snapshot(second, { message: 'second worktree' });

      // Distinct projects…
      assert.notStrictEqual(projectKey(workdir), projectKey(second));
      const keys = await manager.git.listProjectKeys();
      assert.strictEqual(keys.length, 2);

      // …sharing one object database. The identical blob is stored once,
      // which is the entire reason for a single shared store.
      const git = manager.git;
      const shaA = (await git._run(['rev-parse', `${await git.resolveRef(projectKey(workdir))}^{tree}`])).trim();
      const shaB = (await git._run(['rev-parse', `${await git.resolveRef(projectKey(second))}^{tree}`])).trim();
      assert.strictEqual(shaA, shaB, 'identical content yields the identical tree object');
    });
  });

  describe('listing', () => {
    it('lists snapshots newest first with their messages', async () => {
      write('f.txt', 'v1');
      await manager.snapshot(workdir, { message: 'first' });
      write('f.txt', 'v2');
      await manager.snapshot(workdir, { message: 'second' });

      const list = await manager.list(workdir);
      assert.strictEqual(list.length, 2);
      assert.strictEqual(list[0].message, 'second');
      assert.strictEqual(list[1].message, 'first');
      assert.ok(list[0].createdAt);
    });

    it('reports which files a snapshot changed', async () => {
      write('a.txt', 'a1');
      write('b.txt', 'b1');
      await manager.snapshot(workdir, { message: 'base' });

      write('a.txt', 'a2');
      const second = await manager.snapshot(workdir, { message: 'edit a' });

      const changes = await manager.changes(workdir, second);
      assert.deepStrictEqual(changes.map((c) => c.path), ['a.txt']);
      assert.strictEqual(changes[0].status, 'M');
    });

    it('returns an empty list for a directory that was never snapshotted', async () => {
      assert.deepStrictEqual(await manager.list(workdir), []);
    });
  });

  describe('pruning', () => {
    it('drops refs whose working directory no longer exists', async () => {
      const doomed = path.join(path.dirname(workdir), 'doomed');
      fs.mkdirSync(doomed, { recursive: true });
      fs.writeFileSync(path.join(doomed, 'f.txt'), 'x', 'utf8');

      write('keep.txt', 'keep');
      await manager.snapshot(workdir, { message: 'keeper' });
      await manager.snapshot(doomed, { message: 'doomed' });

      assert.strictEqual((await manager.git.listProjectKeys()).length, 2);

      fs.rmSync(doomed, { recursive: true, force: true });
      const { dropped } = await manager.prune();

      assert.strictEqual(dropped.length, 1);
      assert.strictEqual(dropped[0].reason, 'orphaned');

      const remaining = await manager.git.listProjectKeys();
      assert.deepStrictEqual(remaining, [projectKey(workdir)]);
    });

    it('drops projects that have gone cold', async () => {
      write('f.txt', 'v1');
      await manager.snapshot(workdir, { message: 'old' });

      // Backdate the project record past the age cutoff.
      const recordPath = path.join(manager.git.projectsDir, `${projectKey(workdir)}.json`);
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      record.lastTouch = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(recordPath, JSON.stringify(record), 'utf8');

      const { dropped } = await manager.prune();
      assert.strictEqual(dropped.length, 1);
      assert.strictEqual(dropped[0].reason, 'stale');
    });

    it('keeps live, recently-touched projects', async () => {
      write('f.txt', 'v1');
      await manager.snapshot(workdir, { message: 'fresh' });

      const { dropped, scanned } = await manager.prune();
      assert.strictEqual(dropped.length, 0);
      assert.strictEqual(scanned, 1);
    });
  });

  describe('failure containment', () => {
    it('never throws from maybeSnapshot when the store is broken', async () => {
      write('f.txt', 'v1');
      const broken = new CheckpointManager({ rootDir: root });
      broken.git.snapshot = async () => { throw new Error('object store is corrupt'); };

      const taken = await broken.maybeSnapshot({
        toolName: 'Write', workdir, turnId: 'turn-1'
      });
      assert.strictEqual(taken, null, 'a broken store must not break the turn');
    });

    it('never throws from maybeSnapshot when the working directory is gone', async () => {
      const missing = path.join(path.dirname(workdir), 'not-there');
      const taken = await manager.maybeSnapshot({
        toolName: 'Write', workdir: missing, turnId: 'turn-1'
      });
      assert.strictEqual(taken, null);
    });

    it('is inert when disabled', async () => {
      const off = new CheckpointManager({ rootDir: root, enabled: false });
      write('f.txt', 'v1');

      const taken = await off.maybeSnapshot({
        toolName: 'Write', workdir, turnId: 'turn-1'
      });
      assert.strictEqual(taken, null);
      assert.strictEqual(fs.existsSync(path.join(root, 'store')), false);
    });

    it('disables itself rather than failing when git is missing', async () => {
      const noGit = new CheckpointManager({ rootDir: root, gitPath: 'definitely-not-git-xyz' });
      write('f.txt', 'v1');

      const taken = await noGit.maybeSnapshot({
        toolName: 'Write', workdir, turnId: 'turn-1'
      });
      assert.strictEqual(taken, null);
      assert.strictEqual(noGit.enabled, false);
    });
  });

  describe('turn latch bookkeeping', () => {
    it('bounds latch growth over a long-lived session', async () => {
      const bounded = new CheckpointManager({ rootDir: root, maxLatchEntries: 10 });
      write('f.txt', 'v1');

      for (let i = 0; i < 20; i += 1) {
        // Mutate so each turn has something to snapshot.
        write('f.txt', `v${i}`);
        await bounded.maybeSnapshot({ toolName: 'Write', workdir, turnId: `turn-${i}` });
      }

      assert.ok(bounded._snapshotted.size <= 10, `latch grew to ${bounded._snapshotted.size}`);
    });

    it('clears a turn on endTurn', async () => {
      write('f.txt', 'v1');
      await manager.maybeSnapshot({ toolName: 'Write', workdir, turnId: 'turn-1' });
      manager.endTurn('turn-1');

      write('f.txt', 'v2');
      const again = await manager.maybeSnapshot({
        toolName: 'Write', workdir, turnId: 'turn-1'
      });
      assert.ok(again, 'a cleared turn may snapshot again');
    });
  });
});
