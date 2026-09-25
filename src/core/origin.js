// Desktop origin marks (program §4.21, fleet stage 7 §3.5).
//
// The Electron host marks every IPC event before a handler sees it, and the
// desktop bridge marks the events it builds for a paired desktop. A run whose
// event is marked is a local desktop session: it keeps the on-screen approval,
// ask-user and directory dialogs. A ToolExecutor built for such a run (F3's
// `localOrigin`) marks the requester closure it hands to tools, so a child
// agent, which the core builds with event = null and the parent's requester,
// is local too.
//
// WeakMaps keyed on the objects themselves: a mark cannot be forged by copying
// fields into a payload, and nothing is kept alive by being marked. Only the
// standalone host's ipcMain wrapper and the bridge dispatcher call
// markLocalDesktopEvent (tests/core-origin.test.js pins that).
const localEvents = new WeakMap();
const localRequesters = new WeakMap();

function markLocalDesktopEvent(event, { deviceId = null } = {}) {
  if (event && typeof event === 'object') localEvents.set(event, { deviceId: deviceId || null });
  return event;
}

function isLocalDesktopEvent(event) {
  return Boolean(event) && typeof event === 'object' && localEvents.has(event);
}

// The kld- id for bridge events, null for the Electron host's own window.
function localDesktopDeviceId(event) {
  if (!isLocalDesktopEvent(event)) return null;
  return localEvents.get(event).deviceId;
}

function markLocalRequester(fn, { deviceId = null } = {}) {
  if (typeof fn === 'function') localRequesters.set(fn, { deviceId: deviceId || null });
  return fn;
}

function isLocalRequester(fn) {
  return typeof fn === 'function' && localRequesters.has(fn);
}

module.exports = {
  markLocalDesktopEvent,
  isLocalDesktopEvent,
  localDesktopDeviceId,
  markLocalRequester,
  isLocalRequester
};
