const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  EVENT_TYPES,
  createInMemoryEventLedger,
  createFileEventLedger,
  normalizeEvent,
  normalizeWorkflowLog,
  normalizeStore,
} = require('../src/events/event-ledger');

// ── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ledger-test-'));
}

// ── in-memory ledger ────────────────────────────────────────────────────────

describe('EventLedger (in-memory)', () => {
  let ledger;
  let clock;

  beforeEach(() => {
    clock = 1000;
    ledger = createInMemoryEventLedger({ now: () => clock++ });
  });

  describe('append + replay', () => {
    it('records and replays events in order', async () => {
      await ledger.append({
        workflowId: 'wf-1',
        type: EVENT_TYPES.WORKFLOW_CREATED,
        payload: { goal: 'test' },
      });
      await ledger.append({
        workflowId: 'wf-1',
        type: EVENT_TYPES.WORKFLOW_STARTED,
      });

      const replay = await ledger.replay('wf-1');
      assert.strictEqual(replay.complete, true);
      assert.strictEqual(replay.events.length, 2);
      assert.strictEqual(replay.events[0].type, EVENT_TYPES.WORKFLOW_CREATED);
      assert.strictEqual(replay.events[0].seq, 1);
      assert.strictEqual(replay.events[1].type, EVENT_TYPES.WORKFLOW_STARTED);
      assert.strictEqual(replay.events[1].seq, 2);
    });

    it('returns empty replay for unknown workflow', async () => {
      const replay = await ledger.replay('wf-nonexistent');
      assert.strictEqual(replay.complete, false);
      assert.strictEqual(replay.events.length, 0);
    });

    it('records task-level events with taskId', async () => {
      await ledger.append({
        workflowId: 'wf-1',
        taskId: 't1',
        type: EVENT_TYPES.TASK_STARTED,
        payload: { title: 'First task' },
      });

      const replay = await ledger.replay('wf-1');
      assert.strictEqual(replay.events[0].taskId, 't1');
      assert.strictEqual(replay.events[0].payload.title, 'First task');
    });

    it('assigns monotonic sequence numbers', async () => {
      for (let i = 0; i < 5; i++) {
        await ledger.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_STARTED });
      }
      const replay = await ledger.replay('wf-1');
      const seqs = replay.events.map((e) => e.seq);
      assert.deepStrictEqual(seqs, [1, 2, 3, 4, 5]);
    });

    it('assigns increasing timestamps', async () => {
      await ledger.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_CREATED });
      await ledger.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_STARTED });
      const replay = await ledger.replay('wf-1');
      assert.ok(replay.events[1].at > replay.events[0].at);
    });
  });

  describe('immutability', () => {
    it('deep-clones payload on append', async () => {
      const payload = { nested: { value: 1 } };
      await ledger.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_CREATED, payload });
      payload.nested.value = 999;

      const replay = await ledger.replay('wf-1');
      assert.strictEqual(replay.events[0].payload.nested.value, 1);
    });

    it('deep-clones events on replay', async () => {
      await ledger.append({
        workflowId: 'wf-1',
        type: EVENT_TYPES.WORKFLOW_CREATED,
        payload: { data: 'original' },
      });

      const replay1 = await ledger.replay('wf-1');
      replay1.events[0].payload.data = 'mutated';

      const replay2 = await ledger.replay('wf-1');
      assert.strictEqual(replay2.events[0].payload.data, 'original');
    });
  });

  describe('replayRange', () => {
    it('filters events by sequence range', async () => {
      for (let i = 0; i < 5; i++) {
        await ledger.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_STARTED });
      }
      const range = await ledger.replayRange('wf-1', { fromSeq: 2, toSeq: 4 });
      assert.strictEqual(range.events.length, 3);
      assert.deepStrictEqual(range.events.map((e) => e.seq), [2, 3, 4]);
      assert.strictEqual(range.complete, false);
    });

    it('filters with fromSeq only', async () => {
      for (let i = 0; i < 5; i++) {
        await ledger.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_STARTED });
      }
      const range = await ledger.replayRange('wf-1', { fromSeq: 4 });
      assert.strictEqual(range.events.length, 2);
      assert.deepStrictEqual(range.events.map((e) => e.seq), [4, 5]);
    });

    it('returns empty for unknown workflow', async () => {
      const range = await ledger.replayRange('wf-nonexistent', { fromSeq: 1 });
      assert.strictEqual(range.events.length, 0);
      assert.strictEqual(range.complete, false);
    });
  });

  describe('listWorkflows', () => {
    it('lists all workflows with metadata', async () => {
      await ledger.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_CREATED });
      await ledger.append({ workflowId: 'wf-2', type: EVENT_TYPES.WORKFLOW_CREATED });
      await ledger.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_STARTED });

      const list = await ledger.listWorkflows();
      assert.strictEqual(list.length, 2);
      const wf1 = list.find((w) => w.workflowId === 'wf-1');
      assert.strictEqual(wf1.eventCount, 2);
      assert.strictEqual(wf1.complete, true);
    });
  });

  describe('removeWorkflow', () => {
    it('removes a workflow from the ledger', async () => {
      await ledger.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_CREATED });
      await ledger.removeWorkflow('wf-1');
      const replay = await ledger.replay('wf-1');
      assert.strictEqual(replay.events.length, 0);
      assert.strictEqual(replay.complete, false);
    });

    it('is a no-op for unknown workflows', async () => {
      await ledger.removeWorkflow('wf-nonexistent');
    });
  });

  describe('trimming', () => {
    it('trims events beyond per-workflow cap', async () => {
      const small = createInMemoryEventLedger({ maxEventsPerWorkflow: 3, now: () => clock++ });
      for (let i = 0; i < 10; i++) {
        await small.append({ workflowId: 'wf-1', type: EVENT_TYPES.TASK_STARTED, payload: { i } });
      }
      const replay = await small.replay('wf-1');
      assert.strictEqual(replay.events.length, 3);
      assert.strictEqual(replay.complete, false);
      assert.strictEqual(replay.events[0].payload.i, 7);
    });

    it('trims workflows beyond count cap', async () => {
      const small = createInMemoryEventLedger({ maxWorkflows: 2, now: () => clock++ });
      await small.append({ workflowId: 'wf-old', type: EVENT_TYPES.WORKFLOW_CREATED });
      await small.append({ workflowId: 'wf-mid', type: EVENT_TYPES.WORKFLOW_CREATED });
      await small.append({ workflowId: 'wf-new', type: EVENT_TYPES.WORKFLOW_CREATED });

      const list = await small.listWorkflows();
      assert.strictEqual(list.length, 2);
      assert.ok(list.some((w) => w.workflowId === 'wf-new'));
      assert.ok(list.some((w) => w.workflowId === 'wf-mid'));
    });

    it('trims under byte-size cap', async () => {
      const small = createInMemoryEventLedger({
        maxSerializedBytes: 1024,
        maxEventsPerWorkflow: 100,
        now: () => clock++,
      });
      for (let i = 0; i < 50; i++) {
        await small.append({
          workflowId: 'wf-1',
          type: EVENT_TYPES.TASK_COMPLETED,
          payload: { data: 'x'.repeat(100) },
        });
      }
      const replay = await small.replay('wf-1');
      assert.ok(replay.events.length < 50, `Expected trimming, got ${replay.events.length}`);
    });
  });

  describe('multi-workflow isolation', () => {
    it('keeps events separated by workflow', async () => {
      await ledger.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_CREATED });
      await ledger.append({ workflowId: 'wf-2', type: EVENT_TYPES.WORKFLOW_CREATED });
      await ledger.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_STARTED });

      const r1 = await ledger.replay('wf-1');
      const r2 = await ledger.replay('wf-2');
      assert.strictEqual(r1.events.length, 2);
      assert.strictEqual(r2.events.length, 1);
    });
  });
});

