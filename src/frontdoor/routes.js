// F3's phone API routes (spec §4.5), registered through the route registry
// like any extension's. The relay authenticates callers and forwards; nodes
// verify every signature again.
const { open, verifyEs256, deviceIdFromJwk } = require('../approvals/envelope');
const { validateMessage } = require('../approvals/messages');
const { ApiError } = require('./phone-api');
const { isConsoleEnrollment, sameEnvelope } = require('./node-methods');

const NODE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_WAIT_S = 25;
// Long polls one device may have parked at once; more answer 429 at once.
const MAX_POLLS_PER_DEVICE = 2;
// Node answers the relay records for a relayed enrollment or revocation (a
// node reply never makes a device `active` here).
const ENROLL_STATES = ['staged', 'rejected'];

function parseEnvelope(body, type) {
  let message;
  try {
    ({ message } = open(body));
  } catch {
    throw new ApiError(400, 'malformed', 'the body is not a signed envelope');
  }
  if (validateMessage(type, message)) throw new ApiError(400, 'malformed', `the body is not a valid ${type}`);
  return message;
}

function registerPhoneRoutes(relay) {
  const { phoneApi, nodeHub, approvals, devices, invites } = relay;
  const now = relay.now || Date.now;
  const lastSeen = new Map();
  const polling = new Map();

  const activeNodes = (deviceId) => devices.nodesForDevice(deviceId).filter((n) => n.state === 'active').map((n) => n.node_id);
  // Relay-wide powers (pairing codes, invites, enrolling or revoking
  // devices, the device and node lists) belong to a device that approves somewhere.
  // One revoked or rejected everywhere (a stolen phone) keeps none of them.
  const requireActive = (ctx) => {
    const nodes = activeNodes(ctx.deviceId);
    if (nodes.length === 0) throw new ApiError(403, 'forbidden', 'this device is not an approver on any node');
    return nodes;
  };
  const appendLog = (envelope) => {
    try {
      return devices.appendLog(envelope);
    } catch (err) {
      if (err.code === 'log_full') throw new ApiError(503, 'log_full', err.message);
      throw err;
    }
  };
  const toNode = async (nodeId, method, params) => {
    try {
      return await nodeHub.rpc(nodeId, method, params);
    } catch (err) {
      throw new ApiError(503, 'node_offline', `the node could not be reached (${err.code || 'error'})`);
    }
  };
  const view = (entry) => ({ envelope: entry.envelope, expires_in_ms: Math.max(0, entry.expires_at - now()), status: entry.status });
  // `code` auth admits any code still kept (open, or closed and visible for
  // KEEP_MS); a handler that acts on a code first checks it is open.
  const openCode = (codeId) => {
    const code = invites.getCode(codeId);
    if (!code || code.state !== 'waiting') throw new ApiError(410, 'code_closed', 'this enrollment code is no longer open');
    return code;
  };

  phoneApi.registerRoute('GET', '/v1/time', { auth: 'none', handler: async () => ({ body: { server_time: new Date(now()).toISOString() } }) });

  // Console enrollment: the phone posts its self-signed enroll for a code the
  // node opened; the node (not the relay) checks code_mac. The first claim
  // for a code is the one the node sees; posting the same claim again is a
  // retry, a different one is refused.
  phoneApi.registerRoute('POST', '/v1/enroll/{code_id}', {
    auth: 'code',
    handler: async (req, ctx) => {
      const codeId = ctx.params.code_id;
      const code = openCode(codeId);
      parseEnvelope(ctx.body, 'kl.device.enroll');
      if (!isConsoleEnrollment(ctx.body, codeId)) throw new ApiError(400, 'bad_enroll', 'not a self-signed enrollment for this code');
      if (code.claim && !sameEnvelope(code.claim, ctx.body)) throw new ApiError(409, 'already_claimed', 'this code was already claimed by another enrollment');
      try {
        invites.claimCode(codeId, ctx.body);
      } catch {
        throw new ApiError(410, 'code_closed', 'this enrollment code is no longer open');
      }
      const result = await toNode(code.node_id, 'enroll.claim', { code_id: codeId, envelope: ctx.body });
      // The node hands the claim to whoever opened the code; `false` means
      // nobody there is waiting for it any more (closed or expired on the node).
      if (!result || result.delivered !== true) throw new ApiError(410, 'code_closed', 'the node is no longer waiting for this code');
      return { status: 202, body: { state: 'waiting' } };
    }
  });

  // Status of a code: visible in every state (waiting, expired, done,
  // refused) for as long as the relay keeps it.
  phoneApi.registerRoute('GET', '/v1/enroll/{code_id}', {
    auth: 'code',
    handler: async (req, ctx) => {
      const code = invites.getCode(ctx.params.code_id);
      if (!code) throw new ApiError(404, 'unknown_code', 'no enrollment code with that id');
      const node = nodeHub.nodeById(code.node_id);
      return { body: { state: code.state, node: node ? { node_id: node.node_id, node_name: node.node_name } : null } };
    }
  });

  // Long poll: returns at once when something is new since this device's
  // last call, else waits up to `wait` seconds for a change.
  phoneApi.registerRoute('GET', '/v1/approvals', {
    auth: 'device',
    handler: async (req, ctx) => {
      const wait = Math.min(MAX_WAIT_S, Math.max(0, Number.parseInt(ctx.query.wait || '0', 10) || 0));
      const cursor = lastSeen.get(ctx.deviceId) || 0;
      if (wait > 0 && approvals.seq <= cursor) {
        const parked = polling.get(ctx.deviceId) || 0;
        if (parked >= MAX_POLLS_PER_DEVICE) throw new ApiError(429, 'rate_limited', `at most ${MAX_POLLS_PER_DEVICE} long polls per device`);
        polling.set(ctx.deviceId, parked + 1);
        try {
          await approvals.waitForChange(cursor, wait * 1000);
        } finally {
          const left = (polling.get(ctx.deviceId) || 1) - 1;
          if (left > 0) polling.set(ctx.deviceId, left);
          else polling.delete(ctx.deviceId);
        }
      }
      lastSeen.set(ctx.deviceId, approvals.seq);
      return { body: approvals.list(activeNodes(ctx.deviceId)).map(view) };
    }
  });

  phoneApi.registerRoute('GET', '/v1/approvals/{request_id}', {
    auth: 'device',
    handler: async (req, ctx) => {
      const entry = approvals.get(ctx.params.request_id);
      if (!entry || !activeNodes(ctx.deviceId).includes(entry.node_id)) throw new ApiError(404, 'not_found', 'no such request');
      return { body: view(entry) };
    }
  });

  // Forwards the calling device's own signed response for this request.
  // `accepted` is true only when the node answered exactly `true`.
  phoneApi.registerRoute('POST', '/v1/approvals/{request_id}/response', {
    auth: 'device',
    handler: async (req, ctx) => {
      const entry = approvals.get(ctx.params.request_id);
      if (!entry || now() > entry.expires_at) throw new ApiError(410, 'gone', 'the request expired or is unknown');
      if (!activeNodes(ctx.deviceId).includes(entry.node_id)) throw new ApiError(403, 'forbidden', 'this device is not an approver on that node');
      const message = parseEnvelope(ctx.body, 'kl.approval.response');
      if (message.request_id !== ctx.params.request_id || message.device_id !== ctx.deviceId || ctx.body.kid !== ctx.deviceId) {
        throw new ApiError(400, 'bad_response', "the body must be this device's response to this request");
      }
      const result = await toNode(entry.node_id, 'approval.response', { envelope: ctx.body });
      const accepted = result && result.accepted === true ? true : (result && result.accepted === false ? false : null);
      const reason = result && typeof result.reason === 'string' ? result.reason : null;
      return { status: 202, body: { delivered: Boolean(result && result.delivered === true), accepted, reason } };
    }
  });

  // The node list is a relay-wide view too: a device that approves nowhere
  // (revoked everywhere) no longer learns every node id and name.
  phoneApi.registerRoute('GET', '/v1/nodes', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireActive(ctx);
      return { body: nodeHub.nodes().map(({ node_id, node_name, online }) => ({ node_id, node_name, online })) };
    }
  });

  phoneApi.registerRoute('GET', '/v1/nodes/{node_id}/history', {
    auth: 'device',
    handler: async (req, ctx) => {
      if (!activeNodes(ctx.deviceId).includes(ctx.params.node_id)) throw new ApiError(404, 'not_found', 'no such node for this device');
      const params = { limit: Math.min(200, Math.max(1, Number.parseInt(ctx.query.limit || '50', 10) || 50)) };
      const beforeSeq = Number.parseInt(ctx.query.before_seq, 10);
      if (Number.isInteger(beforeSeq)) params.before_seq = beforeSeq;
      const result = await toNode(ctx.params.node_id, 'audit.slice', params);
      const envelope = result && result.envelope;
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new ApiError(502, 'bad_node_answer', 'the node did not return a history slice');
      return { body: envelope };
    }
  });

  // Re-bindable (E8): F4 registers its own handler for the same route.
  phoneApi.registerRoute('POST', '/v1/pairing-codes', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireActive(ctx);
      const nodeName = ctx.body && ctx.body.node_name;
      if (typeof nodeName !== 'string' || !NODE_NAME_RE.test(nodeName)) throw new ApiError(400, 'bad_node_name', 'node_name must be 1–64 of A–Z, a–z, 0–9, . _ -');
      return { body: nodeHub.addCode(nodeName) };
    }
  });

  phoneApi.registerRoute('POST', '/v1/devices/invites', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireActive(ctx);
      return { body: invites.createInvite(ctx.deviceId) };
    }
  });

  // Records a claim for the inviting phone to read. It registers nothing:
  // the inviter then signs the enrollment (POST /v1/devices/enroll).
  phoneApi.registerRoute('POST', '/v1/devices/invites/{id}/claim', {
    auth: 'invite',
    handler: async (req, ctx) => {
      const { device, mac } = ctx.body || {};
      const valid = device && typeof device === 'object' && typeof mac === 'string'
        && ['ios', 'android'].includes(device.platform) && typeof device.name === 'string' && device.name.length <= 64
        && (() => { try { return deviceIdFromJwk(device.public_key) === device.device_id; } catch { return false; } })();
      if (!valid) throw new ApiError(400, 'bad_device', 'claim needs { device: { device_id, name, platform, public_key }, mac }');
      try {
        invites.claim(ctx.params.id, { device, mac });
      } catch (err) {
        throw new ApiError(404, err.code || 'unknown_invite', err.message);
      }
      return { status: 202, body: {} };
    }
  });

  phoneApi.registerRoute('GET', '/v1/devices/invites/{id}', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireActive(ctx);
      try {
        return { body: { claim: invites.getClaim(ctx.params.id, ctx.deviceId) } };
      } catch (err) {
        if (err.code === 'forbidden') throw new ApiError(403, 'forbidden', err.message);
        throw new ApiError(404, err.code || 'not_found', err.message);
      }
    }
  });

  // Signed enrollment of a new phone by an enrolled one: logged, then sent to
  // every node the signer approves on, which stage it for `device apply`.
  // The signed-device path: one of the two ways a device is registered, and
  // only by a device that is active on at least one node.
  phoneApi.registerRoute('POST', '/v1/devices/enroll', {
    auth: 'device',
    handler: async (req, ctx) => {
      const message = parseEnvelope(ctx.body, 'kl.device.enroll');
      if (message.enrolled_by !== ctx.deviceId || ctx.body.kid !== ctx.deviceId || !verifyEs256(ctx.body, ctx.device.jwk)) {
        throw new ApiError(400, 'bad_enroll', 'the enrollment must be signed by the calling device');
      }
      const signerNodes = requireActive(ctx);
      const d = message.device;
      // A full log refuses a new enrollment before anything is registered;
      // it is logged only once register has succeeded.
      if (devices.logDecision(ctx.body) === 'full') throw new ApiError(503, 'log_full', 'the device log is full');
      try {
        devices.register({ device_id: d.device_id, jwk: d.public_key, name: d.name, platform: d.platform });
      } catch (err) {
        throw new ApiError(400, 'bad_device', err.message);
      }
      appendLog(ctx.body);
      const nodes = [];
      for (const nodeId of signerNodes) {
        let state = 'offline';
        try {
          const result = await nodeHub.rpc(nodeId, 'device.enroll', { envelope: ctx.body });
          state = result && typeof result.state === 'string' ? result.state : 'offline';
        } catch {
          state = 'offline';
        }
        if (ENROLL_STATES.includes(state)) devices.setNodeState(d.device_id, nodeId, state);
        nodes.push({ node_id: nodeId, state });
      }
      return { body: { nodes } };
    }
  });

  phoneApi.registerRoute('POST', '/v1/devices/revoke', {
    auth: 'device',
    handler: async (req, ctx) => {
      const message = parseEnvelope(ctx.body, 'kl.device.revoke');
      if (message.revoked_by !== ctx.deviceId || ctx.body.kid !== ctx.deviceId || !verifyEs256(ctx.body, ctx.device.jwk)) {
        throw new ApiError(400, 'bad_revoke', 'the revocation must be signed by the calling device');
      }
      // Revoking a device takes a different device (spec §3.10); a device
      // revoking itself (a thief covering tracks, say) is refused outright.
      if (message.revoked_by === message.device_id) throw new ApiError(403, 'forbidden', 'a device cannot revoke itself');
      requireActive(ctx);
      // Always logged (never capped) and always forwarded; a repeat by the
      // same signer of the same target is forwarded but not logged again.
      appendLog(ctx.body);
      const nodes = [];
      for (const { node_id: nodeId } of devices.nodesForDevice(message.device_id)) {
        let state = 'offline';
        try {
          const result = await nodeHub.rpc(nodeId, 'device.revoke', { envelope: ctx.body });
          state = result && typeof result.state === 'string' ? result.state : 'offline';
        } catch {
          state = 'offline';
        }
        if (state === 'revoked-pending-apply') devices.setNodeState(message.device_id, nodeId, state);
        nodes.push({ node_id: nodeId, state });
      }
      return { body: { nodes } };
    }
  });

  phoneApi.registerRoute('GET', '/v1/devices', {
    auth: 'device',
    handler: async (req, ctx) => {
      requireActive(ctx);
      return { body: devices.list().map((d) => ({ device_id: d.device_id, name: d.name, platform: d.platform, nodes: devices.nodesForDevice(d.device_id) })) };
    }
  });

  phoneApi.registerRoute('PUT', '/v1/push-token', {
    auth: 'device',
    handler: async (req, ctx) => {
      const { platform, token } = ctx.body || {};
      if (!['apns', 'fcm'].includes(platform) || typeof token !== 'string' || !token || token.length > 4096) {
        throw new ApiError(400, 'bad_push_token', 'body is { platform: apns|fcm, token }');
      }
      devices.setPush(ctx.deviceId, { platform, token });
      return { status: 204 };
    }
  });
}

module.exports = { registerPhoneRoutes };
