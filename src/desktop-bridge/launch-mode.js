// The one rule that decides how the app launches (spec
// 2026-11-03-attach-stage2-design §6.1). main.js calls it once, before any
// host is built. First match wins. Stage 4 removes the `platform` row.
const STANDALONE_FLAG = '--kl-standalone';
const STANDALONE_ONCE_FLAG = '--kl-standalone-once';

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

module.exports = { resolveLaunchMode, STANDALONE_FLAG, STANDALONE_ONCE_FLAG };
