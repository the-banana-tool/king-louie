// What a remote window may do (remote window plan R-RW-11, spec 2026-11-04 §8):
// the class of every channel and t:'call' method.
//   read      runs; nothing changes on the node
//   ordinary  runs; the owner's words and the chat's own controls
//   phone     one signed approval over the exact arguments, each time
//   local     never served to a remote connection
// A name with no class is refused: remoteClassOf answers null, never a default.
// tests/desktop-bridge-remote-classes.test.js fails on any channel the node
// serves, or call method the dispatcher has, that is not here.
const CLASSES = Object.freeze(['read', 'ordinary', 'phone', 'local']);

const CALL_METHODS = Object.freeze([
  'bridge.status', 'bridge.checkPath', 'bridge.setWorkingDirectory', 'bridge.addAllowedDirectory',
  'bridge.canvasJsResult', 'bridge.approvalsStatus', 'import.plan', 'import.apply', 'import.finish'
]);

// The local entries answered REMOTE_PRESS: the card says "Answer on your phone".
const PRESS_CHANNELS_REMOTE = Object.freeze([
  'case:answerQuestion', 'case:acknowledgeBriefing', 'case:grantBudget', 'case:confirmScope',
  'case:verifyNow', 'case:setCheck', 'case:resolveDetour', 'tool:approvalResponse',
  'tool:directoryAccessResponse'
]);

const READ = [
  'apps:list', 'canvas:getState', 'case:budget', 'case:detours', 'case:envelopes',
  'case:ingestRecord', 'case:list', 'case:listExamplePlaybooks', 'case:orientation',
  'case:playbookProposals', 'case:playbooks', 'case:progress', 'case:questions', 'case:runningTurn',
  'case:sources', 'chat:get', 'chat:load', 'chat:running', 'chat:readScreenshot',
  'checkpoint:changes', 'checkpoint:getStatus', 'checkpoint:list', 'contact:ladderState',
  'contactPolicy:get', 'cron:list', 'cron:status', 'executors:list', 'history:embedder.status',
  'history:excerpts', 'history:links.get', 'history:search', 'hooks:list', 'memory:list',
  'memory:recall', 'models:chatView', 'models:explain', 'models:kingLouie', 'models:local.list',
  'models:picker', 'models:profiles', 'models:status', 'models:usable', 'presence:status',
  'settings:listVoices', 'settings:load', 'settings:mcpList', 'settings:vaultHeld', 'settings:vaultList',
  'skill:checkDeps', 'skill:getPinned', 'skill:list', 'skill:listPinnable', 'tool:list',
  'tool:listPermissionRules', 'usage:getDaily', 'usage:getSession', 'workflow:get', 'workflow:list',
  'workflow:progress', 'bridge.status', 'bridge.checkPath', 'bridge.approvalsStatus'
];

const ORDINARY = [
  'agent:userResponse', 'canvas:close', 'canvas:setState', 'case:create', 'case:ingestExtract',
  'case:reindex', 'case:rejectPlaybookProposal', 'chat:addMessage', 'chat:create', 'chat:rename',
  'chat:sendMessage', 'chat:setActive', 'chat:setAgentMode', 'chat:setDisabledMcpServers',
  'chat:stopResponse', 'cron:remove', 'history:embedder.rebuild', 'history:embedder.retry',
  'history:import.append', 'history:import.begin', 'history:import.finish', 'history:import.lookup',
  'history:links.set', 'history:scope.set', 'memory:delete', 'models:acceptProposal',
  'models:dismissProposal', 'models:duplicateKingLouie', 'models:duplicateProfile',
  'models:refreshCatalog', 'models:removeCustomRole', 'models:removeProfile',
  'models:saveCustomRole', 'models:saveKingLouieSettings', 'models:saveProfile',
  'models:setChatProfile', 'models:setDefaultProfile', 'models:setMainOverride', 'models:testAll',
  'presence:heartbeat', 'settings:removeAllowedDirectory', 'settings:saveVoice',
  'settings:setImageGenDefault', 'settings:testImageGenKey', 'settings:testProvider',
  'settings:testWebSearchKey', 'skill:pin', 'skill:unpin', 'workflow:cancel', 'workflow:delete',
  'workflow:pause', 'bridge.canvasJsResult'
];

// tool:execute is gated by the dispatcher like the rest of this list; the tool
// it runs then asks the phone too, through approvalSeam, as any remote call does.
const PHONE = [
  'apps:add', 'apps:remove', 'apps:rescan', 'case:acceptPlaybookBudget', 'case:acceptVerified',
  'case:addPlaybook', 'case:applyPlaybookProposal', 'case:cancelJob', 'case:ingestFiles',
  'case:markPrivate', 'case:removePlaybook', 'case:revokeEnvelope', 'case:setDisclosable',
  'case:setStatus', 'case:updatePlaybook', 'channel:accessAllow', 'channel:accessGet',
  'channel:accessRemove', 'channel:setApprovalTarget', 'chat:markPrivate',
  'chat:setWorkingDirectory', 'checkpoint:prune', 'checkpoint:restore', 'contactPolicy:set',
  'cron:add', 'cron:run', 'cron:update', 'diagnostics:run', 'history:embedder.save',
  'history:jev.clearKey', 'history:jev.saveKey', 'hooks:reload', 'hooks:setEnabled',
  'hooks:setGlobalEnabled', 'models:setOllamaBaseUrl', 'settings:mcpDelete', 'settings:mcpReload',
  'settings:mcpSave', 'settings:runLlmCommand', 'settings:saveElevenLabsKey',
  'settings:saveImageGenKey', 'settings:saveProvider', 'settings:saveWebSearchKey',
  'settings:vaultDelete', 'settings:vaultStore', 'settings:vaultUpdate', 'skill:customize',
  'skill:execute', 'skill:handleMessage', 'skill:install', 'skill:remove', 'skill:saveSettings',
  'skill:setEnabled', 'skill:update', 'tool:execute', 'webhook:create', 'webhook:delete',
  'webhook:get', 'webhook:list', 'webhook:regenerateSecret', 'webhook:update', 'workflow:create',
  'workflow:plan', 'workflow:planAndExecute', 'workflow:recoverPlan', 'workflow:run',
  'bridge.setWorkingDirectory', 'bridge.addAllowedDirectory', 'tool:removePermissionRule',
  'chat:setSandboxMode', 'settings:saveDefaults', 'case:checkPlaybookUpdates', 'case:attach',
  'case:reviewProposal', 'settings:saveNotifications', 'settings:saveUserProfile',
  'settings:saveTemplateVariables', 'memory:capture', 'models:saveCatalogSettings',
  'checkpoint:setEnabled', 'skill:checkUpdates', 'chat:delete', 'chat:truncateFrom', 'memory:clear',
  'skill:getSettings', 'skill:listWithSettings'
];

