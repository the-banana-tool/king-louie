'use strict';

// The take manager (spec docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md
// §5, §6, §9): one screen-recorded browser demo at a time on this node. It asks the phone for one
// `take` lease, has the session helper launch the take's Chrome and ffmpeg (both run as the
// logged-in user; this service runs as LOCAL SERVICE and never builds a path in the user's
// profile or searches the user's PATH), attaches to Chrome over CDP, keeps the screen awake, and
// sets the take policy on the session's holder. Every ending, the model's or not, stops the
// recording (the file is kept), closes the browser, clears the policy, releases the lease and
// writes the record's `ended`.

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { GuiError, isGuiError } = require('./errors');
const { SITE_RE, TAKE_MAX_MINUTES } = require('./lease-protocol');
const { newLeaseId } = require('./leases');
const { createTakePolicy, BROWSER_ACTIONS, BROWSER_TOOLS } = require('./take-policy');
const { plainLineProblem } = require('../cases/hidden-chars');
const { CHROME_FLAGS } = require('../browser/chrome-flags');
const { resolveProfileDir } = require('../browser/profile-dirs');

// C-6: a take with no word from the driver for 30 minutes after a report ends.
const SILENT_MS = 30 * 60000;
const NAME_MAX = 60;
const NOTE_MAX = 500;
const REASON_MAX = 280;
const SITES_MAX = 32;
// The browser is the lease's first app; eight in all (§6.1).
const APPS_MAX = 7;
const PROFILE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_PROFILE = 'take';
const DEFAULT_FPS = 30;
const RECORDER_MISSING = 'Install ffmpeg (winget install Gyan.FFmpeg) or set gui.recorder.ffmpeg in node.yaml';
const FIRST_COLUMN = Object.freeze([...BROWSER_ACTIONS.page, ...BROWSER_ACTIONS.session, ...BROWSER_ACTIONS.extract]);

const iso = (ms) => new Date(ms).toISOString();
// record_start's max_s for a take of `minutes`: the approved duration plus a minute of slack.
const recordMaxS = (minutes) => minutes * 60 + 60;
// The real path of p (links and 8.3 names expanded) through its deepest existing ancestor,
// case-folded on Windows.
function realOf(p) {
  const rest = [];
  let cur = p;
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { rest.unshift(path.basename(cur)); cur = path.dirname(cur); }
  const real = path.join(fs.realpathSync.native(cur), ...rest);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}
const isUnder = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const invalid = (detail) => new GuiError('invalid_params', detail);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const plainLine = (v, max) => typeof v === 'string' && v.length > 0 && Array.from(v).length <= max && plainLineProblem(v) === null;

// A browser attached over CDP to the Chrome the helper launched. Required here, not at the top:
// nothing that loads src/gui/ for its config or errors should load Playwright.
async function attachPlaywright(cdpUrl) {
  const PlaywrightBrowser = require('../browser/playwright-browser');
  const browser = new PlaywrightBrowser();
  try {
    await browser.attach({ cdpUrl });
  } catch (err) {
    // A failed attach after connectOverCDP can leave it half attached.
    await browser.stop().catch(() => {});
    throw err;
  }
  return browser;
}

// A personal node's take (browser-runner spec §5, C-3): the service runs in the owner's session,
// so Playwright launches the gui.apps Chrome itself, headed and maximized with no emulated
// viewport, on the profile under the node's data dir. No helper, no debugging port, no pid.
async function launchPersonalBrowser({ exe, userDataPath }, { createBrowser } = {}) {
  const browser = createBrowser ? createBrowser() : new (require('../browser/playwright-browser'))();
  try {
    await browser.start({ userDataPath, executablePath: exe, headless: false, viewport: null, extraArgs: ['--start-maximized'] });
  } catch (err) {
    await browser.stop().catch(() => {});
    throw err;
  }
  return browser;
}

// Closes the take's Chrome itself: disconnecting Playwright from a CDP attach leaves it running.
async function closeOverCdp(browser) {
  const cdp = browser && browser.browser;
  // Not closable this way: the caller ends the process by its pid instead.
  if (!cdp || typeof cdp.newBrowserCDPSession !== 'function') throw new Error('no CDP connection to close');
  const session = await cdp.newBrowserCDPSession();
  await session.send('Browser.close');
}

