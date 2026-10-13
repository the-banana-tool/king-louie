// src/gui/broker.js
// The service's view of the desktop (fleet stage 5 spec §3.5): whether the
// gui capability is up, what the helper may do, the screenshots a job may
// click on, and the one path every GUI op takes to the helper. All policy
// stays here; the helper only checks what each op carries.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { createLogger } = require('../logging');
const { GuiError } = require('./errors');
const { imageMatches, matchSetFor } = require('./apps');
const { realResolve } = require('../platform/path-roots');
const { writeGuiStatus } = require('./status');

const SCREENSHOTS_PER_JOB = 16;
const SCREENSHOT_TTL_MS = 10 * 60 * 1000;
const TITLE_MAX = 120;
const SUSPENDING_CODES = Object.freeze(['foreground_mismatch', 'app_not_running', 'helper_disconnected']);
const suspendsLease = (code) => SUSPENDING_CODES.includes(code);

// How long the service waits for one input op. A click or a key keeps the
// channel's default. Typed text takes as long as it is: a backend that
// presses keys one by one (xdotool waits 12 ms after each key event) needs
// far more than the default for 2000 characters, and a wait that ended
// first would report a refusal while the typing went on. The helper's own
// limit for the same text (x11.js) is shorter, so it stops typing and
// answers before this runs out.
const TYPE_BASE_MS = 15000;
const TYPE_PER_CHAR_MS = 60;
function inputTimeoutMs(action) {
  if (!action || action.kind !== 'type') return undefined;
  return TYPE_BASE_MS + TYPE_PER_CHAR_MS * Array.from(String(action.text || '')).length;
}

class GuiBroker extends EventEmitter {
  constructor({ channel, guiConfig, getPolicy = () => ({}), audit = null, dataDir = null, platform = process.platform, clock = Date.now,
    log = createLogger('gui/broker'), heartbeatMs = 10000, realpath = realResolve } = {}) {
    super();
    Object.assign(this, { channel, guiConfig, getPolicy, audit, dataDir, platform, clock, log, heartbeatMs, realpath });
    this.leases = null;
    // Both maps are per job and only for runs that have one (R-F5-7): a run
    // with no job id gets no entry, so such runs never share a bucket.
    this.shots = new Map(); // jobId → [{ screenshotId, appId, handle, transform, width, height, at, gen }]
    this.launched = new Map(); // jobId → Map(appId → Set(pid))
    this.nextShot = 1;
    this.displaysGen = 0;
    this.lockedFlag = false;
    this.listeners = [];
    this.off = null;
  }

  // The host could not start the GUI (index.js): from here on the capability
  // is unavailable for that reason, whatever the channel says, and every op
  // refuses with it. There is no way back but a restart.
  setUnavailable({ reason, detail, message }) {
    this.off = { reason, detail, message };
    this._changed();
  }

  setLeases(leases) {
    this.leases = leases;
  }

  start() {
    const on = (event, fn) => { this.channel.on(event, fn); this.listeners.push([event, fn]); };
    on('ready', (info) => { this.lockedFlag = Boolean(info && info.locked); this._changed(); });
    on('closed', () => { this.lockedFlag = false; if (this.leases) this.leases.onHelperDisconnected(); this._changed(); });
    on('event', (kind) => {
      if (kind === 'locked' || kind === 'unlocked') {
        this.lockedFlag = kind === 'locked';
        if (this.leases) this.leases.setLocked(this.lockedFlag);
      }
      if (kind === 'displays_changed') this.displaysGen += 1;
      this._changed();
    });
    this.heartbeat = setInterval(() => this._writeStatus(), this.heartbeatMs);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
    this._writeStatus();
  }

  stop() {
    for (const [event, fn] of this.listeners) this.channel.off(event, fn);
    this.listeners = [];
    clearInterval(this.heartbeat);
    this._writeStatus({ stopping: true });
  }

  get locked() {
    return this.lockedFlag;
  }

  appList() {
    return Object.values(this.guiConfig.apps).map((a) => ({ id: a.id, name: a.name }));
  }

