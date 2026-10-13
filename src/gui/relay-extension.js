// src/gui/relay-extension.js
// The relay side of computer-use leases (fleet stage 5 spec §4.7), mounted
// through src/frontdoor/extensions.js. The relay stores and forwards; the
// node verifies every phone envelope (lease-protocol.js checks 1–12). The
// checks here only keep obvious junk off the link. Loads no agent code.
const { open } = require('../approvals/envelope');

const LEASE_TTL_MS = 5 * 60 * 1000;
const MAX_BYTES = 262144;
const MAX_WAIT_S = 25;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTIONS = { grant: 'kl.lease.grant', revoke: 'kl.lease.revoke', watch: 'kl.lease.watch' };

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function messageOf(envelope) {
  try {
    return open(envelope).message;
  } catch {
    return null;
  }
}

const waitMs = (query) => Math.min(MAX_WAIT_S, Math.max(0, Number.parseInt((query && query.wait) || '0', 10) || 0)) * 1000;

// (relay) => void, receiving { phoneApi, nodeHub, mailbox, pusher, devices, approvals, log }.
function registerLeaseRoutes({ phoneApi, nodeHub, mailbox, devices, log }) {
  mailbox.registerType('kl.lease.', { ttlMs: LEASE_TTL_MS, maxBytes: MAX_BYTES });
  const activeNodes = (deviceId) => devices.nodesForDevice(deviceId).filter((n) => n.state === 'active').map((n) => n.node_id);

  // Pending requests with the latest status of each lease.
  function leaseList(deviceId) {
    const items = mailbox.list({ nodeIds: activeNodes(deviceId), typePrefix: 'kl.lease.', toDevice: deviceId });
    const latest = new Map();
    const requests = [];
    for (const item of items) {
      const m = messageOf(item.envelope);
      if (!m) continue;
      if (m.type === 'kl.lease.status') latest.set(`${item.node_id}|${m.lease_id}`, item.envelope);
      if (m.type === 'kl.lease.request') requests.push({ item, leaseId: m.lease_id });
    }
    return requests.map(({ item, leaseId }) => ({ node_id: item.node_id, envelope: item.envelope, status: latest.get(`${item.node_id}|${leaseId}`) || null }));
  }

  phoneApi.registerRoute('GET', '/v1/leases', {
    auth: 'device',
    handler: async (req, ctx) => {
      const ms = waitMs(ctx.query);
      if (ms > 0 && leaseList(ctx.deviceId).length === 0) {
        await mailbox.wait({ nodeIds: activeNodes(ctx.deviceId), typePrefix: 'kl.lease.request', toDevice: ctx.deviceId }, { timeoutMs: ms });
      }
      return { body: leaseList(ctx.deviceId) };
    }
  });

  for (const [action, type] of Object.entries(ACTIONS)) {
    phoneApi.registerRoute('POST', `/v1/leases/{lease_id}/${action}`, {
      auth: 'device',
      rate: action === 'watch' ? { perMin: 12 } : { perMin: 30 },
      handler: async (req, ctx) => {
        const leaseId = String(ctx.params.lease_id);
        if (!UUID_V4_RE.test(leaseId)) throw httpError(400, 'bad_lease', 'not a lease id');
        const m = messageOf(ctx.body);
        if (!m) throw httpError(400, 'malformed', 'the body is not an envelope');
        if (m.type !== type) throw httpError(400, 'malformed', `not a ${type}`);
        if (m.device_id !== ctx.deviceId) throw httpError(403, 'forbidden', 'the envelope is signed for another device');
        if (m.lease_id !== leaseId) throw httpError(400, 'bad_lease', 'the lease id does not match the path');
        if (!activeNodes(ctx.deviceId).includes(m.node_id)) throw httpError(404, 'not_found', 'no such node for this device');
        // R-F5-6: read before the node hears the watch, so the view this
        // watch causes is after it. A phone that fetches on tap asks for
        // views from here with `wait` and gets that frame, not the statuses
        // the lease left earlier.
        const position = action === 'watch' && Number.isInteger(mailbox.seq) ? mailbox.seq : null;
        let result;
        try {
          result = await nodeHub.rpc(m.node_id, `lease.${action}`, { envelope: ctx.body }, { timeoutMs: 10000 });
        } catch (err) {
          log.warn(`lease.${action} to ${m.node_id} failed: ${err.message}`);
          throw httpError(503, 'node_offline', 'the node did not answer; try again');
        }
        // The relay's field goes last, so a node's reply cannot set it.
        if (position !== null && result !== null && typeof result === 'object' && !Array.isArray(result)) {
          return { status: 202, body: { ...result, after_seq: position } };
        }
        return { status: 202, body: result };
      }
    });
  }

  function views(deviceId, leaseId, afterSeq) {
    return mailbox.list({ nodeIds: activeNodes(deviceId), typePrefix: 'kl.lease.', toDevice: deviceId, afterSeq })
      .filter((item) => {
        const m = messageOf(item.envelope);
        return m && m.lease_id === leaseId && (m.type === 'kl.lease.view' || m.type === 'kl.lease.status');
      })
      .map((item) => ({ seq: item.seq, envelope: item.envelope }));
  }

  phoneApi.registerRoute('GET', '/v1/leases/{lease_id}/views', {
    auth: 'device',
    handler: async (req, ctx) => {
      const leaseId = String(ctx.params.lease_id);
      if (!UUID_V4_RE.test(leaseId)) throw httpError(400, 'bad_lease', 'not a lease id');
      const afterSeq = Math.max(0, Number.parseInt((ctx.query && ctx.query.after_seq) || '0', 10) || 0);
      const deadline = Date.now() + waitMs(ctx.query);
      const filter = (seq) => ({ nodeIds: activeNodes(ctx.deviceId), typePrefix: 'kl.lease.', toDevice: ctx.deviceId, afterSeq: seq });
      let out = views(ctx.deviceId, leaseId, afterSeq);
      // Wait past messages for other leases (the mailbox wait returns at
      // once while anything newer than the cursor is listed).
      let cursor = afterSeq;
      while (out.length === 0 && Date.now() < deadline) {
        const seen = mailbox.list(filter(cursor));
        if (seen.length) cursor = seen[seen.length - 1].seq;
        const woke = await mailbox.wait(filter(cursor), { timeoutMs: deadline - Date.now() });
        if (woke.length === 0) break;
        cursor = woke[woke.length - 1].seq;
        out = views(ctx.deviceId, leaseId, afterSeq);
      }
      return { body: out };
    }
  });
}

module.exports = { registerLeaseRoutes, LEASE_TTL_MS };
