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
  'canvas'
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
  'case:changed'
]);

// Settings tabs whose domains the service does not serve while attached.
const ATTACHED_UNAVAILABLE_TABS = Object.freeze(['mcp', 'channels', 'hooks', 'skills', 'webhooks', 'workflows', 'mesh', 'diagnostics', 'system-apps']);

const TIMEOUT_EXEMPT = new Set(['chat:sendMessage', 'tool:execute', 'cron:run']);

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
  return TIMEOUT_EXEMPT.has(ch) || ch.startsWith('case:ingest');
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
  isTimeoutExempt
};
