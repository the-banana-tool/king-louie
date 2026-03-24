const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class CronStore {
  constructor(storageFile) {
    this.storageFile = storageFile;
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
      console.warn(`[cron-store] failed to load jobs from ${this.storageFile}:`, err.message);
      this.jobs = new Map();
    }
  }

  async save() {
    const tempFile = `${this.storageFile}.tmp.${Date.now()}`;
    const data = JSON.stringify(Object.fromEntries(this.jobs), null, 2);

    // Ensure directory exists
    const dir = path.dirname(this.storageFile);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    await fs.promises.writeFile(tempFile, data, 'utf8');
    await fs.promises.rename(tempFile, this.storageFile);
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
