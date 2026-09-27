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