class TakeManager {
  constructor({ leases, broker, store, guiConfig, registry = null, audit = null, clock = Date.now, timers = { setTimeout, clearTimeout },
    log = createLogger('gui/takes'), attachBrowser = attachPlaywright, closeBrowser = closeOverCdp,
    findProcess = undefined, kill = undefined, hosting = 'service', dataDir = null, launchTakeBrowser = null, createBrowser = null } = {}) {
    Object.assign(this, { leases, broker, store, guiConfig, audit, clock, timers, log, attachBrowser, closeBrowser, hosting, dataDir });
    this.personal = hosting === 'personal';
    // Step 2 of a start → the browser. Personal: { exe, profile, userDataPath }. Fleet:
    // { exe, profile, ctx, setPid, checkEnded } (the helper's call, the pid it reports, and the
    // check that the take did not end while the helper launched).
    this.launchTakeBrowser = launchTakeBrowser
      || (this.personal ? (req) => launchPersonalBrowser(req, { createBrowser }) : (req) => this._launchFleetBrowser(req));
    // Personal: { browser, profile } a take kept open with keep_browser, outside the registry;
    // stopAll closes them (C-4).
    this.kept = new Set();
    this.registry = registry || require('../tools/builtin/browser-registry');
    // take_id → the in-memory take (what the record cannot hold: the browser, the lease, the timer).
    this.takes = new Map();
    // job id → its newest take id.
    this.byJob = new Map();
    this.active = null;
    // §6.3: a helper gone 30 s took the recorder with it, so the live take ends helper_lost.
    if (broker && typeof broker.on === 'function') broker.on('helper_lost', () => { this.onHelperLost().catch(() => {}); });
    // §5.3: a take found unfinished at start was cut off by a restart. Its ffmpeg, when one
    // still runs under the pid it recorded, is ended (TakeStore#markLiveEnded).
    let ended = [];
    try {
      ended = store.markLiveEnded('service_restarted', { ...(findProcess ? { findProcess } : {}), ...(kill ? { kill } : {}) }) || [];
    } catch (err) {
      log.warn(`takes left live at the last stop were not marked ended: ${err.message}`);
    }
    this._pushRestartEndings(ended);
  }

  // Push spec §6.2: the lease of a take cut off by a restart is gone from memory, so no ended
  // status is signed for it. Each one that ran (its record has a lease_id and a grant) gets one
  // session_ended for every phone, through the lease manager's queue, which holds it until the
  // relay link is up.
  _pushRestartEndings(takeIds) {
    const queue = this.leases && this.leases.pushQueue;
    if (!queue || typeof queue.enqueue !== 'function') return;
    for (const takeId of takeIds) {
      let record = null;
      try { record = this.store.get(takeId); } catch { record = null; }
      if (!record || typeof record.lease_id !== 'string' || !record.lease_id || !record.grant) continue;
      try {
        queue.enqueue({ kind: 'session_ended', id: record.lease_id });
      } catch (err) {
        this.log.debug('a restart ending was not queued for push', { takeId, code: (err && err.code) || 'error' });
      }
    }
  }

  live() {
    return this.active ? this.store.get(this.active.takeId) : null;
  }

  forJob(jobId) {
    const id = this.byJob.get(jobId);
    if (id) return this.store.get(id);
    const records = this.store.list().filter((r) => r.job_id === jobId);
    records.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return records.at(-1) || null;
  }

  // get_job asks this on every call: the in-memory map only, never a folder scan.
  summaryFor(jobId) {
    const id = this.byJob.get(jobId);
    const record = id ? this.store.get(id) : null;
    return record ? this.store.summary(record) : null;
  }

  // What Take.run_steps needs (Task 13): the browser, the policy and the job of a live take.
  context(takeId) {
    const t = this.takes.get(takeId);
    if (!t || t.ended) return null;
    return { takeId, jobId: t.jobId, browser: t.browser, policy: t.policy, stopWhenDone: t.stopWhenDone };
  }

  // The record's `steps`: Take.run_steps per-step results.
  recordSteps(takeId, steps) {
    return this.store.update(takeId, { steps });
  }

