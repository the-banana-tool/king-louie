// src/ipc/contact-handlers.js
// Cases stage 4 IPC (spec §5.2): the ladder state, the contact policy and
// presence. Everything goes through core.context.getContact().
const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

// F7's origin marks events proxied from an attached desktop. Absent before F7.
let origin = null;
try {
  origin = require('../core/origin');
} catch {
  origin = null;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function registerContactHandlers(ipcMain, context = {}) {
  const contact = () => {
    const c = typeof context.getContact === 'function' ? context.getContact() : null;
    if (!c) throw new Error('Contact is not available in this host.');
    return c;
  };
  const handle = (channel, fn) => ipcMain.handle(channel, wrapHandler(channel, fn));

  const fromMainWindow = (event) => {
    const win = typeof context.getMainWindow === 'function' ? context.getMainWindow() : null;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
    return Boolean(event && event.sender && event.sender === win.webContents);
  };
  const fromAttachedDesktop = (event) => Boolean(origin && typeof origin.isLocalDesktopEvent === 'function' && origin.isLocalDesktopEvent(event));

  handle(IPC.CONTACT_LADDER_STATE, async () => ({ ok: true, state: contact().ladderState() }));

  handle(IPC.CONTACT_POLICY_GET, async () => ({ ok: true, ...contact().getPolicy() }));

  handle(IPC.CONTACT_POLICY_SET, async (_event, policy) => contact().setPolicy(policy));

  handle(IPC.PRESENCE_HEARTBEAT, async (event, payload) => {
    if (!fromMainWindow(event) && !fromAttachedDesktop(event)) {
      return { ok: false, error: 'presence:heartbeat is accepted only from the main window or an attached desktop.' };
    }
    const p = payload && typeof payload === 'object' ? payload : {};
    if (p.focused !== undefined && typeof p.focused !== 'boolean') return { ok: false, error: 'focused must be true or false.' };
    if (p.lastInputAt !== undefined && p.lastInputAt !== null && (typeof p.lastInputAt !== 'string' || !RFC3339.test(p.lastInputAt))) {
      return { ok: false, error: 'lastInputAt must be an RFC3339 date-time.' };
    }
    return contact().heartbeat({ focused: p.focused === true, lastInputAt: p.lastInputAt || null });
  });

  handle(IPC.PRESENCE_STATUS, async () => ({ ok: true, ...contact().presenceStatus() }));
}

module.exports = { registerContactHandlers };
