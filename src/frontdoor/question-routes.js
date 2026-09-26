// src/frontdoor/question-routes.js
// The relay side of the phone app's Questions screen (cases stage 4 spec
// §3.9, R44), mounted through src/frontdoor/extensions.js. The relay stores
// and forwards; it never decides an answer. Its checks here are a front
// filter only: the node verifies the device signature, nonce, binding,
// device and time on every answer, so the relay forwards the signed body
// untouched and adds no field the node trusts. Loads no agent code.
const { open } = require('../approvals/envelope');

const WEEK_MS = 7 * 24 * 3600 * 1000;
const TOKEN = /^[0-9A-HJKMNP-TV-Z]{6}$/;
// Preflight M6: F3's Mailbox routes only full dotted prefixes; the node seals
// questions as `kl.question.ask`.
const MAILBOX_PREFIX = 'kl.question.';
const ASK_TYPE = 'kl.question.ask';

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// (relay) => void, receiving { phoneApi, nodeHub, mailbox, pusher, devices, approvals, log }.
function registerQuestionRoutes({ phoneApi, nodeHub, mailbox, devices, log }) {
  mailbox.registerType(MAILBOX_PREFIX, { ttlMs: WEEK_MS });

  const activeNodes = (deviceId) => devices.nodesForDevice(deviceId).filter((n) => n.state === 'active').map((n) => n.node_id);

  phoneApi.registerRoute('GET', '/v1/questions', {
    auth: 'device',
    handler: async (req, ctx) => ({ body: mailbox.list({ nodeIds: activeNodes(ctx.deviceId), typePrefix: ASK_TYPE, toDevice: ctx.deviceId }) })
  });

  // The body is the device-signed kl.question.answer envelope, forwarded unchanged.
  phoneApi.registerRoute('POST', '/v1/questions/{token}/answer', {
    auth: 'device',
    rate: { perMin: 30 },
    handler: async (req, ctx) => {
      if (!TOKEN.test(String(ctx.params.token))) throw httpError(400, 'bad_token', 'not a question token');
      let message;
      try {
        ({ message } = open(ctx.body));
      } catch {
        throw httpError(400, 'malformed', 'the body is not an envelope');
      }
      if (message.type !== 'kl.question.answer') throw httpError(400, 'malformed', 'not a kl.question.answer');
      if (message.device_id !== ctx.deviceId) throw httpError(403, 'forbidden', 'the answer is signed for another device');
      if (message.token !== ctx.params.token) throw httpError(400, 'bad_token', 'the token does not match the path');
      if (!activeNodes(ctx.deviceId).includes(message.node_id)) throw httpError(404, 'not_found', 'no such node for this device');
      // No mailbox lookup (ruling T18-lookup): the mailbox is in memory, so a
      // relay restart or the TTL would lock out a valid signed answer.
      let result;
      try {
        result = await nodeHub.rpc(message.node_id, 'question.answer', { envelope: ctx.body }, { timeoutMs: 10000 });
      } catch (err) {
        log.warn(`question.answer to ${message.node_id} failed: ${err.message}`);
        throw httpError(502, 'node_offline', 'the node did not answer; try again');
      }
      return { body: result };
    }
  });

  // Foreground pings, unsigned (ruling T17-presence): the node accepts them
  // only from its relay link and for a paired device, and they only reorder
  // the reach ladder. deviceId comes from the device auth, never the body.
  phoneApi.registerRoute('POST', '/v1/presence', {
    auth: 'device',
    rate: { perMin: 6 },
    handler: async (req, ctx) => {
      const body = ctx.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'malformed', 'the body must be { foreground, at }');
      const { foreground, at } = body;
      if (typeof foreground !== 'boolean') throw httpError(400, 'malformed', 'foreground must be true or false');
      if (typeof at !== 'number' || !Number.isFinite(at)) throw httpError(400, 'malformed', 'at must be a time in ms since the epoch');
      let delivered = 0;
      for (const nodeId of activeNodes(ctx.deviceId)) {
        try {
          await nodeHub.rpc(nodeId, 'presence.foreground', { deviceId: ctx.deviceId, foreground, at }, { timeoutMs: 5000 });
          delivered += 1;
        } catch (err) {
          log.debug(`presence.foreground to ${nodeId} failed: ${err.message}`);
        }
      }
      return { body: { ok: true, nodes: delivered } };
    }
  });
}

module.exports = { registerQuestionRoutes, WEEK_MS };
