const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const UsageTracker = require('../src/tracking/usage-tracker');
const { registerUsageHandlers } = require('../src/ipc/usage-handlers');

describe('UsageTracker', () => {
  let tracker;
  let mockStore;

  beforeEach(() => {
    mockStore = {
      data: {},
      get(key, fallbackValue = null) {
        return Object.prototype.hasOwnProperty.call(this.data, key)
          ? this.data[key]
          : fallbackValue;
      },
      set(key, value) {
        this.data[key] = value;
      }
    };

    tracker = new UsageTracker(mockStore);
  });

  it('records usage with the cost the call carries', () => {
    const result = tracker.record({
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.00045
    });

    assert.strictEqual(result.cost, 0.00045);
    assert.strictEqual(result.inputTokens, 1000);
    assert.strictEqual(result.outputTokens, 500);
  });

  it('accumulates session usage totals', () => {
    tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 });
    tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 2000, outputTokens: 1000 });

    const session = tracker.getSessionUsage();
    assert.strictEqual(session.inputTokens, 3000);
    assert.strictEqual(session.outputTokens, 1500);
    assert.strictEqual(session.totalTokens, 4500);
    assert.strictEqual(session.turns, 2);
  });

  it('persists daily usage', () => {
    tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 });
    const today = new Date().toISOString().slice(0, 10);
    const daily = tracker.getDailyUsage(today);

    assert.ok(daily);
    assert.strictEqual(daily.inputTokens, 1000);
    assert.strictEqual(daily.outputTokens, 500);
    assert.strictEqual(daily.turns, 1);
  });

  it('tracks provider breakdown in session and daily usage', () => {
    tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 });
    tracker.record({ provider: 'anthropic', model: 'claude-3-5-sonnet-latest', inputTokens: 700, outputTokens: 300 });

    const session = tracker.getSessionUsage();
    assert.ok(session.providers.openai);
    assert.ok(session.providers.anthropic);
    assert.strictEqual(session.providers.openai.turns, 1);
    assert.strictEqual(session.providers.anthropic.turns, 1);

    const today = new Date().toISOString().slice(0, 10);
    const daily = tracker.getDailyUsage(today);
    assert.ok(daily.providers.openai);
    assert.ok(daily.providers.anthropic);
  });

  it('returns null cost when the call carries none', () => {
    const result = tracker.record({
      provider: 'unknown',
      model: 'unknown-model',
      inputTokens: 1000,
      outputTokens: 500
    });

    assert.strictEqual(result.cost, null);
  });

  it('never recomputes a recorded cost from its own table', () => {
    const result = tracker.record({
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      costUsd: 0.1234
    });

    assert.strictEqual(result.cost, 0.1234);
    const session = tracker.getSessionUsage();
    assert.strictEqual(session.totalCost, 0.1234);
  });

  it('resets session usage', () => {
    tracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 500 });
    tracker.reset();

    const session = tracker.getSessionUsage();
    assert.strictEqual(session.inputTokens, 0);
    assert.strictEqual(session.outputTokens, 0);
    assert.strictEqual(session.totalTokens, 0);
    assert.strictEqual(session.turns, 0);
    assert.deepStrictEqual(session.providers, {});
  });
});

describe('Usage IPC handlers', () => {
  it('registers and serves session + daily usage handlers', async () => {
    const handlers = new Map();
    const ipcMain = {
      handle(channel, handler) {
        handlers.set(channel, handler);
      }
    };

    const store = {
      data: {},
      get(key, fallbackValue = null) {
        return Object.prototype.hasOwnProperty.call(this.data, key)
          ? this.data[key]
          : fallbackValue;
      },
      set(key, value) {
        this.data[key] = value;
      }
    };

    const usageTracker = new UsageTracker(store);
    usageTracker.record({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 100, outputTokens: 50 });

    registerUsageHandlers(ipcMain, {
      getUsageTracker: () => usageTracker
    });

    assert.ok(handlers.has('usage:getSession'));
    assert.ok(handlers.has('usage:getDaily'));

    const sessionResult = await handlers.get('usage:getSession')({});
    assert.strictEqual(sessionResult.ok, true);
    assert.ok(sessionResult.data.totalTokens > 0);

    const today = new Date().toISOString().slice(0, 10);
    const dailyResult = await handlers.get('usage:getDaily')({}, { date: today });
    assert.strictEqual(dailyResult.ok, true);
    assert.ok(dailyResult.data);
    assert.strictEqual(dailyResult.data.turns, 1);
  });
});

