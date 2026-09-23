// Configuration surface for the two chat-channel security rules that landed
// in fix wave 3:
//
//   1. An unconfigured channel denies every sender (src/channels/allowlist-manager.js).
//      Without a way to add an id, the owner's own messages are refused too.
//   2. A tool approval is sent only to an explicitly configured owner target
//      (`channels.<channel>.approvalChatId`), never back to the chat that asked
//      for the tool, and is denied outright when no target is set
//      (src/channels/sender-policy.js `resolveApprovalTarget`).
//
// These handlers deliberately expose *only* add/remove of individual ids.
// There is no way to send `default: 'allow'` from the renderer: re-opening a
// channel to everyone is exactly the hole wave 3 closed.
const { wrapHandler } = require('./wrap-handler');
const C = require('./constants');
const AllowlistManager = require('../channels/allowlist-manager');
const { createLogger } = require('../logging');

const log = createLogger('channels/admin');

// Slack is absent on purpose: SlackChannel has no allowlist check and no
// approval handler yet, so offering its settings here would claim a gate
// that does not exist.
const KNOWN_CHANNELS = new Set(['telegram', 'discord']);

function assertKnownChannel(channel) {
  const name = String(channel || '').trim().toLowerCase();
  if (!KNOWN_CHANNELS.has(name)) {
    throw new Error(`Unknown channel "${channel}". Known channels: ${[...KNOWN_CHANNELS].join(', ')}`);
  }
  return name;
}

function assertId(id) {
  const value = String(id == null ? '' : id).trim();
  if (!value) throw new Error('An id is required.');
  return value;
}

function assertKind(kind) {
  const value = String(kind || '').trim().toLowerCase();
  if (value !== 'user' && value !== 'group') {
    throw new Error('kind must be "user" or "group".');
  }
  return value;
}

function registerChannelHandlers(ipcMain, context = {}) {
  const getStore = () =>
    (typeof context.getStore === 'function' ? context.getStore() : null) || context.store || null;

  // The core owns one manager; fall back to a store-backed one so a context
  // that predates the getter still works. AllowlistManager keeps the policy
  // in the store, so both see the same data — only the in-memory refusal
  // journal is per instance.
  let fallbackManager = null;
  const getAllowlistManager = () => {
    const fromContext =
      (typeof context.getAllowlistManager === 'function' ? context.getAllowlistManager() : null)
      || context.allowlistManager
      || null;
    if (fromContext) return fromContext;
    const store = getStore();
    if (!store) throw new Error('Store not available');
    if (!fallbackManager) fallbackManager = new AllowlistManager(store);
    return fallbackManager;
  };

  const getSettings = () => (typeof context.getSettings === 'function' ? context.getSettings() : {}) || {};
  const setSettings = (next) => {
    if (typeof context.setSettings !== 'function') throw new Error('Settings are not writable');
    return context.setSettings(next);
  };

  const readApprovalChatId = (channel) => {
    const value = getSettings().channels?.[channel]?.approvalChatId;
    return String(value == null ? '' : value).trim();
  };

  const describe = (channel) => {
    const manager = getAllowlistManager();
    const policy = manager.getPolicy(channel);
    return {
      channel,
      defaultPolicy: policy.default,
      users: policy.users,
      groups: policy.groups,
      approvalChatId: readApprovalChatId(channel),
      recentRefusals: typeof manager.listRecentRefusals === 'function'
        ? manager.listRecentRefusals(channel)
        : []
    };
  };

  ipcMain.handle(C.CHANNEL_ACCESS_GET, wrapHandler(C.CHANNEL_ACCESS_GET, async (_event, params = {}) => {
    return describe(assertKnownChannel(params.channel));
  }));

  ipcMain.handle(C.CHANNEL_ACCESS_ALLOW, wrapHandler(C.CHANNEL_ACCESS_ALLOW, async (_event, params = {}) => {
    const channel = assertKnownChannel(params.channel);
    const kind = assertKind(params.kind);
    const id = assertId(params.id);
    const manager = getAllowlistManager();
    if (kind === 'user') manager.addUser(channel, id);
    else manager.addGroup(channel, id);
    log.info(`allowlisted ${kind} ${id} on ${channel}`);
    return describe(channel);
  }));

  ipcMain.handle(C.CHANNEL_ACCESS_REMOVE, wrapHandler(C.CHANNEL_ACCESS_REMOVE, async (_event, params = {}) => {
    const channel = assertKnownChannel(params.channel);
    const kind = assertKind(params.kind);
    const id = assertId(params.id);
    const manager = getAllowlistManager();
    if (kind === 'user') manager.removeUser(channel, id);
    else manager.removeGroup(channel, id);
    log.info(`removed ${kind} ${id} from the ${channel} allowlist`);
    return describe(channel);
  }));

  ipcMain.handle(C.CHANNEL_SET_APPROVAL_TARGET, wrapHandler(C.CHANNEL_SET_APPROVAL_TARGET, async (_event, params = {}) => {
    const channel = assertKnownChannel(params.channel);
    // An empty value is meaningful: it clears the target, which puts the
    // channel back to denying every approval.
    const approvalChatId = String(params.approvalChatId == null ? '' : params.approvalChatId).trim();
    const settings = getSettings();
    setSettings({
      ...settings,
      channels: {
        ...(settings.channels || {}),
        [channel]: { ...(settings.channels?.[channel] || {}), approvalChatId }
      }
    });
    log.info(approvalChatId
      ? `${channel} approvals will be sent to ${approvalChatId}`
      : `${channel} approval target cleared — channel approvals are denied`);
    return { channel, approvalChatId };
  }));
}

module.exports = { registerChannelHandlers, KNOWN_CHANNELS };