// ── file-backed ledger ──────────────────────────────────────────────────────

describe('EventLedger (file-backed)', () => {
  let tmpDir;
  let clock;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    clock = 1000;
  });

  function makeLedger(opts = {}) {
    return createFileEventLedger({
      filePath: path.join(tmpDir, 'ledger.json'),
      now: () => clock++,
      ...opts,
    });
  }

  it('persists events across instances', async () => {
    const ledger1 = makeLedger();
    await ledger1.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_CREATED, payload: { goal: 'test' } });
    await ledger1.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_STARTED });

    const ledger2 = makeLedger();
    const replay = await ledger2.replay('wf-1');
    assert.strictEqual(replay.complete, true);
    assert.strictEqual(replay.events.length, 2);
    assert.strictEqual(replay.events[0].payload.goal, 'test');
  });

  it('creates parent directory if missing', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c', 'ledger.json');
    const ledger = createFileEventLedger({ filePath: nested, now: () => clock++ });
    await ledger.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_CREATED });
    assert.ok(fs.existsSync(nested));
  });

  it('handles corrupt file gracefully', async () => {
    const fp = path.join(tmpDir, 'ledger.json');
    fs.writeFileSync(fp, 'NOT JSON!!!');
    const ledger = makeLedger();
    const replay = await ledger.replay('wf-1');
    assert.strictEqual(replay.events.length, 0);

    await ledger.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_CREATED });
    const replay2 = await ledger.replay('wf-1');
    assert.strictEqual(replay2.events.length, 1);
  });

  it('uses atomic write (tmp + rename)', async () => {
    const ledger = makeLedger();
    await ledger.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_CREATED });

    const files = fs.readdirSync(tmpDir);
    assert.ok(files.includes('ledger.json'), 'Final file must exist');
    assert.ok(!files.includes('ledger.json.tmp'), 'Tmp file must be cleaned up');
  });

  it('removeWorkflow persists deletion', async () => {
    const ledger1 = makeLedger();
    await ledger1.append({ workflowId: 'wf-1', type: EVENT_TYPES.WORKFLOW_CREATED });
    await ledger1.removeWorkflow('wf-1');

    const ledger2 = makeLedger();
    const replay = await ledger2.replay('wf-1');
    assert.strictEqual(replay.events.length, 0);
  });
});

