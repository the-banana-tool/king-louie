// src/cases/executors/registry.js
// ExecutorRegistry (cases stage 3 spec §3.1, program §4.8): who can do the
// work. Resolution is built-in → configured entries → per-case override
// (narrowing only) → floors (R42). Job lifecycle, envelopes and plans live in
// their own modules and are attached below as operations.
const path = require('path');
const AsyncMutex = require('../../workflows/async-mutex');
const { createLogger } = require('../../logging');
const { builtinEntry, BUILTIN_IDS, OUTBOUND_CAPABILITIES, LATENCIES, STATE_MODES, OUTBOUND_MODES } = require('./builtins');
const { checkPackage, loadAdapter, ExecutorUnavailableError } = require('./package-loader');
const { resolveExecutorSettings } = require('./defaults');
const {
  readJsonSafe, writeJsonAtomic, localDate, pickTimeZone, addDays, EXECUTOR_ID_PATTERN, DAY_PATTERN, validTimeZone, sha256hex
} = require('./util');
const { JobStore, readSnapshot, OPEN_STATES } = require('./job-store');
const jobs = require('./jobs');
const envelopeOps = require('./envelope-ops');
const turnHook = require('./turn-hook');
const { OpsMemory, renderOpsNotes } = require('../ops-memory');
const CaseResearcherAgent = require('../../agents/builtin/case-researcher');

const log = createLogger('executors');
const AUTHORITY_RANK = Object.freeze({ none: 0, envelope: 1, signed: 2 });
const OUTBOUND_RANK = Object.freeze({ none: 0, query: 1, message: 2 });
// What settings may change on a built-in (spec §3.1).
const BUILTIN_SETTABLE = new Set(['constraints', 'cost', 'latency', 'pollEveryMs']);
const OVERRIDE_KEYS = new Set(['disabled', 'capabilities', 'constraints', 'briefRules', 'authority']);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
const publicEntry = (e) => JSON.parse(JSON.stringify(e));

// The intersection of two calling windows, or null when it would be empty,
// cross zones, or the override is malformed.
function intersectWindow(base, narrow) {
  if (!isObject(narrow)) return null;
  if (!base) {
    if (!HHMM.test(String(narrow.start)) || !HHMM.test(String(narrow.end)) || !(narrow.start < narrow.end)) return null;
    return { tz: narrow.tz || '', start: narrow.start, end: narrow.end, weekdays: Array.isArray(narrow.weekdays) ? [...narrow.weekdays] : [...ALL_WEEKDAYS] };
  }
  if (narrow.tz && base.tz && narrow.tz !== base.tz) return null;
  const start = HHMM.test(String(narrow.start)) && narrow.start > base.start ? narrow.start : base.start;
  const end = HHMM.test(String(narrow.end)) && narrow.end < base.end ? narrow.end : base.end;
  const baseDays = Array.isArray(base.weekdays) ? base.weekdays : ALL_WEEKDAYS;
  const weekdays = Array.isArray(narrow.weekdays) ? baseDays.filter((d) => narrow.weekdays.includes(d)) : [...baseDays];
  if (!(start < end) || !weekdays.length) return null;
  return { tz: base.tz || narrow.tz || '', start, end, weekdays };
}

