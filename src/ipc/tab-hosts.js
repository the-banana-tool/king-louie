// Task 12: Tabs - coordinator for routing IPC by sender (WebContentsView)
// One createTabHost() instance per tab (entry), routed through createTabHosts()

const { createLogger } = require('../logging');

const log = createLogger('tab-hosts');

/**
 * createTabHosts - coordinates multiple hosts, one per tab
 * Routes IPC handle and on calls to the appropriate host based on sender (webContentsId)
 *
 * @param {Object} opts
 * @param {Object} opts.ipcMain - Electron ipcMain
 * @param {Object} opts.inventory - channel inventory with handle[] and on[]
 * @returns {Object} { add(webContentsId, host), remove(webContentsId), hostOf(event) }
 */
function createTabHosts({ ipcMain, inventory }) {
  const hostsMap = new Map(); // webContentsId -> host

  /**
   * Route an IPC event to its host by sender.id
   * Returns null if no host is registered for this sender
   */
  function hostOf(event) {
    if (!event || !event.sender) return null;
    return hostsMap.get(event.sender.id) || null;
  }

  /**
   * Register one ipcMain.handle for each inventory.handle channel
   * All senders route to their respective host
   */
  if (inventory.handle && Array.isArray(inventory.handle)) {
    for (const item of inventory.handle) {
      const channel = item.channel;
      ipcMain.handle(channel, async (event, ...args) => {
        const host = hostOf(event);
        if (!host) {
          log.debug(`unknown sender for ${channel}`);
          return { ok: false, code: 'UNKNOWN_SENDER' };
        }
        return host.invoke(channel, ...args);
      });
    }
  }

  /**
   * Register one ipcMain.on for each inventory.on channel
   * All senders route to their respective host
   */
  if (inventory.on && Array.isArray(inventory.on)) {
    for (const item of inventory.on) {
      const channel = item.channel;
      ipcMain.on(channel, (event, ...args) => {
        const host = hostOf(event);
        if (!host) {
          log.debug(`unknown sender for ${channel}`);
          return;
        }
        host.on(channel, ...args);
      });
    }
  }

  return {
    add(webContentsId, host) {
      hostsMap.set(webContentsId, host);
    },
    remove(webContentsId) {
      hostsMap.delete(webContentsId);
    },
    hostOf
  };
}

/**
 * createTabHost - creates a single-tab host from an entry
 * This wraps the attached-host logic for reuse per tab
 *
 * @param {Object} opts
 * @param {Object} opts.entry - tab entry (kind, label, etc)
 * @param {Object} opts.deps - dependencies
 * @returns {Object} host with invoke, on, send, start, shutdown, status, onStatus
 */
function createTabHost({ entry, deps }) {
  // For now, return a minimal host structure
  // This will be extended to use attached-host logic
  const statusCallbacks = [];

  return {
    entry,

    async invoke(channel, ...args) {
      // Will be implemented in main host logic
      return { ok: false, code: 'NOT_IMPLEMENTED' };
    },

    on(channel, ...args) {
      // Will be implemented in main host logic
    },

    send(channel, payload) {
      // Will be implemented in main host logic
    },

    async start() {
      // Will be implemented in main host logic
    },

    async shutdown() {
      // Will be implemented in main host logic
    },

    status() {
      // Will be implemented in main host logic
      return { ok: true };
    },

    onStatus(fn) {
      statusCallbacks.push(fn);
    }
  };
}

module.exports = { createTabHosts, createTabHost };
