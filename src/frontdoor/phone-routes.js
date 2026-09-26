// The front door's additions to F3's phone API (fleet stage 4 §4.9), under
// F3's /v1 and X-KL-* device auth. Every route that acts on the front door
// or reads what it holds belongs to its own active approvers (admin-owned
// approvers/, R25, Deviation 13): a phone the relay knows, or one active on
// a node, is not enough. History and audit status also keep F3's rule (a
// device active on that node). GET /v1/frontdoor answers any registered
// device and GET /v1/repin needs no auth at all.
//
// Ids in the path are checked against their own patterns before anything is
// looked up with them. Reason codes are returned as codes; the phone words them.
const { createLogger } = require('../logging');
const { ApiError } = require('./phone-api');
const { NODE_ID_RE } = require('../approvals/messages');
const { checkNodeRemove, verifyPhoneEnvelope } = require('./protocol/checks');
const { rawEd25519, PAIRING_ID_RE } = require('./protocol/messages');
const { recordFrontDoorEvent } = require('./audit/own-ledger');

const log = createLogger('frontdoor/phone-routes');

// Decision refusals by reason; anything else the checks return is 400.
// save_failed (503 with retry_after) is retryable: the phone sends the same
// envelope again.
const DECISION_STATUS = Object.freeze({
  unknown_pairing: 410, expired: 410,
  already_decided: 409, console_record: 409, replaces_changed: 409, key_enrolled_as_other_name: 409,
  revoked_device: 403
});
const RETRY_AFTER_S = 1;
const ALERT_ID_RE = /^[1-9][0-9]{0,15}$/;
const SEQ_RE = /^(?:0|[1-9][0-9]{0,15})$/;
const CAPABILITY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_CAPABILITIES = 32;

const saveFailed = (message) => new ApiError(503, 'save_failed', message, { retry_after: RETRY_AFTER_S });

// One value of a query parameter, or undefined. A repeated parameter is
// refused rather than one copy picked; a value must match `re`.
function queryValue(req, name, re) {
  const values = new URL(req.url, 'http://relay.invalid').searchParams.getAll(name);
  if (values.length === 0) return undefined;
  if (values.length > 1 || !re.test(values[0])) throw new ApiError(400, 'bad_query', `${name} must appear once and be a whole number`);
  return values[0];
}

