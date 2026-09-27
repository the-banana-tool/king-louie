// tests/frontdoor-startup.test.js — fleet stage 4 §3.1 (the checks; the
// running front door is covered further down, Task 32).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { startupProblems, runStartupChecks, startupRows, StartupError } = require('../src/frontdoor/startup-checks');

const TERMS_MSG = 'frontdoor.acme.terms_agreed must be true to use ACME (it records that you accept the CA terms of service)';
const FD = { domain: 'kl.example.com', listen: { host: '127.0.0.1', port: 443 }, acme: { email: null, directory: 'https://acme.example.com/directory', termsAgreed: true }, tls: null };
const OFF = { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: false };
const opts = ({ service = {}, node = {}, fd = {} } = {}) => ({
  serviceConfig: { profile: 'frontdoor', features: OFF, relayRaw: null, ...service },
  nodeConfig: { profile: 'frontdoor', frontdoor: { ...FD, ...fd }, ...node }
});
const first = (o) => {
  try {
    runStartupChecks(o);
    return null;
  } catch (err) {
    assert.ok(err instanceof StartupError);
    return [err.check, err.message];
  }
};

describe('§3.1 startup checks', () => {
  it('passes a good configuration', () => {
    assert.equal(first(opts()), null);
    assert.ok(startupRows(opts()).every((r) => r.ok));
  });

  it('1: both profiles must be frontdoor', () => {
    assert.deepEqual(first(opts({ node: { profile: 'agent', frontdoor: null } })), [1, 'profile mismatch: service.json says "frontdoor", node.yaml says "agent"']);
    assert.deepEqual(first(opts({ service: { profile: 'runbook' } })), [1, 'profile mismatch: service.json says "runbook", node.yaml says "frontdoor"']);
  });

  it('2: the domain is a lowercase DNS name with two labels, not an IP', () => {
    for (const domain of ['localhost', '10.0.0.5', 'KL.example.com', 'kl..example.com', '']) {
      assert.deepEqual(first(opts({ fd: { domain } })), [2, 'frontdoor.domain must be a DNS name'], domain);
    }
  });

  it('3: exactly one TLS source, and ACME only with terms_agreed', () => {
    const msg = 'configure frontdoor.acme or frontdoor.tls, not both/neither';
    assert.deepEqual(first(opts({ fd: { acme: null } })), [3, msg]);
    assert.deepEqual(first(opts({ fd: { tls: { certFile: '/etc/king-louie/tls/mcp.pem', keyFile: '/etc/king-louie/tls/mcp.key' } } })), [3, msg]);
    // T31-keypath: ACME without the agreement is its own refusal, naming the key.
    assert.deepEqual(first(opts({ fd: { acme: { ...FD.acme, termsAgreed: false } } })), [3, TERMS_MSG]);
    assert.deepEqual(first(opts({ fd: { acme: { ...FD.acme, termsAgreed: false }, tls: { certFile: '/etc/king-louie/tls/mcp.pem', keyFile: '/etc/king-louie/tls/mcp.key' } } })), [3, msg], 'both set is still both/neither');
    assert.equal(first(opts({ fd: { acme: null, tls: { certFile: '/etc/king-louie/tls/mcp.pem', keyFile: '/etc/king-louie/tls/mcp.key' } } })), null);
  });

  it('4: no agent features, no relay listener keys, public_url derived, push parsed', () => {
    assert.deepEqual(first(opts({ service: { features: { ...OFF, gateway: true } } })), [4, 'the frontdoor profile runs no agent features: set features.gateway to false in service.json']);
    assert.deepEqual(first(opts({ service: { relayRaw: { public_url: 'https://mcp.kl.example.com' } } })), [4, 'relay.public_url is derived on the frontdoor profile (https://mcp.kl.example.com); remove it']);
    for (const key of ['tls', 'phone_listen', 'mesh_listen']) {
      assert.deepEqual(first(opts({ service: { relayRaw: { [key]: {} } } })), [4, `the frontdoor profile uses one 443 listener; remove relay.${key}`]);
    }
    assert.deepEqual(first(opts({ service: { relayRaw: { nonsense: 1 } } })), [4, 'Invalid service.json: unknown key "relay.nonsense"']);
    assert.match(first(opts({ service: { relayRaw: { push: { gcm: {} } } } }))[1], /unknown key "relay\.push\.gcm"/);
    assert.equal(first(opts({ service: { relayRaw: { push: {} } } })), null);
  });

  it('reports the first failing row, and lists them all for doctor', () => {
    const o = opts({ fd: { domain: 'localhost', acme: null }, service: { features: { ...OFF, mesh: true } } });
    assert.deepEqual(startupProblems(o).map((p) => p.check), [2, 3, 4]);
    assert.equal(first(o)[0], 2);
    assert.deepEqual(startupRows(o).map((r) => [r.check, r.ok]), [
      ['frontdoor profile', true], ['frontdoor.domain', false], ['frontdoor TLS source', false], ['frontdoor features and relay keys', false]
    ]);
  });

  it('after a failing check 1 nothing else is judged', () => {
    const o = opts({ service: { profile: 'agent', features: { ...OFF, gateway: true }, relayRaw: { nonsense: 1 } }, fd: { domain: 'localhost', acme: null } });
    assert.deepEqual(startupProblems(o).map((p) => p.check), [1]);
    assert.deepEqual(startupRows(o).map((r) => [r.check, r.ok, r.detail]).slice(1), [
      ['frontdoor.domain', false, 'not checked (fix the profile first)'],
      ['frontdoor TLS source', false, 'not checked (fix the profile first)'],
      ['frontdoor features and relay keys', false, 'not checked (fix the profile first)']
    ]);
    assert.deepEqual(first({ serviceConfig: null, nodeConfig: null }), [1, 'profile mismatch: service.json says "undefined", node.yaml says "undefined"']);
  });

  it('a frontdoor node.yaml with no frontdoor block fails check 2 (the domain is missing)', () => {
    assert.deepEqual(first(opts({ fd: { domain: undefined } })), [2, 'frontdoor.domain must be a DNS name']);
  });

  it('a relay block that is not an object is refused by check 4', () => {
    for (const relayRaw of ['x', [], 5]) {
      assert.deepEqual(first(opts({ service: { relayRaw } })), [4, 'Invalid service.json: "relay" must be an object'], JSON.stringify(relayRaw));
    }
    assert.match(first(opts({ service: { relayRaw: { push: null } } }))[1], /relay\.push must be an object/);
    assert.deepEqual(first(opts({ service: { relayRaw: JSON.parse('{"__proto__": {}}') } })), [4, 'Invalid service.json: unknown key "relay.__proto__"']);
  });

  it('every refusal names the key path it is about', () => {
    const cases = [
      [opts({ node: { profile: 'agent' } }), /profile/],
      [opts({ fd: { domain: '10.0.0.5' } }), /frontdoor\.domain/],
      [opts({ fd: { acme: null } }), /frontdoor\.acme/],
      [opts({ fd: { acme: { ...FD.acme, termsAgreed: false } } }), /frontdoor\.acme\.terms_agreed/],
      [opts({ service: { features: { ...OFF, webhooks: true } } }), /features\.webhooks/],
      [opts({ service: { relayRaw: { public_url: 'x' } } }), /relay\.public_url/],
      [opts({ service: { relayRaw: { tls: {} } } }), /relay\.tls/],
      [opts({ service: { relayRaw: { push: { apns: {} } } } }), /relay\.push\.apns/]
    ];
    for (const [o, re] of cases) assert.match(first(o)[1], re);
  });

  it('a feature is off only when it is exactly false (the rest of the loader treats any truthy value as on)', () => {
    for (const value of ['yes', 1, null, 'false']) {
      assert.deepEqual(first(opts({ service: { features: { ...OFF, channels: value } } })), [4, 'the frontdoor profile runs no agent features: set features.channels to false in service.json'], String(value));
    }
  });
});
