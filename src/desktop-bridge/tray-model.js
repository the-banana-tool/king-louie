// src/desktop-bridge/tray-model.js
// What the tray shows (boot-node-tray spec §5.4, C-9), from the desktop
// controller's status() and whether the screen host is recording a take.
// Pure and Electron-free: src/ipc/tray.js draws it. The node's state is read
// from the same fields as pane-model.js's describeAttachedBanner (`view`,
// `node`), and a down node's Start or Restart is that banner's row action.
const { disconnectedRow } = require('./pane-model');

const LABELS = Object.freeze({
  open: 'Open King Louie',
  start: 'Start King Louie Node',
  restart: 'Restart King Louie Node',
  take: 'A take is recording',
  quit: 'Quit King Louie'
});

const STATE_WORDS = Object.freeze({
  running: 'running',
  starting: 'starting…',
  stopped: 'stopped',
  'not-installed': 'not installed',
  unreachable: 'not reachable'
});

const TOOLTIPS = Object.freeze({
  running: 'King Louie: node running',
  starting: 'King Louie Node is starting…',
  stopped: 'King Louie: node stopped',
  'not-installed': 'King Louie: node not installed',
  unreachable: 'King Louie: node not reachable'
});

function personalNode(s) {
  return s.node && s.node.hosting === 'personal' ? s.node : null;
}

// The node's state in one word, and the press a down node offers.
function nodeState(s) {
  if (s.view === 'attached-connected') return { state: 'running', icon: 'up', press: 'restart' };
  if (s.view === 'attached-starting') return { state: 'starting', icon: 'starting', press: null };
  const n = personalNode(s);
  const row = n ? disconnectedRow(n, { install: null }) : null;
  const action = row && row.action ? row.action.id : null;
  const press = action === 'nodeStart' ? 'start' : action === 'nodeRestart' ? 'restart' : null;
  let state = 'unreachable';
  if (n && (n.task === 'missing' || n.programGone)) state = 'not-installed';
  else if (n && !n.running && n.task === 'registered') state = 'stopped';
  return { state, icon: 'down', press };
}

function trayModel(status, { recording = false } = {}) {
  const s = status || {};
  const { state, icon, press } = nodeState(s);
  const items = [
    { id: 'open', label: LABELS.open, enabled: true },
    { id: 'state', label: `King Louie Node: ${STATE_WORDS[state]}`, enabled: false }
  ];
  if (press) items.push({ id: press, label: LABELS[press], enabled: true });
  if (recording === true) items.push({ id: 'take', label: LABELS.take, enabled: false });
  items.push({ id: 'quit', label: LABELS.quit, enabled: true });
  return { icon, tooltip: TOOLTIPS[state], items };
}

module.exports = { trayModel, LABELS, TOOLTIPS };