function registerFrontDoorRoutes(phoneApi, { approverStore, devices, nodeHub, registry, pairing, mirror, alerts, challenges, identity, domain,
  certificate = () => null, repin = () => null, ownLedger = null, auditLedger = null } = {}) {
  // Fail closed: without the stores that decide who may act, no route is registered.
  if (!approverStore || typeof approverStore.isActive !== 'function' || typeof approverStore.get !== 'function') throw new TypeError('registerFrontDoorRoutes needs the front door approver store');
  if (!devices || typeof devices.nodesForDevice !== 'function') throw new TypeError('registerFrontDoorRoutes needs the device registry');
  if (!nodeHub || typeof nodeHub.rpc !== 'function') throw new TypeError('registerFrontDoorRoutes needs the node hub');
  if (!registry || typeof registry.removeSigned !== 'function' || typeof registry.byId !== 'function') throw new TypeError('registerFrontDoorRoutes needs the node registry');
  if (!pairing || typeof pairing.issue !== 'function' || typeof pairing.decide !== 'function') throw new TypeError('registerFrontDoorRoutes needs the pairing service');
  if (!mirror || typeof mirror.history !== 'function') throw new TypeError('registerFrontDoorRoutes needs the audit mirror');
  if (!alerts || typeof alerts.list !== 'function') throw new TypeError('registerFrontDoorRoutes needs the alert center');
  if (!challenges || typeof challenges.take !== 'function') throw new TypeError('registerFrontDoorRoutes needs the challenges');
  if (!identity || typeof identity.nodeId !== 'string' || !NODE_ID_RE.test(identity.nodeId)) throw new TypeError('registerFrontDoorRoutes needs the front door identity');
  const frontdoorId = identity.nodeId;

  const requireApprover = (ctx) => {
    if (approverStore.isActive(ctx.deviceId) !== true) throw new ApiError(403, 'forbidden', 'this phone is not an approver on this front door');
  };
  const validId = (value, re) => {
    if (typeof value !== 'string' || !re.test(value)) throw new ApiError(404, 'not_found', 'no such item');
    return value;
  };
  const requireVisible = (ctx, nodeId) => {
    const active = devices.nodesForDevice(ctx.deviceId).some((n) => n.node_id === nodeId && n.state === 'active');
    if (!active) throw new ApiError(404, 'not_found', 'no such node for this device');
  };

  phoneApi.registerRoute('POST', '/v1/pairing-codes', {
    auth: 'device',
    // Its own budget: each call writes pairing.json and an audit entry.
    rate: { perMin: 10 },
    handler: async (req, ctx) => {
      requireApprover(ctx);
      const body = ctx.body;
      const nodeName = body && typeof body === 'object' && !Array.isArray(body) ? body.node_name : undefined;
      try {
        return { body: await pairing.issue(nodeName, { by: ctx.deviceId }) };
      } catch (err) {
        if (err.code === 'bad_node_name') throw new ApiError(400, 'bad_node_name', err.message);
        if (err.code === 'too_many_codes') throw new ApiError(429, 'too_many_codes', err.message, { retry_after: err.retryAfterS || 60 });
        throw err;
      }
    }
  });

  phoneApi.registerRoute('GET', '/v1/pairings/pending', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      return { body: pairing.pending() };
    }
  });

  phoneApi.registerRoute('POST', '/v1/pairings/{id}/decision', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      const pairingId = validId(ctx.params.id, PAIRING_ID_RE);
      try {
        return { body: await pairing.decide(pairingId, ctx.body, { deviceId: ctx.deviceId }) };
      } catch (err) {
        if (err instanceof ApiError || typeof err.code !== 'string') throw err;
        if (err.code === 'save_failed') throw saveFailed(err.message);
        throw new ApiError(DECISION_STATUS[err.code] || 400, err.code, err.message);
      }
    }
  });

  phoneApi.registerRoute('POST', '/v1/nodes/{node_id}/remove', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      const nodeId = validId(ctx.params.node_id, NODE_ID_RE);
      // The target first, without spending the challenge: the message must
      // name this node and be signed by the calling phone, and the node must
      // be one a phone may remove. A node already removed here counts, so a
      // retry after a failed save (with a new challenge) saves and succeeds.
      const pre = verifyPhoneEnvelope(ctx.body, { approverStore, type: 'kl.node.remove', frontdoorId });
      if (!pre.ok) throw new ApiError(pre.reason === 'revoked_device' ? 403 : 400, pre.reason, `the removal was refused: ${pre.reason}`);
      if (pre.message.node_id !== nodeId || pre.deviceId !== ctx.deviceId) {
        throw new ApiError(400, 'bad_remove', 'the removal must name this node and be signed by the calling phone');
      }
      const target = registry.byId(nodeId) || (typeof registry.removal === 'function' ? registry.removal(nodeId) : null);
      if (!target) throw new ApiError(404, 'not_found', 'no such node');
      if (target.source === 'console') throw new ApiError(409, 'console_record', `"${target.node_name}" was confirmed at the console; remove it there with frontdoor remove-node ${target.node_name}`);
      const r = checkNodeRemove(ctx.body, { approverStore, frontdoorId, challenges });
      if (!r.ok) throw new ApiError(400, r.reason, `the removal was refused: ${r.reason}`);
      // A save that fails still leaves the node removed in memory (its link
      // is closed), so the audit entry is written either way; the phone sees
      // a retryable error and its retry saves the removal. Only a call that
      // removed or saved something is audited: a repeat of a removal already
      // on disk answers 204 and writes nothing.
      let result = null;
      let failure = null;
      try {
        result = registry.removeSigned(r.message);
      } catch (err) {
        failure = err;
      } finally {
        if ((result && result.changed === true) || (failure && failure.code === 'save_failed' && failure.removedNow === true)) {
          await recordFrontDoorEvent(auditLedger, 'frontdoor.node.removed', {
            node_id: nodeId, node_name: target.node_name, device_id: r.deviceId, by: 'phone', saved: failure === null
          });
        }
      }
      if (failure) {
        if (failure.code === 'save_failed') throw saveFailed('the node is removed but the removal could not be saved; try again');
        if (failure.code === 'unknown_node') throw new ApiError(404, 'not_found', 'no such node');
        if (failure.code === 'console_record') throw new ApiError(409, 'console_record', failure.message);
        throw failure;
      }
      return { status: 204 };
    }
  });

  phoneApi.registerRoute('GET', '/v1/nodes', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      return {
        body: registry.list().map((r) => {
          const p = registry.presence(r.node_id) || {};
          const hello = p.hello && typeof p.hello === 'object' ? p.hello : {};
          // The hello comes from the node: only well-formed capability names.
          const capabilities = Array.isArray(hello.capabilities)
            ? hello.capabilities.filter((c) => typeof c === 'string' && CAPABILITY_RE.test(c)).slice(0, MAX_CAPABILITIES)
            : [];
          let audit;
          try {
            audit = mirror.audit(r.node_id);
          } catch (err) {
            log.warn(`cannot read the audit mirror status of ${r.node_id}: ${err.message}`);
            audit = 'unknown';
          }
          return {
            node_id: r.node_id,
            node_name: r.node_name,
            online: p.online === true,
            profile: r.profile,
            capabilities,
            source: r.source,
            audit,
            last_seen: typeof p.last_seen === 'string' ? p.last_seen : null
          };
        })
      };
    }
  });

  phoneApi.registerRoute('GET', '/v1/nodes/{node_id}/history', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      const nodeId = validId(ctx.params.node_id, NODE_ID_RE);
      const limit = queryValue(req, 'limit', SEQ_RE);
      const beforeSeq = queryValue(req, 'before_seq', SEQ_RE);
      requireVisible(ctx, nodeId);
      const params = { limit: Math.min(200, Math.max(1, limit === undefined ? 50 : Number(limit))) };
      if (beforeSeq !== undefined) params.before_seq = Number(beforeSeq);
      const presence = registry.presence(nodeId);
      if (nodeId === frontdoorId || (presence && presence.online === true)) {
        try {
          const result = await nodeHub.rpc(nodeId, 'audit.slice', params);
          const envelope = result && result.envelope;
          if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) return { body: envelope };
        } catch (err) {
          log.debug(`history for ${nodeId} from the node failed (${err.code || err.message}); using the mirror`);
        }
      }
      const stored = mirror.history(nodeId, { before_seq: params.before_seq });
      if (!stored || !stored.envelope) throw new ApiError(503, 'node_offline', 'the node is offline and the front door holds no history for it');
      return { body: stored.envelope };
    }
  });

  phoneApi.registerRoute('GET', '/v1/nodes/{node_id}/audit-status', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      const nodeId = validId(ctx.params.node_id, NODE_ID_RE);
      requireVisible(ctx, nodeId);
      if (nodeId === frontdoorId) {
        const last = ownLedger ? ownLedger.tail(1)[0] : null;
        return { body: { head_seq: last ? last.seq : 0, anchor: null, gaps: [], breaks: [] } };
      }
      // Break reasons (oversize_entry, withheld_entries, fork, ...) go out as
      // the mirror records them.
      const s = mirror.status(nodeId);
      return { body: { head_seq: s.head_seq, anchor: s.anchor, gaps: s.gaps, breaks: s.breaks } };
    }
  });

  phoneApi.registerRoute('GET', '/v1/alerts', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      const since = queryValue(req, 'since', SEQ_RE);
      return { body: alerts.list({ since: since === undefined ? 0 : Number(since) }) };
    }
  });

  phoneApi.registerRoute('POST', '/v1/alerts/{id}/ack', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireApprover(ctx);
      const id = validId(ctx.params.id, ALERT_ID_RE);
      if (!alerts.ack(id)) throw new ApiError(404, 'not_found', 'no such alert');
      await recordFrontDoorEvent(auditLedger, 'frontdoor.alert.ack', { id, device_id: ctx.deviceId });
      return { status: 204 };
    }
  });

  // Public facts about this front door, for any phone the relay knows.
  phoneApi.registerRoute('GET', '/v1/frontdoor', {
    auth: 'device',
    handler: async () => {
      let cert = null;
      try {
        cert = certificate();
      } catch (err) {
        log.warn(`cannot read the current certificate: ${err.message}`);
      }
      return { body: { frontdoor_id: frontdoorId, public_key: rawEd25519(identity.publicKey), domain, cert_not_after: cert && cert.notAfter ? cert.notAfter : null } };
    }
  });

  // No auth: a phone whose pin no longer matches cannot sign in, and the
  // envelope is signed by the front-door key the phone already pinned.
  phoneApi.registerRoute('GET', '/v1/repin', {
    auth: 'none',
    handler: async () => {
      const envelope = repin();
      if (!envelope) throw new ApiError(404, 'not_found', 'no re-pin has been published');
      return { body: envelope };
    }
  });
}

module.exports = { registerFrontDoorRoutes };