  _validate(params, workingDirectory) {
    if (!isPlainObject(params)) throw invalid('the take\'s parameters must be an object');
    const cfg = this.guiConfig;
    if (!plainLine(params.name, NAME_MAX)) throw invalid(`"name" must be one plain line of 1–${NAME_MAX} characters`);
    const { sites } = params;
    if (!Array.isArray(sites) || sites.length < 1 || sites.length > SITES_MAX || !sites.every((s) => typeof s === 'string' && SITE_RE.test(s))) {
      throw invalid(`"sites" must be 1–${SITES_MAX} hosts, each "example.com" or "*.example.com" in lower case`);
    }
    if (new Set(sites).size !== sites.length) throw invalid('"sites" names a host twice');
    let browser = true;
    if (params.browser !== undefined && params.browser !== true) {
      if (!Array.isArray(params.browser) || params.browser.length < 1 || params.browser.length > 64
        || !params.browser.every((a) => FIRST_COLUMN.includes(a)) || new Set(params.browser).size !== params.browser.length) {
        throw invalid('"browser" must be true or a list of the browser actions a take may use');
      }
      browser = [...params.browser];
    }
    const apps = params.apps === undefined ? [] : params.apps;
    if (!Array.isArray(apps) || apps.length > APPS_MAX || new Set(apps).size !== apps.length
      || !apps.every((id) => typeof id === 'string' && Object.hasOwn(cfg.apps, id) && id !== cfg.browser)) {
      throw invalid(`"apps" must be at most ${APPS_MAX} distinct gui.apps ids besides the browser`);
    }
    if (params.credentials !== undefined && typeof params.credentials !== 'boolean') throw invalid('"credentials" must be true or false');
    const max = Math.min(cfg.take.maxMinutes, TAKE_MAX_MINUTES);
    if (!Number.isInteger(params.minutes) || params.minutes < 1 || params.minutes > max) throw invalid(`"minutes" must be 1–${max}`);
    const profile = params.profile === undefined ? DEFAULT_PROFILE : params.profile;
    if (typeof profile !== 'string' || !PROFILE_RE.test(profile)) throw invalid('"profile" must be 1–64 letters, digits, "_" or "-"');
    if (params.reason !== undefined && !plainLine(params.reason, REASON_MAX)) throw invalid(`"reason" must be one plain line of 1–${REASON_MAX} characters`);
    if (params.stop_when_done !== undefined && typeof params.stop_when_done !== 'boolean') throw invalid('"stop_when_done" must be true or false');

    let record = null;
    const raw = params.record === undefined ? true : params.record;
    if (raw === true || isPlainObject(raw)) {
      const r = raw === true ? {} : raw;
      for (const key of Object.keys(r)) if (!['dir', 'fps', 'size'].includes(key)) throw invalid(`unknown parameter "record.${key}"`);
      const fps = r.fps === undefined ? DEFAULT_FPS : r.fps;
      if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw invalid('"record.fps" must be 1–60');
      let size = null;
      if (r.size !== undefined) {
        const even = (n) => Number.isInteger(n) && n >= 2 && n <= 7680 && n % 2 === 0;
        if (!isPlainObject(r.size) || Object.keys(r.size).some((k) => !['width', 'height'].includes(k)) || !even(r.size.width) || !even(r.size.height)) {
          throw invalid('"record.size" must be { width, height }, even numbers of pixels');
        }
        size = { width: r.size.width, height: r.size.height };
      }
      let dir;
      if (r.dir !== undefined) {
        if (typeof r.dir !== 'string' || !r.dir || r.dir.length > 1024) throw invalid('"record.dir" must be a folder under the session\'s working folder');
        if (typeof workingDirectory !== 'string' || !workingDirectory) throw invalid('"record.dir" needs a session with a working folder');
        const cwd = path.resolve(workingDirectory);
        const resolved = path.resolve(cwd, r.dir);
        let inside = isUnder(resolved, cwd);
        try {
          inside = inside && isUnder(realOf(resolved), realOf(cwd));
        } catch {
          inside = false;
        }
        if (!inside) throw invalid('"record.dir" must be under the session\'s working folder');
        dir = resolved;
      }
      record = { fps, size, dir };
    } else if (raw !== false) {
      throw invalid('"record" must be true, false or { dir?, fps?, size? }');
    }
    return {
      name: params.name, sites: [...sites], browser, apps: [...apps], credentials: params.credentials === true, minutes: params.minutes,
      profile, reason: params.reason || params.name, stopWhenDone: params.stop_when_done === true, record
    };
  }

