// src/cases/presence.js
// Where the owner is right now (cases stage 4 spec §3.4): the desktop
// heartbeat, the phone app's foreground pings and owner-proven inbound on
// each channel. Only the per-channel last-seen times persist.
const { validTimeZone } = require('./clock');
const { effectivePolicy, CONTACT_CHANNELS } = require('./contact-format');
const { readJson, writeJson } = require('./jsonfile');
const { createLogger } = require('../logging');

const HEARTBEAT_STALE_MS = 90 * 1000;
const MOBILE_STALE_MS = 120 * 1000;
const MINUTE = 60 * 1000;
const STEP_LIMIT = 26 * 60;

const WALL = new Map();
function wallFormatter(tz) {
  const key = tz || '';
  if (!WALL.has(key)) {
    WALL.set(key, new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }));
  }
  return WALL.get(key);
}

// 'HH:MM' on the wall clock of `tz` at instant `date`.
function wallHhmm(date, tz) {
  const p = {};
  for (const part of wallFormatter(tz).formatToParts(date)) if (part.type !== 'literal') p[part.type] = part.value;
  return `${p.hour}:${p.minute}`;
}

function inWindow(hhmm, start, end) {
  return start > end ? (hhmm >= start || hhmm < end) : (hhmm >= start && hhmm < end);
}

class Presence {
  constructor({
    file, getPolicy = () => ({}), clock = () => new Date(), interactive = () => false, isEnabled = () => false,
    getTimeZone = () => '', log = createLogger('contact/presence')
  } = {}) {
    this.file = file;
    this.getPolicy = getPolicy;
    this.clock = clock;
    this.interactive = interactive;
    this.isEnabled = isEnabled;
    this.getTimeZone = getTimeZone;
    this.log = log;
    this.desktop = null;
    this.mobile = new Map();
    this.channels = this._load();
    this._desktopWasPresent = false;
    this._presentSince = null;
    this._hostZoneLogged = false;
  }

  _load() {
    const data = readJson(this.file, null);
    return data && typeof data.channels === 'object' && data.channels ? { ...data.channels } : {};
  }

  _save() {
    if (!this.file) return;
    writeJson(this.file, { version: 1, channels: this.channels });
  }

  policy() {
    return effectivePolicy(this.getPolicy());
  }

  timeZone() {
    const tz = validTimeZone(this.getTimeZone());
    if (!tz && !this._hostZoneLogged) {
      this._hostZoneLogged = true;
      this.log.info('settings.cases.timeZone is empty; contact times use the host time zone');
    }
    return tz || '';
  }

  // Desktop IPC. lastInputAt is clamped to now; memory only.
  heartbeat({ focused = false, lastInputAt = null } = {}) {
    const now = this.clock();
    const input = Date.parse(lastInputAt);
    const clamped = Number.isFinite(input) ? Math.min(input, now.getTime()) : now.getTime();
    this.desktop = { at: now.getTime(), focused: focused === true, lastInputAt: clamped };
    this._track(now);
    return { ok: true };
  }

  mobileForeground({ deviceId, foreground = true } = {}) {
    if (!deviceId) return { ok: false };
    this.mobile.set(String(deviceId), { at: this.clock().getTime(), foreground: foreground === true });
    return { ok: true };
  }

  // Owner-proven inbound only.
  noteInbound(channelId, at = this.clock()) {
    const t = new Date(at).toISOString();
    if (!this.channels[channelId] || this.channels[channelId] < t) {
      this.channels[channelId] = t;
      this._save();
    }
  }

  _desktopPresent(nowMs) {
    const d = this.desktop;
    if (!d || !this.interactive()) return false;
    const idleMs = this.policy().presence.desktopIdleMin * MINUTE;
    return nowMs - d.at <= HEARTBEAT_STALE_MS && d.focused && nowMs - d.lastInputAt <= idleMs;
  }

  _track(now) {
    const present = this._desktopPresent(now.getTime());
    if (present && !this._desktopWasPresent) this._presentSince = new Date(now.getTime());
    this._desktopWasPresent = present;
    return present;
  }

