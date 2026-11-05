// What a phone card shows of a remote window's call (remote window plan R-RW-12,
// R-RW-30, R-RW-32). The card must show what runs, must not carry a stored value, and
// must not be something a thief can make unreadable:
//   - a channel whose arguments hold a stored value always shows its named fields and
//     a keyed mark (HIDDEN_FIELDS);
//   - the one bulk channel shows names and sizes it read itself, and a keyed mark;
//   - every other call goes on the card whole, up to 64 KiB, each leaf capped, and past
//     that it is refused, so no padding can push what runs out of sight;
//   - a channel with a known shape refuses any other key (ARG_KEYS): JCS sorts keys, so
//     an unknown one could otherwise sit on the card ahead of the real leaves.
// What runs is always parsed from the one text, whatever the card shows.
const { hiddenMark } = require('../approvals/hidden-card');
const { llmCommandAction } = require('../core/llm-command');

const WINDOW_ARGS_INLINE_MAX = 65536;
const WINDOW_LEAF_MAX = 16384;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const namesOf = (value) => (isObject(value) ? Object.keys(value).sort() : []);
const pick = (payload, keys) => Object.fromEntries(keys.filter((k) => Object.hasOwn(payload, k)).map((k) => [k, payload[k]]));

// The first argument's whole set of keys, from each handler.
const ARG_KEYS = Object.freeze({
  'apps:remove': ['id'],
  'bridge.addAllowedDirectory': ['path'],
  'bridge.setWorkingDirectory': ['chatId', 'path'],
  'case:acceptPlaybookBudget': ['caseId', 'name'],
  'case:acceptVerified': ['caseId', 'docId'],
  'case:addPlaybook': ['caseId', 'source', 'adopt', 'ref', 'acceptBudgetRaises'],
  'case:applyPlaybookProposal': ['caseId', 'proposalId', 'repoPath'],
  'case:attach': ['chatId', 'caseId', 'makeCasePrivate'],
  'case:cancelJob': ['caseId', 'jobId'],
  'case:checkPlaybookUpdates': ['caseId', 'name', 'confirmSource'],
  'case:ingestFiles': ['caseId', 'files', 'source'],
  'case:markPrivate': ['caseId', 'confirm', 'private'],
  'case:removePlaybook': ['caseId', 'name'],
  'case:reviewProposal': ['caseId', 'docId', 'proposalId', 'action', 'edit', 'supersedes', 'keepBoth', 'reason'],
  'case:revokeEnvelope': ['caseId', 'envelopeId'],
  'case:setDisclosable': ['caseId', 'factId', 'disclosable'],
  'case:setStatus': ['caseId', 'status', 'kind', 'note'],
  'case:updatePlaybook': ['caseId', 'name', 'force', 'confirmSource'],
  'channel:accessAllow': ['channel', 'kind', 'id'],
  'channel:accessGet': ['channel'],
  'channel:accessRemove': ['channel', 'kind', 'id'],
  'channel:setApprovalTarget': ['channel', 'approvalChatId'],
  'chat:markPrivate': ['chatId', 'confirm', 'private'],
  'chat:setSandboxMode': ['chatId', 'sandboxMode'],
  'chat:setWorkingDirectory': ['chatId', 'workingDirectory'],
  'chat:truncateFrom': ['chatId', 'fromIndex'],
  'checkpoint:prune': ['force'],
  'checkpoint:restore': ['workingDirectory', 'checkpointId'],
  'checkpoint:setEnabled': ['enabled'],
  'cron:add': ['name', 'description', 'enabled', 'schedule', 'payload', 'delivery'],
  'cron:run': ['id'],
  'cron:update': ['id', 'patch'],
  'history:embedder.save': ['embedder', 'rerank', 'confirmJev'],
  'history:jev.saveKey': ['key'],
  'hooks:setEnabled': ['name', 'enabled'],
  'hooks:setGlobalEnabled': ['enabled'],
  'memory:capture': ['type', 'content', 'source', 'metadata'],
  'models:saveCatalogSettings': ['fetch', 'refreshHours', 'overrides'],
  'models:setOllamaBaseUrl': ['baseUrl'],
  'settings:mcpDelete': ['name'],
  'settings:mcpReload': ['name'],
  'settings:mcpSave': ['name', 'server', 'oldName'],
  'settings:runLlmCommand': ['command'],
  'settings:saveDefaults': ['defaults'],
  'settings:saveElevenLabsKey': ['apiKey', 'clear'],
  'settings:saveImageGenKey': ['provider', 'apiKey', 'clear'],
  'settings:saveNotifications': ['notifications'],
  'settings:saveProvider': ['provider', 'token', 'clear'],
  'settings:saveTemplateVariables': ['templateVariables'],
  'settings:saveUserProfile': ['profile'],
  'settings:saveWebSearchKey': ['provider', 'apiKey', 'clear'],
  'settings:vaultDelete': ['key'],
  'settings:vaultStore': ['key', 'value'],
  'settings:vaultUpdate': ['oldKey', 'newKey', 'value'],
  'skill:checkUpdates': ['fetch'],
  'skill:customize': ['skillId'],
  'skill:execute': ['command', 'args', 'chatId'],
  'skill:getSettings': ['skillId'],
  'skill:handleMessage': ['chatId', 'message'],
  'skill:install': ['url'],
  'skill:remove': ['skillId'],
  'skill:saveSettings': ['skillId', 'settings'],
  'skill:setEnabled': ['skillId', 'enabled'],
  'skill:update': ['skillId'],
  'tool:execute': ['toolName', 'parameters'],
  'tool:removePermissionRule': ['tool', 'pattern', 'action'],
  'webhook:delete': ['id'],
  'webhook:get': ['id'],
  'webhook:regenerateSecret': ['id'],
  'workflow:recoverPlan': ['chatId'],
  'workflow:run': ['id']
});

