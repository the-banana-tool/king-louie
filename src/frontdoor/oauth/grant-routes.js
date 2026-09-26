// The phone's side of connecting a client (fleet stage 4 §3.4, §4.9), under
// F3's /v1 and its X-KL-* device auth. Only an active approver of this front
// door (its admin-owned approvers/, R25) may use these routes (Deviation 13).
const { ApiError } = require('../phone-api');
const { printable } = require('../http-util');
const { normalizeUserCode } = require('../protocol/messages');
const { checkGrantDecision, checkClientRevoke, verifyPhoneEnvelope } = require('../protocol/checks');
const { recordFrontDoorEvent } = require('../audit/own-ledger');
const { revokeGrantEverywhere } = require('./grants');

// The request as the phone is shown it. client_name is self-declared, so it
// goes out printable (no controls, bidi or invisible characters); that is
// the name the owner reads and signs, so the decision is checked against the
// same view.
const phoneView = (p) => ({ ...p, client_name: printable(p.client_name) });

// `nodes` is the front door's node registry (Task 19; anything with
// byName(name) → { node_id }). A machine limit may name only nodes it holds;
// without a registry no machine limit is accepted. Each name resolves to the
// node id it has now, which the grant pins (ruling T23-nodeid).
function resolveMachines(scopes, nodes) {
  const ids = {};
  for (const s of scopes) {
    for (const name of s.machines || []) {
      const node = nodes && typeof nodes.byName === 'function' ? nodes.byName(name) : null;
      if (!node || typeof node.node_id !== 'string') return { unknown: name };
      ids[name] = node.node_id;
    }
  }
  return { ids };
}