  // The latest absent → present transition of the desktop.
  desktopPresentSince() {
    this._track(this.clock());
    return this._presentSince;
  }

  _mobileLatest(nowMs) {
    let best = null;
    for (const m of this.mobile.values()) {
      if (m.foreground && nowMs - m.at <= MOBILE_STALE_MS && (!best || m.at > best)) best = m.at;
    }
    return best;
  }

  _ladderOrder(policy) {
    const order = [];
    for (const u of ['high', 'normal', 'low']) {
      for (const s of policy.ladders[u] || []) if (CONTACT_CHANNELS.includes(s.channel) && !order.includes(s.channel)) order.push(s.channel);
    }
    for (const c of CONTACT_CHANNELS) if (!order.includes(c)) order.push(c);
    return order;
  }

  _awayActive(policy, nowMs) {
    return Boolean(policy.away && Date.parse(policy.away.until) > nowMs);
  }

  presentChannel(now = this.clock()) {
    const nowMs = now.getTime();
    const policy = this.policy();
    if (this._awayActive(policy, nowMs)) {
      if (policy.away.mode === 'email-only') return this.isEnabled('email') ? 'email' : null;
      return this.interactive() ? 'in-app' : null;
    }
    const candidates = [];
    if (this._track(now)) candidates.push({ channel: 'in-app', at: this.desktop.lastInputAt, rank: 0 });
    const mobileAt = this.isEnabled('mobile') ? this._mobileLatest(nowMs) : null;
    if (mobileAt !== null) candidates.push({ channel: 'mobile', at: mobileAt, rank: 1 });
    const recentMs = policy.presence.recentInboundMin * MINUTE;
    const order = this._ladderOrder(policy);
    for (const [channel, iso] of Object.entries(this.channels)) {
      const at = Date.parse(iso);
      if (channel === 'in-app' || channel === 'mobile') continue;
      if (!this.isEnabled(channel) || !Number.isFinite(at) || nowMs - at > recentMs) continue;
      candidates.push({ channel, at, rank: 2 + order.indexOf(channel) });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.at - a.at || a.rank - b.rank);
    return candidates[0].channel;
  }

  inQuietHours(now = this.clock()) {
    const q = this.policy().quietHours;
    if (!q) return false;
    return inWindow(wallHhmm(now, this.timeZone()), q.start, q.end);
  }

  // The first whole minute at or after `now` outside the quiet window. An end
  // inside a spring-forward gap lands on the first minute that exists after
  // it; in a fall-back repeat, on the first occurrence.
  nextQuietEnd(now = this.clock()) {
    const q = this.policy().quietHours;
    if (!q) return new Date(now.getTime());
    const tz = this.timeZone();
    let t = Math.ceil(now.getTime() / MINUTE) * MINUTE;
    for (let i = 0; i <= STEP_LIMIT; i += 1, t += MINUTE) {
      if (!inWindow(wallHhmm(new Date(t), tz), q.start, q.end)) return new Date(t);
    }
    return new Date(t);
  }

  status(now = this.clock()) {
    const nowMs = now.getTime();
    const policy = this.policy();
    const desktop = this.desktop
      ? { present: this._desktopPresent(nowMs), heartbeatAt: new Date(this.desktop.at).toISOString(), focused: this.desktop.focused, lastInputAt: new Date(this.desktop.lastInputAt).toISOString() }
      : null;
    const mobileAt = this._mobileLatest(nowMs);
    return {
      presentChannel: this.presentChannel(now),
      away: this._awayActive(policy, nowMs),
      quiet: this.inQuietHours(now),
      timeZoneSource: validTimeZone(this.getTimeZone()) ? 'settings' : 'host',
      signals: {
        desktop,
        mobile: mobileAt === null ? null : { present: true, lastPingAt: new Date(mobileAt).toISOString() },
        channels: { ...this.channels }
      }
    };
  }
}

module.exports = { Presence, wallHhmm, HEARTBEAT_STALE_MS, MOBILE_STALE_MS };
