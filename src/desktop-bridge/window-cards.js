// What a phone card shows of a remote window's call (remote window plan R-RW-12,
// R-RW-30, R-RW-32). The card must show what runs, must not carry a stored value, and
// must not be something a thief can make unreadable:
//   - a channel whose arguments hold a stored value always shows its named fields and
//     a keyed mark (HIDDEN_FIELDS);
//   - the one bulk channel shows names and sizes it read itself, and a keyed mark;
//   - every other call goes on the card whole, up to 64 KiB, and past that it is refused;
//   - every form is held to the same size: 64 rows, depth 6, 8 KB of shown text, a leaf of
//     2000 code points (the phone's collapse size). Only the fields in FREE_TEXT_FIELDS,
//     whose text is what runs, may pass the leaf and shown limits, to 64 KiB in all;
//   - a phone shows parameters in JCS key order, which is signed, so nothing can be moved
//     up the list: the summary carries a host-built count and a "runs:" line instead.
// That line is the first thing the owner reads, so it must never say something false.
// Where the host cannot be sure what acts, it says less, never a guess.
//   - a channel with a known shape refuses any other key (ARG_KEYS): JCS sorts keys, so
//     an unknown one could otherwise sit on the card ahead of the real leaves.
// What runs is always parsed from the one text, whatever the card shows.
const { hiddenMark } = require('../approvals/hidden-card');
const { llmCommandAction } = require('../core/llm-command');
const { plainLineProblem } = require('../cases/hidden-chars');

const WINDOW_ARGS_INLINE_MAX = 65536;
const WINDOW_LEAF_MAX = 2000;
const WINDOW_LEAVES_MAX = 64;
const WINDOW_DEPTH_MAX = 6;
const WINDOW_SHOWN_MAX = 8192;
const INGEST_FILES_MAX = 64;
const WORKFLOW_TASKS_MAX = 32;

// Where each channel's free text is, from its first argument. Each is what runs, read
// by a model or a shell, so a long one is the point of the call and the owner reads it.
const FREE_TEXT_FIELDS = Object.freeze({
  'cron:add': [['payload', 'message']],
  'cron:update': [['patch', 'payload', 'message']],
  'memory:capture': [['content']],
  'skill:handleMessage': [['message']],
  'workflow:plan': [['goal']],
  'workflow:planAndExecute': [['goal']]
});
// tool:execute's are the tool's: another tool's field of that name does nothing.
const TOOL_FREE_TEXT = Object.freeze({ Bash: 'command', PowerShell: 'command', Write: 'content' });

// The field that says what a call runs, from the card's copy of its first argument.
const RUNS_FIELDS = Object.freeze({
  'apps:add': ['launchCmd'],
  'bridge.addAllowedDirectory': ['path'],
  'bridge.setWorkingDirectory': ['path'],
  'case:addPlaybook': ['source'],
  'case:applyPlaybookProposal': ['repoPath'],
  'channel:accessAllow': ['id'],
  'chat:setWorkingDirectory': ['workingDirectory'],
  'checkpoint:restore': ['workingDirectory'],
  'history:embedder.save': ['embedder', 'ollama', 'baseUrl'],
  'memory:capture': ['content'],
  'models:setOllamaBaseUrl': ['baseUrl'],
  'skill:handleMessage': ['message'],
  'webhook:create': ['messageTemplate'],
  'skill:install': ['url'],
  'workflow:plan': ['goal'],
  'workflow:planAndExecute': ['goal']
});
// What each tool's line names. Any other tool's line is its name alone.
const TOOL_MAIN_FIELD = Object.freeze({ Bash: 'command', PowerShell: 'command', Write: 'file_path', Edit: 'file_path', SpawnAgent: 'task' });
const BROWSER_TOOLS = new Set(['Browser', 'BrowserPage', 'BrowserExtract', 'BrowserSession']);
// The actions a target says something about; for any other the field does nothing.
const BROWSER_URL_ACTIONS = new Set(['navigate', 'open_tab']);
const BROWSER_SELECTOR_ACTIONS = new Set(['click', 'dblclick', 'fill', 'type', 'press', 'clear', 'select_option', 'check', 'uncheck', 'drag_and_drop', 'set_input_files', 'hover', 'focus']);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const namesOf = (value) => (isObject(value) ? Object.keys(value).sort() : []);
const pick = (payload, keys) => Object.fromEntries(keys.filter((k) => Object.hasOwn(payload, k)).map((k) => [k, payload[k]]));

