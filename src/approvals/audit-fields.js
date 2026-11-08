// What a tool call may say in the audit ledger, which is served to the relay's
// mirror (sealed phones, R-SP-7, and the ruling after Task 5's review): the tool's
// name, the tier, the ids. Never a parameter, an error's words or a client's name.
// The detail stays in the node's own logs.
//
// node:crypto only: the runbook profile loads this.
const crypto = require('crypto');
const { canonicalize } = require('../platform/jcs');

const PARAMS_INFO = 'kl-audit-params-v1';
const CODE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const ORIGIN_KINDS = Object.freeze(['frontdoor', 'stdio', 'service-chat']);
// The names only this node's own callers go by (fleet-tools.js refuses them to a
// front-door client), so they say which caller it was without repeating a client's words.
const LOCAL_CLIENTS = Object.freeze({ desktop: 'desktop', 'stdio-mcp': 'stdio', 'king-louie': 'node' });

// HMAC-SHA256 over a call's parameters, under a key only this node holds, so a
// relay cannot guess a short parameter from it as it could from a plain hash.
// null when this process holds no box key, or the parameters have no one
// encoding: an entry says nothing rather than something guessable.
function paramsHmac(params, identity) {
  const box = identity && identity.box;
  if (!box || typeof box.deriveKey !== 'function') return null;
  try {
    return crypto.createHmac('sha256', box.deriveKey(PARAMS_INFO))
      .update(canonicalize(params === undefined || params === null ? {} : params))
      .digest('base64url');
  } catch {
    return null;
  }
}

// { kind }, from a fixed list: a kind or client nobody knows is 'remote', never
// repeated. A front-door origin adds the ids the front door issued (controller's
// ruling), so a call can be tied to its grant; never the name a client gave itself,
// or its session.
function auditOriginOf(origin) {
  const o = origin || {};
  if (o.kind === 'frontdoor') {
    const id = (v) => (typeof v === 'string' && v ? v : null);
    return { kind: 'frontdoor', grant_id: id(o.grant_id), client_id: id(o.client_id) };
  }
  if (ORIGIN_KINDS.includes(o.kind)) return { kind: o.kind };
  // The bare id (R-RW-33): the front door already sees it in the clear hello_w.
  if (o.client === 'remote-window') return { kind: 'remote-window', deviceId: typeof o.deviceId === 'string' && o.deviceId ? o.deviceId : null };
  if (typeof o.client === 'string' && Object.hasOwn(LOCAL_CLIENTS, o.client)) return { kind: LOCAL_CLIENTS[o.client] };
  return { kind: 'remote' };
}

// A failure's code, or how long its words were: a tool's error can quote a command.
function auditError(result) {
  const r = result || {};
  if (typeof r.code === 'string' && CODE_RE.test(r.code)) return r.code;
  return { error_chars: typeof r.error === 'string' ? r.error.length : 0 };
}

// A failure as the node's own log may say it when its tool's text must stay out
// of logs too (Type, Key): the code, or how long it was.
function errorByCode(result) {
  const shown = auditError(result);
  return typeof shown === 'string' ? shown : `${shown.error_chars} characters`;
}

module.exports = { paramsHmac, auditOriginOf, auditError, errorByCode, PARAMS_INFO };
