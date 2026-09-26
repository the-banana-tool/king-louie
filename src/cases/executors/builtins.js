// src/cases/executors/builtins.js
// The built-in executors (cases stage 3 spec §3.1). phone-agent is not
// built in: it is the reference package the owner installs.
const { EXECUTOR_ID_PATTERN } = require('./util');

const OUTBOUND_CAPABILITIES = Object.freeze(['call', 'sms', 'email', 'web-form', 'postal-mail', 'pay', 'sign']);
const CAPABILITIES = Object.freeze([
  'shell', 'read-files', 'write-files', 'search', 'fetch', 'web-browse', 'web-form', 'web-login', 'fan-out-research',
  'runbook', 'call', 'voicemail', 'sms', 'email', 'postal-mail', 'in-person', 'sign', 'pay', 'any'
]);
const KINDS = Object.freeze(['tool', 'external-agent', 'runbook', 'owner']);
const LATENCIES = Object.freeze(['interactive', 'async-minutes', 'async-hours', 'async-days']);
const AUTHORITIES = Object.freeze(['none', 'envelope', 'signed']);
const OUTBOUND_MODES = Object.freeze(['none', 'query', 'message']);
const STATE_MODES = Object.freeze(['poll', 'webhook', 'none']);
// The one executor-id pattern lives in util.js (M18); re-exported here.
const ID_PATTERN = EXECUTOR_ID_PATTERN;
// What a direct executor's work is done with (Executor.submit refuses them).
const DIRECT_TOOLS = Object.freeze({ bash: 'Bash', files: 'Read, Write', web: 'WebSearch, WebFetch' });

const row = (id, kind, capabilities, { direct, outbound, authority, latency, state }) => Object.freeze({
  id, kind, capabilities: Object.freeze(capabilities), direct, outbound, authority, latency, state
});

const TABLE = Object.freeze([
  row('bash', 'tool', ['shell', 'read-files', 'write-files'], { direct: true, outbound: 'none', authority: 'none', latency: 'interactive', state: 'none' }),
  row('files', 'tool', ['read-files', 'write-files'], { direct: true, outbound: 'none', authority: 'none', latency: 'interactive', state: 'none' }),
  row('web', 'tool', ['search', 'fetch'], { direct: true, outbound: 'query', authority: 'none', latency: 'interactive', state: 'none' }),
  row('browser', 'tool', ['web-browse', 'web-form', 'web-login'], { direct: false, outbound: 'message', authority: 'envelope', latency: 'interactive', state: 'none' }),
  row('workflow', 'tool', ['fan-out-research'], { direct: false, outbound: 'query', authority: 'none', latency: 'async-minutes', state: 'poll' }),
  row('runbook', 'runbook', ['runbook'], { direct: false, outbound: 'none', authority: 'none', latency: 'async-minutes', state: 'poll' }),
  row('owner', 'owner', ['any'], { direct: false, outbound: 'none', authority: 'none', latency: 'async-days', state: 'poll' })
]);

const BUILTIN_IDS = Object.freeze(TABLE.map((r) => r.id));

function builtinEntry(id) {
  const r = TABLE.find((x) => x.id === id);
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    builtin: true,
    package: null,
    capabilities: [...r.capabilities],
    cannot: r.kind === 'owner' ? [] : OUTBOUND_CAPABILITIES.filter((c) => !r.capabilities.includes(c)),
    constraints: {},
    cost: {},
    latency: r.latency,
    state: r.state,
    authority: r.authority,
    direct: r.direct,
    outbound: r.outbound,
    pollEveryMs: null,
    packageSha256: null
  };
}

module.exports = {
  OUTBOUND_CAPABILITIES,
  CAPABILITIES,
  KINDS,
  LATENCIES,
  AUTHORITIES,
  OUTBOUND_MODES,
  STATE_MODES,
  ID_PATTERN,
  DIRECT_TOOLS,
  BUILTIN_IDS,
  builtinEntry
};
