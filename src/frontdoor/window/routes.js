// GET /window/v1/nodes (R-RW-22): the nodes a window's grant may attach to. The
// same three checks as the splice (the audience, the scope, the machine pinned
// to its node id), so the list holds what the upgrade would let through, the
// node's own answers aside. public_key is what the registry holds; a window
// still trusts a node key only after a code from the phone (R-RW-34).
const { createLogger } = require('../../logging');
const { allows } = require('../../fleet/scope-rules');
const { sendJson } = require('../http-util');
const { WINDOW_SCOPE, WINDOW_TOOL } = require('./scope');

const log = createLogger('frontdoor/window/routes');
const BEARER_RE = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

function authorizationCount(req) {
  let n = 0;
  const raw = req.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() === 'authorization') n += 1;
  return n;
}

// `oauth` is read on every request: its URLs change once a port-0 listener binds.
function createWindowRoutes({ oauth, tokens, grants, registry } = {}) {
  const unauthorized = (res) => sendJson(res, 401, { error: 'invalid_token' }, {
    'www-authenticate': `Bearer error="invalid_token", resource_metadata="${oauth.issuer}/.well-known/oauth-protected-resource/window/v1"`
  });

  async function handle(req, res) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
      return;
    }
    if (authorizationCount(req) > 1) {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'more than one authorization header' });
      return;
    }
    const bearer = BEARER_RE.exec(String(req.headers.authorization || ''));
    const token = bearer ? tokens.authenticate(bearer[1], { aud: oauth.windowResourceUrl }) : null;
    const grant = token ? grants.live(token.grant_id) : null;
    if (!grant) {
      unauthorized(res);
      return;
    }
    if (!allows(token.scopes, WINDOW_TOOL, { required: WINDOW_SCOPE }).ok) {
      sendJson(res, 403, { error: 'insufficient_scope' }, { 'www-authenticate': `Bearer error="insufficient_scope", scope="${WINDOW_SCOPE}"` });
      return;
    }
    try {
      grants.touch(token.grant_id);
    } catch (err) {
      // last_used_at is bookkeeping; a failed save never refuses a request.
      log.warn(`recording use of grant ${token.grant_id} failed: ${err && err.message}`);
    }
    const nodes = registry.list()
      .filter((r) => allows(token.scopes, WINDOW_TOOL, { required: WINDOW_SCOPE, machine: r.node_name }).ok
        && grants.machineMatches(grant, WINDOW_SCOPE, r.node_name, r.node_id))
      .map((r) => {
        const presence = registry.presence(r.node_id);
        return { node_id: r.node_id, node_name: r.node_name, online: Boolean(presence) && presence.online === true, public_key: r.public_key };
      });
    sendJson(res, 200, { nodes });
  }

  return { handle };
}

module.exports = { createWindowRoutes };