  // Spec §5.2's start. Every refusal before the lease request leaves nothing behind; every failure
  // after it ends the record and releases the lease.
  async start({ jobId, origin = null, nodeLocalOrigin = false, holder, params, workingDirectory = null, signal = null } = {}) {
    const cfg = this.guiConfig;
    if (!(cfg.take && cfg.take.enabled === true)) throw invalid('takes are off in node.yaml');
    if (nodeLocalOrigin !== true) throw new GuiError('take_requires_local_origin', 'a take is started only from a session this node started itself');
    if (typeof jobId !== 'string' || !jobId) throw new GuiError('job_required', 'this run has no job to bind a take to');
    if (!holder || typeof holder.set !== 'function' || typeof holder.clear !== 'function') throw invalid('this run cannot hold a take');
    const liveRecord = this.live();
    if (liveRecord) throw new GuiError('take_busy', `a take is already live: ${liveRecord.name}`);
    if (!cfg.browser || !Object.hasOwn(cfg.apps, cfg.browser)) throw invalid('gui.browser is not set in node.yaml');
    const p = this._validate(params, workingDirectory);
    let ffmpeg = null;
    if (p.record) {
      ffmpeg = (cfg.recorder && cfg.recorder.ffmpeg) || (this.broker && typeof this.broker.recorder === 'function' ? this.broker.recorder() : null);
      if (!ffmpeg) throw new GuiError('recorder_missing', RECORDER_MISSING);
    }

    if (this.personal) this._assertProfileFree(p.profile, null);

    const record = this.store.create({ name: p.name, job_id: jobId, origin, state: 'requested' });
    const takeId = record.take_id;
    let settle;
    const t = {
      takeId, jobId, name: p.name, profile: p.profile, holder, lease: null, leaseId: null, leaseEndReason: null, browser: null, browserPid: null,
      browserKey: `take:${takeId}`, policy: null, recording: null, awake: false, silentTimer: null, listener: null,
      ended: false, ending: null, lateRelease: null, stopWhenDone: p.stopWhenDone, startSettled: new Promise((r) => { settle = r; })
    };
    this.takes.set(takeId, t);
    this.byJob.set(jobId, takeId);
    this.active = t;
    try {
      return await this._start(t, p, { origin, nodeLocalOrigin, signal, ffmpeg });
    } finally {
      settle();
    }
  }