class ExecutorRegistry {
  constructor({
    dataDir, getSettings = () => ({}), adminExecutors = null, isService = false, vault = null, caseRuntime = null,
    getWorkflowEngine = () => null, getRunbookEngine = () => null, getPhoneApprover = () => null, getAuditLedger = () => null,
    getApprovalTrust = () => null,
    usageTracker = null, now = () => new Date(), packageRoot = null, assertRoot = null, fetchImpl = null, browserActions = null,
    adminUid = 0, geteuid = undefined
  } = {}) {
    if (!dataDir) throw new Error('ExecutorRegistry needs a dataDir.');
    const fn = (f) => (typeof f === 'function' ? f : () => null);
    this.dataDir = dataDir;
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this.adminExecutors = isObject(adminExecutors) ? adminExecutors : null;
    this.isService = isService === true;
    this.vault = vault;
    this.caseRuntime = caseRuntime;
    this.getWorkflowEngine = fn(getWorkflowEngine);
    this.getRunbookEngine = fn(getRunbookEngine);
    this.getPhoneApprover = fn(getPhoneApprover);
    this.getAuditLedger = fn(getAuditLedger);
    // → { approverStore, nodeId, nodePublicKey } for verifySignedGrant's audit
    // path: F3's ADMIN-owned ApproverStore (built from the config dir, never
    // the data dir) and this node's identity. Missing → that path fails closed.
    this.getApprovalTrust = fn(getApprovalTrust);
    this._usageTracker = usageTracker;
    this.now = typeof now === 'function' ? now : () => new Date();
    this.dir = path.join(dataDir, 'executors');
    this.packageRoot = packageRoot || this.dir;
    // Service mode: the root check (default makeRootAssert) and the per-entry
    // ownership check are bound to the service's adminUid (M16).
    this.assertRoot = assertRoot;
    this.adminUid = adminUid;
    this.geteuid = geteuid;
    this.fetchImpl = fetchImpl;
    this.browserActions = browserActions;
    this.usagePath = path.join(this.dir, 'usage.json');
    this.jobsPath = path.join(this.dir, 'jobs.json');
    this.runsDir = path.join(this.dir, 'runs');
    this.mutex = new AsyncMutex();
    this.extraBriefRules = [];
    // `${caseId}/${envelopeId}` → approve Outcomes from the phone (never from a file).
    this.signedOutcomes = new Map();
    // `${caseId}/${envelopeId}` → an approve Outcome waiting for the case lock.
    this.pendingSignedGrants = new Map();
    // `${caseId}/${jobId}` → { controller, started, name, stamp } for background runs.
    this.running = new Map();
    // `${caseId}/${jobId}` while this process is inside adapter.submit.
    this.inFlight = new Set();
    this._adapters = new Map();
    this._loaded = new Map();
    this._warned = new Set();
  }

  getUsageTracker() {
    return typeof this._usageTracker === 'function' ? this._usageTracker() : this._usageTracker;
  }

  settings() {
    let raw;
    try {
      raw = this.getSettings()?.executors;
    } catch (err) {
      log.warn(`Reading executor settings failed: ${err.message}`);
    }
    // Service mode: the data dir may add outbound keywords, never remove them.
    return resolveExecutorSettings(raw, { additiveKeywords: this.isService });
  }

  casesTimeZone() {
    try {
      return this.getSettings()?.cases?.timeZone || '';
    } catch {
      return '';
    }
  }