function withoutNtfyTopic(notifications) {
  if (!isObject(notifications)) return notifications;
  if (!isObject(notifications.ntfy)) return notifications;
  const { topic: _topic, ...ntfy } = notifications.ntfy;
  return { ...notifications, ntfy };
}

// What each channel with a stored value shows. A hash alone would hide what it does,
// so each keeps the fields that say so.
const HIDDEN_FIELDS = Object.freeze({
  'settings:vaultStore': (p) => pick(p, ['key']),
  'settings:vaultUpdate': (p) => pick(p, ['oldKey', 'newKey']),
  'settings:saveProvider': (p) => pick(p, ['provider', 'clear']),
  'settings:saveWebSearchKey': (p) => pick(p, ['provider', 'clear']),
  'settings:saveImageGenKey': (p) => pick(p, ['provider', 'clear']),
  'settings:saveElevenLabsKey': (p) => pick(p, ['clear']),
  'history:jev.saveKey': () => ({}),
  'settings:mcpSave': (p) => {
    const server = isObject(p.server) ? p.server : {};
    return { ...pick(p, ['name', 'oldName']), command: server.command ?? null, env_names: namesOf(server.env) };
  },
  'settings:runLlmCommand': (p) => ({ verb: llmCommandAction(p.command) }),
  'webhook:update': (p) => ({ ...pick(p, ['id']), fields: namesOf(p).filter((k) => k !== 'id') }),
  'skill:saveSettings': (p) => ({ ...pick(p, ['skillId']), setting_names: namesOf(p.settings) }),
  'settings:saveTemplateVariables': (p) => ({ variable_names: namesOf(p.templateVariables) }),
  'settings:saveNotifications': (p) => ({ notifications: withoutNtfyTopic(p.notifications) ?? null })
});

// The bulk channel's card: what it read of each file, never what the window says of it.
function ingestFields(p) {
  const files = Array.isArray(p.files) ? p.files : [];
  return {
    ...pick(p, ['caseId', 'source']),
    files: files.map((f) => {
      const base64 = isObject(f) && typeof f.base64 === 'string' ? f.base64 : '';
      const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
      return { name: isObject(f) ? f.name ?? null : null, bytes: Math.max(0, (base64.length / 4) * 3 - padding) };
    })
  };
}

