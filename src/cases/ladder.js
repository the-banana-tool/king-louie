// src/cases/ladder.js
// The contact ladder (cases stage 4 spec §3.6, §3.7): its own tick, no model
// turn, no case lock for delivery, batching across cases. Every step is
// persisted before it acts. One process per cases root runs it (the lease
// <casesRoot>/.contact.lock); any other process stays passive.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ContactState } = require('./contact-state');
const { writeAtomic } = require('./jsonfile');
const { effectivePolicy, resolveSteps, formatShort } = require('./contact-format');
const { localDay } = require('./clock');
const { wallHhmm } = require('./presence');
const { ContactDeliveryError } = require('../channels/channel-plugin');
const { createLogger } = require('../logging');

const MINUTE = 60 * 1000;
const DAY = 24 * 3600 * 1000;
const ASYNC_FAILURES = new Set(['failed', 'bounced', 'no-answer', 'busy']);
const CLOSED_CASE = new Set(['done', 'abandoned']);
const LOCK_FILE = '.contact.lock';

const iso = (ms) => new Date(ms).toISOString();
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

class LadderEngine {
  constructor({
    state, casesRoot, runtime, router, presence, getPolicy = () => ({}), clock = () => new Date(), tickMs = 30000,
    dataDir = null, hostName = os.hostname(), log = createLogger('contact/ladder')
  } = {}) {
    this.state = state;
    this.casesRoot = casesRoot;
    this.runtime = runtime;
    this.router = router;
    this.presence = presence;
    this.getPolicy = getPolicy;
    this.clock = clock;
    this.tickMs = tickMs;
    this.dataDir = dataDir || path.dirname(state.dir);
    this.hostName = hostName;
    this.log = log;
    this.active = false;
    this.holder = null;
    this.timer = null;
    this.inflight = null;
    this.recovered = false;
    this.notConfiguredLogged = new Set();
    this.warned = new Set();
  }

  // ---- The cases-root lease ----

  lockPath() {
    return path.join(this.casesRoot, LOCK_FILE);
  }

  _lease() {
    return { pid: process.pid, host: this.hostName, dataDir: this.dataDir, heartbeatAt: this.clock().toISOString() };
  }

  // null: no lock file. A lock file that exists but does not parse (a torn
  // or corrupt write) is { unreadable: true, mtimeMs }: it is held until it
  // is as old as a stale heartbeat (final review M3), never a free lease.
  _readLock() {
    let text;
    try {
      text = fs.readFileSync(this.lockPath(), 'utf8');
    } catch {
      return null;
    }
    try {
      const lock = JSON.parse(text);
      if (lock && typeof lock === 'object' && !Array.isArray(lock)) return lock;
    } catch {
      // fall through
    }
    let mtimeMs = Date.now();
    try {
      mtimeMs = fs.statSync(this.lockPath()).mtimeMs;
    } catch {
      // gone since the read: treat as just written
    }
    return { unreadable: true, mtimeMs };
  }

  _writeLock() {
    writeAtomic(this.lockPath(), JSON.stringify(this._lease()));
  }

  _mine(lock) {
    return Boolean(lock && lock.pid === process.pid && lock.host === this.hostName && lock.dataDir === this.dataDir);
  }

