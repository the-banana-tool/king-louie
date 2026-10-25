// src/session/backends/wayland.js
// Wayland (fleet stage 5 spec §3.3, §11.4): no portal exposes the focused
// window's process, and the Screenshot portal returns full-screen or
// interactive captures, so only gui.launch is offered.
const fs = require('fs');
const { GuiError } = require('../../gui/errors');
const { listProcesses, launchDetached, windowsOnlyTakeOps } = require('./linux-common');

function createWaylandBackend({ spawnImpl, readdir = fs.readdirSync, readlink = fs.readlinkSync } = {}) {
  const none = async () => { throw new GuiError('capability_unavailable', 'gui.input'); };
  return {
    name: 'wayland',
    probe: async () => ({
      capabilities: ['gui.launch'],
      probes: [{ check: 'wayland', ok: false, hint: 'Wayland session: apps can be launched, but screenshots and input are not available' }],
      displays: [], limits: [], locked: false
    }),
    launch: ({ exe, argv, files }) => launchDetached({ exe, argv, files, ...(spawnImpl ? { spawnImpl } : {}) }),
    processes: async ({ match }) => listProcesses({ match, readdir, readlink }),
    windows: async () => [],
    foreground: async () => null,
    focus: async () => ({ focused: false }),
    close: async ({ pids, force }) => {
      const closed = [];
      for (const pid of pids || []) {
        try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); closed.push(pid); } catch { /* gone */ }
      }
      return { closed };
    },
    screenshot: async () => { throw new GuiError('capability_unavailable', 'gui.screenshot'); },
    input: none,
    releaseAll: async () => null,
    locked: async () => null,
    hitTest: async () => null,
    ...windowsOnlyTakeOps(),
    stop: async () => {}
  };
}

module.exports = { createWaylandBackend };
