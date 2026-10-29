// What stands between a push and an fcm device (push spec §6.3, §6.4, C-5,
// C-6): dedupe by (node, kind, id) with per-kind windows, a 10-second
// coalescing window per device carrying a count, and at most 60 pushes per
// device per hour. apns devices never come here (C-2).
//
// State is in memory only: a relay restart forgets it, which can repeat one
// push. Timers are unref'd, so a window never holds the relay open; stop()
// drops whatever a window holds (a push is a hint, and the phone's next list
// says the same).
const { createLogger } = require('../../logging');

const log = createLogger('frontdoor/push');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

// How long a pushed (node, kind, id) is remembered per device (§6.3).
const DEDUPE_MS = Object.freeze({
  session_ended: 24 * HOUR,
  session_paused: 2 * MIN
});
// approval, question, lease, pairing, alert (and grant, never pushed today).
const DEFAULT_DEDUPE_MS = 10 * MIN;
// `test` is never deduped: each push-test is meant to arrive.
const NOT_DEDUPED = new Set(['test']);
const MAX_KEYS = 2048;
const COALESCE_MS = 10 * SEC;
const HOURLY_CAP = 60;

const defaultTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };

// send(device, payload) → Promise; payload carries `count` when it stands
// for two or more held items.
function createPushGate({ send, now = Date.now, timers = defaultTimers }) {
  const seen = new Map(); // `${device}\0${node}\0${kind}\0${id}` → expires at, oldest first
  const windows = new Map(); // device id → { timer, held: [{ device, payload }] }
  const sent = new Map(); // device id → [times of the pushes in the last hour]
  const warnedAt = new Map(); // device id → time of the last cap warning
  let stopped = false;

  const arm = (fn, ms) => {
    const handle = timers.setTimeout(fn, ms);
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  };

  // True when this (node, kind, id) was pushed to this device inside its window.
  function duplicate(deviceId, payload, nodeId) {
    if (NOT_DEDUPED.has(payload.kind)) return false;
    const key = `${deviceId}\0${nodeId || ''}\0${payload.kind}\0${payload.id}`;
    const t = now();
    const until = seen.get(key);
    if (until !== undefined && until > t) return true;
    seen.delete(key);
    seen.set(key, t + (DEDUPE_MS[payload.kind] || DEFAULT_DEDUPE_MS));
    while (seen.size > MAX_KEYS) seen.delete(seen.keys().next().value);
    return false;
  }

  // The hourly cap, checked when a push actually leaves.
  function underCap(deviceId) {
    const t = now();
    const times = (sent.get(deviceId) || []).filter((at) => at > t - HOUR);
    if (times.length >= HOURLY_CAP) {
      sent.set(deviceId, times);
      const warned = warnedAt.get(deviceId);
      if (warned === undefined || warned <= t - HOUR) {
        warnedAt.set(deviceId, t);
        log.warn(`push to ${deviceId} dropped: ${HOURLY_CAP} pushes in the last hour (further drops this hour are not logged)`);
      }
      return false;
    }
    times.push(t);
    sent.set(deviceId, times);
    return true;
  }

  function release(device, payload) {
    if (!underCap(device.device_id)) return Promise.resolve();
    return send(device, payload);
  }

  function openWindow(deviceId) {
    const w = { held: [], timer: null };
    w.timer = arm(() => closeWindow(deviceId, w), COALESCE_MS);
    windows.set(deviceId, w);
  }

  function closeWindow(deviceId, w) {
    if (windows.get(deviceId) !== w) return;
    windows.delete(deviceId);
    if (stopped || w.held.length === 0) return;
    const newest = w.held[w.held.length - 1];
    const payload = { ...newest.payload };
    delete payload.count;
    if (w.held.length > 1) payload.count = w.held.length;
    openWindow(deviceId);
    release(newest.device, payload).catch((err) => log.warn(`coalesced push to ${deviceId} failed: ${err && err.message}`));
  }

  return {
    // Resolves once the push left, or at once when it was deduped, held or stopped.
    notify(device, payload, nodeId = null) {
      if (stopped) return Promise.resolve();
      const deviceId = device.device_id;
      if (duplicate(deviceId, payload, nodeId)) return Promise.resolve();
      const w = windows.get(deviceId);
      if (w) {
        w.held.push({ device, payload });
        return Promise.resolve();
      }
      openWindow(deviceId);
      return release(device, payload);
    },
    // Drops what the windows hold and clears their timers.
    stop() {
      stopped = true;
      for (const w of windows.values()) timers.clearTimeout(w.timer);
      windows.clear();
    }
  };
}

module.exports = { createPushGate, DEDUPE_MS, DEFAULT_DEDUPE_MS, MAX_KEYS, COALESCE_MS, HOURLY_CAP };