  async _start(t, p, { origin, nodeLocalOrigin, signal, ffmpeg }) {
    const cfg = this.guiConfig;
    const { takeId, jobId, holder } = t;
    const ctx = { jobId };
    // The take ended while start was still going: what start made since is let go of.
    const checkEnded = async () => {
      if (!t.ended) return;
      t.lateRelease = this._release(t).then(() => {
        if (t.recordingDone) this._safeUpdate(takeId, { recording: t.recordingDone });
      });
      await t.lateRelease;
      throw new GuiError('lease_required', `the take ended (${t.endReason || t.leaseEndReason || 'ended'})`);
    };

    // 1. The lease: one tap on the phone approves the whole take. Its id is minted here, so only
    // that lease is ever ended by this take, and only its end reason is recorded.
    t.leaseId = newLeaseId();
    t.listener = (l) => {
      if (l.leaseId !== t.leaseId) return;
      if (l.state === 'ended') {
        t.leaseEndReason = l.endReason || 'lease_ended';
        if (!t.ended) this.end(takeId, t.leaseEndReason).catch(() => {});
      } else if (l.locked && !t.ended) {
        this.onLocked();
      }
    };
    this.leases.on('state', t.listener);
    let lease;
    try {
      lease = await this.leases.request({
        jobId, origin, appIds: [cfg.browser, ...p.apps], minutes: p.minutes, reason: p.reason, signal, kind: 'take',
        take: { name: p.name, sites: p.sites, browser: p.browser, credentials: p.credentials, unattended: true }, nodeLocalOrigin,
        leaseId: t.leaseId
      });
    } catch (err) {
      await this.end(takeId, t.leaseEndReason || (isGuiError(err) ? err.code : 'lease_failed'));
      throw err;
    }
    t.lease = lease;
    t.leaseId = lease.leaseId;
    const expiresAt = iso(lease.expiresAt);
    const grantedMinutes = Math.round((lease.expiresAt - this.clock()) / 60000);
    const grant = { sites: p.sites, browser: p.browser, apps: [...lease.apps], credentials: p.credentials, minutes: grantedMinutes, expires_at: expiresAt };
    this._safeUpdate(takeId, { lease_id: lease.leaseId, grant });
    if (lease.state === 'ended') await this.end(takeId, lease.endReason || 'lease_ended');
    await checkEnded();

    try {
      // The phone may narrow the apps; without the browser there is no take.
      if (!lease.apps.includes(cfg.browser)) {
        throw Object.assign(new GuiError('take_app_not_allowed', 'the phone did not approve the browser'), { endReason: 'browser_not_granted' });
      }
      // 2. The browser: the helper's Chrome attached over CDP (fleet), or one Playwright launches
      // itself (personal).
      const exe = cfg.apps[cfg.browser].path;
      let launchReq;
      if (this.personal) {
        if (!this.dataDir) throw new GuiError('browser_launch_failed', 'no data dir for the take\'s browser profile');
        // Chrome locks a user-data dir to one process (C-3): checked again, the phone took time.
        this._assertProfileFree(p.profile, t.browserKey);
        // The same directory the browser tools open for this profile name.
        launchReq = { exe, profile: p.profile, userDataPath: resolveProfileDir({ userDataPath: this.dataDir }, p.profile) };
      } else {
        launchReq = { exe, profile: p.profile, ctx, setPid: (pid) => { if (Number.isInteger(pid)) t.browserPid = pid; }, checkEnded };
      }
      let browser;
      try {
        browser = await this.launchTakeBrowser(launchReq);
      } catch (err) {
        // The launcher's own refusal, or checkEnded's (the take ended while launching).
        if (isGuiError(err) && (err.code === 'browser_launch_failed' || t.ended)) throw err;
        throw new GuiError('browser_launch_failed', isGuiError(err) ? err.code : null);
      }
      t.browser = browser;
      // Registered before the policy is set, so no call approved by the take finds no browser.
      this.registry.setBrowser(t.browserKey, browser);
      // The vault's browser_cred:<profile>:<host> entries are found by the key's profile
      // (spec §8); a call inside a take may not name one itself (take_browser_managed).
      // removeBrowser clears it.
      this.registry.setActiveProfile(t.browserKey, p.profile);
      t.registered = true;
      await checkEnded();

      // 3. The recorder.
      let recording = null;
      if (p.record) {
        let res;
        try {
          // max_s bounds the file in ffmpeg itself (the approved minutes and one more), so a
          // recording outlives a service that never sends record_stop by a minute at most.
          res = await this.broker.recordStart({
            ffmpeg, takeId, path: p.record.dir ? path.join(p.record.dir, `${takeId}.mp4`) : undefined, fps: p.record.fps, size: p.record.size,
            maxS: recordMaxS(p.minutes)
          }, ctx);
        } catch (err) {
          // The helper may have started ffmpeg and only the answer was lost (a timeout): it is
          // stopped by the take id, best effort, so it does not record the desktop until the
          // helper exits.
          try {
            await this.broker.recordStop({ takeId }, ctx);
          } catch (stopErr) {
            this.log.info(`no recording to stop for the take (${isGuiError(stopErr) ? stopErr.code : 'error'})`, { takeId });
          }
          throw new GuiError('recorder_failed', isGuiError(err) && err.code !== 'recorder_failed' ? err.code : null);
        }
        recording = { pid: res.pid, path: res.path, started_at: iso(Number.isFinite(res.startedAt) ? res.startedAt : this.clock()) };
        t.recording = recording;
        // The pid lets the next start end an ffmpeg this service left running (TakeStore).
        this._safeUpdate(takeId, {
          recording: { path: recording.path, started_at: recording.started_at },
          recorder: { pid: recording.pid, started_at: recording.started_at }
        });
        await checkEnded();
      }

      // 4. C-12: the display and the system stay awake while the take is live.
      try {
        await this.broker.keepAwake(true, ctx);
        t.awake = true;
      } catch (err) {
        this.log.warn(`the screen may lock during the take: keep_awake failed (${isGuiError(err) ? err.code : 'error'})`, { takeId });
      }
      await checkEnded();

      // 5. The policy: every approval inside the take is answered by what the phone approved.
      t.policy = this._policy(grant, t);
      holder.set(t.policy);
      this._safeUpdate(takeId, { state: 'live' });
      return {
        take_id: takeId, lease_id: lease.leaseId, granted_minutes: grantedMinutes, expires_at: expiresAt,
        browser: { profile: p.profile, cdp: !this.personal },
        recording: recording ? { path: recording.path, started_at: recording.started_at } : null
      };
    } catch (err) {
      if (!t.ended) await this.end(takeId, err.endReason || (isGuiError(err) ? err.code : 'take_start_failed'));
      throw err;
    }
  }

