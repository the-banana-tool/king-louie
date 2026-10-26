// src/session/session-watch.js
// The two polls a connected session runs (fleet stage 5 spec §3.3): a
// re-probe that says `probe_changed` when the capabilities or limits move,
// and a lock poll that says `locked` / `unlocked`. Shared by the session
// helper and the in-process channel; timers are injectable for tests.
const { NO_BACKEND_REPORT } = require('./backends');

async function safeProbe(backend, log) {
  try {
    const r = await backend.probe();
    return { capabilities: r.capabilities || [], probes: r.probes || [], displays: r.displays || [], limits: r.limits || [], locked: r.locked === true };
  } catch (err) {
    log.warn(`probe failed: ${err.message}`);
    return NO_BACKEND_REPORT(`the probe failed: ${err.message}`);
  }
}

function startSessionWatch(backend, { report, emit, recorder, log, reprobeMs = 60000, lockPollMs = 2000, timers = { setInterval, clearInterval } } = {}) {
  const withRecorder = (r) => ({ ...r, recorder });
  let current = report;
  let lastLocked = report.locked;
  // A callback already awaiting the backend when stop() runs says nothing.
  let stopped = false;
  const reprobe = timers.setInterval(async () => {
    if (!backend) return;
    const next = withRecorder(await safeProbe(backend, log));
    if (stopped) return;
    if (JSON.stringify(next.capabilities) !== JSON.stringify(current.capabilities) || JSON.stringify(next.limits) !== JSON.stringify(current.limits)) {
      current = next;
      emit('probe_changed', next);
    }
  }, reprobeMs || 60000);
  const lockPoll = timers.setInterval(async () => {
    if (!backend || typeof backend.locked !== 'function') return;
    let now;
    try { now = await backend.locked(); } catch { return; }
    if (stopped) return;
    if (now === null || now === lastLocked) return;
    lastLocked = now;
    emit(now ? 'locked' : 'unlocked', {});
  }, lockPollMs || 2000);
  return {
    stop() {
      stopped = true;
      timers.clearInterval(reprobe);
      timers.clearInterval(lockPoll);
    },
    current: () => current
  };
}

module.exports = { startSessionWatch, safeProbe };
