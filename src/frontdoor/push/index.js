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
const { KINDS, alertText } = require('./text');

const log = createLogger('frontdoor/push');

// config: { apns?: { teamId, keyId, keyFile, topic, environment }, fcm?: { serviceAccountFile } }
function defaultSenders(config = {}, { readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const senders = [];
  if (config && config.apns) {
    const a = config.apns;
    senders.push(createApnsSender({ teamId: a.teamId, keyId: a.keyId, keyPem: readFile(a.keyFile), topic: a.topic, environment: a.environment }));
  }
  if (config && config.fcm) {
    senders.push(createFcmSender({ serviceAccount: JSON.parse(readFile(config.fcm.serviceAccountFile)) }));
  }
  return senders;
}

function createPusher(config = {}, { senders = defaultSenders(config), onDropToken = null } = {}) {
  return {
    senders: [...senders.map((s) => s.id), noneSender.id],
    async notify(device, { kind = 'approval', id, node_name: nodeName = null, expires_at: expiresAt = null } = {}) {
      const payload = { kind: KINDS.includes(kind) ? kind : 'approval', id, node_name: nodeName, expires_at: expiresAt };
      const platform = device && device.push && device.push.platform;
      const sender = (platform && senders.find((s) => s.platforms.includes(platform))) || noneSender;
      try {
        const result = await sender.notify(device, payload);
        if (result && result.dropToken) {
          log.info(`push token of ${device.device_id} was rejected by ${sender.id}; dropping it`);
          if (onDropToken) onDropToken(device);
        } else if (result && result.ok === false) {
          log.warn(`push via ${sender.id} to ${device.device_id} failed (${result.status})`);
        }
      } catch (err) {
        log.warn(`push via ${sender.id} to ${device.device_id} failed: ${err.message}`);
      }
    }
  };
}

module.exports = { createPusher, defaultSenders, alertText, KINDS };
