// node → relay link methods (spec §4.6). Everything a node sends is checked
// against that node's key before the relay stores or forwards it; the relay
// never alters a signed message.
const { open, verifyEd25519, verifyEs256 } = require('../approvals/envelope');
const { validateMessage, isTimestamp } = require('../approvals/messages');
const { LinkRpcError } = require('../approvals/link-rpc');
const { TTL_MS: CODE_TTL_MS } = require('./invites');
const { KINDS: PUSH_KINDS } = require('./push/text');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_PUSH_ID = 128;

// Node answers to device.enroll / device.revoke that the relay records. A
// node reply can never mark a device `active` through these paths: only
// enroll.done (console enrollment) and device.state (the admin-applied set)
// do that.
const ENROLL_STATES = ['staged', 'rejected'];
const REVOKE_STATES = ['revoked-pending-apply'];

function sameEnvelope(a, b) {
  return isPlainObject(a) && isPlainObject(b) && ['alg', 'kid', 'payload', 'sig'].every((k) => typeof a[k] === 'string' && a[k] === b[k]);
}

// A phone's self-signed console enrollment for this code: well formed,
// enrolled_by null, naming the code, signed by the key it enrolls.
function isConsoleEnrollment(envelope, codeId) {
  let message;
  try {
    ({ message } = open(envelope));
  } catch {
    return null;
  }
  if (validateMessage('kl.device.enroll', message) || message.enrolled_by !== null || message.code_id !== codeId) return null;
  if (envelope.kid !== message.device.device_id || !verifyEs256(envelope, message.device.public_key)) return null;
  return message;
}

