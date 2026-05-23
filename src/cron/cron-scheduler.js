const cronParser = require('cron-parser');
const { createLogger } = require('../logging');

const log = createLogger('cron-scheduler');

class CronScheduler {
  constructor(store, executor, options = {}) {
    this.store = store;
    this.executor = executor;
    this.tickIntervalMs = options.tickIntervalMs || 30000;
    this.maxConcurrentJobs = options.maxConcurrentJobs || 5;

    this.timer = null;
    this.runningJobs = new Set();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    setTimeout(() => this.tick(), 100);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getNextRun(job) {
    if (!job.schedule || !job.enabled) return null;
    const { kind, at, everyMs, expr, tz } = job.schedule;

    if (kind === 'at') {
      const runAt = new Date(at).getTime();
      return runAt > Date.now() ? runAt : null;
    }

    if (kind === 'every') {
      const lastRun = job.state?.lastRunAtMs || 0;
      return lastRun + (everyMs || 60000);
    }

    if (kind === 'cron') {
      try {
        const lastRun = job.state?.lastRunAtMs || 0;
        const options = { tz: tz || 'UTC' };
        if (lastRun > 0) {
          options.currentDate = new Date(lastRun);
        }
        const interval = cronParser.CronExpressionParser.parse(expr, options);
        return interval.next().getTime();
      } catch (err) {
        return null;
      }
    }

    return null;
  }

  isDue(job) {
    if (!job.enabled) return false;

    if (job.schedule?.kind === 'at') {
        const runAt = new Date(job.schedule.at).getTime();
        return runAt <= Date.now() && (!job.state?.lastRunAtMs || job.state.lastRunAtMs < runAt);
    }

    const nextRun = this.getNextRun(job);
    return nextRun !== null && nextRun <= Date.now();
  }

  async tick() {
    const jobs = this.store.list();
    const dueJobs = jobs.filter(job => this.isDue(job) && !this.runningJobs.has(job.id));

    if (dueJobs.length === 0) return;

    const jobsToRun = dueJobs.slice(0, Math.max(0, this.maxConcurrentJobs - this.runningJobs.size));

    for (const job of jobsToRun) {
      this.runNow(job.id).catch(err => log.error(`tick run failed for ${job.id}: ${err.message}`));
    }
  }

  async runNow(id) {
    const job = this.store.get(id);
    if (!job) {
      return { ok: false, error: `Job not found: ${id}` };
    }

    if (this.runningJobs.has(id)) {
      return { ok: false, error: `Job ${id} is already running` };
    }

    this.runningJobs.add(id);
    let result = { ok: false, error: 'Unknown error' };

    try {
      if (this.executor && typeof this.executor.execute === 'function') {
         result = await this.executor.execute(job);
      } else {
         result = { ok: false, error: 'Executor not configured' };
      }
    } catch (err) {
      result = { ok: false, error: err.message };
    } finally {
      this.runningJobs.delete(id);
    }

    const currentState = job.state || {};
    const newState = {
        lastRunAtMs: Date.now(),
        lastResult: result,
        consecutiveErrors: result.ok ? 0 : (currentState.consecutiveErrors || 0) + 1
    };

    const patch = { state: newState };
    if (job.schedule?.kind === 'at') {
        patch.enabled = false;
    } else if (newState.consecutiveErrors >= 5) {
        patch.enabled = false;
        log.warn(`disabled job ${id} after 5 consecutive errors`);
    }

    await this.store.update(id, patch);
    return result;
  }

  async addJob(job) {
    return this.store.add(job);
  }

  async updateJob(id, patch) {
    return this.store.update(id, patch);
  }

  async removeJob(id) {
    return this.store.remove(id);
  }

  listJobs() {
    return this.store.list().map(job => {
      const nextRun = this.getNextRun(job);
      return {
         ...job,
         nextRunAt: nextRun ? new Date(nextRun).toISOString() : null
      };
    });
  }
}

module.exports = CronScheduler;
