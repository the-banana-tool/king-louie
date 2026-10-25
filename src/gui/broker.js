// src/gui/broker.js
// The service's view of the desktop (fleet stage 5 spec §3.5): whether the
// gui capability is up, what the helper may do, the screenshots a job may
// click on, and the one path every GUI op takes to the helper. All policy
// stays here; the helper only checks what each op carries.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { createLogger } = require('../logging');
const { GuiError, isGuiError } = require('./errors');
const { imageMatches, matchSetFor } = require('./apps');
const { realResolve } = require('../platform/path-roots');
const { writeGuiStatus } = require('./status');

const SCREENSHOTS_PER_JOB = 16;
const SCREENSHOT_TTL_MS = 10 * 60 * 1000;
// How many of an app's other windows a screenshot names, and how many window
// ids a job keeps (the oldest are forgotten first).
const OTHER_WINDOWS_MAX = 16;
const WINDOW_IDS_PER_JOB = 256;
const TITLE_MAX = 120;
const SUSPENDING_CODES = Object.freeze(['foreground_mismatch', 'app_not_running', 'helper_disconnected']);
const suspendsLease = (code) => SUSPENDING_CODES.includes(code);

// A window title is whatever the app (or a web page in it) put there. It goes
// to the model as one short line: no line breaks, controls or bidi controls
// that could make it read as anything but a title.
const TITLE_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;
const titleLine = (title) => String(title || '').replace(TITLE_UNSAFE, ' ').replace(/ {2,}/g, ' ').trim().slice(0, TITLE_MAX);

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

// Typed text goes to the helper in pieces of at most this many code points,
// on every platform, and the lease is checked before each piece (second
// security review, finding 5): a Stop, an expiry or a suspension takes
// effect within one piece instead of after the whole text. At xdotool's
// pace (two key events a character, 12 ms after each) a piece is about a
// second; the Windows worker sends one in a single call.
const TYPE_CHUNK = 40;
function typeChunks(text) {
  const points = Array.from(String(text));
  const out = [];
  for (let i = 0; i < points.length; i += TYPE_CHUNK) out.push(points.slice(i, i + TYPE_CHUNK).join(''));
  return out;
}

// closeLaunched: how long a process asked to close may take before it is forced.
const CLOSE_WAIT_MS = 5000;
const CLOSE_POLL_MS = 500;