// The first argument's whole set of keys, from each handler.
const ARG_KEYS = Object.freeze({
  'apps:add': ['id', 'description', 'capabilities', 'category', 'launchCmd'],
  'workflow:create': ['taskGraph', 'chatId', 'workingDirectory'],
  'workflow:plan': ['goal', 'options', 'chatId', 'workingDirectory', 'chatMessages'],
  'workflow:planAndExecute': ['goal', 'options', 'background', 'chatId', 'workingDirectory', 'chatMessages'],
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
    return { ...pick(p, ['name', 'oldName']), command: server.command ?? null, args: server.args ?? [], cwd: server.cwd ?? null, env_names: namesOf(server.env) };
  },
  'settings:runLlmCommand': (p) => ({ verb: llmCommandAction(p.command) }),
  'webhook:update': (p) => ({ ...pick(p, ['id']), fields: namesOf(p).filter((k) => k !== 'id') }),
  'skill:saveSettings': (p) => ({ ...pick(p, ['skillId']), setting_names: namesOf(p.settings) }),
  'settings:saveTemplateVariables': (p) => ({ variable_names: namesOf(p.templateVariables) }),
  'settings:saveNotifications': (p) => ({ notifications: withoutNtfyTopic(p.notifications) ?? null }),
  // A graph's depth and its other fields are its own; a card shows each task.
  'workflow:create': (p) => {
    const graph = isObject(p.taskGraph) ? p.taskGraph : {};
    const tasks = Array.isArray(graph.tasks) ? graph.tasks : [];
    return {
      ...pick(p, ['chatId', 'workingDirectory']),
      goal: graph.goal ?? null,
      tasks: tasks.map((task) => (isObject(task) ? { id: task.id ?? null, title: task.title ?? null, description: task.description ?? null } : null))
    };
  }
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

// A URL's user and password are no part of what the owner is deciding, but the card must
// show the host that runs. An address the node itself fetches goes through the parser the
// node uses, so the card shows what that parser read: the backslash in
// http://a.example\@b.example ends the host, and a pattern for userinfo would show b.
function fetchedUrlShown(value) {
  if (typeof value !== 'string') return value;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return value;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return value;
  url.username = '';
  url.password = '';
  return url.href;
}

// A source git fetches is read by git and curl, not by this parser, and they differ on odd
// forms. Only the plain form, where all of them agree, loses its userinfo.
const PLAIN_USERINFO_URL = /^https?:\/\/[^\s\\@/?#]+@[^\s\\@/?#]+(?:[/?#][^\s\\@]*)?$/i;
function gitUrlShown(value) {
  if (typeof value !== 'string' || !PLAIN_USERINFO_URL.test(value)) return value;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return value;
  }
}

// The card's copy of the arguments with userinfo gone from the fields that hold a URL.
const URL_FIELDS = Object.freeze({
  'models:setOllamaBaseUrl': (p) => ({ ...p, baseUrl: fetchedUrlShown(p.baseUrl) }),
  'skill:install': (p) => ({ ...p, url: gitUrlShown(p.url) }),
  'case:addPlaybook': (p) => ({ ...p, source: gitUrlShown(p.source) }),
  'history:embedder.save': (p) => (isObject(p.embedder) && isObject(p.embedder.ollama)
    ? { ...p, embedder: { ...p.embedder, ollama: { ...p.embedder.ollama, baseUrl: fetchedUrlShown(p.embedder.ollama.baseUrl) } } }
    : p),
  'case:create': (p) => (Array.isArray(p.playbooks)
    ? { ...p, playbooks: p.playbooks.map((entry) => (isObject(entry) ? { ...entry, source: gitUrlShown(entry.source) } : entry)) }
    : p)
});

const firstArg = (args) => (Array.isArray(args) ? args[0] : args);

function badShape(name, args) {
  if (!Object.hasOwn(ARG_KEYS, name)) return false;
  if (Array.isArray(args) && args.length > 1) return true;
  const payload = firstArg(args);
  if (payload === undefined) return false;
  if (!isObject(payload)) return true;
  if (Object.keys(payload).some((key) => !ARG_KEYS[name].includes(key))) return true;
  return PLANNING.has(name) && badPlan(payload);
}

// Messages that name no chat would drive the plan, while the line shows only the goal,
// and the node recalls the chat for itself when it is named.
const PLANNING = new Set(['workflow:plan', 'workflow:planAndExecute']);
function badPlan(payload) {
  const options = isObject(payload.options) ? payload.options : {};
  if (Object.hasOwn(payload, 'chatMessages') || Object.hasOwn(options, 'chatMessages')) return true;
  return !payload.chatId && !options.chatId && !payload.goal;
}

const overLeaf = (text) => Buffer.byteLength(text) > WINDOW_LEAF_MAX && Array.from(text).length > WINDOW_LEAF_MAX;
// What the host puts on every card, and no caller chose.
const HOST_FIELDS = new Set(['channel', 'args_sha256', 'bytes']);

// Holds a built card to its limits. → how many rows it has, or null when it is over.
function measure(params, name) {
  const free = new Set(freeTextPaths(name, params).map((path) => JSON.stringify(path)));
  // Their rows are the point of the call, and each has its own cap on how many.
  const listing = name === 'case:ingestFiles' || name === 'workflow:create';
  const leavesMax = listing ? Infinity : WINDOW_LEAVES_MAX;
  const shownMax = listing ? WINDOW_ARGS_INLINE_MAX : WINDOW_SHOWN_MAX;
  let leaves = 0;
  let shown = 0;
  let longText = false;
  const walk = (value, path, depth) => {
    if (Array.isArray(value) || isObject(value)) {
      if (depth + 1 > WINDOW_DEPTH_MAX) return false;
      const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
      if (entries.length === 0) leaves += 1; // a phone shows an empty one as a row
      for (const [key, leaf] of entries) {
        if (typeof key === 'string') {
          if (overLeaf(key)) return false;
          shown += Buffer.byteLength(key);
        }
        if (!walk(leaf, [...path, key], depth + 1)) return false;
      }
    } else {
      leaves += 1;
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (typeof value === 'string' && free.has(JSON.stringify(path))) longText = longText || overLeaf(text);
      else if (overLeaf(text)) return false;
      else shown += Buffer.byteLength(text);
    }
    return leaves <= leavesMax && shown <= shownMax;
  };
  const top = Object.entries(params).filter(([key]) => !HOST_FIELDS.has(key));
  // The root is depth 1.
  for (const [key, value] of top) {
    if (!walk(value, [key], 1)) return null;
  }
  return { leaves, longText };
}

// Whole paths from the card's root. Every form but ingest's is held to 64 KiB of text
// before it is measured, so free text needs no total of its own here.
function freeTextPaths(name, params) {
  if (name === 'workflow:create') return (Array.isArray(params.tasks) ? params.tasks : []).map((_, i) => ['tasks', i, 'description']);
  if (name === 'tool:execute') {
    const first = Array.isArray(params.args) ? params.args[0] : null;
    const field = isObject(first) && Object.hasOwn(TOOL_FREE_TEXT, first.toolName) ? TOOL_FREE_TEXT[first.toolName] : null;
    return field ? [['args', 0, 'parameters', field]] : [];
  }
  return (FREE_TEXT_FIELDS[name] || []).map((path) => ['args', 0, ...path]);
}

const at = (value, path) => path.reduce((v, key) => (isObject(v) ? v[key] : undefined), value);
const NOT_PLAIN = '(not one plain line)';
function oneLine(text) {
  if (plainLineProblem(text) === null) return text;
  const lines = text.split(/\r\n|\r|\n/);
  return lines.length > 1 && lines[0] && plainLineProblem(lines[0]) === null ? `${lines[0]} (${lines.length} lines)` : NOT_PLAIN;
}

// A browser call's line: the action, then the target only where that action has one.
function browserDetail(parameters) {
  if (typeof parameters.action !== 'string') return null;
  const target = BROWSER_URL_ACTIONS.has(parameters.action) ? parameters.url
    : BROWSER_SELECTOR_ACTIONS.has(parameters.action) ? parameters.selector : undefined;
  return typeof target === 'string' ? `${parameters.action} ${target}` : parameters.action;
}

// A job's message, ahead of it where the result goes.
function cronLine(job) {
  if (!isObject(job)) return null;
  const message = at(job, ['payload', 'message']);
  if (typeof message !== 'string') return null;
  const target = at(job, ['delivery', 'target']);
  if (target === undefined || target === null) return oneLine(message);
  return typeof target === 'string' && plainLineProblem(target) === null ? oneLine(`to ${target}: ${message}`) : NOT_PLAIN;
}

// What the call runs, in a line. Built from the card, so it shows what the card shows.
function runsLine(name, params) {
  if (name === 'settings:mcpSave') {
    const argv = Array.isArray(params.args) ? params.args.map(String) : [];
    return typeof params.command === 'string' ? oneLine([params.command, ...argv].join(' ')) : null;
  }
  const first = Array.isArray(params.args) ? params.args[0] : params.args;
  if (name === 'tool:execute' && isObject(first)) {
    const parameters = isObject(first.parameters) ? first.parameters : {};
    const main = BROWSER_TOOLS.has(first.toolName) ? browserDetail(parameters)
      : Object.hasOwn(TOOL_MAIN_FIELD, first.toolName) ? parameters[TOOL_MAIN_FIELD[first.toolName]] : null;
    return oneLine(typeof main === 'string' ? `${first.toolName} ${main}` : String(first.toolName));
  }
  if (name === 'workflow:create') return `${(params.tasks || []).length} tasks`;
  if (name === 'settings:saveNotifications') {
    const server = at(params, ['notifications', 'ntfy', 'server']);
    return typeof server === 'string' ? oneLine(server) : null;
  }
  if (name === 'cron:add') return cronLine(first);
  if (name === 'cron:update') return cronLine(isObject(first) ? first.patch : null);
  if (name === 'skill:execute' && isObject(first) && typeof first.command === 'string') {
    return oneLine([first.command, ...(Array.isArray(first.args) ? first.args.map(String) : [])].join(' '));
  }
  const value = Object.hasOwn(RUNS_FIELDS, name) ? at(first, RUNS_FIELDS[name]) : undefined;
  return typeof value === 'string' ? oneLine(value) : null;
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
  if (name === 'case:ingestFiles' && Array.isArray(object.files) && object.files.length > INGEST_FILES_MAX) return { refusal: 'REMOTE_ARGS_TOO_LARGE' };
  if (name === 'workflow:create') {
    const tasks = at(object, ['taskGraph', 'tasks']);
    if (Buffer.byteLength(text) > WINDOW_ARGS_INLINE_MAX || (Array.isArray(tasks) && tasks.length > WORKFLOW_TASKS_MAX)) return { refusal: 'REMOTE_ARGS_TOO_LARGE' };
  }
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
  const measured = measure(params, name);
  if (measured === null) return { refusal: 'REMOTE_ARGS_TOO_LARGE' };
  return { params, parameters: measured.leaves, longText: measured.longText, kb: Math.max(1, Math.ceil(Buffer.byteLength(text) / 1024)), runs: runsLine(name, params) };
}

// tool:execute names a tool: it must exist, and take every parameter it is given, as
// validateParameters ignores the rest and a card would show what does nothing.
function undeclaredToolCall(args, registry) {
  const first = firstArg(args);
  if (!isObject(first) || typeof first.toolName !== 'string') return true;
  const tool = registry && typeof registry.get === 'function' ? registry.get(first.toolName) : null;
  if (!tool) return true;
  if (first.parameters === undefined) return false;
  if (!isObject(first.parameters)) return true;
  const declared = (tool.parameters && tool.parameters.properties) || {};
  return Object.keys(first.parameters).some((key) => !Object.hasOwn(declared, key));
}

module.exports = {
  windowCard, undeclaredToolCall, fetchedUrlShown, gitUrlShown, ARG_KEYS, HIDDEN_FIELDS, FREE_TEXT_FIELDS,
  WINDOW_ARGS_INLINE_MAX, WINDOW_LEAF_MAX, WINDOW_LEAVES_MAX, WINDOW_DEPTH_MAX, WINDOW_SHOWN_MAX, INGEST_FILES_MAX
};
