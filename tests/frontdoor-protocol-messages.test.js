// tests/frontdoor-protocol-messages.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { validateMessage } = require('../src/approvals/messages');
const { open, verifyEd25519 } = require('../src/approvals/envelope');
const { deriveNodeId } = require('../src/mesh/node-identity');
const P = require('../src/frontdoor/protocol/messages');
const { testNodeIdentity } = require('./helpers/fake-phone');

const NOW = '2026-09-23T18:04:11.201Z';
const nonce = () => crypto.randomBytes(32).toString('base64url');
const id22 = () => crypto.randomBytes(16).toString('base64url');

function grant(overrides = {}) {
  return {
    v: 1, type: 'kl.client.grant', frontdoor_id: 'kl-nt4ritcfj5kepq3y', grant_id: `gr_${id22()}`, client_id: `dcr_${id22()}`,
    client_name: 'Example Client', redirect_uri: 'https://client.example.com/cb', resource: 'https://mcp.kl.example.com/mcp',
    code_challenge: crypto.randomBytes(32).toString('base64url'), user_code: 'Q7KM2X',
    scopes: [{ scope: 'fleet:read', machines: null }, { scope: 'fleet:run', machines: ['gpu-box', 'web-01'] }],
    decision: 'approve', nonce: nonce(), device_id: 'd-3vmwrihhdbnit4oi', signed_at: NOW, ...overrides
  };
}

describe('user codes', () => {
  it('normalises what the owner types: case, dash, O→0, I/L→1', () => {
    assert.equal(P.normalizeUserCode('q7k-m2x'), 'Q7KM2X');
    assert.equal(P.normalizeUserCode(' o1l abc '), '011ABC');
    assert.equal(P.normalizeUserCode('Q7KM2'), null);
    assert.equal(P.normalizeUserCode('Q7KM2U'), null, 'U is not Crockford base32');
    assert.equal(P.normalizeUserCode(42), null);
  });

  it('formats as XXX-XXX and draws only from the Crockford alphabet', () => {
    assert.equal(P.formatUserCode('Q7KM2X'), 'Q7K-M2X');
    for (let i = 0; i < 200; i += 1) assert.match(P.randomUserCode(), P.USER_CODE_RE);
  });
});

describe('pairing codes', () => {
  it('trims, lower-cases and collapses spaces before hashing', () => {
    assert.equal(P.normalizePairingCode('  Abandon   ability\table '), 'abandon ability able');
    assert.equal(P.pairingCodeHash('Abandon ability'), P.pairingCodeHash(' abandon   ABILITY '));
    assert.match(P.pairingCodeHash('x'), /^[A-Za-z0-9_-]{43}$/);
  });
});

describe('scope lists', () => {
  it('accepts sorted unique scopes with sorted unique machines', () => {
    assert.equal(P.isScopeList([{ scope: 'fleet:read', machines: null }, { scope: 'fleet:run', machines: ['gpu-box', 'web-01'] }]), true);
    assert.equal(P.isScopeList([]), true);
  });

  it('refuses unsorted, duplicate, extra keys and bad machine names', () => {
    assert.equal(P.isScopeList([{ scope: 'fleet:run', machines: null }, { scope: 'fleet:read', machines: null }]), false);
    assert.equal(P.isScopeList([{ scope: 'fleet:read', machines: null }, { scope: 'fleet:read', machines: null }]), false);
    assert.equal(P.isScopeList([{ scope: 'fleet:run', machines: ['web-01', 'gpu-box'] }]), false);
    assert.equal(P.isScopeList([{ scope: 'fleet:run', machines: ['Web-01'] }]), false);
    assert.equal(P.isScopeList([{ scope: 'fleet:run', machines: [] }]), false);
    assert.equal(P.isScopeList([{ scope: 'fleet:run', machines: null, extra: 1 }]), false);
    assert.equal(P.isScopeList([{ scope: 'FLEET', machines: null }]), false);
  });
});