  _warnOnce(key, message) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    log.warn(message);
  }

  // Desktop: settings.executors.entries. Service: the admin service.json
  // only (R42); a data-dir value is ignored with a warning per id.
  _configured() {
    const s = this.settings();
    if (this.isService) {
      for (const id of Object.keys(s.entries || {})) {
        this._warnOnce(`data-entry:${id}`, `Ignoring executors.entries.${id} from the data dir: in service mode executors come only from the admin service.json.`);
      }
      return isObject(this.adminExecutors?.entries) ? this.adminExecutors.entries : {};
    }
    return isObject(s.entries) ? s.entries : {};
  }

  _roots() {
    if (!this.isService) return [this.packageRoot];
    return Array.isArray(this.adminExecutors?.packageRoots) ? this.adminExecutors.packageRoots.map(String) : [];
  }

  ids() {
    // An entry that is not an object (null, a string) is not configured.
    const conf = this._configured();
    const configured = Object.keys(conf).filter((id) => !BUILTIN_IDS.includes(id) && isObject(conf[id])).sort();
    return [...BUILTIN_IDS, ...configured];
  }

  _base(id) {
    const warnings = [];
    const conf = this._configured()[id];
    const builtin = builtinEntry(id);
    if (builtin) {
      if (isObject(conf)) {
        for (const [k, v] of Object.entries(conf)) {
          if (BUILTIN_SETTABLE.has(k)) builtin[k] = clone(v);
          else warnings.push(`${id}: "${k}" cannot be changed on a built-in executor; ignored`);
        }
      }
      return { entry: builtin, conf: null, warnings };
    }
    if (!isObject(conf)) return null;
    const entry = {
      id,
      kind: conf.kind || 'external-agent',
      builtin: false,
      package: typeof conf.package === 'string' ? conf.package : null,
      capabilities: [],
      cannot: [],
      constraints: isObject(conf.constraints) ? clone(conf.constraints) : {},
      cost: isObject(conf.cost) ? clone(conf.cost) : {},
      latency: LATENCIES.includes(conf.latency) ? conf.latency : 'async-hours',
      state: STATE_MODES.includes(conf.state) ? conf.state : 'poll',
      authority: AUTHORITY_RANK[conf.authority] !== undefined ? conf.authority : 'envelope',
      direct: false,
      outbound: OUTBOUND_MODES.includes(conf.outbound) ? conf.outbound : 'none',
      pollEveryMs: Number.isInteger(conf.pollEveryMs) ? conf.pollEveryMs : null,
      packageSha256: typeof conf.packageSha256 === 'string' ? conf.packageSha256 : null,
      computedSha256: null,
      payloadSchema: {}
    };
    return { entry, conf, warnings };
  }

  _checkExternal(entry, conf) {
    const unavailable = (reason) => {
      entry.available = false;
      entry.reason = reason;
    };
    if (!EXECUTOR_ID_PATTERN.test(entry.id)) return unavailable('executor ids are lowercase slugs of 2 to 40 characters');
    if (entry.kind !== 'external-agent') return unavailable(`only external-agent executors can be configured; "${entry.kind}" executors are built in`);
    if (!entry.package) return unavailable('no package is configured');
    const roots = this._roots();
    const dir = path.isAbsolute(entry.package) ? entry.package : path.resolve(roots[0] || this.packageRoot, entry.package);
    const checked = checkPackage({
      id: entry.id,
      entry: { packageSha256: entry.packageSha256, config: isObject(conf.config) ? conf.config : {} },
      dir, roots, isService: this.isService, assertRoot: this.assertRoot, vault: this.vault,
      adminUid: this.adminUid, geteuid: this.geteuid
    });
    entry.computedSha256 = checked.computed || null;
    if (checked.manifest) {
      const manifestCaps = Array.isArray(checked.manifest.capabilities) ? checked.manifest.capabilities.map(String) : [];
      entry.capabilities = Array.isArray(conf.capabilities) ? conf.capabilities.map(String).filter((c) => manifestCaps.includes(c)) : manifestCaps;
      entry.cannot = Array.isArray(checked.manifest.cannot) ? checked.manifest.cannot.map(String) : [];
      entry.payloadSchema = isObject(checked.manifest.payloadSchema) ? clone(checked.manifest.payloadSchema) : {};
    }
    if (!checked.ok) return unavailable(checked.error);
    const clash = entry.capabilities.filter((c) => entry.cannot.includes(c));
    if (clash.length) return unavailable(`capabilities and cannot overlap: ${clash.join(', ')}`);
    // Kept as checkPackage returned it: loadAdapter needs its non-enumerable
    // config and entryCheck, which a spread or clone would drop.
    Object.defineProperty(entry, '_checked', { value: checked, enumerable: false });
    return undefined;
  }

  _override(id, caseId) {
    if (!caseId || !this.caseRuntime) return null;
    const snap = readSnapshot(this.caseDir(caseId));
    return isObject(snap[id]?.override) ? snap[id].override : null;
  }

  // An override only narrows; a widening part is ignored with a warning.
  _narrow(entry, o, warnings) {
    const widen = (what) => warnings.push(`${entry.id}: override ${what} would widen the executor; ignored`);
    for (const key of Object.keys(o)) if (!OVERRIDE_KEYS.has(key)) widen(`"${key}"`);
    if (o.disabled === true) {
      entry.available = false;
      entry.reason = 'disabled for this case';
    }
    if (Array.isArray(o.capabilities)) {
      const extra = o.capabilities.filter((c) => !entry.capabilities.includes(c));
      if (extra.length) widen(`capabilities ${extra.join(', ')}`);
      entry.capabilities = entry.capabilities.filter((c) => o.capabilities.includes(c));
    }
    const oc = isObject(o.constraints) ? o.constraints : {};
    for (const key of Object.keys(oc)) if (key !== 'contactsPerDay' && key !== 'callingWindow') widen(`constraints.${key}`);
    if (oc.contactsPerDay !== undefined) {
      const n = oc.contactsPerDay;
      const current = entry.constraints.contactsPerDay;
      if (!Number.isInteger(n) || n < 0 || (Number.isInteger(current) && n > current)) widen('contactsPerDay');
      else entry.constraints.contactsPerDay = n;
    }
    if (oc.callingWindow !== undefined) {
      const merged = intersectWindow(entry.constraints.callingWindow || null, oc.callingWindow);
      if (!merged) widen('callingWindow');
      else entry.constraints.callingWindow = merged;
    }
    if (Array.isArray(o.briefRules)) entry.overrideBriefRules = o.briefRules.map((r) => String(r).trim()).filter(Boolean);
    if (o.authority !== undefined) {
      if (AUTHORITY_RANK[o.authority] === undefined || AUTHORITY_RANK[o.authority] < AUTHORITY_RANK[entry.authority]) widen('authority');
      else entry.authority = o.authority;
    }
  }

  // R42: an outbound capability forces outbound "message" and authority ≥ envelope.
  _floors(entry, warnings) {
    const outbound = entry.capabilities.filter((c) => OUTBOUND_CAPABILITIES.includes(c));
    if (!outbound.length) return;
    if (entry.outbound !== 'message') {
      warnings.push(`${entry.id}: outbound capabilities (${outbound.join(', ')}) keep outbound at "message"`);
      entry.outbound = 'message';
    }
    if ((AUTHORITY_RANK[entry.authority] ?? 0) < AUTHORITY_RANK.envelope) {
      warnings.push(`${entry.id}: outbound capabilities (${outbound.join(', ')}) keep authority at "envelope" or above`);
      entry.authority = 'envelope';
    }
  }

  _resolve(id, caseId = null) {
    const base = this._base(id);
    if (!base) return null;
    const { entry, conf } = base;
    const warnings = [...base.warnings];
    entry.available = true;
    entry.reason = null;
    entry.overrideBriefRules = [];
    if (!entry.builtin) this._checkExternal(entry, conf);
    else if (id === 'runbook' && !this.getRunbookEngine()) {
      entry.available = false;
      entry.reason = 'no runbook engine on this node';
    } else if (id === 'workflow' && !this.getWorkflowEngine()) {
      entry.available = false;
      entry.reason = 'no workflow engine on this node';
    }
    // Final review I2: the floors come from the admin/base capabilities,
    // before any case override. An override narrows the tools only; it never
    // lowers the gate mode or the authority those capabilities set.
    this._floors(entry, warnings);
    if (caseId) {
      const override = this._override(id, caseId);
      if (override) {
        const floor = { outbound: entry.outbound, authority: entry.authority };
        this._narrow(entry, override, warnings);
        if (OUTBOUND_RANK[entry.outbound] < OUTBOUND_RANK[floor.outbound]) entry.outbound = floor.outbound;
        if ((AUTHORITY_RANK[entry.authority] ?? 0) < (AUTHORITY_RANK[floor.authority] ?? 0)) entry.authority = floor.authority;
      }
    }
    this._floors(entry, warnings);
    entry.warnings = warnings;
    return entry;
  }

  list({ caseId = null } = {}) {
    return this.ids().map((id) => {
      try {
        return publicEntry(this._resolve(id, caseId));
      } catch (err) {
        return { id, available: false, reason: err.message, warnings: [] };
      }
    });
  }

  get(id, { caseId = null } = {}) {
    try {
      const e = this._resolve(id, caseId);
      return e ? publicEntry(e) : null;
    } catch (err) {
      return { id, available: false, reason: err.message, warnings: [] };
    }
  }

  async adapter(id) {
    const entry = this._resolve(id, null);
    if (!entry) throw new ExecutorUnavailableError(id, 'not a known executor');
    if (entry.kind !== 'external-agent') throw new ExecutorUnavailableError(id, 'only external-agent executors have an adapter');
    if (!entry.available) throw new ExecutorUnavailableError(id, entry.reason);
    // The package hash plus a hash of the resolved config, so a rotated vault
    // secret or a changed baseUrl loads a new adapter. The key holds digests
    // only, never a config value.
    const key = `${entry._checked.computed}:${sha256hex(JSON.stringify(entry._checked.config || {}))}`;
    const cached = this._adapters.get(id);
    if (cached && cached.key === key) return cached.promise;
    const promise = loadAdapter(entry._checked, {
      id, entry, requestTimeoutMs: this.settings().requestTimeoutMs, fetchImpl: this.fetchImpl, now: this.now
    }).then(({ adapter }) => {
      this._loaded.set(id, adapter);
      return adapter;
    }).catch((err) => {
      if (this._adapters.get(id)?.promise === promise) this._adapters.delete(id);
      throw err instanceof ExecutorUnavailableError ? err : new ExecutorUnavailableError(id, err.message);
    });
    this._adapters.set(id, { key, promise });
    return promise;
  }

  // Adapter rules (once loaded), then the case override, then extra sources (C6, R18).
  briefRules(id, { caseId = null } = {}) {
    const out = [];
    const push = (r) => {
      const t = String(r ?? '').trim();
      if (t && !out.includes(t)) out.push(t);
    };
    const adapter = this._loaded.get(id);
    if (adapter) {
      try {
        const rules = adapter.briefRules();
        if (Array.isArray(rules)) rules.forEach(push);
      } catch (err) {
        log.warn(`${id} briefRules failed: ${err.message}`);
      }
    }
    let entry = null;
    try {
      entry = this._resolve(id, caseId);
    } catch {
      entry = null;
    }
    (entry?.overrideBriefRules || []).forEach(push);
    for (const fn of this.extraBriefRules) {
      try {
        const rules = fn(id, caseId);
        if (Array.isArray(rules)) rules.forEach(push);
      } catch (err) {
        log.warn(`Extra brief rules for ${id} failed: ${err.message}`);
      }
    }
    return out;
  }

  registerExtraBriefRules(fn) {
    if (typeof fn !== 'function') throw new TypeError('registerExtraBriefRules needs a function (executorId, caseId) → string[].');
    this.extraBriefRules.push(fn);
  }

  // ---- The global daily cap: <dataDir>/executors/usage.json ----

  _capTimeZone(entry) {
    return pickTimeZone(entry?.constraints?.callingWindow?.tz, this.casesTimeZone());
  }

  _readObject(file) {
    const v = readJsonSafe(file, {});
    return isObject(v) ? v : {};
  }

  _capLimit(entry) {
    return Number.isInteger(entry?.constraints?.contactsPerDay) ? entry.constraints.contactsPerDay : null;
  }

  // Today's usage record for an executor, or null when there is none. A
  // record stays current until its own local day ends in the zone it was
  // opened in; only a new record adopts the configured zone. So changing the
  // zone mid-day (the data dir decides it) never resets the count. Counts read
  // from the file are coerced to whole numbers of 0 or more.
  _currentUsage(rec) {
    if (!isObject(rec) || !DAY_PATTERN.test(String(rec.day)) || !validTimeZone(rec.tz)) return null;
    if (localDate(this.now(), rec.tz) !== rec.day) return null;
    const count = (v) => {
      const x = Number(v);
      return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
    };
    const byCase = {};
    if (isObject(rec.byCase)) for (const [k, v] of Object.entries(rec.byCase)) byCase[k] = count(v);
    return { day: rec.day, tz: rec.tz, limit: Number.isInteger(rec.limit) ? rec.limit : null, used: count(rec.used), byCase };
  }

  async reserveContacts(id, n, { caseId = null } = {}) {
    const entry = this._resolve(id, null);
    if (!entry) return { ok: false, used: 0, limit: null, day: null, error: 'not a known executor' };
    const limit = this._capLimit(entry);
    const count = Number(n);
    if (!Number.isFinite(count)) {
      return { ok: false, used: 0, limit, day: null, error: 'the number of contacts to reserve must be a finite number' };
    }
    const add = Math.max(0, Math.floor(count));
    return this.mutex.run('usage', async () => {
      const data = this._readObject(this.usagePath);
      const tz = this._capTimeZone(entry);
      const rec = this._currentUsage(data[id]) || { day: localDate(this.now(), tz), tz, limit, used: 0, byCase: {} };
      rec.limit = limit;
      if (limit !== null && rec.used + add > limit) {
        const cases = Object.values(rec.byCase).filter((v) => v > 0).length;
        return {
          ok: false, used: rec.used, limit, day: rec.day,
          error: `${id} daily cap ${limit} reached (used by ${cases} case${cases === 1 ? '' : 's'}); resets ${addDays(rec.day, 1)} 00:00 ${rec.tz}`
        };
      }
      const key = caseId || 'none';
      rec.used += add;
      rec.byCase[key] = (rec.byCase[key] || 0) + add;
      data[id] = rec;
      writeJsonAtomic(this.usagePath, data);
      return { ok: true, used: rec.used, limit, day: rec.day };
    });
  }

  async releaseContacts(id, n, { caseId = null } = {}) {
    const count = Number(n);
    const sub = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    return this.mutex.run('usage', async () => {
      const data = this._readObject(this.usagePath);
      const rec = this._currentUsage(data[id]);
      if (!rec || !sub) return { ok: true, released: 0 };
      const key = caseId || 'none';
      const take = Math.min(sub, rec.byCase[key] || 0, rec.used);
      rec.used -= take;
      rec.byCase[key] = (rec.byCase[key] || 0) - take;
      data[id] = rec;
      writeJsonAtomic(this.usagePath, data);
      return { ok: true, released: take };
    });
  }

  globalRemaining(id) {
    const entry = this._resolve(id, null);
    const limit = this._capLimit(entry);
    if (limit === null) return null;
    const rec = this._currentUsage(this._readObject(this.usagePath)[id]);
    if (!rec) return limit;
    return Math.max(0, limit - rec.used);
  }

  // ---- Jobs ----

  caseDir(caseId) {
    return this.caseRuntime.getCase(caseId).dir;
  }

  jobs(caseId) {
    return new JobStore(this.caseDir(caseId));
  }

  // <dataDir>/executors/jobs.json: "<caseId>/<jobId>" → the live row (spec §4).
  async indexJob(caseId, job) {
    return this.mutex.run('jobs', async () => {
      const data = this._readObject(this.jobsPath);
      data[`${caseId}/${job.id}`] = {
        executor: job.executor,
        externalId: job.externalId || null,
        state: job.state,
        signature: job.signature || null,
        intent: job.intent || '',
        recipients: Array.isArray(job.recipients) ? job.recipients : [],
        lastChange: job.lastChange || null
      };
      writeJsonAtomic(this.jobsPath, data);
    });
  }

  // The execute extras a case workflow's children run with, rebuilt from the
  // jobs index (under the guarded executors folder), never from the workflow
  // file: isolated case-researcher children, guarded for that case, confined
  // to the researcher's tools. null for a workflow no case job started.
  workflowChildExtras(workflowId) {
    if (typeof workflowId !== 'string' || !workflowId) return null;
    for (const [key, row] of Object.entries(this._readObject(this.jobsPath))) {
      if (!isObject(row) || row.executor !== 'workflow' || row.externalId !== workflowId) continue;
      return {
        isolatedContext: true,
        guardContext: { caseId: key.slice(0, key.lastIndexOf('/')) },
        allowedToolNames: [...CaseResearcherAgent.allowedTools]
      };
    }
    return null;
  }

  liveState({ caseId = null } = {}) {
    return Object.entries(this._readObject(this.jobsPath))
      .filter(([, row]) => isObject(row))
      .map(([key, row]) => {
        const i = key.lastIndexOf('/');
        return {
          jobId: key.slice(i + 1),
          executorId: row.executor,
          signature: row.signature || null,
          state: row.state,
          caseId: key.slice(0, i),
          intent: row.intent || '',
          recipients: Array.isArray(row.recipients) ? row.recipients : []
        };
      })
      .filter((r) => OPEN_STATES.includes(r.state) && (!caseId || r.caseId === caseId));
  }

  // ---- Job lifecycle (Task 9) ----

  refreshCase(caseId, opts = {}) {
    return jobs.refreshCase(this, caseId, opts);
  }

  pollWakeup(caseId, wakeup, options = {}) {
    return jobs.pollWakeup(this, caseId, wakeup, options);
  }

  // Final review I3: C2's sweep calls this before it takes the case lock;
  // the result goes to pollWakeup as { prefetched }. null: nothing is due.
  async prefetchPolls(caseId, now = this.now()) {
    const rt = this.caseRuntime;
    const status = rt.getCase(caseId).status;
    if (!['active', 'needs-direction'].includes(status)) return null;
    const due = rt.wakeups(caseId).due(now).filter((w) => w.kind === 'poll-executor');
    if (!due.length) return null;
    return jobs.prefetchPolls(this, caseId, due, now);
  }

  cancelOpenJobs(caseId, reason) {
    return jobs.cancelOpenJobs(this, caseId, reason);
  }

  // The owner's cancel (IPC): runs in systemAction.
  cancelJob(caseId, jobId, reason) {
    return jobs.cancelJobAsOwner(this, caseId, jobId, reason);
  }

  // ---- Envelopes and the turn-start hook (Task 10) ----

  // IPC case:revokeEnvelope and C4's conflict follow-up; runs in systemAction.
  revokeEnvelope(caseId, envelopeId, reason) {
    return envelopeOps.revokeEnvelope(this, caseId, envelopeId, reason);
  }

  // Registered as caseRuntime.addTurnStartHook('executors', …) by createCore.
  turnStartHook(ctx) {
    return turnHook.turnStartHook(this, ctx);
  }

  // The signing trust for verifySignedGrant; each part null when absent.
  approvalTrust() {
    let t = null;
    try {
      t = this.getApprovalTrust();
    } catch (err) {
      log.warn(`Reading the approval trust failed: ${err.message}`);
    }
    return {
      approverStore: isObject(t?.approverStore) ? t.approverStore : null,
      nodeId: typeof t?.nodeId === 'string' && t.nodeId ? t.nodeId : null,
      nodePublicKey: t?.nodePublicKey || null
    };
  }

  // ---- Ops memory (Task 12) ----

  get opsMemory() {
    if (!this._opsMemory) {
      this._opsMemory = new OpsMemory(this.dataDir, {
        now: this.now,
        resolveFacts: (caseId) => this.caseRuntime.ledger(caseId).view().facts,
        resolveFact: (caseId, factId) => this.caseRuntime.ledger(caseId).view().facts.get(factId) || null
      });
    }
    return this._opsMemory;
  }

  // Keys: the executors themselves and the origins of their baseUrl.
  opsNotes(caseId, executorIds = []) {
    const keys = new Set(executorIds);
    const configured = this._configured();
    for (const id of executorIds) {
      try {
        const base = configured[id]?.config?.baseUrl;
        if (base) keys.add(new URL(base).origin);
      } catch {
        // not a URL
      }
    }
    return renderOpsNotes(this.opsMemory.entriesFor([...keys], { max: this.settings().opsMemory.maxEntries, excludeCaseId: caseId }));
  }

  // ---- operations (Task 13 adds none; the tools call the modules directly) ----
}

module.exports = { ExecutorRegistry, intersectWindow, AUTHORITY_RANK };