  capability() {
    const info = !this.off && this.channel.connected ? this.channel.info : null;
    const available = Boolean(this.guiConfig.enabled && info);
    const lease = this.leases ? this.leases.statusSummary() : null;
    return {
      available,
      ...(this.off ? { reason: this.off.reason } : {}),
      capabilities: available ? [...info.capabilities] : [],
      user: info ? info.user : null,
      platform: info ? info.platform : null,
      since: info ? info.since : null,
      apps: this.appList(),
      limits: info ? [...info.limits] : [],
      locked: this.lockedFlag,
      lease
    };
  }

  require(sub) {
    if (this.off) throw new GuiError('capability_unavailable', `gui (${this.off.message})`);
    const cap = this.capability();
    if (!cap.available) throw new GuiError('capability_unavailable', 'gui');
    if (!cap.capabilities.includes(sub)) throw new GuiError('capability_unavailable', sub);
  }

  _changed() {
    this._writeStatus();
    this.emit('capability', this.capability());
  }

  leaseChanged() {
    this._changed();
  }

  _writeStatus({ stopping = false } = {}) {
    if (!this.dataDir) return;
    const cap = this.capability();
    const info = !this.off && this.channel.connected ? this.channel.info : null;
    try {
      writeGuiStatus(this.dataDir, {
        v: 1, pid: process.pid, available: stopping ? false : cap.available,
        ...(this.off ? { reason: this.off.reason, detail: this.off.detail } : {}), user: cap.user, platform: cap.platform,
        capabilities: cap.capabilities, probes: info ? info.probes : [], limits: cap.limits, apps: cap.apps, since: cap.since,
        updated_at: new Date(this.clock()).toISOString(),
        lease: cap.lease ? { active: cap.lease.active, app_ids: cap.lease.appIds, expires_at: cap.lease.expiresAt } : null
      });
    } catch (err) {
      this.log.warn(`status.json not written: ${err.message}`);
    }
  }

  _audit(kind, data) {
    if (!this.audit) return;
    Promise.resolve().then(() => this.audit.append({ kind, data })).catch((err) => this.log.warn(`audit ${kind} failed: ${err.message}`));
  }

  _app(appId) {
    const app = appId && Object.hasOwn(this.guiConfig.apps, appId) ? this.guiConfig.apps[appId] : null;
    if (!app) throw new GuiError('app_not_allowlisted', String(appId));
    return app;
  }

  _match(appIds) {
    return matchSetFor(this.guiConfig, appIds, { realpath: this.realpath });
  }

  async _pids(appIds, ctx = {}) {
    const found = await this.channel.request('processes', { match: this._match(appIds) }, { jobId: ctx.jobId || null });
    return (Array.isArray(found) ? found : []).filter((p) => Number.isInteger(p.pid));
  }

  async listApps(ctx) {
    this.require('gui.launch');
    const out = [];
    for (const app of Object.values(this.guiConfig.apps)) {
      const procs = await this._pids([app.id], ctx);
      const windows = procs.length ? await this.channel.request('windows', { pids: procs.map((p) => p.pid) }, { jobId: ctx.jobId }) : [];
      out.push({
        id: app.id, name: app.name, running: procs.length > 0,
        windows: (windows || []).map((w) => ({ title: String(w.title || '').slice(0, TITLE_MAX), minimized: w.minimized === true }))
      });
    }
    return out;
  }

  async launch(resolution, ctx, { approvedBy }) {
    this.require('gui.launch');
    const result = await this.channel.request('launch', { exe: resolution.exe, argv: resolution.argv, files: resolution.files }, { jobId: ctx.jobId, timeoutMs: 30000 });
    const pid = result && Number.isInteger(result.pid) ? result.pid : null;
    if (resolution.appId && pid !== null && ctx.jobId) {
      if (!this.launched.has(ctx.jobId)) this.launched.set(ctx.jobId, new Map());
      const byApp = this.launched.get(ctx.jobId);
      if (!byApp.has(resolution.appId)) byApp.set(resolution.appId, new Set());
      byApp.get(resolution.appId).add(pid);
    }
    this._audit('gui.launch', { job_id: ctx.jobId, app_id: resolution.appId, exe: resolution.exe, argv: [...resolution.argv, ...resolution.files], tier: resolution.tier, approved_by: approvedBy, pid });
    return { app_id: resolution.appId, pid, tier: resolution.tier, launched_at: new Date(this.clock()).toISOString() };
  }