describe('DNS names and client ids', () => {
  it('knows a DNS name from an IP or a single label', () => {
    assert.equal(P.isDnsName('kl.example.com'), true);
    assert.equal(P.isDnsName('example'), false);
    assert.equal(P.isDnsName('10.0.0.1'), false);
    assert.equal(P.isDnsName('KL.example.com'), false);
  });

  it('accepts dcr_ ids and https CIMD URLs only', () => {
    assert.equal(P.isClientId(`dcr_${id22()}`), true);
    assert.equal(P.isClientId('https://client.example.com/client.json'), true);
    assert.equal(P.isClientId('http://client.example.com/client.json'), false);
    assert.equal(P.isClientId('dcr_short'), false);
  });
});

describe('message validators', () => {
  it('kl.client.grant: approve needs scopes, deny needs none, no extra keys', () => {
    assert.equal(validateMessage('kl.client.grant', grant()), null);
    assert.equal(validateMessage('kl.client.grant', grant({ decision: 'deny', scopes: [] })), null);
    assert.equal(validateMessage('kl.client.grant', grant({ decision: 'deny' })), 'malformed');
    assert.equal(validateMessage('kl.client.grant', grant({ scopes: [] })), 'malformed');
    assert.equal(validateMessage('kl.client.grant', { ...grant(), extra: true }), 'malformed');
    assert.equal(validateMessage('kl.client.grant', grant({ code_challenge: 'short' })), 'malformed');
    assert.equal(validateMessage('kl.client.grant', grant({ user_code: 'Q7K-M2X' })), 'malformed');
    assert.equal(validateMessage('kl.client.grant', grant({ v: 2 })), 'unsupported_version');
  });

  it('kl.client.revoke, kl.node.remove: a challenge, a device, a time', () => {
    const revoke = { v: 1, type: 'kl.client.revoke', frontdoor_id: 'kl-nt4ritcfj5kepq3y', grant_id: `gr_${id22()}`, challenge: nonce(), device_id: 'd-3vmwrihhdbnit4oi', signed_at: NOW };
    assert.equal(validateMessage('kl.client.revoke', revoke), null);
    assert.equal(validateMessage('kl.client.revoke', { ...revoke, challenge: 'x' }), 'malformed');
    const remove = { v: 1, type: 'kl.node.remove', frontdoor_id: 'kl-nt4ritcfj5kepq3y', node_id: 'kl-hnef32472qzibi5r', challenge: nonce(), device_id: 'd-3vmwrihhdbnit4oi', signed_at: NOW };
    assert.equal(validateMessage('kl.node.remove', remove), null);
  });

  it('kl.node.enroll: profile, raw key, hex fingerprint, replaces', () => {
    const node = testNodeIdentity({ key: 'gpu-box' });
    const enroll = {
      v: 1, type: 'kl.node.enroll', frontdoor_id: 'kl-nt4ritcfj5kepq3y', pairing_id: `pr_${id22()}`, node_id: node.nodeId,
      node_name: 'gpu-box', profile: 'agent', public_key: P.rawEd25519(node.publicKey), tls_fingerprint: 'a'.repeat(64),
      replaces: null, decision: 'approve', nonce: nonce(), device_id: 'd-3vmwrihhdbnit4oi', signed_at: NOW
    };
    assert.equal(validateMessage('kl.node.enroll', enroll), null);
    assert.equal(validateMessage('kl.node.enroll', { ...enroll, replaces: 'kl-c2ubd6jjqumalzt5' }), null);
    assert.equal(validateMessage('kl.node.enroll', { ...enroll, profile: 'frontdoor' }), 'malformed');
    assert.equal(validateMessage('kl.node.enroll', { ...enroll, tls_fingerprint: 'A'.repeat(64) }), 'malformed');
  });
});

