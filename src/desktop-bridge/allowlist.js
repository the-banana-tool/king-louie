// Which IPC channels attached mode proxies to the service (fleet stage 7 §3.6).
// Rules are evaluated in order; the first match wins. A stage that adds a
// domain that must work while attached appends it to PROXIED_DOMAINS (one line).
const LOCAL_PREFIXES = Object.freeze(['desktop:', 'wizard:']);
const LOCAL_CHANNELS = Object.freeze(['app:quitWindow']);
const PRESTEP_CHANNELS = Object.freeze(['chat:pickWorkingDirectory', 'settings:addAllowedDirectory']);
const DENY_CHANNELS = Object.freeze(['chat:speakLast', 'settings:testVoice']);
const DENY_PREFIXES = Object.freeze(['settings:mcp', 'settings:anthropicOAuth']);
const PROXIED_DOMAINS = Object.freeze([
  'chat',
  'settings',
  'case',
  'cron',
  'memory',
  'tool',
  'usage',
  'checkpoint',
  'canvas',
  // Cases stage 3: executors:list (the case:* executor channels ride 'case').
  'executors',
  // Cases stage 4: the ladder state, the contact policy editor and heartbeats.
  'contact',
  'contactPolicy',
  'presence',
  // Models stage M1: catalog status, usable models, provider tests.
  'models',
  // History stage H2: the recall line's excerpts and history search.
  'history'
]);
const PROXIED_CHANNELS = Object.freeze(['agent:userResponse']);

const PROMPT_EVENTS = new Set(['tool:approvalRequired', 'tool:directoryAccessRequired', 'agent:askUser']);
const RENDERER_EVENTS = new Set([
  'chat:messageStart', 'chat:messageChunk', 'chat:messageComplete', 'chat:messageError',
  'chat:toolUse', 'chat:toolResult', 'chat:toolProgress', 'chat:updated',
  'chat:advisorStarted', 'chat:advisorCompleted',
  'canvas:render', 'canvas:close', 'canvas:executeJs',
  ...PROMPT_EVENTS,
  'backgroundTask:completed',
  // Cases stage 2: the one event the case runtime emits (status, questions,
  // budget). A later case event is added here by name, not by prefix.
  'case:changed',
  'models:statusChanged', 'models:catalogUpdated',
  // Models M3: the King Louie proposal, recomputed on the service.
  'models:proposalChanged'
]);

// Settings tabs whose domains the service does not serve while attached.
const ATTACHED_UNAVAILABLE_TABS = Object.freeze(['mcp', 'channels', 'hooks', 'skills', 'webhooks', 'workflows', 'mesh', 'diagnostics', 'system-apps']);

const TIMEOUT_EXEMPT = new Set(['chat:sendMessage', 'tool:execute', 'cron:run']);
// Cases stage 6 (ruling T14-bridgetimeout): channels that fetch and validate
// playbooks can outlast the default timeout. They get a longer but still
// bounded one: a timeout that fires while the service keeps working invites
// a duplicate retry, and an unbounded wait could hang the desktop.
// case:applyPlaybookProposal clones the owner's repository and applies
// there, each step bounded at 60 s (final review M-4).
const LONG_CHANNEL_TIMEOUT_MS = 10 * 60 * 1000;
// Cases stage 7: storing a dropped file (PDF page count in the sandboxed
// reader, then a commit), queueing a read, and reviewing (which re-reads
// the stored PDF page) can outlast it too. They replace F7's placeholder
// exemption of every case:ingest* channel: a bounded wait, never none.
const LONG_CHANNELS = new Set([
  'case:create', 'case:addPlaybook', 'case:checkPlaybookUpdates', 'case:updatePlaybook', 'case:applyPlaybookProposal',
  'case:ingestFiles', 'case:ingestExtract', 'case:reviewProposal', 'case:acceptVerified'
]);

function domainOf(channel) {
  const i = channel.indexOf(':');
  return i === -1 ? channel : channel.slice(0, i);
}

function classifyChannel(channel) {
  const ch = String(channel);
  if (LOCAL_CHANNELS.includes(ch) || LOCAL_PREFIXES.some((p) => ch.startsWith(p))) return 'local';
  if (PRESTEP_CHANNELS.includes(ch)) return 'prestep';
  if (DENY_CHANNELS.includes(ch) || DENY_PREFIXES.some((p) => ch.startsWith(p))) return 'deny';
  if (PROXIED_CHANNELS.includes(ch) || PROXIED_DOMAINS.includes(domainOf(ch))) return 'proxy';
  return 'deny';
}

function servedChannels({ handle = [], on = [] } = {}) {
  return {
    handle: handle.filter((ch) => classifyChannel(ch) === 'proxy'),
    on: on.filter((ch) => classifyChannel(ch) === 'proxy')
  };
}

function isRendererEvent(channel) {
  const ch = String(channel);
  return RENDERER_EVENTS.has(ch);
}

function isTimeoutExempt(channel) {
  const ch = String(channel);
  return TIMEOUT_EXEMPT.has(ch);
}

// The bridge timeout for one invoke: 0 (none) for an exempt channel, the long
// bound for a long channel, else the default.
function channelTimeoutMs(channel, defaultMs) {
  const ch = String(channel);
  if (isTimeoutExempt(ch)) return 0;
  if (LONG_CHANNELS.has(ch)) return LONG_CHANNEL_TIMEOUT_MS;
  return defaultMs;
}

module.exports = {
  PROXIED_DOMAINS,
  PROXIED_CHANNELS,
  PRESTEP_CHANNELS,
  RENDERER_EVENTS,
  PROMPT_EVENTS,
  ATTACHED_UNAVAILABLE_TABS,
  classifyChannel,
  servedChannels,
  isRendererEvent,
  isTimeoutExempt,
  channelTimeoutMs,
  LONG_CHANNEL_TIMEOUT_MS
};