  // true when this process holds the lease. Taking over a stale lease
  // writes it and returns false; the next call returns true only if the
  // lock still names this process (two contenders: the last writer wins).
  tryAcquire() {
    // No cases root yet means no cases: nothing to ladder, and nothing is
    // created on disk until the first case is (CaseRuntime's rule).
    if (!fs.existsSync(this.casesRoot)) {
      this.active = false;
      this.holder = null;
      return false;
    }
    try {
      const fd = fs.openSync(this.lockPath(), 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(this._lease()));
      } finally {
        fs.closeSync(fd);
      }
      return this._becomeActive();
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const held = this._readLock();
    if (this._mine(held)) return this._becomeActive();
    const stale = held?.unreadable
      ? Date.now() - held.mtimeMs > 3 * this.tickMs
      : (() => {
        const beat = Date.parse(held?.heartbeatAt);
        return !held || !Number.isFinite(beat) || this.clock().getTime() - beat > 3 * this.tickMs;
      })();
    if (held?.unreadable && !stale) {
      this._warnOnce('lock-unreadable', `the contact ladder lease ${this.lockPath()} is unreadable; waiting until it is stale before taking it over`);
      this.active = false;
      this.holder = { host: 'unknown', pid: null, unreadable: true };
      return false;
    }
    if (stale) {
      this.log.warn(`taking over a stale contact ladder lease${held && !held.unreadable ? ` from ${held.host}:${held.pid}` : ''}`);
      this._writeLock();
      this.active = false;
      this.holder = null;
      return false;
    }
    if (!this.holder || this.holder.pid !== held.pid || this.holder.host !== held.host) {
      this.log.info(`contact ladder runs in ${held.host}:${held.pid}`);
    }
    this.active = false;
    this.holder = held;
    return false;
  }

  _becomeActive() {
    // Final review M3: a lease regained after losing it recovers in-flight
    // attempts again on the next tick.
    if (!this.active) this.recovered = false;
    this.active = true;
    this.holder = null;
    return true;
  }

  // False when another process now holds the lease (no lock file: nobody
  // else does, as when a test drives tick() directly).
  _stillLeased() {
    const held = this._readLock();
    if (!held || this._mine(held)) return true;
    if (this.active) this.log.warn(`lost the contact ladder lease to ${held.host}:${held.pid}; stopping delivery`);
    this.active = false;
    this.holder = held;
    return false;
  }

