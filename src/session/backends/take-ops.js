// src/session/backends/take-ops.js
// Demo takes (D1): launch_browser, record_start, record_stop and keep_awake
// exist on Windows only. The one definition of the refusal, for the macOS,
// X11 and Wayland backends. There is never a recording to stop there.
const { GuiError } = require('../../gui/errors');

const TAKE_OPS_WINDOWS_ONLY = 'recording and browser launch are Windows only in D1';

function windowsOnlyTakeOps() {
  const refuse = async () => { throw new GuiError('capability_unavailable', TAKE_OPS_WINDOWS_ONLY); };
  return { launchBrowser: refuse, recordStart: refuse, recordStop: refuse, keepAwake: refuse, stopRecordings: async () => [] };
}

module.exports = { windowsOnlyTakeOps, TAKE_OPS_WINDOWS_ONLY };