  async close(appId, force, ctx) {
    this.require('gui.launch');
    this._app(appId);
    const pids = (await this._pids([appId], ctx)).map((p) => p.pid);
    const mine = (ctx.jobId && this.launched.get(ctx.jobId) && this.launched.get(ctx.jobId).get(appId)) || new Set();
    const forced = force ? pids.filter((p) => mine.has(p)) : [];
    const graceful = pids.filter((p) => !forced.includes(p));
    const closed = [];
    if (forced.length) closed.push(...((await this.channel.request('close', { pids: forced, force: true }, { jobId: ctx.jobId })).closed || []));
    if (graceful.length) closed.push(...((await this.channel.request('close', { pids: graceful, force: false }, { jobId: ctx.jobId })).closed || []));
    this._audit('gui.close', { job_id: ctx.jobId, app_id: appId, pids: closed });
    return { closed };
  }

  // The window to capture: the foreground one if it is the app's, else its
  // largest window that is not minimized.
  async _window(appId, ctx) {
    const procs = await this._pids([appId], ctx);
    if (procs.length === 0) throw new GuiError('app_not_running', appId);
    const pids = procs.map((p) => p.pid);
    const fg = await this.channel.request('foreground', {}, { jobId: ctx.jobId });
    const windows = (await this.channel.request('windows', { pids }, { jobId: ctx.jobId })) || [];
    if (fg && pids.includes(fg.pid)) {
      const w = windows.find((x) => x.handle === fg.handle);
      if (w && !w.minimized) return w;
    }
    const open = windows.filter((w) => !w.minimized);
    if (open.length === 0) throw new GuiError(windows.length ? 'window_minimized' : 'app_not_running', appId);
    const area = (w) => (w.bounds ? (w.bounds.w || 0) * (w.bounds.h || 0) : 0);
    return open.sort((a, b) => area(b) - area(a))[0];
  }

  async foregroundApp(appIds) {
    const fg = await this.channel.request('foreground', {}, {});
    if (!fg) return null;
    for (const id of appIds) if (imageMatches(fg.image, this._match([id]), this.platform)) return { appId: id, image: fg.image, handle: fg.handle };
    return { appId: null, image: fg.image, handle: fg.handle };
  }

