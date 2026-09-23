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
  constructor(title, { pid, lockPath } = {}) {
    const holder = pid ? ` in process ${pid}` : '';
    const recover = lockPath
      ? ` If that process is stuck or is not King Louie, quit it or delete ${lockPath}.`
      : '';
    super(`Case "${title}" is busy with another turn${holder}. Try again when it finishes.${recover}`);
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

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readLock(lock) {
  try {
    const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
    return held && typeof held === 'object' ? held : null;
  } catch {
    return null;
  }
}

class CaseRuntime {
  constructor({ root, staleLockMs = 30 * 60 * 1000, orientationMaxChars = DEFAULT_MAX_CHARS }) {
    this.store = new CaseStore({ root });
    this.staleLockMs = staleLockMs;
    this.orientationMaxChars = orientationMaxChars;
    // turnId -> { dir, timer }: the locks this runtime holds right now.
    this.held = new Map();
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
        this._hold(meta.dir, turnId);
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const holder = readLock(lock);
        const stale = this._staleReason(lock, holder);
        if (attempt === 0 && stale) {
          log.warn(`Reclaiming stale lock on case ${meta.slug} (${stale})`);
          fs.rmSync(lock, { force: true });
          continue;
        }
        throw new CaseBusyError(meta.title, { pid: holder?.pid, lockPath: lock });
      }
    }
  }

  // Why an existing lock can be taken over, or null while its holder is live.
  _staleReason(lock, holder) {
    if (holder && Number.isInteger(holder.pid)) {
      if (holder.pid === process.pid) {
        if (!this.held.has(holder.turnId)) return 'left by an earlier turn in this process';
      } else if (!pidAlive(holder.pid)) {
        return `process ${holder.pid} is gone`;
      }
    }
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age > this.staleLockMs) return `${Math.round(age / 60000)} min old`;
    return null;
  }

  // Keep the held lock's mtime fresh so a long turn never looks stale.
  _hold(dir, turnId) {
    const lock = this._lockPath(dir);
    const timer = setInterval(() => {
      try {
        const now = new Date();
        fs.utimesSync(lock, now, now);
      } catch (err) {
        log.warn(`Could not refresh lock in ${dir}: ${err.message}`);
      }
    }, Math.max(10, Math.floor(this.staleLockMs / 3)));
    timer.unref?.();
    this.held.set(turnId, { dir, timer });
  }

  releaseAll() {
    for (const [turnId, { dir }] of [...this.held]) this._release(dir, turnId);
  }

  _release(dir, turnId) {
    const entry = this.held.get(turnId);
    if (entry && entry.dir === dir) {
      clearInterval(entry.timer);
      this.held.delete(turnId);
    }
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