describe('node-side and front-door builders', () => {
  const certPem = require('../src/mesh/mesh-identity').MeshIdentity._generateFallbackTlsCert('gpu-box', 1).cert;

  it('buildNodePair signs with the node key over a code hash, never the code', () => {
    const node = testNodeIdentity({ key: 'gpu-box', nodeName: 'gpu-box' });
    const env = P.buildNodePair({ identity: node, frontdoorHost: 'mcp.kl.example.com', code: 'Abandon  ability', profile: 'agent', capabilities: ['gpu', 'cuda', 'gpu'], tlsCertPem: certPem, now: Date.parse(NOW) });
    const { message } = open(env);
    assert.equal(validateMessage('kl.node.pair', message), null);
    assert.equal(env.kid, node.nodeId);
    assert.deepEqual(message.capabilities, ['cuda', 'gpu']);
    assert.equal(message.code_hash, P.pairingCodeHash('abandon ability'));
    assert.ok(!JSON.stringify(message).includes('abandon'));
    assert.equal(deriveNodeId(P.spkiHexFromRaw(message.public_key)), node.nodeId);
    assert.equal(verifyEd25519(env, P.spkiHexFromRaw(message.public_key)), true);
  });

  it('buildNodePairAccept and buildRelayRepin sign as the front door', () => {
    const fd = testNodeIdentity({ key: 'relay' });
    const accept = P.buildNodePairAccept({ identity: fd, pairingId: `pr_${id22()}`, nodeId: 'kl-hnef32472qzibi5r', nonce: nonce(), meshUrl: 'wss://mesh.kl.example.com/mesh/v1', meshCertFingerprint: 'b'.repeat(64) });
    assert.equal(validateMessage('kl.node.pair.accept', open(accept).message), null);
    assert.equal(open(accept).message.frontdoor_public_key, P.rawEd25519(fd.publicKey));
    const repin = P.buildRelayRepin({ identity: fd, relay: 'https://mcp.kl.example.com', oldSpki: `sha256/${nonce()}`, newSpki: `sha256/${nonce()}`, now: Date.parse(NOW) });
    assert.equal(validateMessage('kl.relay.repin', open(repin).message), null);
    assert.equal(verifyEd25519(repin, fd.publicKey.toString('hex')), true);
  });

  it('nodeFingerprint groups the node id in fours after kl-', () => {
    assert.equal(P.nodeFingerprint('kl-3v7q2m4k8d1x9c0a'), 'kl-3v7q 2m4k 8d1x 9c0a');
  });
});

describe('strictness beyond the shapes', () => {
  it('normalizeUserCode never throws and takes only ASCII letters and digits', () => {
    for (const bad of [undefined, null, {}, [], ['Q7KM2X'], Symbol('x'), 'Q7KM2X'.repeat(20), 'ıııAAA', 'ﬀﬀAA', 'Q7K–M2X']) {
      assert.equal(P.normalizeUserCode(bad), null);
    }
    assert.equal(P.normalizeUserCode('q7k m2x\n'), 'Q7KM2X');
  });

  it('a field that is an array of a valid string is refused, not coerced', () => {
    assert.equal(validateMessage('kl.client.grant', grant({ frontdoor_id: ['kl-nt4ritcfj5kepq3y'] })), 'malformed');
    assert.equal(validateMessage('kl.client.grant', grant({ device_id: ['d-3vmwrihhdbnit4oi'] })), 'malformed');
    assert.equal(validateMessage('kl.client.grant', grant({ grant_id: [`gr_${id22()}`] })), 'malformed');
    const remove = { v: 1, type: 'kl.node.remove', frontdoor_id: 'kl-nt4ritcfj5kepq3y', node_id: ['kl-hnef32472qzibi5r'], challenge: nonce(), device_id: 'd-3vmwrihhdbnit4oi', signed_at: NOW };
    assert.equal(validateMessage('kl.node.remove', remove), 'malformed');
  });

  it('mesh_url must parse as a wss: URL with a host', () => {
    const fd = testNodeIdentity({ key: 'relay' });
    const accept = (meshUrl) => open(P.buildNodePairAccept({ identity: fd, pairingId: `pr_${id22()}`, nodeId: 'kl-hnef32472qzibi5r', nonce: nonce(), meshUrl, meshCertFingerprint: 'b'.repeat(64) })).message;
    assert.equal(validateMessage('kl.node.pair.accept', accept('wss://')), 'malformed');
    assert.equal(validateMessage('kl.node.pair.accept', accept(`wss://mesh.kl.example.com/${'a'.repeat(600)}`)), 'malformed');
  });

  it('rawEd25519 refuses a 44-byte key that is not Ed25519', () => {
    const node = testNodeIdentity({ key: 'gpu-box' });
    const forged = Buffer.from(node.publicKey);
    forged[5] ^= 0xff;
    assert.throws(() => P.rawEd25519(forged), TypeError);
    assert.equal(P.rawEd25519(node.publicKey.toString('hex')), P.rawEd25519(node.publicKey));
  });
});