  // The fleet's step 2: the helper launches Chrome on the owner's screen with CHROME_FLAGS and
  // the service attaches over CDP. Its pid is kept: every ending closes it through the broker
  // unless the attached browser was closed over CDP.
  async _launchFleetBrowser({ exe, profile, ctx, setPid, checkEnded }) {
    let launched;
    try {
      launched = await this.broker.launchBrowser({ exe, profile, args: [...CHROME_FLAGS] }, ctx);
    } catch (err) {
      throw new GuiError('browser_launch_failed', isGuiError(err) && err.code !== 'browser_launch_failed' ? err.code : null);
    }
    if (launched) setPid(launched.pid);
    await checkEnded();
    const port = launched && launched.cdp && launched.cdp.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new GuiError('browser_launch_failed', 'the helper gave no debugging port');
    try {
      return await this.attachBrowser(`http://127.0.0.1:${port}`);
    } catch {
      throw new GuiError('browser_launch_failed', 'could not attach to the browser');
    }
  }

  // Personal (C-4): a kept browser stays in `kept` until stopAll, or until its context closes
  // (the owner closed the window), which frees its profile for the next take.
  _keep(browser, profile) {
    const entry = { browser, profile };
    this.kept.add(entry);
    const context = browser && browser.context;
    if (context && typeof context.on === 'function') context.on('close', () => this.kept.delete(entry));
  }

  // Personal (C-3): a profile open under another registry key, or in a browser a take kept and
  // that still runs, is refused before Chrome starts.
  _assertProfileFree(profile, ownKey) {
    for (const k of [...this.kept]) if (k.browser && k.browser.isRunning === false) this.kept.delete(k);
    const open = this.registry.activeProfiles().some((e) => e.key !== ownKey && e.profile === profile)
      || [...this.kept].some((k) => k.profile === profile);
    if (open) throw new GuiError('browser_launch_failed', `profile ${profile} is open in another browser`);
  }

  _policy(grant, t) {
    // The take's browser apps are its own: LaunchApp launches only the take's other apps.
    const inner = createTakePolicy({ ...grant, apps: grant.apps.filter((id) => id !== this.guiConfig.browser) }, {
      currentUrl: () => (t.browser && t.browser.page ? t.browser.page.url() : null)
    });
    return {
      grant: inner.grant,
      browserKey: t.browserKey,
      takeId: t.takeId,
      async decide(toolName, params) {
        // From the instant the take ends, nothing is approved by it (a call that still holds
        // this policy is refused, whatever the teardown is waiting on).
        if (t.ended) return { allow: false, code: 'take_ended', error: 'the take has ended' };
        // A browser call naming a profile would open another browser and another vault's logins.
        if (BROWSER_TOOLS.includes(toolName) && params && params.profile !== undefined && params.profile !== null) {
          return { allow: false, code: 'take_browser_managed', error: 'the take owns its browser; use Take.start and Take.stop' };
        }
        return inner.decide(toolName, params);
      }
    };
  }

  _safeUpdate(takeId, patch) {
    try {
      return this.store.update(takeId, patch);
    } catch (err) {
      this.log.error(`take record not written: ${err.message}`, { takeId });
      return null;
    }
  }