describe('UsageTracker by role and model (spec 2026-09-27 §10)', () => {
  const memoryStore = () => ({
    data: {},
    get(key, fallbackValue = null) { return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallbackValue; },
    set(key, value) { this.data[key] = value; }
  });

  it('totals by role and by model, counting unpriced calls instead of adding $0', () => {
    const tracker = new UsageTracker(memoryStore());
    tracker.record({ provider: 'openai', model: 'gpt-5.5', role: 'main', inputTokens: 100, outputTokens: 10, costUsd: 0.02 });
    tracker.record({ provider: 'openai', model: 'gpt-5.4-mini', role: 'worker', inputTokens: 50, outputTokens: 5, costUsd: null });
    tracker.record({ provider: 'openai', model: 'gpt-5.4-mini', inputTokens: 5, outputTokens: 1, costUsd: 0.001 });
    const s = tracker.getSessionUsage();
    assert.deepStrictEqual([s.roles.main.totalCost, s.roles.main.turns, s.roles.main.unpricedCalls], [0.02, 1, 0]);
    assert.deepStrictEqual([s.roles.worker.totalCost, s.roles.worker.unpricedCalls], [0, 1]);
    assert.strictEqual(s.roles.other.turns, 1);
    assert.deepStrictEqual([s.models['openai:gpt-5.4-mini'].turns, s.models['openai:gpt-5.4-mini'].unpricedCalls], [2, 1]);
    assert.strictEqual(s.unpricedCalls, 1);
    const today = new Date().toISOString().slice(0, 10);
    assert.strictEqual(tracker.getDailyUsage(today).roles.worker.unpricedCalls, 1);
  });

  it('builds the event from a call\'s metrics, role and priceable usage included', () => {
    const e = UsageTracker.eventFromMetrics({
      provider: 'openai', model: 'gpt-5.5', inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: 60,
      costUsd: 0.01, role: 'main', profileId: 'p-1',
      pricingUsage: { input: 40, cachedInput: 60, cacheWrite: 0, output: 10, reasoning: 0 }
    }, 25);
    assert.deepStrictEqual(e, {
      provider: 'openai', model: 'gpt-5.5', inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 60,
      costUsd: 0.01, role: 'main', pricingUsage: { input: 40, cachedInput: 60, cacheWrite: 0, output: 10, reasoning: 0 }, durationMs: 25
    });
    assert.strictEqual(UsageTracker.eventFromMetrics({ costUsd: null }).costUsd, null);
  });

  it('sums the last 30 days by role, with the priceable parts', () => {
    let now = new Date('2026-09-27T12:00:00Z');
    const tracker = new UsageTracker(memoryStore(), { now: () => now });
    const call = (role, costUsd, input) => tracker.record({
      provider: 'openai', model: 'm', role, inputTokens: input, outputTokens: 1, costUsd,
      pricingUsage: { input, cachedInput: 0, cacheWrite: 0, output: 1, reasoning: 0 }
    });
    call('utility', 0.01, 1000);
    now = new Date('2026-09-10T12:00:00Z');
    call('utility', 0.02, 2000);
    now = new Date('2026-08-01T12:00:00Z'); // outside the window
    call('utility', 5, 99999);
    now = new Date('2026-09-27T12:00:00Z');
    call('main', null, 10);
    const recent = tracker.recentRoleUsage({ days: 30 });
    assert.deepStrictEqual(recent.utility, { calls: 2, unpricedCalls: 0, cost: 0.03, usage: { input: 3000, cachedInput: 0, cacheWrite: 0, output: 2, reasoning: 0 } });
    assert.deepStrictEqual([recent.main.calls, recent.main.unpricedCalls, recent.main.cost], [1, 1, 0]);
  });

  it('backfills a daily record stored before unpricedCalls, roles and models existed (Task 3 review)', () => {
    const store = memoryStore();
    const today = new Date().toISOString().slice(0, 10);
    // Pre-Task-3 shape: no unpricedCalls, no roles, no models; a provider
    // entry that likewise predates unpricedCalls.
    store.set(`usage.daily.${today}`, {
      inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, totalTokens: 12, totalCost: 0.01, turns: 1,
      providers: { openai: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, totalTokens: 12, totalCost: 0.01, turns: 1 } }
    });
    const tracker = new UsageTracker(store);
    const daily = tracker.getDailyUsage(today);
    assert.strictEqual(daily.unpricedCalls, 0);
    assert.deepStrictEqual(daily.roles, {});
    assert.deepStrictEqual(daily.models, {});
    assert.strictEqual(daily.providers.openai.unpricedCalls, 0);
    assert.strictEqual(daily.providers.openai.turns, 1, 'the old data itself is preserved');

    // A new call against that same old-shape provider entry backfills it in
    // place rather than losing its history.
    tracker.record({ provider: 'openai', model: 'gpt-5.5', role: 'main', inputTokens: 1, outputTokens: 1, costUsd: null });
    const after = tracker.getDailyUsage(today);
    assert.strictEqual(after.providers.openai.turns, 2);
    assert.strictEqual(after.providers.openai.unpricedCalls, 1);
  });
});
