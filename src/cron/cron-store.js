const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class CronStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.jobs = new Map();
  }

  async load() {
    try {
      const data = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      this.jobs.clear();
      for (const job of parsed) {
        this.jobs.set(job.id, job);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      this.jobs.clear();
    }
  }

  async save() {
    const data = JSON.stringify(Array.from(this.jobs.values()), null, 2);
    const tempFile = `${this.filePath}.tmp.${Date.now()}`;
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.promises.writeFile(tempFile, data, 'utf8');
    await fs.promises.rename(tempFile, this.filePath);
  }

  list() {
    return Array.from(this.jobs.values());
  }

  get(id) {
    return this.jobs.get(id);
  }

  async add(job) {
    const newJob = {
      id: crypto.randomUUID(),
      enabled: true,
      state: {},
      createdAt: new Date().toISOString(),
      ...job
    };
    this.jobs.set(newJob.id, newJob);
    await this.save();
    return newJob;
  }

  async update(id, patch) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const updatedJob = { ...job, ...patch };
    this.jobs.set(id, updatedJob);
    await this.save();
    return updatedJob;
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
