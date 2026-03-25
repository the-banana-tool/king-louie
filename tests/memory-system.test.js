const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { MemoryStore, MemoryManager } = require('../src/memory');

function createTempStorageFile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'king-louie-memory-test-'));
  return {
    root,
    storageFile: path.join(root, 'memory-store.json')
  };
}

function cleanupTempRoot(root) {
  if (!root || !fs.existsSync(root)) {
    return;
  }

  fs.rmSync(root, { recursive: true, force: true });
}

function run(name, fn) {
  try {
    fn();
    console.log(`✔ ${name}`);
  } catch (error) {
    console.error(`✖ ${name}`);
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }
}

run('captures and lists entries with schema fields', () => {
  const temp = createTempStorageFile();

  try {
    const store = new MemoryStore({ storageFile: temp.storageFile });
    const manager = new MemoryManager({
      store,
      currentSessionId: 'session-test-1'
    });

    const entry = manager.capture('context', 'Remember this implementation detail');
    assert.ok(entry.id);
    assert.strictEqual(entry.type, 'context');
    assert.strictEqual(entry.source, 'session-test-1');
    assert.ok(['hot', 'warm', 'cold'].includes(entry.tier));
    assert.ok(entry.created);
    assert.ok(entry.lastAccessed);

    const listed = manager.list({ limit: 10 });
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].id, entry.id);
  } finally {
    cleanupTempRoot(temp.root);
  }
});

run('supports tier aging hot/warm/cold', () => {
  const temp = createTempStorageFile();

  try {
    const store = new MemoryStore({ storageFile: temp.storageFile });
    const manager = new MemoryManager({
      store,
      currentSessionId: 'current-session'
    });

    const oldHot = manager.normalizeEntry({
      id: 'hot-old',
      type: 'context',
      content: 'Old hot entry',
      source: 'other-session',
      created: new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)).toISOString(),
      lastAccessed: new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)).toISOString(),
      tier: 'hot'
    });

    const oldWarm = manager.normalizeEntry({
      id: 'warm-old',
      type: 'context',
      content: 'Old warm entry',
      source: 'other-session',
      created: new Date(Date.now() - (120 * 24 * 60 * 60 * 1000)).toISOString(),
      lastAccessed: new Date(Date.now() - (120 * 24 * 60 * 60 * 1000)).toISOString(),
      tier: 'warm'
    });

    store.insert(oldHot);
    store.insert(oldWarm);

    const aging = manager.runAging();
    assert.strictEqual(aging.total, 2);
    assert.ok(aging.changed >= 2);

    const listed = manager.list({ limit: 10 });
    const byId = new Map(listed.map((entry) => [entry.id, entry]));
    assert.strictEqual(byId.get('hot-old').tier, 'warm');
    assert.strictEqual(byId.get('warm-old').tier, 'cold');
  } finally {
    cleanupTempRoot(temp.root);
  }
});

run('recalls relevant memories and updates lastAccessed', async () => {
  const temp = createTempStorageFile();

  try {
    const store = new MemoryStore({ storageFile: temp.storageFile });
    const manager = new MemoryManager({
      store,
      currentSessionId: 'session-test-2'
    });

    const target = manager.capture('success', 'Use npm test to validate tiered memory behavior quickly');
    manager.capture('context', 'Unrelated content about UI colors and spacing.');

    const before = store.getById(target.id);
    const recalled = await manager.recall('memory behavior test', { limit: 3 });
    assert.ok(recalled.length >= 1);
    assert.strictEqual(recalled[0].id, target.id);

    const after = store.getById(target.id);
    assert.ok(Date.parse(after.lastAccessed) >= Date.parse(before.lastAccessed));
  } finally {
    cleanupTempRoot(temp.root);
  }
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}

console.log('Memory system tests completed.');