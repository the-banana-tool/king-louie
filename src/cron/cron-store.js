const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createLogger } = require('../logging');
const { guardCheck } = require('../platform/write-guard');
const log = createLogger('cron-store');

class CronStore {
  // `writeGuard` (src/platform/write-guard.js) is passed only by the admin
  // CLI's import writer, which may run as an Administrator inside a data dir
  // the service account controls; without one, writes are unchanged.
  constructor(storageFile, { writeGuard = null } = {}) {
    this.storageFile = storageFile;
    this.writeGuard = writeGuard;
    this.jobs = new Map();
  }

  async load() {
    try {
      if (fs.existsSync(this.storageFile)) {
        const data = await fs.promises.readFile(this.storageFile, 'utf8');
        const parsed = JSON.parse(data);
        this.jobs = new Map(Object.entries(parsed));
      }
    } catch (err) {
      log.warn(`failed to load jobs from ${this.storageFile}: ${err.message}`);
      this.jobs = new Map();
    }
  }

  async save() {
    // An unpredictable name opened with 'wx' (O_CREAT|O_EXCL): nothing can
    // be planted there in advance, and an existing entry is never followed
    // or truncated (fleet stage 7 Task 9, fix round 1).
    const tempFile = `${this.storageFile}.tmp.${crypto.randomBytes(8).toString('hex')}`;
    const data = JSON.stringify(Object.fromEntries(this.jobs), null, 2);

    // Ensure directory exists
    const dir = path.dirname(this.storageFile);
    guardCheck(this.writeGuard, tempFile);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
      guardCheck(this.writeGuard, tempFile);
    }

    const handle = await fs.promises.open(tempFile, 'wx');
    try {
      await handle.writeFile(data, 'utf8');
    } finally {
      await handle.close();
    }
    try {
      await fs.promises.rename(tempFile, this.storageFile);
    } catch (err) {
      await fs.promises.rm(tempFile, { force: true });
      throw err;
    }
  }

  list() {
    return Array.from(this.jobs.values());
  }

  get(id) {
    return this.jobs.get(id);
  }

  async add(job) {
    const id = job.id || `cron_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const newJob = {
      ...job,
      id,
      enabled: job.enabled !== false,
      createdAt: job.createdAt || new Date().toISOString(),
      state: job.state || { lastRunAtMs: 0, consecutiveErrors: 0 }
    };

    this.jobs.set(id, newJob);
    await this.save();
    return newJob;
  }

  async update(id, patch) {
    const job = this.jobs.get(id);
    if (!job) return null;

    const updated = { ...job, ...patch };
    this.jobs.set(id, updated);
    await this.save();
    return updated;
  }

  async remove(id) {
    if (this.jobs.has(id)) {
      this.jobs.delete(id);
      await this.save();
      return true;
    }
    return false;
  }
}

module.exports = CronStore;