  // One warning per distinct failure, not one per tick.
  _warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log.warn(message);
  }

  _heartbeat() {
    const held = this._readLock();
    if (!this._mine(held)) {
      this.active = false;
      this.holder = held;
      return false;
    }
    this._writeLock();
    return true;
  }

  start() {
    this.tryAcquire();
    if (this.timer) return;
    this.timer = setInterval(() => {
      let ok;
      try {
        ok = this.active ? this._heartbeat() : this.tryAcquire();
      } catch (err) {
        // A lease I/O error must not escape the interval (it would crash the host).
        this.log.warn(`contact ladder lease check failed: ${err.message}`);
        return;
      }
      if (!ok || this.inflight) return;
      this.inflight = this.tick()
        .catch((err) => this.log.warn(`contact ladder tick failed: ${err.message}`))
        .finally(() => { this.inflight = null; });
    }, this.tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inflight) await this.inflight;
    if (this.active && this._mine(this._readLock())) fs.rmSync(this.lockPath(), { force: true });
    this.active = false;
  }

  status() {
    return this.active ? { runsHere: true } : { runsHere: false, holder: this.holder };
  }

  // ---- Helpers ----

  policy() {
    return effectivePolicy(this.getPolicy());
  }

  resolveSteps(urgency, caseMeta) {
    return resolveSteps(this.policy(), urgency, caseMeta?.channels || null);
  }

  _nominal(entry, i, policy) {
    const step = entry.steps[i];
    if (!step) return Infinity;
    return Date.parse(entry.startedAt) + Math.max(step.afterMin * MINUTE, policy.batchDelaySec * 1000);
  }

  _advance(entry, policy, { now = null } = {}) {
    entry.step += 1;
    entry.nextAt = now !== null ? iso(now) : (entry.step < entry.steps.length ? iso(this._nominal(entry, entry.step, policy)) : null);
    entry.quietDeferred = false;
  }

  // A step quiet hours held back went out late; the next one keeps its gap
  // from it (an SMS must not follow the deferred Telegram seconds later).
  _keepSpacing(e, sentMs) {
    if (e.step >= e.steps.length) return;
    const gap = (e.steps[e.step].afterMin - e.steps[e.step - 1].afterMin) * MINUTE;
    e.nextAt = iso(Math.max(Date.parse(e.nextAt), sentMs + Math.max(gap, 0)));
  }

  // 8. A briefing (never has options) stops after its first sent step.
  _afterSent(entry) {
    if (entry.kind === 'briefing') entry.stopped = true;
  }

  _attempt(entry, fields) {
    const a = { step: entry.step, at: this.clock().toISOString(), mirrored: true, ...fields };
    entry.attempts.push(a);
    return a;
  }

  _record(caseId, questionId) {
    try {
      return this.runtime.questions(caseId).get(questionId);
    } catch {
      return null;
    }
  }

  async _journal(caseId, label, text, now) {
    await this.runtime.systemAction(caseId, label, () => this.runtime.records(caseId).writeJournal('question', text, now));
  }

  // ---- The tick ----

  async tick(now = this.clock()) {
    const nowMs = now.getTime();
    const policy = this.policy();
    const ladder = this.state.ladder();
    const result = { delivered: 0, failed: 0, exhausted: 0 };
    if (!this.recovered) {
      this.recovered = true;
      await this._recover(policy, nowMs);
    }
    await this.router.drainInbox();

    const cases = new Map();
    for (const c of this.runtime.listCases()) cases.set(c.id, c);

    // 1. Scan: enqueue every open record without an entry.
    for (const c of cases.values()) {
      if (CLOSED_CASE.has(c.status)) continue;
      let open;
      try {
        open = this.runtime.questions(c.id).open();
      } catch (err) {
        // One unreadable case must not starve the others.
        this._warnOnce(`scan|${c.id}|${err.message}`, `contact ladder: cannot read the questions of case ${c.id}: ${err.message}`);
        continue;
      }
      for (const rec of open) {
        const key = `${c.id}/${rec.id}`;
        if (ladder.entries[key]) continue;
        const pinned = this.state.takePin(key);
        const steps = pinned ? [{ channel: pinned, afterMin: 0, digest: false }] : this.resolveSteps(rec.urgency, c);
        const startedAt = rec.createdAt;
        ladder.entries[key] = {
          caseId: c.id, questionId: rec.id, kind: rec.kind, urgency: rec.urgency, token: this.state.newToken(),
          startedAt, step: 0, nextAt: iso(Date.parse(startedAt) + policy.batchDelaySec * 1000), pinnedChannel: pinned,
          steps, expired: false, exhausted: false, exhaustJournaled: false, stopped: false, quietDeferred: false, heldJournaled: false, attempts: []
        };
      }
    }
    this.state.saveLadder();

    // 2. Retire and expire.
    const retiring = [];
    for (const [key, e] of Object.entries(ladder.entries)) {
      const c = cases.get(e.caseId);
      const rec = c ? this._record(e.caseId, e.questionId) : null;
      if (!c || CLOSED_CASE.has(c.status) || !rec || rec.answer || rec.closed) {
        retiring.push(key);
        continue;
      }
      if (!e.expired && rec.expiresAt && Date.parse(rec.expiresAt) <= nowMs) e.expired = true;
    }

    // 6 (async). A later relay failure or DSN on the entry's latest attempt.
    const deliveries = this.state.deliveries();
    for (const e of Object.values(ladder.entries)) {
      const last = e.attempts[e.attempts.length - 1];
      const d = last && last.outcome === 'sent' && last.deliveryId ? deliveries[last.deliveryId] : null;
      if (d && ASYNC_FAILURES.has(d.status)) {
        last.outcome = 'failed';
        last.error = { code: d.status, message: d.error || d.status };
        if (!e.expired && !e.stopped) e.nextAt = iso(nowMs);
        result.failed += 1;
      }
    }

    // 3–5. Resolve due steps and group deliveries by channel.
    const groups = new Map();
    const journals = [];
    for (const e of Object.values(ladder.entries)) {
      if (retiring.includes(`${e.caseId}/${e.questionId}`) || e.expired || e.exhausted || e.stopped) continue;
      this._collapse(e, policy, nowMs);
      for (let guard = 0; guard <= e.steps.length && e.step < e.steps.length && Date.parse(e.nextAt) <= nowMs; guard += 1) {
        const r = this._resolve(e, policy, nowMs);
        if (r.kind === 'next') continue;
        if (r.kind === 'deliver') {
          if (!groups.has(r.channel)) groups.set(r.channel, []);
          groups.get(r.channel).push(e);
        } else if (r.kind === 'journal') {
          journals.push(e);
        }
        break;
      }
    }

    for (const e of journals) {
      const rec = this._record(e.caseId, e.questionId);
      try {
        await this._journal(e.caseId, `contact: ${e.questionId} waiting`, `${e.questionId} waiting: ${rec ? rec.text : ''}`, now);
        this._attempt(e, { channel: 'journal', outcome: 'sent' });
        this._advance(e, policy);
        this._afterSent(e);
      } catch (err) {
        if (err.code === 'CASE_BUSY') continue;
        // Like a failed send: record it and move to the next step.
        this._attempt(e, { channel: 'journal', outcome: 'failed', error: { code: err.code || 'error', message: err.message } });
        this._advance(e, policy, { now: nowMs });
        this.log.warn(`contact ladder: journaling ${e.caseId}/${e.questionId} failed: ${err.message}`);
      }
    }

    // Quiet hours: one "held until" journal line per deferred step, retried
    // while the case is busy.
    for (const e of Object.values(ladder.entries)) {
      if (!e.quietDeferred || e.heldJournaled || e.expired || e.stopped || retiring.includes(`${e.caseId}/${e.questionId}`)) continue;
      const rec = this._record(e.caseId, e.questionId);
      const until = formatShort(e.nextAt, this.presence.timeZone());
      try {
        await this._journal(e.caseId, `contact: ${e.questionId} held until ${until}`, `${e.questionId} held until ${until} (quiet hours): ${rec ? rec.text : ''}`, now);
        e.heldJournaled = true;
      } catch (err) {
        if (err.code !== 'CASE_BUSY') this._warnOnce(`held|${e.caseId}/${e.questionId}|${err.message}`, `contact ladder: journaling the quiet-hours hold of ${e.caseId}/${e.questionId} failed: ${err.message}`);
      }
    }

    for (const [channel, entries] of groups) {
      const r = await this._deliver(channel, entries, policy, now);
      result.delivered += r.delivered;
      result.failed += r.failed;
    }

    // 7. Exhaust.
    for (const e of Object.values(ladder.entries)) {
      if (retiring.includes(`${e.caseId}/${e.questionId}`) || e.expired || e.stopped || e.step < e.steps.length) continue;
      if (!e.exhausted) {
        e.exhausted = true;
        result.exhausted += 1;
      }
      if (!e.exhaustJournaled) {
        const tried = e.attempts.map((a) => `${a.channel} ${a.outcome}${a.error ? ` (${a.error.code})` : ''}${a.reason ? ` (${a.reason})` : ''}`).join(', ') || 'no channel';
        try {
          await this._journal(e.caseId, `contact: ladder exhausted for ${e.questionId}`, `Ladder exhausted for ${e.questionId}: tried ${tried}. The question stays open.`, now);
          e.exhaustJournaled = true;
        } catch (err) {
          if (err.code !== 'CASE_BUSY') this._warnOnce(`exhaust|${e.caseId}/${e.questionId}|${err.message}`, `contact ladder: journaling the exhausted ladder of ${e.caseId}/${e.questionId} failed: ${err.message}`);
        }
      }
    }
    this.state.saveLadder();

    await this._digest(policy, now, retiring);
    await this._mirror();

    for (const key of retiring) delete ladder.entries[key];
    this.state.saveLadder();
    this.state.pruneDeliveries((caseId, questionId) => {
      const rec = cases.has(caseId) ? this._record(caseId, questionId) : null;
      return Boolean(rec && !rec.answer && !rec.closed);
    });
    return result;
  }

  // 3. After downtime only the latest due step fires; earlier ones are
  // skipped. A step held back by quiet hours is not downtime: it fires.
  _collapse(e, policy, nowMs) {
    if (e.quietDeferred || Date.parse(e.nextAt) > nowMs) return;
    let latest = e.step;
    for (let j = e.step + 1; j < e.steps.length; j += 1) {
      const t = this._nominal(e, j, policy);
      if (t <= nowMs && t > this._nominal(e, e.step, policy)) latest = j;
    }
    while (e.step < latest) {
      this._attempt(e, { channel: e.steps[e.step].channel, outcome: 'skipped', reason: 'overdue' });
      e.step += 1;
    }
  }

  // 4. What the due step does now: { kind: 'next' | 'deliver' | 'journal' | 'wait', channel }.
  _resolve(e, policy, nowMs) {
    const step = e.steps[e.step];
    let channel = step.channel;
    const awayActive = policy.away && Date.parse(policy.away.until) > nowMs;
    if (awayActive && channel !== 'journal' && channel !== 'present') channel = policy.away.mode === 'email-only' ? 'email' : 'in-app';
    if (channel === 'present') {
      const present = this.presence.presentChannel(new Date(nowMs));
      if (!present) {
        this._attempt(e, { channel: 'present', outcome: 'absent' });
        this._advance(e, policy);
        return { kind: 'next' };
      }
      channel = present;
    }
    if (channel === 'journal') return { kind: 'journal' };
    if (step.digest) return { kind: 'wait' };

    const status = this.router.channelStatus(channel);
    if (!status.configured) {
      const day = localDay(new Date(nowMs), this.presence.timeZone());
      if (!this.notConfiguredLogged.has(`${channel}|${day}`)) {
        this.notConfiguredLogged.add(`${channel}|${day}`);
        this.log.info(`contact channel ${channel} is not configured; skipping it (${status.reason})`);
      }
      this._attempt(e, { channel, outcome: 'skipped', reason: 'not-configured' });
      this._advance(e, policy, { now: nowMs });
      return { kind: 'next' };
    }

    const rec = this._record(e.caseId, e.questionId);
    let resurface = false;
    if (channel === 'in-app' && rec) {
      const inApp = (rec.deliveries || []).filter((d) => d.channel === 'in-app').map((d) => Date.parse(d.at)).filter(Number.isFinite);
      const since = this.presence.desktopPresentSince();
      if (inApp.length) {
        resurface = Boolean(since && Math.max(...inApp) < since.getTime());
        if (!resurface) {
          if (e.attempts.some((a) => a.channel === 'in-app' && a.outcome === 'sent')) {
            this._attempt(e, { channel, outcome: 'skipped', reason: 'duplicate' });
            this._advance(e, policy, { now: nowMs });
          } else {
            // Stage 2 already showed it in the window: sent without sending.
            this._attempt(e, { channel, outcome: 'sent', deliveryId: `in-app-${e.questionId}` });
            this._advance(e, policy);
            this._afterSent(e);
          }
          return { kind: 'next' };
        }
      }
    }
    if (!resurface && e.attempts.some((a) => a.channel === channel && a.outcome === 'sent')) {
      this._attempt(e, { channel, outcome: 'skipped', reason: 'duplicate' });
      this._advance(e, policy, { now: nowMs });
      return { kind: 'next' };
    }

    const caps = this.router.adapter(channel)?.contactCapabilities() || {};
    const quiet = policy.quietHours;
    if (caps.interrupts && quiet && !quiet.breakthrough.includes(e.urgency) && this.presence.inQuietHours(new Date(nowMs))) {
      if (!e.quietDeferred) {
        e.nextAt = this.presence.nextQuietEnd(new Date(nowMs)).toISOString();
        e.quietDeferred = true;
        e.heldJournaled = false;
        return { kind: 'wait' };
      }
    }
    e.resolvedChannel = channel;
    return { kind: 'deliver', channel };
  }

  _item(e) {
    const rec = this._record(e.caseId, e.questionId);
    let caseTitle = e.caseId;
    try {
      caseTitle = this.runtime.getCase(e.caseId).title;
    } catch {
      // A case removed mid-tick keeps its id as the title.
    }
    return rec ? { caseId: e.caseId, caseTitle, token: e.token, record: rec } : null;
  }

  // 5–6. One router.deliver per channel; every attempt is saved inFlight first.
  async _deliver(channel, entries, policy, now) {
    const out = { delivered: 0, failed: 0 };
    const items = entries.map((e) => this._item(e)).filter(Boolean);
    if (!items.length || !this._stillLeased()) return out;
    const deliveryId = this.state.newDeliveryId();
    const batchToken = this.state.newToken();
    for (const e of entries) this._attempt(e, { channel, outcome: 'inFlight', deliveryId, batchToken, idempotencyKey: deliveryId, mirrored: false });
    this.state.saveLadder();
    try {
      await this.router.deliver(channel, items, { deliveryId, batchToken });
      const sentMs = this.clock().getTime();
      for (const e of entries) {
        const a = e.attempts[e.attempts.length - 1];
        a.outcome = 'sent';
        const deferred = e.quietDeferred;
        this._advance(e, policy);
        if (deferred) this._keepSpacing(e, sentMs);
        this._afterSent(e);
      }
      out.delivered += entries.length;
    } catch (err) {
      const error = err instanceof ContactDeliveryError ? { code: err.code, message: err.message } : { code: 'unreachable', message: err.message };
      for (const e of entries) {
        const a = e.attempts[e.attempts.length - 1];
        a.outcome = 'failed';
        a.error = error;
        a.mirrored = true;
        this._advance(e, policy, { now: now.getTime() });
      }
      out.failed += entries.length;
      this.log.warn(`contact delivery on ${channel} failed: ${error.code}: ${error.message}`);
    }
    this.state.saveLadder();
    return out;
  }

  // Restarts: an inFlight relay attempt is re-sent with the same key; any
  // other inFlight attempt becomes unknown and the entry advances.
  async _recover(policy, nowMs) {
    const byDelivery = new Map();
    for (const e of Object.values(this.state.ladder().entries)) {
      const a = e.attempts[e.attempts.length - 1];
      if (!a || a.outcome !== 'inFlight') continue;
      if (!byDelivery.has(a.deliveryId)) byDelivery.set(a.deliveryId, { channel: a.channel, batchToken: a.batchToken, entries: [] });
      byDelivery.get(a.deliveryId).entries.push(e);
    }
    for (const [deliveryId, g] of byDelivery) {
      if (!this._stillLeased()) return;
      const caps = this.router.adapter(g.channel)?.contactCapabilities() || {};
      if (caps.idempotentSend) {
        const items = g.entries.map((e) => this._item(e)).filter(Boolean);
        try {
          await this.router.deliver(g.channel, items, { deliveryId, batchToken: g.batchToken });
          for (const e of g.entries) {
            e.attempts[e.attempts.length - 1].outcome = 'sent';
            e.step += 1;
            e.nextAt = e.step < e.steps.length ? iso(this._nominal(e, e.step, policy)) : null;
          }
          continue;
        } catch (err) {
          this.log.warn(`re-sending ${deliveryId} on ${g.channel} failed: ${err.message}`);
        }
      }
      for (const e of g.entries) {
        const a = e.attempts[e.attempts.length - 1];
        a.outcome = 'unknown';
        a.mirrored = true;
        e.step += 1;
        e.nextAt = iso(nowMs);
      }
    }
    this.state.saveLadder();
  }

  // 3.7. One delivery a day at digest.at (owner zone), late if the process was down.
  async _digest(policy, now, retiring) {
    const d = policy.digest;
    if (!d) return;
    const ladder = this.state.ladder();
    const tz = this.presence.timeZone();
    const today = localDay(now, tz);
    if (ladder.digest.lastSentDay && ladder.digest.lastSentDay >= today) return;
    if (wallHhmm(now, tz) < d.at) return;
    const caps = this.router.adapter(d.channel)?.contactCapabilities() || {};
    if (caps.interrupts && this.presence.inQuietHours(now)) return;
    const nowMs = now.getTime();
    const entries = Object.values(ladder.entries).filter((e) => !retiring.includes(`${e.caseId}/${e.questionId}`) && !e.expired && (
      (e.steps[e.step]?.digest && Date.parse(e.nextAt) <= nowMs)
      || e.exhausted
      || (e.kind === 'briefing' && nowMs - Date.parse(e.startedAt) <= DAY)
    ));
    ladder.digest.lastSentDay = today;
    this.state.saveLadder();
    if (!entries.length) return;
    if (!this.router.channelStatus(d.channel).configured) {
      this.log.info(`the daily digest channel ${d.channel} is not configured; no digest today`);
      return;
    }
    const items = entries.map((e) => this._item(e)).filter(Boolean);
    if (!this._stillLeased()) return;
    const deliveryId = this.state.newDeliveryId();
    try {
      await this.router.deliver(d.channel, items, { deliveryId });
      for (const e of entries) this._attempt(e, { channel: d.channel, outcome: 'sent', deliveryId, digest: true, mirrored: false });
    } catch (err) {
      this.log.warn(`the daily digest on ${d.channel} failed: ${err.message}`);
    }
    this.state.saveLadder();
  }

  // 9. Sent attempts go into the record's deliveries, one commit per case per tick.
  async _mirror() {
    const byCase = new Map();
    for (const e of Object.values(this.state.ladder().entries)) {
      for (const a of e.attempts) {
        if (a.mirrored || a.outcome !== 'sent' || !a.deliveryId) continue;
        if (!byCase.has(e.caseId)) byCase.set(e.caseId, []);
        byCase.get(e.caseId).push({ e, a });
      }
    }
    for (const [caseId, list] of byCase) {
      const qids = [...new Set(list.map((x) => x.e.questionId))].join(', ');
      const channels = [...new Set(list.map((x) => x.a.channel))].join(', ');
      try {
        await this.runtime.systemAction(caseId, `contact: delivered ${qids} via ${channels}`, () => {
          const store = this.runtime.questions(caseId);
          for (const { e, a } of list) {
            try {
              store.recordDelivery(e.questionId, { channel: a.channel, at: a.at, deliveryId: a.deliveryId });
            } catch (err) {
              if (err.code !== 'NOT_FOUND') throw err;
            }
          }
        });
        for (const { a } of list) a.mirrored = true;
      } catch (err) {
        // Retried next tick; one case's failure never blocks another's mirror.
        if (err.code !== 'CASE_BUSY' && err.code !== 'CASE_NOT_FOUND') this._warnOnce(`mirror|${caseId}|${err.message}`, `contact ladder: mirroring deliveries into case ${caseId} failed: ${err.message}`);
      }
    }
    this.state.saveLadder();
  }

  // contact:ladderState. A passive process reads the holder's files.
  list() {
    let ladder = this.state.ladder();
    // The lock is in the (agent-writable) cases root, so its dataDir is read
    // only when it is an absolute path whose contact/ folder exists (final
    // review M7), never an arbitrary relative or made-up path.
    const other = !this.active && this.holder && typeof this.holder.dataDir === 'string' ? this.holder.dataDir : null;
    if (other && other !== this.dataDir && path.isAbsolute(other) && isDir(path.join(other, 'contact'))) {
      ladder = new ContactState({ dir: path.join(other, 'contact'), readOnly: true }).ladder();
    }
    const out = {};
    for (const [key, e] of Object.entries(ladder.entries)) {
      out[key] = {
        step: e.step,
        nextAt: e.nextAt,
        nextChannel: e.steps[e.step]?.channel || null,
        expired: e.expired,
        exhausted: e.exhausted,
        attempts: e.attempts.map((a) => ({ channel: a.channel, at: a.at, outcome: a.outcome }))
      };
    }
    return out;
  }
}

module.exports = { LadderEngine, LOCK_FILE };
