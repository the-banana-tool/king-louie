// The one rule that decides how the app launches (spec
// 2026-11-03-attach-stage2-design §6.1). main.js calls it once, before any
// host is built. First match wins. Stage 4 removes the `platform` row.
const STANDALONE_FLAG = '--kl-standalone';
const STANDALONE_ONCE_FLAG = '--kl-standalone-once';
// Boot-node-tray §5.4 (C-8): start in the tray with no window shown. It says
// only how the window starts; it never takes part in the host choice below,
// and it shows nothing hidden unless tray mode is on (local-personal.js).
const TRAY_FLAG = '--kl-tray';

// `migrated`: the marker of a verified move (§6.5). A migrated profile is never
// opened as a live King Louie again, so the once flag means nothing to it; the
// development flag, which is no product path, still opens it.
function resolveLaunchMode({ argv, platform, stateMode, migrated = false }) {
  if (argv.includes(STANDALONE_ONCE_FLAG) && !migrated) return { host: 'standalone', why: 'once', degraded: true };
  if (argv.includes(STANDALONE_FLAG)) return { host: 'standalone', why: 'dev', degraded: false };
  if (stateMode === 'attached') return { host: 'attached', why: 'attached', degraded: false };
  if (platform !== 'win32') return { host: 'standalone', why: 'platform', degraded: false };
  return { host: 'attached', why: 'needs-node', degraded: false };
}

// The arguments a relaunch passes (argv without the binary): both standalone
// flags go, since the persisted mode decides again, and so does the tray flag:
// every relaunch follows a press in the visible window, so it comes back
// visible. Everything else stays. `extraArgs` are appended.
const RELAUNCH_DROPS = new Set([STANDALONE_ONCE_FLAG, STANDALONE_FLAG, TRAY_FLAG]);
function relaunchArgs(argv, extraArgs = []) {
  return argv.slice(1).filter((a) => !RELAUNCH_DROPS.has(a)).concat(extraArgs);
}

const startsInTray = (argv) => Array.isArray(argv) && argv.includes(TRAY_FLAG);

module.exports = { resolveLaunchMode, relaunchArgs, startsInTray, STANDALONE_FLAG, STANDALONE_ONCE_FLAG, TRAY_FLAG };