// A URL's user and password are no part of what the owner is deciding.
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i;
const stripUserinfo = (value) => (typeof value === 'string' ? value.replace(USERINFO, '$1') : value);

// The card's copy of the arguments with userinfo gone from the fields that hold a URL.
const URL_FIELDS = Object.freeze({
  'models:setOllamaBaseUrl': (p) => ({ ...p, baseUrl: stripUserinfo(p.baseUrl) }),
  'skill:install': (p) => ({ ...p, url: stripUserinfo(p.url) }),
  'case:addPlaybook': (p) => ({ ...p, source: stripUserinfo(p.source) }),
  'history:embedder.save': (p) => (isObject(p.embedder) && isObject(p.embedder.ollama)
    ? { ...p, embedder: { ...p.embedder, ollama: { ...p.embedder.ollama, baseUrl: stripUserinfo(p.embedder.ollama.baseUrl) } } }
    : p),
  'case:create': (p) => (Array.isArray(p.playbooks)
    ? { ...p, playbooks: p.playbooks.map((entry) => (isObject(entry) ? { ...entry, source: stripUserinfo(entry.source) } : entry)) }
    : p)
});

const firstArg = (args) => (Array.isArray(args) ? args[0] : args);

function badShape(name, args) {
  if (!Object.hasOwn(ARG_KEYS, name)) return false;
  if (Array.isArray(args) && args.length > 1) return true;
  const payload = firstArg(args);
  if (payload === undefined) return false;
  if (!isObject(payload)) return true;
  return Object.keys(payload).some((key) => !ARG_KEYS[name].includes(key));
}

function leafOver(value) {
  if (typeof value === 'string') return Buffer.byteLength(value) > WINDOW_LEAF_MAX;
  if (Array.isArray(value)) return value.some(leafOver);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, leaf]) => Buffer.byteLength(key) > WINDOW_LEAF_MAX || leafOver(leaf));
}

function hiddenFieldsFor(name, payload) {
  if (name === 'case:ingestFiles') return ingestFields(payload);
  if (name === 'tool:execute' && payload.toolName === 'Vault') {
    const parameters = isObject(payload.parameters) ? payload.parameters : {};
    return { tool: 'Vault', action: parameters.action ?? null, key: parameters.key ?? null };
  }
  return Object.hasOwn(HIDDEN_FIELDS, name) ? HIDDEN_FIELDS[name](payload) : null;
}

// `text` is canonicalize(args). → { params } | { refusal: code }
function windowCard(name, args, text) {
  if (badShape(name, args)) return { refusal: 'REMOTE_ARGS_INVALID' };
  const payload = firstArg(args);
  const object = isObject(payload) ? payload : {};
  const hidden = hiddenFieldsFor(name, object);
  let params;
  if (hidden) {
    params = { channel: name, ...hidden, ...hiddenMark(text) };
  } else {
    if (Buffer.byteLength(text) > WINDOW_ARGS_INLINE_MAX) return { refusal: 'REMOTE_ARGS_TOO_LARGE' };
    const inline = JSON.parse(text);
    const shown = Object.hasOwn(URL_FIELDS, name) && isObject(firstArg(inline)) ? URL_FIELDS[name](firstArg(inline)) : null;
    const stripped = shown && JSON.stringify(shown) !== JSON.stringify(firstArg(inline));
    params = stripped
      ? { channel: name, args: Array.isArray(inline) ? [shown, ...inline.slice(1)] : shown, ...hiddenMark(text) }
      : { channel: name, args: inline };
  }
  return leafOver(params) ? { refusal: 'REMOTE_ARGS_TOO_LARGE' } : { params };
}

module.exports = { windowCard, stripUserinfo, ARG_KEYS, HIDDEN_FIELDS, WINDOW_ARGS_INLINE_MAX, WINDOW_LEAF_MAX };
