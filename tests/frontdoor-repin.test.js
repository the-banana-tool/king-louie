// tests/frontdoor-repin.test.js — fleet stage 4 §3.3.1: rotate-tls-key → a
// valid kl.relay.repin, checked with the Node port of the app's verifier.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RepinPublisher } = require('../src/frontdoor/repin');
const { verifyRepin } = require('../src/frontdoor/protocol/checks');
const { rawEd25519 } = require('../src/frontdoor/protocol/messages');
const { testNodeIdentity } = require('./helpers/fake-phone');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-repin-')); temps.push(d); return d; };
const FD = testNodeIdentity({ key: 'relay', nodeName: 'frontdoor' });
const OLD = `sha256/${'a'.repeat(43)}`;
const NEW = `sha256/${'b'.repeat(43)}`;

describe('RepinPublisher', () => {
  it('publishes a kl.relay.repin the phone verifier accepts, persists it, re-pins the relay and audits', async () => {
    const file = path.join(tmp(), 'repin.json');
    const pins = [];
    const audit = [];
    const publisher = new RepinPublisher({
      identity: FD, publicUrl: 'https://mcp.kl.example.com', file,
      auditLedger: { append: async (e) => { audit.push(e); } }, onPinChanged: (spki) => pins.push(spki)
    });
    assert.equal(publisher.current(), null);
    const env = await publisher.rotated({ oldSpki: OLD, newSpki: NEW });
    const check = (e, over = {}) => verifyRepin(e, { frontdoorId: FD.nodeId, frontdoorPublicKey: rawEd25519(FD.publicKey), receivedSpki: NEW, currentPin: OLD, ...over });
    assert.equal(check(env).ok, true);
    assert.equal(check(env).message.relay, 'https://mcp.kl.example.com');
    const flipped = Buffer.from(env.sig, 'base64url');
    flipped[0] ^= 1;
    assert.equal(check({ ...env, sig: flipped.toString('base64url') }).reason, 'bad_signature');
    assert.equal(check(env, { receivedSpki: `sha256/${'c'.repeat(43)}` }).reason, 'spki_mismatch');
    assert.equal(check(env, { currentPin: NEW }).reason, 'old_pin_mismatch');
    assert.deepEqual(pins, [NEW]);
    assert.deepEqual(audit, [{ kind: 'frontdoor.tls.repin', data: { old_spki: OLD, new_spki: NEW } }]);
    assert.deepEqual(new RepinPublisher({ identity: FD, publicUrl: 'https://mcp.kl.example.com', file }).current(), env, 'it survives a restart');
  });

  it('a failed save still serves the envelope, re-pins the relay and audits, then reports the failure', async () => {
    const dir = tmp();
    const file = path.join(dir, 'repin.json');
    fs.mkdirSync(file); // a directory where the file should go: the save throws
    const pins = [];
    const audit = [];
    const publisher = new RepinPublisher({
      identity: FD, publicUrl: 'https://mcp.kl.example.com', file,
      auditLedger: { append: async (e) => { audit.push(e); } }, onPinChanged: (spki) => pins.push(spki)
    });
    await assert.rejects(publisher.rotated({ oldSpki: OLD, newSpki: NEW }));
    assert.ok(publisher.current(), 'the signed re-pin is served from memory');
    assert.deepEqual(pins, [NEW]);
    assert.deepEqual(audit.map((e) => e.kind), ['frontdoor.tls.repin']);
  });

  it('a stored file that is not an envelope is not served', () => {
    const file = path.join(tmp(), 'repin.json');
    fs.writeFileSync(file, JSON.stringify({ alg: 'Ed25519', kid: 'x', payload: 1 }));
    assert.equal(new RepinPublisher({ identity: FD, publicUrl: 'https://mcp.kl.example.com', file }).current(), null);
  });
});