// ── normalization ───────────────────────────────────────────────────────────

describe('normalization', () => {
  describe('normalizeEvent', () => {
    it('accepts valid events', () => {
      const event = normalizeEvent({
        seq: 1,
        at: 1000,
        workflowId: 'wf-1',
        type: 'workflow:created',
        payload: {},
        update: undefined,
      });
      assert.ok(event);
      assert.strictEqual(event.seq, 1);
    });

    it('rejects events with missing fields', () => {
      assert.strictEqual(normalizeEvent(null), undefined);
      assert.strictEqual(normalizeEvent({}), undefined);
      assert.strictEqual(normalizeEvent({ seq: 'not-a-number', at: 1000, workflowId: 'w', type: 'x' }), undefined);
      assert.strictEqual(normalizeEvent({ seq: 1, at: Infinity, workflowId: 'w', type: 'x' }), undefined);
      assert.strictEqual(normalizeEvent({ seq: 1, at: 1000, workflowId: 123, type: 'x' }), undefined);
    });

    it('includes optional taskId when present', () => {
      const event = normalizeEvent({ seq: 1, at: 1000, workflowId: 'wf-1', taskId: 't1', type: 'task:started', payload: {} });
      assert.strictEqual(event.taskId, 't1');
    });

    it('omits taskId when not a string', () => {
      const event = normalizeEvent({ seq: 1, at: 1000, workflowId: 'wf-1', taskId: 123, type: 'task:started', payload: {} });
      assert.strictEqual(event.taskId, undefined);
    });
  });

  describe('normalizeWorkflowLog', () => {
    it('accepts valid workflow logs', () => {
      const log = normalizeWorkflowLog({
        workflowId: 'wf-1',
        complete: true,
        createdAt: 1000,
        updatedAt: 2000,
        nextSeq: 1,
        events: [],
      });
      assert.ok(log);
      assert.strictEqual(log.workflowId, 'wf-1');
    });

    it('rejects invalid workflow logs', () => {
      assert.strictEqual(normalizeWorkflowLog(null), undefined);
      assert.strictEqual(normalizeWorkflowLog({ workflowId: 123 }), undefined);
      assert.strictEqual(normalizeWorkflowLog({ workflowId: 'w', createdAt: NaN, updatedAt: 1, nextSeq: 1 }), undefined);
      assert.strictEqual(normalizeWorkflowLog({ workflowId: 'w', createdAt: 1, updatedAt: 1, nextSeq: 0 }), undefined);
    });

    it('filters out invalid events from the array', () => {
      const log = normalizeWorkflowLog({
        workflowId: 'wf-1',
        complete: true,
        createdAt: 1000,
        updatedAt: 2000,
        nextSeq: 2,
        events: [
          { seq: 1, at: 1000, workflowId: 'wf-1', type: 'workflow:created', payload: {} },
          'garbage',
          null,
        ],
      });
      assert.strictEqual(log.events.length, 1);
    });
  });

  describe('normalizeStore', () => {
    it('returns empty store for invalid input', () => {
      const store = normalizeStore(null);
      assert.deepStrictEqual(store, { version: 1, workflows: {} });
    });

    it('returns empty store for version mismatch', () => {
      const store = normalizeStore({ version: 99, workflows: {} });
      assert.deepStrictEqual(store, { version: 1, workflows: {} });
    });

    it('skips workflows with mismatched ids', () => {
      const store = normalizeStore({
        version: 1,
        workflows: {
          'wf-1': { workflowId: 'wf-wrong', complete: true, createdAt: 1, updatedAt: 1, nextSeq: 1, events: [] },
        },
      });
      assert.strictEqual(Object.keys(store.workflows).length, 0);
    });
  });
});
