// The front door's startup checks 1–4 (fleet stage 4 §3.1), in the spec's
// order with its exact messages. Check 5 (bind) is the listener's own
// error, 6 (registry) and 7 (no phone) are run by startFrontDoor.
//
// The inputs are the parsed admin config only (node.yaml and service.json
// from the admin config dir, as loadNodeConfig/loadServiceConfig read
// them); nothing here reads the data dir, so it never decides policy.
const net = require('net');
const { isDnsName } = require('./protocol/messages');
const { parsePushConfig } = require('../service/config');

const RELAY_KEYS = ['public_url', 'tls', 'phone_listen', 'mesh_listen', 'push'];
const LISTENER_KEYS = ['tls', 'phone_listen', 'mesh_listen'];
const NAMES = { 1: 'frontdoor profile', 2: 'frontdoor.domain', 3: 'frontdoor TLS source', 4: 'frontdoor features and relay keys' };

class StartupError extends Error {
  constructor(check, message) {
    super(message);
    this.name = 'StartupError';
    this.check = check;
  }
}

function goodDomain(domain) {
  return typeof domain === 'string' && isDnsName(domain) && domain.split('.').length >= 2 && net.isIP(domain) === 0;
}

function startupProblems({ serviceConfig, nodeConfig } = {}) {
  const problems = [];
  const add = (check, message) => problems.push({ check, name: NAMES[check], message });
  const a = serviceConfig ? serviceConfig.profile : undefined;
  const b = nodeConfig ? nodeConfig.profile : undefined;
  if (a !== 'frontdoor' || b !== 'frontdoor' || !nodeConfig.frontdoor) {
    add(1, `profile mismatch: service.json says "${a}", node.yaml says "${b}"`);
    return problems;
  }
  const fd = nodeConfig.frontdoor;
  if (!goodDomain(fd.domain)) add(2, 'frontdoor.domain must be a DNS name');
  const acme = Boolean(fd.acme);
  const tls = Boolean(fd.tls);
  if (acme === tls) add(3, 'configure frontdoor.acme or frontdoor.tls, not both/neither');
  // Ruling T31-keypath: the missing agreement names its own key.
  else if (acme && fd.acme.termsAgreed !== true) add(3, 'frontdoor.acme.terms_agreed must be true to use ACME (it records that you accept the CA terms of service)');

  const fourth = [];
  // Off means exactly false: the rest of the service treats any truthy
  // value as on, so anything else is refused rather than guessed at.
  for (const [name, on] of Object.entries(serviceConfig.features || {})) {
    if (on !== false) fourth.push(`the frontdoor profile runs no agent features: set features.${name} to false in service.json`);
  }
  const relay = serviceConfig.relayRaw;
  if (relay !== null && relay !== undefined) {
    if (typeof relay !== 'object' || Array.isArray(relay)) {
      fourth.push('Invalid service.json: "relay" must be an object');
    } else {
      for (const key of Object.keys(relay)) if (!RELAY_KEYS.includes(key)) fourth.push(`Invalid service.json: unknown key "relay.${key}"`);
      if (relay.public_url !== undefined) fourth.push(`relay.public_url is derived on the frontdoor profile (https://mcp.${fd.domain}); remove it`);
      for (const key of LISTENER_KEYS) if (relay[key] !== undefined) fourth.push(`the frontdoor profile uses one 443 listener; remove relay.${key}`);
      try {
        parsePushConfig(relay.push, 'service.json');
      } catch (err) {
        fourth.push(err.message);
      }
    }
  }
  for (const message of fourth) add(4, message);
  return problems;
}

function runStartupChecks(opts) {
  const [problem] = startupProblems(opts);
  if (problem) throw new StartupError(problem.check, problem.message);
}

function startupRows(opts) {
  const problems = startupProblems(opts);
  const stopped = problems.length > 0 && problems[0].check === 1;
  return [1, 2, 3, 4].map((n) => {
    const mine = problems.filter((p) => p.check === n);
    if (stopped && n > 1) return { check: NAMES[n], ok: false, detail: 'not checked (fix the profile first)' };
    return { check: NAMES[n], ok: mine.length === 0, detail: mine.length ? mine.map((p) => p.message).join('; ') : 'ok' };
  });
}

module.exports = { StartupError, startupProblems, runStartupChecks, startupRows };
