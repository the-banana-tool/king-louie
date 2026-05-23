const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const log = createLogger('event-ledger');

const LEDGER_VERSION = 1;
const DEFAULT_MAX_WORKFLOWS = 200;
const DEFAULT_MAX_EVENTS_PER_WORKFLOW = 5000;
const DEFAULT_MAX_SERIALIZED_BYTES = 16 * 1024 * 1024;

// ── Event types ─────────────────────────────────────────────────────────────

const EVENT_TYPES = {
  WORKFLOW_CREATED: 'workflow:created',
  WORKFLOW_STARTED: 'workflow:started',
  WORKFLOW_PAUSED: 'workflow:paused',
  WORKFLOW_COMPLETED: 'workflow:completed',
  WORKFLOW_FAILED: 'workflow:failed',
  WORKFLOW_CANCELLED: 'workflow:cancelled',
  TASK_STARTED: 'task:started',
  TASK_COMPLETED: 'task:completed',
  TASK_FAILED: 'task:failed',
  TASK_SKIPPED: 'task:skipped',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function cloneValue(value) {
  return structuredClone(value);
}

function serializeStore(store) {
  return JSON.stringify(store);
}

function getSerializedByteLength(store) {
  return Buffer.byteLength(serializeStore(store), 'utf8');
}

// ── Normalization (safe deserialization from untrusted JSON) ─────────────────

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') {
    return undefined;
  }
  const { seq, at, workflowId, taskId, type, payload } = raw;
  if (
    typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 ||
    typeof at !== 'number' || !Number.isFinite(at) ||
    typeof workflowId !== 'string' ||
    typeof type !== 'string'
  ) {
    return undefined;
  }
  return {
    seq,
    at,
    workflowId,
    ...(typeof taskId === 'string' ? { taskId } : {}),
    type,
    payload: payload && typeof payload === 'object' ? cloneValue(payload) : {},
  };
}

function normalizeWorkflowLog(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const { workflowId, complete, createdAt, updatedAt, nextSeq } = raw;
  if (
    typeof workflowId !== 'string' ||
    typeof createdAt !== 'number' || !Number.isFinite(createdAt) ||
    typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) ||
    typeof nextSeq !== 'number' || !Number.isInteger(nextSeq) || nextSeq < 1
  ) {
    return undefined;
  }
  const events = Array.isArray(raw.events)
    ? raw.events.map(normalizeEvent).filter(Boolean)
    : [];
  return {
    workflowId,
    complete: raw.complete === true,
    createdAt,
    updatedAt,
    nextSeq,
    events,
  };
}

function normalizeStore(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== LEDGER_VERSION || !raw.workflows || typeof raw.workflows !== 'object') {
    return createEmptyStore();
  }
  const workflows = {};
  for (const [id, value] of Object.entries(raw.workflows)) {
    const wfLog = normalizeWorkflowLog(value);
    if (!wfLog || wfLog.workflowId !== id) continue;
    workflows[id] = wfLog;
  }
  return { version: LEDGER_VERSION, workflows };
}

function createEmptyStore() {
  return { version: LEDGER_VERSION, workflows: {} };
}

// ── Core ledger operations ──────────────────────────────────────────────────

function getOrCreateWorkflowLog(state, workflowId) {
  const existing = state.store.workflows[workflowId];
  if (existing) {
    existing.updatedAt = state.now();
    return existing;
  }
  const wfLog = {
    workflowId,
    complete: true,
    createdAt: state.now(),
    updatedAt: state.now(),
    nextSeq: 1,
    events: [],
  };
  state.store.workflows[workflowId] = wfLog;
  return wfLog;
}

function trimLedger(state) {
  // 1. Per-workflow event cap
  for (const wfLog of Object.values(state.store.workflows)) {
    if (wfLog.events.length <= state.maxEventsPerWorkflow) continue;
    wfLog.events = wfLog.events.slice(-state.maxEventsPerWorkflow);
    wfLog.complete = false;
  }

  // 2. Workflow count cap — evict least-recently-updated
  const logs = Object.values(state.store.workflows);
  if (logs.length > state.maxWorkflows) {
    const sorted = logs.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    for (const old of sorted.slice(state.maxWorkflows)) {
      delete state.store.workflows[old.workflowId];
    }
  }

  // 3. Byte-size cap — shed oldest events, then oldest workflows
  let bytes = getSerializedByteLength(state.store);
  while (bytes > state.maxSerializedBytes) {
    const oldest = Object.values(state.store.workflows)
      .filter((w) => w.events.length > 0)
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!oldest) break;
    oldest.events.shift();
    oldest.complete = false;
    bytes = getSerializedByteLength(state.store);
  }
  while (bytes > state.maxSerializedBytes) {
    const oldest = Object.values(state.store.workflows)
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!oldest) break;
    delete state.store.workflows[oldest.workflowId];
    bytes = getSerializedByteLength(state.store);
  }
}

