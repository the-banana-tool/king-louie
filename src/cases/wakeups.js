// src/cases/wakeups.js
// Per-case wake-ups in .kl/wakeups.json (cases stage 2 spec §3.6, program
// §4.6). `every` is in milliseconds; daily-orientation is anchored to the
// owner's local dailyAt so it neither drifts nor jumps an hour at DST.
const path = require('path');
const { readJson, writeJsonIfChanged } = require('./jsonfile');
const { nextLocalTime, nextLocalMidnight } = require('./clock');

const MIN_EVERY_MS = 60000;
const DEFAULT_BACKOFF_MINUTES = Object.freeze([5, 15, 60]);
const OUTCOMES = Object.freeze(['quiet', 'acted', 'skipped', 'failed']);
// Built-in kinds are bare words; later stages prefix theirs (`detours:incoming`).
const KIND_PATTERN = /^[a-z0-9-]+(?::[a-z0-9-]+)?$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

class WakeupStore {
  constructor(dir, { now = () => new Date(), timeZone = '', dailyAt = '09:00', backoffMinutes = DEFAULT_BACKOFF_MINUTES } = {}) {
    this.dir = dir;
    this.path = path.join(dir, '.kl', 'wakeups.json');
    this.now = now;
    this.timeZone = timeZone || '';
    this.dailyAt = dailyAt || '09:00';
    const backoff = Array.isArray(backoffMinutes) ? backoffMinutes.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
    this.backoffMinutes = backoff.length ? backoff : [...DEFAULT_BACKOFF_MINUTES];
  }

  _load() {
    const data = readJson(this.path, null);
    const items = Array.isArray(data?.items) ? data.items : [];
    const counter = Number.isInteger(data?.counter)
      ? data.counter
      : items.reduce((max, w) => Math.max(max, Number(String(w.id).replace(/^w-/, '')) || 0), 0);
    return { counter, items };
  }

  _save(data) {
    return writeJsonIfChanged(this.path, data);
  }

  _nextFor(entry, now) {
    if (entry.kind === 'daily-orientation') return nextLocalTime(now, this.dailyAt, this.timeZone).toISOString();
    return new Date(now.getTime() + entry.everyMs).toISOString();
  }

  list() {
    return this._load().items;
  }

  register({ kind, at = null, every = null, payload = {}, createdBy = 'runtime' } = {}) {
    if (typeof kind !== 'string' || !KIND_PATTERN.test(kind)) {
      throw new Error(`Invalid wake-up kind "${kind}": use lower-case words, optionally "<module>:<kind>".`);
    }
    const hasAt = at !== null && at !== undefined;
    const hasEvery = every !== null && every !== undefined;
    if (hasAt === hasEvery) throw new Error('A wake-up needs exactly one of "at" or "every".');
    let atIso = null;
    let everyMs = null;
    if (hasAt) {
      if (typeof at !== 'string' || !RFC3339.test(at) || !Number.isFinite(Date.parse(at))) {
        throw new Error('"at" must be an RFC3339 date-time.');
      }
      atIso = new Date(Date.parse(at)).toISOString();
    } else {
      if (!Number.isInteger(every)) throw new Error(`"every" is in milliseconds and must be an integer of at least ${MIN_EVERY_MS}.`);
      if (every < MIN_EVERY_MS) throw new Error(`"every" is in milliseconds and must be at least ${MIN_EVERY_MS}.`);
      everyMs = every;
    }
    const data = this._load();
    data.counter += 1;
    const now = this.now();
    const entry = {
      id: `w-${String(data.counter).padStart(4, '0')}`,
      kind,
      at: atIso,
      everyMs,
      nextAt: null,
      payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {},
      createdBy: String(createdBy || 'runtime'),
      createdAt: now.toISOString(),
      lastRunAt: null,
      lastOutcome: null,
      attempts: 0,
      lastError: null
    };
    entry.nextAt = atIso || this._nextFor(entry, now);
    data.items.push(entry);
    this._save(data);
    return entry.id;
  }