  async screenshot({ app = null, maxWidth = null } = {}, ctx) {
    this.require('gui.screenshot');
    if (this.lockedFlag) throw new GuiError('screen_locked');
    let appId = app;
    if (!appId) {
      const lease = this.leases ? this.leases.active(ctx.jobId) : null;
      const fg = lease ? await this.foregroundApp(lease.apps) : null;
      appId = fg && fg.appId;
      if (!appId) throw new GuiError('app_required', 'name an allowlisted app');
    }
    this._app(appId);
    const win = await this._window(appId, ctx);
    const shot = await this.channel.request('screenshot', {
      handle: win.handle, max_width: maxWidth || this.guiConfig.screenshot.maxWidth, quality: this.guiConfig.screenshot.quality
    }, { jobId: ctx.jobId, timeoutMs: 20000 });
    const bytes = Buffer.from(shot.data || '', 'base64');
    const entry = {
      screenshotId: `ss-${this.nextShot}`, appId, handle: win.handle, transform: shot.transform,
      width: shot.width, height: shot.height, at: this.clock(), gen: this.displaysGen
    };
    this.nextShot += 1;
    // A run without a job can hold no lease, so its screenshot is never clicked on.
    if (ctx.jobId) {
      const list = this.shots.get(ctx.jobId) || [];
      list.push(entry);
      while (list.length > SCREENSHOTS_PER_JOB) list.shift();
      this.shots.set(ctx.jobId, list);
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('base64url');
    this._audit('gui.screenshot', { job_id: ctx.jobId, app_id: appId, screenshot_id: entry.screenshotId, sha256, bytes: bytes.length });
    return {
      screenshotId: entry.screenshotId, appId, width: shot.width, height: shot.height, mime: 'image/jpeg', data: shot.data,
      transform: shot.transform, capturedAt: new Date(entry.at).toISOString(), sha256, bytes: bytes.length
    };
  }

  // Live-view frames (§3.7): the foreground leased app's window, never stored.
  async captureFrame({ appIds, maxWidth, quality }) {
    const fg = await this.foregroundApp(appIds);
    if (!fg || !fg.appId) return { appId: null };
    const shot = await this.channel.request('screenshot', { handle: fg.handle, max_width: maxWidth, quality }, { timeoutMs: 20000 });
    const bytes = Buffer.from(shot.data || '', 'base64');
    return { appId: fg.appId, width: shot.width, height: shot.height, data: shot.data, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('base64url') };
  }

  mapPoint(jobId, screenshotId, x, y, appIds) {
    const entry = (this.shots.get(jobId) || []).find((s) => s.screenshotId === screenshotId);
    if (!entry || entry.gen !== this.displaysGen || this.clock() - entry.at > SCREENSHOT_TTL_MS) {
      throw new GuiError('stale_screenshot', 'take a new screenshot');
    }
    if (!appIds.includes(entry.appId)) throw new GuiError('stale_screenshot', 'that screenshot is not of a leased app');
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= entry.width || y >= entry.height) {
      throw new GuiError('outside_window', `the point is outside the ${entry.width}x${entry.height} screenshot`);
    }
    const { sx, sy } = entry.transform || { sx: 1, sy: 1 };
    return { handle: entry.handle, rel: [Math.round(x * sx), Math.round(y * sy)], appId: entry.appId };
  }

  async expectFor(appIds) {
    const pids = (await this._pids(appIds)).map((p) => p.pid);
    if (pids.length === 0) throw new GuiError('app_not_running', appIds.join(', '));
    return { match: this._match(appIds), pids };
  }

  async input(action, { jobId, leaseId, appIds, yieldMs }) {
    this.require('gui.input');
    const expect = await this.expectFor(appIds);
    const timeoutMs = inputTimeoutMs(action);
    const res = await this.channel.request('input', { expect, yield_ms: yieldMs, action }, { jobId, leaseId, ...(timeoutMs ? { timeoutMs } : {}) });
    const after = res && res.foregroundAfter;
    const afterAppId = after ? (appIds.find((id) => imageMatches(after.image, this._match([id]), this.platform)) || null) : null;
    return {
      foregroundBefore: res && res.foregroundBefore ? res.foregroundBefore : null,
      foregroundAfter: after || null,
      afterMatches: Boolean(after && expect.pids.includes(after.pid) && imageMatches(after.image, expect.match, this.platform)),
      afterAppId
    };
  }

  async releaseAll() {
    if (!this.channel.connected) return;
    try {
      await this.channel.request('release_all', {}, {});
    } catch (err) {
      this.log.warn(`release_all failed: ${err.message}`);
    }
  }

  async focusApp(appIds) {
    try {
      const procs = await this._pids(appIds);
      if (!procs.length) return;
      const windows = (await this.channel.request('windows', { pids: procs.map((p) => p.pid) }, {})) || [];
      const top = windows.find((w) => !w.minimized);
      if (top) await this.channel.request('focus', { handle: top.handle }, {});
    } catch (err) {
      this.log.debug(`focus after resume failed: ${err.message}`);
    }
  }
}

module.exports = { GuiBroker, SUSPENDING_CODES, suspendsLease, SCREENSHOTS_PER_JOB, SCREENSHOT_TTL_MS, inputTimeoutMs };
