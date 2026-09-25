// Whether the service account can read/write a path, found out by doing it:
// fs.access ignores Windows ACLs (fleet stage 7 §3.4 bridge.checkPath).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');

const log = createLogger('desktop-bridge/check-path');

const NOT_THERE = Object.freeze({ ok: true, exists: false, isDirectory: false, readable: false, writable: false });

async function checkPath(target, { fsp = fs.promises } = {}) {
  if (typeof target !== 'string' || !target || target.includes('\0') || !path.isAbsolute(target)) {
    return { ...NOT_THERE };
  }

  let st;
  try {
    st = await fsp.stat(target);
  } catch {
    // ENOENT, EACCES, EPERM, etc. — all reported as "not there", never thrown.
    return { ...NOT_THERE };
  }

  const isDirectory = st.isDirectory();
  let readable = false;
  let writable = false;

  if (isDirectory) {
    try {
      const handle = await fsp.opendir(target);
      await handle.close();
      readable = true;
    } catch { /* not readable */ }

    const probe = path.join(target, `.kl-write-probe-${crypto.randomBytes(6).toString('hex')}`);
    let created = false;
    try {
      const handle = await fsp.open(probe, 'wx');
      created = true;
      await handle.close();
      writable = true;
    } catch { /* not writable */ }
    if (created) {
      try {
        await fsp.rm(probe, { force: true });
      } catch (err) {
        // Best-effort cleanup failed; report rather than hide it. The probe
        // may still be left behind (e.g. a concurrent actor holds it open),
        // but callers see writable:true either way, so nothing above this
        // call depends on the cleanup succeeding.
        log.warn('could not remove write probe', { probe, error: err.message });
      }
    }
  } else {
    try {
      const handle = await fsp.open(target, 'r');
      await handle.close();
      readable = true;
    } catch { /* not readable */ }
    try {
      const handle = await fsp.open(target, 'r+');
      await handle.close();
      writable = true;
    } catch { /* not writable */ }
  }

  return { ok: true, exists: true, isDirectory, readable, writable };
}

module.exports = { checkPath };