function appendEvent(state, { workflowId, taskId, type, payload }) {
  const wfLog = getOrCreateWorkflowLog(state, workflowId);
  const now = state.now();
  wfLog.updatedAt = now;
  wfLog.events.push({
    seq: wfLog.nextSeq,
    at: now,
    workflowId,
    ...(taskId ? { taskId } : {}),
    type,
    payload: payload ? cloneValue(payload) : {},
  });
  wfLog.nextSeq += 1;
  trimLedger(state);
}

// ── Replay ──────────────────────────────────────────────────────────────────

function buildReplay(wfLog) {
  return {
    complete: wfLog.complete,
    workflowId: wfLog.workflowId,
    events: wfLog.events.map((e) => cloneValue(e)),
  };
}

// ── Public API factory ──────────────────────────────────────────────────────

function createLedgerApi({ state, mutate, read }) {
  return {
    async append({ workflowId, taskId, type, payload }) {
      await mutate(() => {
        appendEvent(state, { workflowId, taskId, type, payload });
      });
    },

    async replay(workflowId) {
      return read(() => {
        const wfLog = state.store.workflows[workflowId];
        if (!wfLog) return { complete: false, workflowId, events: [] };
        return buildReplay(wfLog);
      });
    },

    async replayRange(workflowId, { fromSeq, toSeq } = {}) {
      return read(() => {
        const wfLog = state.store.workflows[workflowId];
        if (!wfLog) return { complete: false, workflowId, events: [] };
        let events = wfLog.events;
        if (typeof fromSeq === 'number') {
          events = events.filter((e) => e.seq >= fromSeq);
        }
        if (typeof toSeq === 'number') {
          events = events.filter((e) => e.seq <= toSeq);
        }
        return {
          complete: wfLog.complete && typeof fromSeq !== 'number',
          workflowId: wfLog.workflowId,
          events: events.map((e) => cloneValue(e)),
        };
      });
    },

    async listWorkflows() {
      return read(() =>
        Object.values(state.store.workflows).map((wfLog) => ({
          workflowId: wfLog.workflowId,
          eventCount: wfLog.events.length,
          complete: wfLog.complete,
          createdAt: wfLog.createdAt,
          updatedAt: wfLog.updatedAt,
        }))
      );
    },

    async removeWorkflow(workflowId) {
      await mutate(() => {
        delete state.store.workflows[workflowId];
      });
    },
  };
}

// ── In-memory implementation ────────────────────────────────────────────────

function createInMemoryEventLedger(options = {}) {
  const state = {
    store: createEmptyStore(),
    maxWorkflows: Math.max(1, Math.floor(options.maxWorkflows ?? DEFAULT_MAX_WORKFLOWS)),
    maxEventsPerWorkflow: Math.max(1, Math.floor(options.maxEventsPerWorkflow ?? DEFAULT_MAX_EVENTS_PER_WORKFLOW)),
    maxSerializedBytes: Math.max(1024, Math.floor(options.maxSerializedBytes ?? DEFAULT_MAX_SERIALIZED_BYTES)),
    now: options.now ?? Date.now,
  };
  return createLedgerApi({
    state,
    mutate: async (fn) => { fn(); },
    read: async (fn) => fn(),
  });
}

// ── File-backed implementation ──────────────────────────────────────────────

function createFileEventLedger({ filePath, ...options }) {
  const state = {
    store: createEmptyStore(),
    maxWorkflows: Math.max(1, Math.floor(options.maxWorkflows ?? DEFAULT_MAX_WORKFLOWS)),
    maxEventsPerWorkflow: Math.max(1, Math.floor(options.maxEventsPerWorkflow ?? DEFAULT_MAX_EVENTS_PER_WORKFLOW)),
    maxSerializedBytes: Math.max(1024, Math.floor(options.maxSerializedBytes ?? DEFAULT_MAX_SERIALIZED_BYTES)),
    now: options.now ?? Date.now,
  };

  let operation = Promise.resolve();

  async function load() {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      state.store = normalizeStore(JSON.parse(raw));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.warn(`Failed to load event ledger: ${err.message}`);
      }
      state.store = createEmptyStore();
    }
  }

  async function save() {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tmpPath, serializeStore(state.store), 'utf8');
    await fs.promises.rename(tmpPath, filePath);
  }

  function enqueue(fn) {
    const task = operation.then(fn, fn);
    operation = task.then(() => {}, () => {});
    return task;
  }

  return createLedgerApi({
    state,
    mutate: (fn) => enqueue(async () => {
      await load();
      fn();
      await save();
    }),
    read: (fn) => enqueue(async () => {
      await load();
      return fn();
    }),
  });
}

module.exports = {
  EVENT_TYPES,
  createInMemoryEventLedger,
  createFileEventLedger,
  // Exported for testing
  normalizeEvent,
  normalizeWorkflowLog,
  normalizeStore,
};