function registerNodeMethods(relay) {
  const { nodeHub, approvals, devices, invites, mailbox, pusher, identity, log } = relay;
  const now = relay.now || Date.now;

  // The envelope must be signed by the node on this link and name it: its
  // kid and its message's node_id are both this link's node id, and a typed
  // message must also be a valid message of that type.
  const fromNode = (nodeId, envelope, type = null) => {
    const node = nodeHub.nodeById(nodeId);
    if (!node || !isPlainObject(envelope) || envelope.alg !== 'Ed25519' || envelope.kid !== nodeId || !verifyEd25519(envelope, node.public_key)) {
      throw new LinkRpcError('bad_signature', 'not signed by this node');
    }
    let message;
    try {
      ({ message } = open(envelope));
    } catch {
      throw new LinkRpcError('malformed', 'the envelope does not open');
    }
    if (type ? validateMessage(type, message) : typeof message.type !== 'string') throw new LinkRpcError('malformed', `expected ${type || 'a typed message'}`);
    if (message.node_id !== nodeId) throw new LinkRpcError('wrong_node', 'the message does not name this node');
    return { message, node };
  };

  // Push carries only { kind, id } plus the node name (the pusher sanitises
  // it and builds generic alert text); never anything from the action.
  const pushTo = (targets, payload) => {
    for (const device of targets) {
      pusher.notify(device, payload).catch((err) => log.warn(`push failed: ${err.message}`));
    }
  };

  // Every enrollment and revocation the relay relayed, so a node that was
  // offline catches up (it answers `duplicate` for what it already has).
  const replaying = new Set();
  const replayDeviceLog = async (nodeId) => {
    // One replay per node at a time: a node that says hello again while its
    // last replay is still running does not start a second pass.
    if (replaying.has(nodeId)) return;
    replaying.add(nodeId);
    try {
      await replayOnce(nodeId);
    } finally {
      replaying.delete(nodeId);
    }
  };
  const replayOnce = async (nodeId) => {
    for (const envelope of devices.log()) {
      let message;
      try {
        ({ message } = open(envelope));
      } catch {
        continue;
      }
      const enroll = message.type === 'kl.device.enroll';
      const method = enroll ? 'device.enroll' : 'device.revoke';
      const target = enroll ? message.device && message.device.device_id : message.device_id;
      try {
        const result = await nodeHub.rpc(nodeId, method, { envelope });
        const state = result && result.state;
        if ((enroll ? ENROLL_STATES : REVOKE_STATES).includes(state)) devices.setNodeState(target, nodeId, state);
      } catch (err) {
        log.warn(`device log replay to ${nodeId} stopped: ${err.message}`);
        return;
      }
    }
  };

  nodeHub.onNodeMessage('relay.hello', async (params, { nodeId }) => {
    if (!isPlainObject(params) || params.node_id !== nodeId) throw new LinkRpcError('wrong_node', 'relay.hello names another node');
    setImmediate(() => { replayDeviceLog(nodeId).catch((err) => log.warn(`replay failed: ${err.message}`)); });
    return { relay_id: identity.nodeId, public_url: relay.publicUrl, phone_spki: relay.phoneSpki };
  });

  nodeHub.onNodeMessage('approval.submit', async ({ envelope }, { nodeId }) => {
    const { message, node } = fromNode(nodeId, envelope, 'kl.approval.request');
    try {
      approvals.put(nodeId, envelope);
    } catch (err) {
      throw new LinkRpcError(err.code || 'malformed', err.message);
    }
    pushTo(devices.devicesForNode(nodeId), { kind: 'approval', id: message.request_id, node_name: node.node_name, expires_at: message.expires_at });
    return { ok: true };
  });

  nodeHub.onNodeMessage('approval.status', async ({ envelope }, { nodeId }) => {
    const { message } = fromNode(nodeId, envelope, 'kl.approval.status');
    return { ok: approvals.setStatus(message.request_id, envelope) };
  });

  // Only a type a consumer registered with mailbox.registerType is routed;
  // the mailbox itself refuses the approval-protocol types (kl.enroll.* …).
  nodeHub.onNodeMessage('message.submit', async ({ envelope, push = null, to_device: toDevice = null }, { nodeId }) => {
    const { node } = fromNode(nodeId, envelope);
    if (push !== null && push !== undefined) {
      const ok = isPlainObject(push) && PUSH_KINDS.includes(push.kind) && typeof push.id === 'string' && push.id.length > 0 && push.id.length <= MAX_PUSH_ID
        && (push.expires_at === undefined || push.expires_at === null || isTimestamp(push.expires_at));
      if (!ok) throw new LinkRpcError('bad_push', `push must be { kind: ${PUSH_KINDS.join('|')}, id, expires_at? }`);
    }
    let result;
    try {
      result = mailbox.put(nodeId, envelope, { to_device: toDevice });
    } catch (err) {
      throw new LinkRpcError(err.code || 'error', err.message);
    }
    if (push) {
      // Pushed only to phones that approve on this node.
      const targets = devices.devicesForNode(nodeId).filter((d) => toDevice === null || d.device_id === toDevice);
      pushTo(targets, { kind: push.kind, id: push.id, node_name: node.node_name, expires_at: typeof push.expires_at === 'string' ? push.expires_at : null });
    }
    return { ok: true, seq: result.seq };
  });

  // A node opens a console enrollment code. A code id already known to the
  // relay (open, or closed but still kept) is never re-opened: another node
  // must not take over a code, and a closed code stays closed. The same
  // node repeating the open of a code that is still open is a retry.
  nodeHub.onNodeMessage('enroll.open', async ({ envelope }, { nodeId }) => {
    const { message } = fromNode(nodeId, envelope, 'kl.enroll.open');
    const existing = invites.getCode(message.code_id);
    if (existing) {
      if (existing.node_id === nodeId && existing.state === 'waiting') return { ok: true };
      throw new LinkRpcError('code_taken', 'that code id is already in use');
    }
    const expiresAt = Math.min(Date.parse(message.expires_at), now() + CODE_TTL_MS);
    if (!(expiresAt > now())) throw new LinkRpcError('code_closed', 'the code has already expired');
    invites.openCode(message.code_id, nodeId, expiresAt);
    return { ok: true };
  });

  // The console confirmed (or refused) the phone's claim. This and the
  // signed-device route are the only two ways a device is ever registered,
  // and here only for an open code this node opened, and only for the exact
  // self-signed enrollment the relay received from the phone.
  nodeHub.onNodeMessage('enroll.done', async ({ envelope }, { nodeId }) => {
    const { message } = fromNode(nodeId, envelope, 'kl.enroll.done');
    const code = invites.getCode(message.code_id);
    if (!code || code.node_id !== nodeId) throw new LinkRpcError('unknown_code', 'this node did not open that code');
    if (code.state !== 'waiting') throw new LinkRpcError('code_closed', 'the code is no longer open');
    if (message.refused !== false || message.enroll === null) {
      invites.closeCode(message.code_id, 'refused');
      return { ok: true };
    }
    if (!code.claim || !sameEnvelope(code.claim, message.enroll)) throw new LinkRpcError('claim_mismatch', 'not the enrollment the phone sent for this code');
    const enroll = isConsoleEnrollment(message.enroll, message.code_id);
    if (!enroll) throw new LinkRpcError('bad_enroll', 'not a self-signed enrollment for this code');
    const d = enroll.device;
    try {
      devices.register({ device_id: d.device_id, jwk: d.public_key, name: d.name, platform: d.platform });
    } catch (err) {
      throw new LinkRpcError(err.code || 'bad_device', err.message);
    }
    devices.setNodeState(d.device_id, nodeId, 'active');
    invites.closeCode(message.code_id, 'done', message.enroll);
    return { ok: true };
  });

  nodeHub.onNodeMessage('device.state', async ({ device_id: deviceId, state }, { nodeId }) => {
    if (!['active', 'revoked'].includes(state)) throw new LinkRpcError('malformed', 'state must be active or revoked');
    // Only this link's node's column, and only for a device the relay knows.
    if (!devices.get(deviceId)) throw new LinkRpcError('unknown_device', 'the relay has no such device');
    devices.setNodeState(deviceId, nodeId, state);
    return { ok: true };
  });

  return { replayDeviceLog };
}

module.exports = { registerNodeMethods, isConsoleEnrollment, sameEnvelope };
