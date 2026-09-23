// src/cases/case-runtime.js
// The one object core holds for cases: turn lifecycle (spec §5.5), lock,
// commits, and read access to each case's ledger, brief and records.
const fs = require('fs');
const path = require('path');
const git = require('./git');
const { CaseStore } = require('./case-store');
const { FactLedger } = require('./ledger');
const { Brief } = require('./brief');
const { CaseRecords } = require('./records');
const { buildOrientation, DEFAULT_MAX_CHARS } = require('./orientation');
const { createLogger } = require('../logging');

const log = createLogger('cases/runtime');

class CaseBusyError extends Error {
  constructor(title) {
    super(`Case "${title}" is busy with another turn. Try again when it finishes.`);
    this.name = 'CaseBusyError';
    this.code = 'CASE_BUSY';
  }
}

class CaseNotFoundError extends Error {
  constructor(id) {
    super(`Case not found: ${id}`);
    this.name = 'CaseNotFoundError';
    this.code = 'CASE_NOT_FOUND';
  }
}

function resolveCasesRoot({ settings, env = process.env, dataDir }) {
  const configured = settings?.cases?.root;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  if (env && env.KL_CASES_ROOT) return env.KL_CASES_ROOT;
  return path.join(dataDir, 'cases');
}

const oneLine = (s, max = 72) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

class CaseRuntime {
  constructor({ root, staleLockMs = 30 * 60 * 1000, orientationMaxChars = DEFAULT_MAX_CHARS }) {
    this.store = new CaseStore({ root });
    this.staleLockMs = staleLockMs;
    this.orientationMaxChars = orientationMaxChars;
  }

  get root() {
    return this.store.root;
  }

  createCase(opts) {
    return this.store.create(opts);
  }

  listCases() {
    return this.store.list();
  }

  getCase(idOrSlug) {
    const c = this.store.get(idOrSlug);
    if (!c) throw new CaseNotFoundError(idOrSlug);
    return c;
  }

  ledger(id) { return new FactLedger(this.getCase(id).dir); }

  brief(id) { return new Brief(this.getCase(id).dir); }

  records(id) { return new CaseRecords(this.getCase(id).dir); }

  orientation(id) {
    const meta = this.getCase(id);
    const { facts, errors } = new FactLedger(meta.dir).view();
    let brief;
    try {
      brief = { data: new Brief(meta.dir).read().data };
    } catch (err) {
      brief = { error: err.message };
    }
    const records = new CaseRecords(meta.dir);
    return buildOrientation({
      meta,
      brief,
      facts,
      decisions: records.decisions(),
      lastJournal: records.lastJournal(),
      ledgerErrors: errors,
      maxChars: this.orientationMaxChars
    });
  }

  otherCaseFacts(id) {
    const self = this.getCase(id);
    return this.listCases()
      .filter((c) => c.id !== self.id)
      .map((c) => ({ caseId: c.id, title: c.title, facts: new FactLedger(c.dir).view().facts }));
  }

  completeGating(id) {
    const meta = this.getCase(id);
    new Brief(meta.dir).completeGating();
    if (meta.status === 'draft') this.store.updateMeta(meta.id, { status: 'active' });
    return this.getCase(meta.id);
  }

  _lockPath(dir) {
    return path.join(dir, '.kl', 'lock');
  }

  _acquire(meta, turnId) {
    const lock = this._lockPath(meta.dir);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(lock, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify({ turnId, pid: process.pid, at: new Date().toISOString() }));
        } finally {
          fs.closeSync(fd);
        }
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (attempt === 0 && age > this.staleLockMs) {
          log.warn(`Reclaiming stale lock on case ${meta.slug} (${Math.round(age / 60000)} min old)`);
          fs.rmSync(lock, { force: true });
          continue;
        }
        throw new CaseBusyError(meta.title);
      }
    }
  }

  _release(dir, turnId) {
    const lock = this._lockPath(dir);
    try {
      const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (held.turnId === turnId) fs.rmSync(lock, { force: true });
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`Could not release lock in ${dir}: ${err.message}`);
    }
  }

  async beginTurn(id, { turnId }) {
    const meta = this.getCase(id);
    this._acquire(meta, turnId);
    try {
      if (await git.isDirty(meta.dir)) await git.commitAll(meta.dir, 'owner edits');
      return { caseId: meta.id, dir: meta.dir, turnId, title: meta.title, orientation: this.orientation(meta.id) };
    } catch (err) {
      this._release(meta.dir, turnId);
      throw err;
    }
  }

  async endTurn(turn, { summary = '', journal = null } = {}) {
    try {
      const records = new CaseRecords(turn.dir);
      records.renderOpenItems(new FactLedger(turn.dir).view().facts);
      if (journal && String(journal).trim()) records.writeJournal('turn', journal);
      return await git.commitAll(turn.dir, `${turn.turnId}: ${oneLine(summary) || 'turn'}`);
    } finally {
      this._release(turn.dir, turn.turnId);
    }
  }
}

module.exports = { CaseRuntime, CaseBusyError, CaseNotFoundError, resolveCasesRoot };