class GuiBroker extends EventEmitter {
  constructor({ channel, guiConfig, getPolicy = () => ({}), audit = null, dataDir = null, platform = process.platform, clock = Date.now,
    log = createLogger('gui/broker'), heartbeatMs = 10000, realpath = realResolve, timers = { setTimeout, clearTimeout },
    monotonic = () => performance.now() } = {}) {
    super();
    Object.assign(this, { channel, guiConfig, getPolicy, audit, dataDir, platform, clock, log, heartbeatMs, realpath, timers, monotonic });
    this.leases = null;
    // Both maps are per job and only for runs that have one (R-F5-7): a run
    // with no job id gets no entry, so such runs never share a bucket.
    this.shots = new Map(); // jobId → [{ screenshotId, appId, handle, transform, width, height, at, gen }]
    this.launched = new Map(); // jobId → Map(appId → Set(pid))
    // The ids a job may name a window by (Screenshot's `window`): never a
    // handle from the model. jobId → Map(id → handle), with a counter.
    this.windowIds = new Map();
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
        windows: (windows || []).map((w) => ({ title: titleLine(w.title), minimized: w.minimized === true }))
      });
    }
    return out;
  }

  async launch(resolution, ctx, { approvedBy }) {
    this.require('gui.launch');
    const result = await this.channel.request('launch', { exe: resolution.exe, argv: resolution.argv, files: resolution.files }, { jobId: ctx.jobId, timeoutMs: 30000 });
    const pid = result && Number.isInteger(result.pid) ? result.pid : null;
    this._recordLaunched(ctx.jobId, resolution.appId, pid);
    this._audit('gui.launch', { job_id: ctx.jobId, app_id: resolution.appId, exe: resolution.exe, argv: [...resolution.argv, ...resolution.files], tier: resolution.tier, approved_by: approvedBy, pid });
    return { app_id: resolution.appId, pid, tier: resolution.tier, launched_at: new Date(this.clock()).toISOString() };
  }

  _recordLaunched(jobId, appId, pid) {
    if (!appId || pid === null || !jobId) return;
    if (!this.launched.has(jobId)) this.launched.set(jobId, new Map());
    const byApp = this.launched.get(jobId);
    if (!byApp.has(appId)) byApp.set(appId, new Set());
    byApp.get(appId).add(pid);
  }

  // A take's browser (gui.browser), started by the helper with a DevTools
  // port the service then attaches to. `profile` is a profile name: the
  // helper puts it under its own profiles root. Its pid counts as launched
  // by the job.
  async launchBrowser({ exe, profile, args = [] }, ctx = {}) {
    this.require('gui.launch');
    if (!this.guiConfig.browser) throw new GuiError('invalid_params', 'no browser in node.yaml (gui.browser)');
    const result = await this.channel.request('launch_browser', { exe, profile, args }, { jobId: ctx.jobId, timeoutMs: 15000 });
    const pid = result && Number.isInteger(result.pid) ? result.pid : null;
    this._recordLaunched(ctx.jobId, this.guiConfig.browser, pid);
    this._audit('gui.browser.launch', { job_id: ctx.jobId, exe, pid });
    return result;
  }

  // The ffmpeg the connected helper found for its user (its probe report's
  // `recorder.ffmpeg`, kept by the channel's sanitizeProbe), or null.
  recorder() {
    const info = !this.off && this.channel.connected ? this.channel.info : null;
    return (info && info.recorder && info.recorder.ffmpeg) || null;
  }

  // `ffmpeg` and `path` are left out when not given: the helper then uses
  // the ffmpeg it found and a path of its own for the take.
  async recordStart({ ffmpeg, takeId, path, fps, size }, ctx = {}) {
    const params = { take_id: takeId, fps, size };
    if (ffmpeg !== undefined) params.ffmpeg = ffmpeg;
    if (path !== undefined) params.path = path;
    const result = await this.channel.request('record_start', params, { jobId: ctx.jobId });
    // A recording with no pid never started, or cannot be stopped: not one.
    if (!result || !Number.isInteger(result.pid)) throw new GuiError('recorder_failed', 'the recorder reported no process');
    this._audit('gui.record.start', { job_id: ctx.jobId, pid: result.pid });
    return result;
  }

  async recordStop({ pid }, ctx = {}) {
    const result = await this.channel.request('record_stop', { pid }, { jobId: ctx.jobId, timeoutMs: 20000 });
    this._audit('gui.record.stop', { job_id: ctx.jobId, pid, duration_s: result.durationS, bytes: result.bytes, truncated: result.truncated });
    return result;
  }

  async keepAwake(on, ctx = {}) {
    return this.channel.request('keep_awake', { on }, { jobId: ctx.jobId });
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

  // Ends one process this job launched (a take's Chrome), by its pid: asked
  // to close, watched through the helper's process listing for up to
  // CLOSE_WAIT_MS (a close that was sent is not a process that exited: a
  // "Leave site?" dialog or a hung browser keeps it up), then forced. The
  // bound is on the monotonic clock and covers the polls themselves; a close
  // or a poll that fails or runs past it is doubt, and doubt forces. A pid
  // the job did not launch is refused.
  async closeLaunched(pid, ctx = {}) {
    const byApp = ctx.jobId ? this.launched.get(ctx.jobId) : null;
    const appId = byApp && Number.isInteger(pid) ? [...byApp.entries()].find(([, pids]) => pids.has(pid))?.[0] : undefined;
    if (appId === undefined) throw new GuiError('invalid_params', 'not a process this job launched');
    const req = { jobId: ctx.jobId };
    const codeOf = (err) => (isGuiError(err) ? err.code : 'error');
    const startedAt = this.monotonic();
    const left = () => CLOSE_WAIT_MS - (this.monotonic() - startedAt);
    // Ref'd timers: the wait itself keeps the process up until it is over.
    const TIMED_OUT = Symbol('timed out');
    const within = (promise, ms) => {
      let handle;
      promise.catch(() => {});
      const timer = new Promise((resolve) => { handle = this.timers.setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms)); });
      return Promise.race([promise, timer]).finally(() => this.timers.clearTimeout(handle));
    };
    let gone = false;
    try {
      await within(this.channel.request('close', { pids: [pid], force: false }, req), left());
      while (left() > 0) {
        const listed = await within(this._pids([appId], ctx).then((procs) => procs.some((p) => p.pid === pid)), left());
        if (listed === false) { gone = true; break; }
        if (listed === TIMED_OUT || left() <= 0) break;
        await within(new Promise(() => {}), Math.min(CLOSE_POLL_MS, left()));
      }
    } catch (err) {
      this.log.warn(`closing a launched process: the close or a poll failed (${codeOf(err)}); forcing it`);
    }
    let forced = false;
    let closed = gone ? [pid] : [];
    if (!gone) {
      forced = true;
      try {
        const reply = await this.channel.request('close', { pids: [pid], force: true }, req);
        if (reply && Array.isArray(reply.closed) && reply.closed.includes(pid)) closed = [pid];
        else this.log.warn('closing a launched process: the forced close was not confirmed');
      } catch (err) {
        this.log.warn(`closing a launched process: the forced close failed (${codeOf(err)})`);
      }
    }
    for (const pids of byApp.values()) pids.delete(pid);
    this._audit('gui.close', { job_id: ctx.jobId, app_id: appId, pids: closed, forced });
    return { closed, forced };
  }

  // The id a job names one window by. A handle keeps its id for the job.
  _windowId(jobId, handle) {
    if (!jobId) return null;
    if (!this.windowIds.has(jobId)) this.windowIds.set(jobId, { next: 1, ids: new Map() });
    const book = this.windowIds.get(jobId);
    for (const [id, h] of book.ids) if (h === String(handle)) return id;
    const id = `win-${book.next}`;
    book.next += 1;
    book.ids.set(id, String(handle));
    while (book.ids.size > WINDOW_IDS_PER_JOB) book.ids.delete(book.ids.keys().next().value);
    return id;
  }

  _windowHandle(jobId, id) {
    const book = jobId ? this.windowIds.get(jobId) : null;
    return book && book.ids.has(id) ? book.ids.get(id) : null;
  }

  // The window to capture, and the app's other open windows.
  //   - `windowId` (the model named one of the ids an earlier screenshot gave
  //     this job): that window, if the helper still lists it for this app.
  //   - else the foreground window when it is the app's: a dialog that is in
  //     front is what the user would see and click. The helper lists owned
  //     windows too (second security review, finding 4); a foreground window
  //     of the app that its list does not hold is used itself.
  //   - else the app's largest main window that is not minimized.
  // A menu or a dropdown list is never the foreground window and is never
  // picked by itself: the screenshot names it and the model asks for it.
  // Whatever is picked, a click is sent with that window's own handle and
  // the helper refuses a point any other window covers.
  async _window(appId, ctx, windowId = null) {
    const procs = await this._pids([appId], ctx);
    if (procs.length === 0) throw new GuiError('app_not_running', appId);
    const pids = procs.map((p) => p.pid);
    const fg = await this.channel.request('foreground', {}, { jobId: ctx.jobId });
    // Only windows of this app's processes, whatever the helper sent.
    const windows = ((await this.channel.request('windows', { pids }, { jobId: ctx.jobId })) || []).filter((w) => w && pids.includes(w.pid));
    const open = windows.filter((w) => !w.minimized);
    const same = (w, handle) => String(w.handle) === String(handle);
    let win = null;
    if (windowId !== null) {
      const handle = this._windowHandle(ctx.jobId, windowId);
      win = handle === null ? null : open.find((w) => same(w, handle)) || null;
      if (!win) throw new GuiError('stale_screenshot', 'that window is gone, or was never one of this app\'s: take a new screenshot without "window"');
    } else if (fg && pids.includes(fg.pid)) {
      win = open.find((w) => same(w, fg.handle)) || null;
      if (!win && !windows.some((w) => same(w, fg.handle))) {
        win = { handle: fg.handle, pid: fg.pid, image: fg.image, title: '', bounds: fg.bounds || null, minimized: false, owned: true };
      }
    }
    if (!win) {
      if (open.length === 0) throw new GuiError(windows.length ? 'window_minimized' : 'app_not_running', appId);
      const area = (w) => (w.bounds ? (w.bounds.w || 0) * (w.bounds.h || 0) : 0);
      const main = open.filter((w) => w.owned !== true);
      win = [...(main.length ? main : open)].sort((a, b) => area(b) - area(a))[0];
    }
    return { win, others: open.filter((w) => !same(w, win.handle)) };
  }

  async foregroundApp(appIds) {
    const fg = await this.channel.request('foreground', {}, {});
    if (!fg) return null;
    for (const id of appIds) if (imageMatches(fg.image, this._match([id]), this.platform)) return { appId: id, image: fg.image, handle: fg.handle };
    return { appId: null, image: fg.image, handle: fg.handle };
  }

  async screenshot({ app = null, maxWidth = null, window = null } = {}, ctx) {
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
    const { win, others } = await this._window(appId, ctx, window);
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
    // The app's other open windows, by id (a run without a job holds no
    // lease and gets none). Titles are the app's own text: one short line.
    const otherWindows = ctx.jobId ? others.slice(0, OTHER_WINDOWS_MAX).map((w) => ({
      window: this._windowId(ctx.jobId, w.handle), title: titleLine(w.title), owned: w.owned === true,
      width: w.bounds && Number.isFinite(w.bounds.w) ? w.bounds.w : null, height: w.bounds && Number.isFinite(w.bounds.h) ? w.bounds.h : null
    })) : [];
    return {
      screenshotId: entry.screenshotId, appId, width: shot.width, height: shot.height, mime: 'image/jpeg', data: shot.data,
      transform: shot.transform, capturedAt: new Date(entry.at).toISOString(), sha256, bytes: bytes.length, otherWindows
    };
  }

  // A click, scroll or drag was refused because another window covers the
  // point (the helper's own check, which this never relaxes). The refusal
  // says what to do: take a new screenshot; and when what covers the point
  // is a window of the leased apps (a dialog, a menu, a list), which one.
  _obscured(err, { jobId, pids }) {
    const covering = err.info && err.info.covering;
    const ofApp = covering && Number.isInteger(covering.pid) && pids.includes(covering.pid) && (typeof covering.handle === 'string' || Number.isInteger(covering.handle));
    const id = ofApp ? this._windowId(jobId, covering.handle) : null;
    const hint = id
      ? `a window of the app covers that point (a dialog, a menu or a list): take a new screenshot; Screenshot with window "${id}" shows the window that covers it`
      : 'another window covers that point: take a new screenshot';
    return new GuiError('point_obscured', hint, { info: err.info || {} });
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
    const typing = Boolean(action && action.kind === 'type');
    // For typed text: what the helper has acknowledged, and the piece it was
    // sent last and has not answered for. A failure carries both (err.typed),
    // so the typed buffer holds exactly what was sent.
    const progress = { sent: '', inFlight: '' };
    try {
      this.require('gui.input');
      const expect = await this.expectFor(appIds);
      // The lease again, now (security review finding 4): the lookup above is
      // a round trip to the helper, and a Stop, an expiry, a suspension or the
      // job closing during it must not be followed by one more input. Nothing
      // awaits between this check and the send. No lease manager, no input.
      if (!this.leases) throw new GuiError('lease_required', 'this node has no lease manager');
      const checkLease = () => {
        const lease = this.leases.assertUsable(jobId);
        if (lease.leaseId !== leaseId) throw new GuiError('lease_required', 'that lease is no longer this job\'s lease');
      };
      const send = async (piece) => {
        const timeoutMs = inputTimeoutMs(piece);
        try {
          return await this.channel.request('input', { expect, yield_ms: yieldMs, action: piece }, { jobId, leaseId, ...(timeoutMs ? { timeoutMs } : {}) });
        } catch (err) {
          if (isGuiError(err) && err.code === 'point_obscured') throw this._obscured(err, { jobId, pids: expect.pids });
          throw err;
        }
      };
      let first = null;
      let res = null;
      if (typing) {
        // A piece at a time, the lease checked before each (finding 5).
        for (const chunk of typeChunks(action.text)) {
          checkLease();
          progress.inFlight = chunk;
          res = await send({ ...action, text: chunk });
          progress.sent += chunk;
          progress.inFlight = '';
          if (first === null) first = res;
        }
      } else {
        checkLease();
        res = await send(action);
        first = res;
      }
      const after = res && res.foregroundAfter;
      const afterAppId = after ? (appIds.find((id) => imageMatches(after.image, this._match([id]), this.platform)) || null) : null;
      return {
        foregroundBefore: first && first.foregroundBefore ? first.foregroundBefore : null,
        foregroundAfter: after || null,
        afterMatches: Boolean(after && expect.pids.includes(after.pid) && imageMatches(after.image, expect.match, this.platform)),
        afterAppId
      };
    } catch (err) {
      if (typing && err !== null && typeof err === 'object') err.typed = { sent: progress.sent, inFlight: progress.inFlight };
      throw err;
    }
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
      // A main window first: the list holds menus and dropdown lists too.
      const top = windows.find((w) => !w.minimized && w.owned !== true) || windows.find((w) => !w.minimized);
      if (top) await this.channel.request('focus', { handle: top.handle }, {});
    } catch (err) {
      this.log.debug(`focus after resume failed: ${err.message}`);
    }
  }
}

module.exports = { GuiBroker, SUSPENDING_CODES, suspendsLease, SCREENSHOTS_PER_JOB, SCREENSHOT_TTL_MS, inputTimeoutMs, TYPE_CHUNK, typeChunks };