describe('fix round 1', () => {
  it('isDnsName refuses names the URL parser reads as IPv4', () => {
    for (const bad of ['0x7f.1', '1.2.3', '10.0.0.1', 'example.123', 'example.0x7f', 'example.0x']) assert.equal(P.isDnsName(bad), false, bad);
    for (const good of ['kl.example.com', 'mcp.kl.example.com', 'a1.b2.example.com', 'example.123abc', 'example.0xg1', 'x.io']) assert.equal(P.isDnsName(good), true, good);
  });

  it('normalizePairingCode returns an empty string for any non-string and pins dotted capital I', () => {
    for (const bad of [undefined, null, 42, {}, ['abandon'], Object.create(null), Symbol('x')]) assert.equal(P.normalizePairingCode(bad), '');
    assert.equal(P.normalizePairingCode('İ'), 'i̇', 'default Unicode lower case, not locale: U+0130 becomes i + U+0307');
    assert.notEqual(P.pairingCodeHash('İ'), P.pairingCodeHash('i'));
  });

  it('URLs with userinfo or a fragment are refused', () => {
    for (const bad of ['https://user@client.example.com/c.json', 'https://user:pw@client.example.com/c.json', 'https://@client.example.com/c.json',
      'https://:@client.example.com/c.json', 'https://client.example.com/c.json#frag', 'https://client.example.com/c.json#']) assert.equal(P.isClientId(bad), false, bad);
    assert.equal(P.isClientId('https://client.example.com/c.json?x=a@b'), true, 'an @ outside the authority is not userinfo');
    const fd = testNodeIdentity({ key: 'relay' });
    const accept = (meshUrl) => open(P.buildNodePairAccept({ identity: fd, pairingId: `pr_${id22()}`, nodeId: 'kl-hnef32472qzibi5r', nonce: nonce(), meshUrl, meshCertFingerprint: 'b'.repeat(64) })).message;
    for (const bad of ['wss://u@mesh.kl.example.com/mesh/v1', 'wss://u:p@mesh.kl.example.com/mesh/v1', 'wss://mesh.kl.example.com/mesh/v1#x', 'wss://mesh.kl.example.com/mesh/v1#']) {
      assert.equal(validateMessage('kl.node.pair.accept', accept(bad)), 'malformed', bad);
    }
  });

  it('kl.relay.repin refuses old_spki equal to new_spki', () => {
    const fd = testNodeIdentity({ key: 'relay' });
    const pin = `sha256/${nonce()}`;
    const repin = P.buildRelayRepin({ identity: fd, relay: 'https://mcp.kl.example.com', oldSpki: pin, newSpki: pin, now: Date.parse(NOW) });
    assert.equal(validateMessage('kl.relay.repin', open(repin).message), 'malformed');
  });

  it('buildNodePair refuses an empty code', () => {
    const node = testNodeIdentity({ key: 'gpu-box', nodeName: 'gpu-box' });
    const certPem = require('../src/mesh/mesh-identity').MeshIdentity._generateFallbackTlsCert('gpu-box', 1).cert;
    for (const code of ['', '   \t ', undefined, null, 42]) {
      assert.throws(() => P.buildNodePair({ identity: node, frontdoorHost: 'mcp.kl.example.com', code, profile: 'agent', tlsCertPem: certPem, now: Date.parse(NOW) }), TypeError);
    }
  });
});
