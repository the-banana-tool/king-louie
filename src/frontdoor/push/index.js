// Pluggable push (program §4.12, E4). A PushSender is
// { id, platforms: string[], notify(device, payload) → Promise<{ ok, dropToken? }> }.
// The `none` sender is the default and the fallback for any device without a
// matching sender. Push failures are logged and never block anything: a
// sender's own device push tokens, JWTs and OAuth tokens never reach the
// log, since a leaked one lets someone else send push under our identity.
const fs = require('fs');
const { createLogger } = require('../../logging');
const { noneSender } = require('./none');
const { createApnsSender } = require('./apns');
const { createFcmSender } = require('./fcm');
const { readServiceAccountFile } = require('./service-account');
const { KINDS, FCM_ONLY_KINDS, alertText } = require('./text');
const { createPushGate, defaultTimers } = require('./gate');
const { createPushStatus } = require('./status');

const log = createLogger('frontdoor/push');

// config: { apns?: { teamId, keyId, keyFile, topic, environment }, fcm?: { serviceAccountFile } }
function defaultSenders(config = {}, { readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const senders = [];
  if (config && config.apns) {
    const a = config.apns;
    senders.push(createApnsSender({ teamId: a.teamId, keyId: a.keyId, keyPem: readFile(a.keyFile), topic: a.topic, environment: a.environment }));
  }
  if (config && config.fcm) {
    senders.push(createFcmSender({ serviceAccount: readServiceAccountFile(config.fcm.serviceAccountFile, { readFile }) }));
  }
  return senders;
}

// options.now / options.timers: injected clock and timers (tests);
// options.statusFile: where push-status.json goes (the relay passes
// <dataDir>/relay/push-status.json; none, no file).
function createPusher(config = {}, { senders = defaultSenders(config), onDropToken = null, now = Date.now, timers = defaultTimers, statusFile = null } = {}) {
  const status = statusFile ? createPushStatus({ file: statusFile, now, timers }) : null;

  async function send(sender, device, payload) {
    let result = null;
    try {
      result = await sender.notify(device, payload);
    } catch (err) {
      log.warn(`push via ${sender.id} to ${device.device_id} failed: ${err.message}`);
    }
    if (status && sender !== noneSender) status.record(sender.id, result);
    if (result && result.dropToken) {
      log.info(`push token of ${device.device_id} was rejected by ${sender.id}; dropping it`);
      if (onDropToken) onDropToken(device);
    } else if (result && result.ok === false) {
      log.warn(`push via ${sender.id} to ${device.device_id} failed (${result.status})`);
    }
  }

  const fcmSender = senders.find((s) => s.platforms.includes('fcm'));
  const gate = fcmSender ? createPushGate({ send: (device, payload) => send(fcmSender, device, payload), now, timers }) : null;
  let stopped = false;

  return {
    senders: [...senders.map((s) => s.id), noneSender.id],
    // The token platforms some sender can reach (GET /v1/push-token's `sender`).
    platforms: [...new Set(senders.flatMap((s) => s.platforms))],
    // node_id: the node the push is for (null for the front door's own
    // pairing and alert pushes). Only the gate's dedupe key reads it; it is
    // never sent to a phone.
    async notify(device, { node_id: nodeId = null, kind = 'approval', id, node_name: nodeName = null, expires_at: expiresAt = null, count = null } = {}) {
      if (stopped) return;
      const payload = { kind: KINDS.includes(kind) ? kind : 'approval', id, node_name: nodeName, expires_at: expiresAt };
      const platform = device && device.push && device.push.platform;
      // The new kinds, the count and the gate are for fcm devices only (push
      // spec C-2): anything else gets exactly what it got before.
      if (platform !== 'fcm' && FCM_ONLY_KINDS.includes(payload.kind)) return;
      if (platform === 'fcm' && count !== null && count !== undefined) payload.count = count;
      if (platform === 'fcm' && gate) {
        await gate.notify(device, payload, nodeId);
        return;
      }
      const sender = (platform && senders.find((s) => s.platforms.includes(platform))) || noneSender;
      await send(sender, device, payload);
    },
    // Relay stop: drops what a coalescing window holds (never sends it) and
    // writes a pending push-status.json now.
    stop() {
      stopped = true;
      if (gate) gate.stop();
      if (status) status.flush();
    }
  };
}

module.exports = { createPusher, defaultSenders, alertText, KINDS };