  ensure(kind, spec = {}) {
    const key = spec.payload?.key ?? null;
    const existing = this.list().find((w) => w.kind === kind && (w.payload?.key ?? null) === key);
    return existing ? existing.id : this.register({ ...spec, kind });
  }

  cancel(id) {
    const data = this._load();
    const before = data.items.length;
    data.items = data.items.filter((w) => w.id !== id);
    if (data.items.length === before) return false;
    this._save(data);
    return true;
  }

  cancelAll() {
    const data = this._load();
    const n = data.items.length;
    if (!n) return 0;
    data.items = [];
    this._save(data);
    return n;
  }

  due(now = this.now()) {
    const t = now.getTime();
    return this.list().filter((w) => Date.parse(w.nextAt) <= t);
  }

  markRan(id, { outcome, error = null, now = this.now() } = {}) {
    if (!OUTCOMES.includes(outcome)) throw new Error(`Unknown wake-up outcome "${outcome}". Outcomes: ${OUTCOMES.join(', ')}.`);
    const data = this._load();
    const entry = data.items.find((w) => w.id === id);
    if (!entry) return null;
    entry.lastRunAt = now.toISOString();
    entry.lastOutcome = outcome;
    if (outcome === 'failed') {
      entry.attempts = (Number(entry.attempts) || 0) + 1;
      entry.lastError = error ? String(error) : null;
      const minutes = this.backoffMinutes[Math.min(entry.attempts, this.backoffMinutes.length) - 1];
      entry.nextAt = new Date(now.getTime() + minutes * 60000).toISOString();
    } else {
      entry.attempts = 0;
      entry.lastError = null;
      if (entry.everyMs) {
        entry.nextAt = this._nextFor(entry, now);
      } else if (outcome === 'skipped') {
        entry.nextAt = nextLocalMidnight(now, this.timeZone).toISOString();
      } else {
        data.items = data.items.filter((w) => w.id !== id);
      }
    }
    this._save(data);
    return data.items.find((w) => w.id === id) || null;
  }

  // After the clock jumps back, an every-entry can sit far in the future.
  reanchor(now = this.now()) {
    const data = this._load();
    let moved = 0;
    for (const w of data.items) {
      if (!w.everyMs) continue;
      if (Date.parse(w.nextAt) - now.getTime() > 2 * w.everyMs) {
        w.nextAt = this._nextFor(w, now);
        moved += 1;
      }
    }
    if (moved) this._save(data);
    return moved;
  }
}

const WAKEUP_JOB_ID = 'cases:wakeups';
const WAKEUP_JOB_SPEC = Object.freeze({
  system: true,
  enabled: true,
  schedule: Object.freeze({ kind: 'every', everyMs: 60000 }),
  payload: Object.freeze({ system: WAKEUP_JOB_ID })
});

// One system job per data dir, written through the store (not addJob, which
// strips `system`). Idempotent: a job the owner disabled or that a bad run
// left erroring is put back as specified on every start.
async function ensureWakeupJob(cronStore) {
  const spec = {
    system: true,
    enabled: true,
    schedule: { ...WAKEUP_JOB_SPEC.schedule },
    payload: { ...WAKEUP_JOB_SPEC.payload }
  };
  const existing = cronStore.get(WAKEUP_JOB_ID);
  if (!existing) {
    return cronStore.add({ id: WAKEUP_JOB_ID, name: 'Case wake-ups', ...spec });
  }
  const same = existing.system === true
    && existing.enabled === true
    && JSON.stringify(existing.schedule) === JSON.stringify(spec.schedule)
    && JSON.stringify(existing.payload) === JSON.stringify(spec.payload)
    && (existing.state?.consecutiveErrors || 0) === 0;
  if (same) return existing;
  return cronStore.update(WAKEUP_JOB_ID, {
    ...spec,
    state: { ...(existing.state || {}), consecutiveErrors: 0 }
  });
}

module.exports = {
  WakeupStore,
  MIN_EVERY_MS,
  OUTCOMES,
  DEFAULT_BACKOFF_MINUTES,
  WAKEUP_JOB_ID,
  ensureWakeupJob
};
