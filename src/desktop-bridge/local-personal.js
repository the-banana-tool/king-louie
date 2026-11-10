// src/desktop-bridge/local-personal.js
// The one rule for "this window serves this machine's personal node"
// (boot-node-tray spec §5.2, §5.4, C-10): the local pairing record, on
// Windows, saying `hosting: personal` with its data dir. A remote entry
// (attach stage 3) is never one. The attached host starts the screen host by
// it, and main.js turns tray mode on by it. Electron-free.

// The node's data dir when the pairing is the local personal node's, else null.
function localPersonalDataDir(pairing, platform) {
  if (platform !== 'win32') return null;
  if (!pairing || typeof pairing !== 'object' || pairing.kind === 'remote') return null;
  const svc = pairing.service;
  return svc && svc.hosting === 'personal' && typeof svc.dataDir === 'string' && svc.dataDir ? svc.dataDir : null;
}

// Tray mode: an attached launch that connects (not the setup view's
// `needs-node` with nothing attached) to the local personal node.
// Standalone, development and fleet launches never have it.
function trayModeOn({ launch, platform, pairing, stateMode }) {
  if (!launch || launch.host !== 'attached') return false;
  // The launch rule gives `needs-node` only when the stored mode is not
  // attached; the stateMode operand is defensive, matching attached-host's
  // own `mode` choice should that rule ever change.
  if (launch.why === 'needs-node' && stateMode !== 'attached') return false;
  return localPersonalDataDir(pairing, platform) !== null;
}

module.exports = { localPersonalDataDir, trayModeOn };