  // Lets go of what a take holds on the screen. Idempotent per piece; a step that throws is logged
  // and the rest still run.
  async _release(t, { keepBrowser = false } = {}) {
    const ctx = { jobId: t.jobId };
    const step = async (what, fn) => {
      try {
        await fn();
        return true;
      } catch (err) {
        this.log.warn(`take teardown: ${what} failed (${isGuiError(err) ? err.code : err && err.message})`, { takeId: t.takeId });
        return false;
      }
    };
    if (t.policy && t.holder.current === t.policy) t.holder.clear();
    if (t.recording) {
      const rec = t.recording;
      t.recording = null;
      const done = { path: rec.path, started_at: rec.started_at, stopped_at: null, duration_s: null, bytes: null };
      // A stop that fails found no recording to finish (the helper dropped it, or cannot be
      // reached): the video is not what was asked for.
      const stopped = await step('record_stop', async () => {
        const res = await this.broker.recordStop({ pid: rec.pid }, ctx);
        Object.assign(done, {
          path: res && typeof res.path === 'string' ? res.path : rec.path,
          duration_s: res && Number.isFinite(res.durationS) ? res.durationS : null,
          bytes: res && Number.isFinite(res.bytes) ? res.bytes : null,
          truncated: Boolean(res && res.truncated)
        });
        if (res && res.exited === true) {
          done.exited = true;
          t.recorderExited = true;
        }
      });
      if (!stopped) t.recordStopFailed = true;
      done.stopped_at = iso(this.clock());
      t.recordingDone = done;
    }
    if (t.awake) {
      t.awake = false;
      await step('keep_awake off', () => this.broker.keepAwake(false, ctx));
    }
    let closedOverCdp = false;
    if (t.browser && this.personal) {
      // C-4: Playwright launched it, so stop() ends Chrome. A kept one leaves the registry (no
      // tool reaches it) and is closed by stopAll.
      const browser = t.browser;
      t.browser = null;
      if (t.registered) {
        t.registered = false;
        await step('the browser registry', () => this.registry.removeBrowser(t.browserKey));
      }
      if (keepBrowser) this._keep(browser, t.profile);
      else await step('closing the browser', () => browser.stop());
    }
    if (t.browser) {
      const browser = t.browser;
      t.browser = null;
      if (!keepBrowser) closedOverCdp = await step('closing the browser', () => this.closeBrowser(browser));
      if (t.registered) {
        t.registered = false;
        await step('the browser registry', () => this.registry.removeBrowser(t.browserKey));
      }
      await step('disconnecting the browser', () => browser.stop());
    }
    // The Chrome the helper launched, when it was never attached or would not close over CDP.
    if (t.browserPid !== null) {
      const pid = t.browserPid;
      t.browserPid = null;
      if (!keepBrowser && !closedOverCdp) await step('ending the browser process', () => this.broker.closeLaunched(pid, ctx));
    }
  }

  end(takeId, reason, opts = {}) {
    const t = this.takes.get(takeId);
    if (!t) return Promise.resolve(null);
    if (!t.ending) t.ending = this._end(t, String(reason || 'ended'), opts);
    return t.ending;
  }

  async _end(t, reason, opts) {
    // First and at once: the take approves nothing more, and its policy leaves the session.
    t.ended = true;
    if (t.policy && t.holder.current === t.policy) t.holder.clear();
    if (t.silentTimer) this.timers.clearTimeout(t.silentTimer);
    t.silentTimer = null;
    await this._release(t, opts);
    // The model said done, but ffmpeg had already gone, or the stop found no recording: the
    // video is not what was asked for, and the take never says take_done (final review I-3).
    if ((t.recorderExited || t.recordStopFailed) && reason === 'take_done') reason = 'recorder_failed';
    t.endReason = reason;
    // Only the lease this take's own request made.
    try {
      if (t.leaseId) this.leases.endLease(t.leaseId, reason);
    } catch (err) {
      this.log.warn(`take teardown: releasing the lease failed (${err.message})`, { takeId: t.takeId });
    }
    if (t.listener) this.leases.off('state', t.listener);
    const at = iso(this.clock());
    const current = this.store.get(t.takeId);
    const log = current && Array.isArray(current.log) ? current.log : [];
    const patch = { state: 'ended', ended: { at, reason }, log: [...log, { at, ended: reason }] };
    if (t.recordingDone) patch.recording = t.recordingDone;
    const written = this._safeUpdate(t.takeId, patch);
    if (this.active === t) this.active = null;
    if (this.audit) {
      Promise.resolve().then(() => this.audit.append({ kind: 'take.ended', data: { take_id: t.takeId, job_id: t.jobId, reason } }))
        .catch((err) => this.log.warn(`audit take.ended failed: ${err.message}`));
    }
    return written || current;
  }

  // Take.stop: the model's own ending.
  async stop(takeId, { keepBrowser = false, reason = null } = {}) {
    const t = this.takes.get(takeId);
    if (!t || t.ended) throw invalid('the take has ended');
    if (reason !== null && reason !== undefined) this.note(takeId, reason);
    const record = await this.end(takeId, 'take_done', { keepBrowser });
    const rec = record && record.recording;
    return {
      // `truncated` only when the helper said so (ffmpeg killed, or gone early).
      recording: rec ? { path: rec.path ?? null, duration_s: rec.duration_s ?? null, bytes: rec.bytes ?? null, ...(rec.truncated === true ? { truncated: true } : {}) } : null,
      steps: record ? this.store.summary(record).steps : { done: 0, failed: 0, total: 0 },
      ended: record && record.ended ? record.ended.reason : 'take_done'
    };
  }