function registerGrantRoutes(phoneApi, { pending, grants, codes, clients, challenges, approverStore, frontdoorId, scopeRules,
  auditLedger = null, onGrantRevoked = () => {}, tokens = null, nodes = null, now = Date.now } = {}) {
  const requireApprover = (ctx) => {
    if (!approverStore.isActive(ctx.deviceId)) throw new ApiError(403, 'forbidden', 'this phone is not an approver on this front door');
  };

  phoneApi.registerRoute('GET', '/v1/grants/pending', {
    auth: 'device',
    rate: { perMin: 10 },
    handler: async (req, ctx) => {
      requireApprover(ctx);
      // byUserCode compares every live code in constant time; a request
      // another phone claimed answers exactly like no request at all.
      const code = normalizeUserCode(ctx.query.user_code);
      const found = code ? pending.byUserCode(code) : null;
      const claimed = found ? pending.claim(found.grant_id, ctx.deviceId) : null;
      if (!claimed) throw new ApiError(404, 'no_such_request', 'No connection request with that code');
      const view = phoneView(claimed);
      return {
        body: {
          grant_id: view.grant_id,
          // Not in §4.9's list: the phone signs client_id (§4.2), so it
          // needs it (Deviation 26).
          client_id: view.client_id,
          client_name: view.client_name,
          client_host: view.client_host,
          redirect_uri: view.redirect_uri,
          resource: view.resource,
          code_challenge: view.code_challenge,
          requested_scopes: view.requested_scopes,
          preselected: view.preselected,
          expires_in_ms: Math.max(0, view.expires_at_ms - now())
        }
      };
    }
  });

  phoneApi.registerRoute('POST', '/v1/grants/{id}/decision', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      const p = pending.get(ctx.params.id);
      // A request already decided is no longer pending: it cannot be decided
      // again (no second grant, no second code).
      const open = p && p.status === 'pending' ? p : null;
      const r = checkGrantDecision(ctx.body, { approverStore, frontdoorId, pending: open ? phoneView(open) : null, scopes: scopeRules(), now: now() });
      if (!r.ok) throw new ApiError(r.reason === 'unknown_request' || r.reason === 'expired' ? 410 : 400, r.reason, `the decision was refused: ${r.reason}`);
      if (r.deviceId !== ctx.deviceId) throw new ApiError(400, 'bad_decision', 'the decision must be signed by the calling phone');
      const m = r.message;
      if (m.decision === 'deny') {
        open.nonces.add(m.nonce);
        pending.settle(open.grant_id, { status: 'denied' });
        await recordFrontDoorEvent(auditLedger, 'frontdoor.grant.denied', { grant_id: open.grant_id, client_id: open.client_id, device_id: r.deviceId });
        return { body: { state: 'denied' } };
      }
      // Only an explicit, verified approve grants anything.
      if (m.decision !== 'approve') throw new ApiError(400, 'malformed', 'the decision is neither approve nor deny');
      const machines = resolveMachines(m.scopes, nodes);
      if (machines.unknown) throw new ApiError(400, 'unknown_machine', `no machine named "${machines.unknown}" is enrolled with this front door`);
      open.nonces.add(m.nonce);
      const grant = grants.create({ pending: open, envelope: ctx.body, message: m, machineIds: machines.ids, acceptedAt: new Date(now()).toISOString() });
      clients.markGranted(grant.client_id);
      // The code binds exactly what the phone signed; the token endpoint
      // compares each field with the redemption.
      const code = codes.issue({ grantId: grant.grant_id, clientId: m.client_id, redirectUri: m.redirect_uri, codeChallenge: m.code_challenge, resource: m.resource });
      pending.settle(open.grant_id, { status: 'approved', code });
      await recordFrontDoorEvent(auditLedger, 'frontdoor.grant.approved', { grant_id: grant.grant_id, client_id: grant.client_id, device_id: r.deviceId, scopes: grants.scopeStrings(grant) });
      return { body: { state: 'approved' } };
    }
  });

  phoneApi.registerRoute('GET', '/v1/clients', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      return {
        body: grants.list().map((g) => ({
          grant_id: g.grant_id, client_name: g.client_name, client_host: g.client_host, scopes: grants.scopeStrings(g), accepted_at: g.accepted_at, last_used_at: g.last_used_at
        }))
      };
    }
  });

  // Ruling T2-purpose: a challenge is issued for one purpose and spent only
  // by that kind of message.
  phoneApi.registerRoute('POST', '/v1/challenges', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      const purpose = ctx.body && typeof ctx.body === 'object' ? ctx.body.purpose : undefined;
      try {
        return { body: challenges.issue(ctx.deviceId, purpose) };
      } catch (err) {
        if (err.code === 'bad_purpose') throw new ApiError(400, 'bad_purpose', err.message);
        throw new ApiError(429, err.code || 'too_many_challenges', err.message);
      }
    }
  });

  phoneApi.registerRoute('POST', '/v1/clients/{grant_id}/revoke', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      const grantId = ctx.params.grant_id;
      // The target first, without spending the challenge: the message must
      // name the grant in the path and be signed by the calling phone, and
      // the grant must exist.
      const pre = verifyPhoneEnvelope(ctx.body, { approverStore, type: 'kl.client.revoke', frontdoorId });
      if (!pre.ok) throw new ApiError(400, pre.reason, `the revocation was refused: ${pre.reason}`);
      if (pre.message.grant_id !== grantId || pre.deviceId !== ctx.deviceId) throw new ApiError(400, 'bad_revoke', 'the revocation must name this grant and be signed by the calling phone');
      if (!grants.get(grantId)) throw new ApiError(404, 'not_found', 'no grant with that id');
      const r = checkClientRevoke(ctx.body, { approverStore, frontdoorId, challenges });
      if (!r.ok) throw new ApiError(400, r.reason, `the revocation was refused: ${r.reason}`);
      // The tokens and onGrantRevoked run even if saving the grant throws
      // (ruling T25-revokefail); the phone then sees an error, and its retry
      // saves the revocation. The audit entry is written either way, since
      // the grant is revoked in memory from then on.
      let changed = false;
      let threw = false;
      try {
        changed = revokeGrantEverywhere({ grants, tokens, onGrantRevoked }, grantId, 'phone');
      } catch (err) {
        threw = true;
        throw err;
      } finally {
        if (changed || threw) await recordFrontDoorEvent(auditLedger, 'frontdoor.grant.revoked', { grant_id: grantId, device_id: r.deviceId, reason: 'phone' });
      }
      if (!changed) throw new ApiError(404, 'not_found', 'no live grant with that id');
      return { status: 204 };
    }
  });
}

module.exports = { registerGrantRoutes };
