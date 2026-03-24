const cronParser = require('cron-parser');

class CronScheduler {
  constructor(store, executor, options = {}) {
    this.store = store;
    this.executor = executor;
    this.tickIntervalMs = options.tickIntervalMs || 30000;
    this.maxConcurrentJobs = options.maxConcurrentJobs || 5;
    this.jobTimeoutMs = options.jobTimeoutMs || 300000;

    this.timer = null;
    this.activeJobs = new Set();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getNextRun(job) {
    if (!job.schedule) return null;

    const { kind } = job.schedule;
    const lastRun = job.state?.lastRunAtMs || 0;
    const now = Date.now();

    if (kind === 'every') {
      const everyMs = job.schedule.everyMs;
      if (!everyMs) return null;
      if (lastRun === 0) return now; // Run immediately if never run
      return lastRun + everyMs;
    }

    if (kind === 'cron') {
      const expr = job.schedule.expr;
      if (!expr) return null;
      try {
        const options = {};
        if (job.schedule.tz) options.tz = job.schedule.tz;

        // Ensure we calculate from max(lastRun, now) to avoid immediate re-runs
        const fromDate = lastRun ? new Date(lastRun) : new Date(job.createdAt || now);
        options.currentDate = fromDate;

        const interval = (cronParser.parseExpression || cronParser.parse || (cronParser.default && cronParser.default.parse))(expr, options);
        return interval.next().getTime();
      } catch (err) {
        console.error(`Invalid cron expression for job ${job.id}: ${expr}`, err);
        return null;
      }
    }

    if (kind === 'at') {
      if (lastRun > 0) return null; // Already ran
      const atTime = new Date(job.schedule.at).getTime();
      if (isNaN(atTime)) return null;
      return atTime;
    }

    return null;
  }

  isDue(job) {
    if (!job.enabled) return false;
    if (this.activeJobs.has(job.id)) return false; // Already running

    const nextRun = this.getNextRun(job);
    if (nextRun === null) return false;

    return Date.now() >= nextRun;
  }

  async tick() {
    const allJobs = this.store.list();
    const dueJobs = allJobs.filter(job => this.isDue(job));

    // Sort by next run time (optional, but good practice)
    dueJobs.sort((a, b) => {
        const nextA = this.getNextRun(a) || 0;
        const nextB = this.getNextRun(b) || 0;
        return nextA - nextB;
    });

    const jobsToRun = dueJobs.slice(0, Math.max(0, this.maxConcurrentJobs - this.activeJobs.size));

    for (const job of jobsToRun) {
      this.executeJob(job);
    }
  }

  async executeJob(job) {
    if (this.activeJobs.has(job.id)) return;
    this.activeJobs.add(job.id);

    try {
      const executePromise = this.executor.execute(job);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Job execution timed out')), this.jobTimeoutMs);
      });

      await Promise.race([executePromise, timeoutPromise]);
    } catch (err) {
      job.state = job.state || {};
      job.state.consecutiveErrors = (job.state.consecutiveErrors || 0) + 1;
      console.error(`Error executing cron job ${job.id}:`, err);
    } finally {
      this.activeJobs.delete(job.id);
      try {
        await this.store.update(job.id, { state: job.state });
      } catch (updateErr) {
        console.error(`Failed to update job state for ${job.id}:`, updateErr);
      }
    }
  }

  async addJob(jobData) {
    return await this.store.add(jobData);
  }

  async updateJob(id, patch) {
    return await this.store.update(id, patch);
  }

  async removeJob(id) {
    return await this.store.remove(id);
  }

  async runNow(id) {
    const job = this.store.get(id);
    if (!job) throw new Error(`Job ${id} not found`);
    return await this.executeJob(job);
  }

  listJobs() {
    return this.store.list();
  }
}

module.exports = CronScheduler;
