// The front door's "relay link" to itself (fleet stage 4 §3.11): F3's
// CourierPump and trackDeviceStates talk to a relay client; on the front
// door that client hands every call to the relay's own node → relay
// handlers as the local node. link.json is written so F3's enroll-device
// finds the relay URL and pin it puts in the phone's QR code.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createLogger } = require('../logging');
const { writeFileAtomic } = require('../approvals/approver-store');

const log = createLogger('frontdoor/self-link');

class FrontDoorSelfLink extends EventEmitter {
  constructor({ nodeHub, dataDir, frontdoorId, publicUrl, spki = () => null, now = Date.now } = {}) {
    super();
    this.nodeHub = nodeHub;
    this.linkFile = path.join(dataDir, 'approvals', 'link.json');
    this.frontdoorId = frontdoorId;
    this.publicUrl = publicUrl;
    this.spki = spki;
    this.since = new Date(now()).toISOString();
  }

  isConnected() {
    return true;
  }

  canDeliver() {
    return { ok: true };
  }

  call(method, params = {}) {
    return this.nodeHub.callLocal(method, params);
  }

  notify(method, params = {}) {
    this.nodeHub.callLocal(method, params).catch((err) => log.warn(`local ${method} failed: ${err.message}`));
  }

  writeLink() {
    fs.mkdirSync(path.dirname(this.linkFile), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.linkFile, `${JSON.stringify({
      connected: true, since: this.since, relay_id: this.frontdoorId, relay_public_url: this.publicUrl, relay_spki: this.spki()
    })}\n`);
  }
}

module.exports = { FrontDoorSelfLink };
