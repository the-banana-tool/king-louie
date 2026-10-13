// tests/e2e/fixtures/session-helper-child.js
// The real session helper, as its own process, for the GUI e2e. The only
// test-only input is the owner of the temp config dir (a test cannot make it
// root-owned); production has no way to set it.
const { runSessionHelper } = require('../../../src/session/helper');

// The test stops this process by closing its IPC channel: on Windows
// child.kill() ends a process without running a SIGTERM handler, and a
// closed channel also ends the helper when the test process itself dies.
const ac = new AbortController();
process.on('SIGTERM', () => ac.abort());
process.on('disconnect', () => ac.abort());
runSessionHelper({ signal: ac.signal, deps: { rootUid: Number(process.env.KL_E2E_ROOT_UID), attachLog: false } })
  .then((code) => process.exit(code), () => process.exit(1));