const LOCAL = [
  ...PRESS_CHANNELS_REMOTE,
  // Answered REMOTE_LOCAL_ONLY.
  'models:local.add', 'models:local.fromOllama', 'models:local.probe', 'models:local.recheck',
  'models:local.remove', 'models:local.setModelInfo', 'models:local.unsetLocalOnly',
  'import.plan', 'import.apply', 'import.finish',
  // Handled in the window and never sent. Every other desktop: and wizard:
  // channel is local too, by WINDOW_PREFIXES.
  'app:quitWindow', 'history:import.pick', 'history:import.preview', 'history:import.commit',
  'chat:pickWorkingDirectory', 'settings:addAllowedDirectory',
  'desktop:nodes', 'desktop:addFrontDoor', 'desktop:listFrontDoorNodes', 'desktop:addRemoteNode',
  'desktop:forgetNode', 'desktop:enrollRemote', 'desktop:remoteStatus', 'desktop:nodeRemoteWindow'
];

const WINDOW_PREFIXES = Object.freeze(['desktop:', 'wizard:']);

// No prototype, so 'constructor' and '__proto__' are no class.
const table = Object.create(null);
for (const [cls, names] of [['read', READ], ['ordinary', ORDINARY], ['phone', PHONE], ['local', LOCAL]]) {
  for (const name of names) {
    if (table[name]) throw new Error(`${name} is in two classes`);
    table[name] = cls;
  }
}
const REMOTE_CLASSES = Object.freeze(table);

function remoteClassOf(name) {
  if (typeof name !== 'string') return null;
  if (REMOTE_CLASSES[name]) return REMOTE_CLASSES[name];
  return WINDOW_PREFIXES.some((prefix) => name.startsWith(prefix)) ? 'local' : null;
}

// A channel whose class depends on what it is asked to do. It only ever raises
// the table's class, and what it cannot read is phone. `args` is the frame's
// argument list; `context` is the core's, for `getSettings` and `getChat`.
const RAISED_BY_FIELD = Object.freeze({ 'case:create': Object.freeze(['playbooks', 'acceptBudgetRaises']) });
const LEAVES_PROFILE = new Set(['models:removeProfile', 'models:setDefaultProfile', 'models:setChatProfile']);

function payloadOf(args) {
  const first = Array.isArray(args) ? args[0] : args;
  return first && typeof first === 'object' && !Array.isArray(first) ? first : {};
}

function leavesLocalOnlyProfile(channel, payload, context) {
  const models = context.getSettings().models || {};
  const profiles = Array.isArray(models.profiles) ? models.profiles : [];
  const isLocalOnly = (id) => {
    const profile = profiles.find((p) => p && p.id === id);
    return Boolean(profile && Array.isArray(profile.localOnly) && profile.localOnly.length > 0);
  };
  const stored = models.defaultProfileId;
  const defaultId = profiles.some((p) => p && p.id === stored) ? stored : (profiles[0] && profiles[0].id) || null;
  if (channel === 'models:removeProfile') return isLocalOnly(payload.id);
  if (channel === 'models:setDefaultProfile') return payload.id !== defaultId && isLocalOnly(defaultId);
  const chat = context.getChat(payload.chatId);
  // A case keeps its choice in case.yaml, which is not read here.
  if (!chat || chat.caseId) return true;
  const current = chat.profileId || defaultId;
  return (payload.profileId || defaultId) !== current && isLocalOnly(current);
}

function remotePayloadClass(channel, args, context = null) {
  const base = remoteClassOf(channel);
  if (base === null || base === 'phone' || base === 'local') return base;
  const payload = payloadOf(args);
  const fields = Object.hasOwn(RAISED_BY_FIELD, channel) ? RAISED_BY_FIELD[channel] : null;
  if (fields) return fields.some((field) => Object.hasOwn(payload, field)) ? 'phone' : base;
  if (!LEAVES_PROFILE.has(channel)) return base;
  try {
    return leavesLocalOnlyProfile(channel, payload, context) ? 'phone' : base;
  } catch {
    return 'phone';
  }
}

function assertComplete(names) {
  const missing = [...names].filter((name) => remoteClassOf(name) === null);
  if (missing.length > 0) throw new Error(`No remote class for: ${missing.join(', ')}`);
}

module.exports = { CLASSES, REMOTE_CLASSES, CALL_METHODS, PRESS_CHANNELS_REMOTE, remoteClassOf, remotePayloadClass, assertComplete };