  async status(takeId) {
    const record = this.store.get(takeId);
    if (!record) throw invalid('no such take');
    const summary = this.store.summary(record);
    const t = this.takes.get(takeId);
    const live = t && !t.ended;
    const expiresAt = record.grant && record.grant.expires_at ? Date.parse(record.grant.expires_at) : null;
    const rec = record.recording;
    let tabs = null;
    if (live && t.browser && typeof t.browser.getPages === 'function') {
      try {
        tabs = (await t.browser.getPages()).map((pg) => ({ index: pg.index, url: pg.url, current: pg.isCurrent === true }));
      } catch {
        tabs = null;
      }
    }
    return {
      ...summary,
      lease: { expires_at: summary.lease.expires_at, left_s: live && expiresAt ? Math.max(0, Math.round((expiresAt - this.clock()) / 1000)) : 0 },
      recording: rec ? {
        path: rec.path ?? null,
        started_at: rec.started_at ?? null,
        duration_s: rec.duration_s ?? (live && rec.started_at ? Math.max(0, Math.round((this.clock() - Date.parse(rec.started_at)) / 1000)) : null)
      } : null,
      browser: live ? { tabs } : null,
      ended: record.ended
    };
  }

  note(takeId, text) {
    const t = this.takes.get(takeId);
    if (!t || t.ended) throw invalid('the take has ended');
    if (!plainLine(text, NOTE_MAX)) throw invalid(`a note must be one plain line of 1–${NOTE_MAX} characters`);
    const record = this.store.get(takeId);
    const log = record && Array.isArray(record.log) ? record.log : [];
    this.store.update(takeId, { log: [...log, { at: iso(this.clock()), text }] });
  }

  _activeFor(jobId) {
    const t = this.active;
    return t && t.jobId === jobId && !t.ended ? t : null;
  }

  // A turn of the take's session starts: the driver answered.
  onTurnStart(jobId) {
    const t = this._activeFor(jobId);
    if (!t) return;
    if (t.silentTimer) this.timers.clearTimeout(t.silentTimer);
    t.silentTimer = null;
    if (t.policy) this._safeUpdate(t.takeId, { state: 'live' });
  }

  // The turn ended (a report, or stuck): the take waits for the driver, at most 30 minutes (C-6).
  onTurnEnd(jobId) {
    const t = this._activeFor(jobId);
    if (!t || !t.policy) return;
    this._safeUpdate(t.takeId, { state: 'waiting' });
    if (t.silentTimer) this.timers.clearTimeout(t.silentTimer);
    t.silentTimer = this.timers.setTimeout(() => {
      t.silentTimer = null;
      this.end(t.takeId, 'driver_silent').catch(() => {});
    }, SILENT_MS);
    if (t.silentTimer && typeof t.silentTimer.unref === 'function') t.silentTimer.unref();
  }

  // ffmpeg exited before it was asked to stop (a helper event, when one is wired).
  onRecorderExit(pid) {
    const t = this.active;
    if (!t || t.ended || !t.recording || t.recording.pid !== pid) return Promise.resolve(null);
    t.recorderExited = true;
    return this.end(t.takeId, 'recorder_failed');
  }

  // The broker's helper_lost: the helper has been gone 30 s and has stopped its recordings.
  onHelperLost() {
    const t = this.active;
    if (!t || t.ended) return Promise.resolve(null);
    return this.end(t.takeId, 'helper_lost');
  }

  // C-12: a lock that still happens ends the take; the recording is kept.
  onLocked() {
    const t = this.active;
    if (!t || t.ended) return Promise.resolve(null);
    return this.end(t.takeId, 'screen_locked');
  }

  endForJob(jobId, reason) {
    const t = this._activeFor(jobId);
    return t ? this.end(t.takeId, reason) : Promise.resolve(null);
  }

  // Ends every take, and waits for any start still going to let go of what it made.
  async stopAll(reason = 'service_stopped') {
    const all = [...this.takes.values()];
    await Promise.all(all.filter((t) => !t.ended).map((t) => this.end(t.takeId, reason)));
    await Promise.all(all.map((t) => t.startSettled));
    const kept = [...this.kept];
    this.kept.clear();
    await Promise.all(kept.map(({ browser }) => browser.stop().catch((err) => {
      this.log.warn(`a kept take browser did not close: ${err && err.message}`);
    })));
  }
}

module.exports = { TakeManager, SILENT_MS, RECORDER_MISSING, recordMaxS, launchPersonalBrowser };
