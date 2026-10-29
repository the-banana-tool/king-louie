// tests/frontdoor-config.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseDuration } = require('../src/platform/duration');
const { parseFrontDoorConfig, FRONTDOOR_KEYS, frontDoorHosts, LETS_ENCRYPT_PRODUCTION } = require('../src/frontdoor/config');
const { loadNodeConfig, NODE_YAML_KEYS } = require('../src/service/node-config');
const { loadServiceConfig, parsePushConfig, hostPushConfig } = require('../src/service/config');
const { readServiceAccountFile } = require('../src/frontdoor/push/service-account');
const { defaultSenders } = require('../src/frontdoor/push');

const EUID = typeof process.geteuid === 'function' ? process.geteuid() : 0;
const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function adminDir(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-fd-config-'));
  temps.push(base);
  const dir = path.join(base, 'config');
  fs.mkdirSync(dir, { mode: 0o755 });
  if (process.platform !== 'win32') { fs.chmodSync(base, 0o755); fs.chmodSync(dir, 0o755); }
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text, { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(path.join(dir, name), 0o644);
  }
  return { base, dir };
}
const load = (yaml) => loadNodeConfig({ adminConfigDir: adminDir({ 'node.yaml': yaml }).dir, geteuid: () => EUID, adminUid: EUID });

describe('parseDuration', () => {
  it('reads s, m, h and d', () => {
    assert.equal(parseDuration('90s'), 90000);
    assert.equal(parseDuration('5m'), 300000);
    assert.equal(parseDuration('2h'), 7200000);
    assert.equal(parseDuration('30d'), 30 * 86400000);
    assert.equal(parseDuration('2 h'), null);
    assert.equal(parseDuration('1w'), null);
    assert.equal(parseDuration(7200), null);
  });

  it('refuses negative, NaN, overflowing, unit-less and ambiguous values', () => {
    for (const bad of ['-5m', 'NaNm', 'NaN', '1000000s', '5', '', '1.5h', '5ms', '5M', '1h30m', '0x10s', '+5m', null, undefined, Number.NaN]) {
      assert.equal(parseDuration(bad), null, String(bad));
    }
    assert.equal(parseDuration('999999d'), 999999 * 86400000);
    assert.ok(Number.isSafeInteger(parseDuration('999999d')));
  });
});

describe('parseFrontDoorConfig', () => {
  it('fills defaults and keeps the domain for the startup checks', () => {
    const cfg = parseFrontDoorConfig({ domain: 'kl.example.com', acme: { terms_agreed: true } }, 'node.yaml');
    assert.equal(cfg.domain, 'kl.example.com');
    assert.deepEqual(cfg.listen, { host: '0.0.0.0', port: 443 });
    assert.deepEqual(cfg.acme, { email: null, directory: LETS_ENCRYPT_PRODUCTION, termsAgreed: true });
    assert.equal(cfg.tls, null);
    assert.equal(cfg.oauth.accessTokenTtlMs, 3600000);
    assert.equal(cfg.oauth.refreshIdleTtlMs, 30 * 86400000);
    assert.deepEqual(cfg.oauth.scopesEnabled, ['fleet:read', 'fleet:run', 'fleet:unsafe', 'fleet:delegate']);
    assert.deepEqual(cfg.oauth.clientDefaults, []);
    assert.equal(cfg.mcp.progressHoldS, 20);
    assert.equal(cfg.audit.retentionDays, null);
    assert.deepEqual(frontDoorHosts('kl.example.com'), { mcp: 'mcp.kl.example.com', mesh: 'mesh.kl.example.com' });
  });

  it('names an unknown key at any depth with its dotted path', () => {
    assert.throws(() => parseFrontDoorConfig({ oauth: { x: 1 } }, 'node.yaml'), /unknown key "frontdoor\.oauth\.x" \(known: access_token_ttl, refresh_token_idle_ttl, scopes_enabled, client_defaults\)/);
    assert.throws(() => parseFrontDoorConfig({ acme: { staging: true } }, 'node.yaml'), /unknown key "frontdoor\.acme\.staging"/);
    assert.throws(() => parseFrontDoorConfig({ oauth: { client_defaults: [{ match: { name: 'x' }, scopes: [] }] } }, 'node.yaml'), /unknown key "frontdoor\.oauth\.client_defaults\[0\]\.match\.name"/);
    assert.throws(() => parseFrontDoorConfig({ port: 443 }, 'node.yaml'), /unknown key "frontdoor\.port"/);
  });

  it('enforces the ranges of §6', () => {
    const bad = [
      [{ oauth: { access_token_ttl: '4m' } }, /access_token_ttl must be a duration from 5m to 24h/],
      [{ oauth: { refresh_token_idle_ttl: '400d' } }, /refresh_token_idle_ttl must be a duration from 1d to 365d/],
      [{ mcp: { progress_hold_s: 56 } }, /progress_hold_s must be an integer from 0 to 55/],
      [{ audit: { retention_days: 29 } }, /retention_days must be null or an integer of at least 30/],
      [{ listen: { port: 0 } }, /listen\.port must be an integer from 1 to 65535/],
      [{ acme: { directory: 'http://acme.example.com/dir' } }, /acme\.directory must be an https:\/\/ URL/],
      [{ tls: { cert_file: '/x.pem' } }, /tls\.key_file is required/],
      [{ oauth: { scopes_enabled: ['Fleet'] } }, /scopes_enabled must be a list of scope names/],
      [{ oauth: { client_defaults: [{ match: { host: '10.0.0.1' }, scopes: ['fleet:read'] }] } }, /match\.host must be a DNS name/]
    ];
    for (const [raw, re] of bad) assert.throws(() => parseFrontDoorConfig(raw, 'node.yaml'), re, JSON.stringify(raw));
  });

  it('keeps FRONTDOOR_KEYS.top and NODE_YAML_KEYS.frontdoor identical', () => {
    assert.deepEqual([...NODE_YAML_KEYS.frontdoor], [...FRONTDOOR_KEYS.top]);
  });
});

describe('loadNodeConfig: frontdoor and delegate', () => {
  it('parses the frontdoor block only on the frontdoor profile', () => {
    const cfg = load('name: frontdoor\nprofile: frontdoor\nfrontdoor:\n  domain: kl.example.com\n  acme: { terms_agreed: true }\n');
    assert.equal(cfg.profile, 'frontdoor');
    assert.equal(cfg.frontdoor.domain, 'kl.example.com');
    assert.equal(cfg.delegate.agent, 'main');
    assert.throws(() => load('profile: agent\nfrontdoor:\n  domain: kl.example.com\n'), /frontdoor: is only for profile: frontdoor/);
    assert.equal(load('profile: agent\n').frontdoor, null);
  });

  it('delegate: agent profile only, with defaults and ranges', () => {
    const cfg = load("profile: agent\ndelegate: { provider: anthropic, model: example-model, idle_close: 30m, cwd: '/srv/work', max_sessions: 2 }\n");
    assert.deepEqual(cfg.delegate, { provider: 'anthropic', model: 'example-model', agent: 'main', idleCloseMs: 1800000, cwd: '/srv/work', maxSessions: 2 });
    assert.deepEqual(load('profile: agent\n').delegate, { provider: null, model: null, agent: 'main', idleCloseMs: 7200000, cwd: null, maxSessions: 4 });
    assert.throws(() => load('profile: runbook\ndelegate: { agent: main }\n'), /delegate needs profile: agent/);
    assert.throws(() => load('profile: agent\ndelegate: { max_sessions: 17 }\n'), /delegate\.max_sessions must be an integer from 1 to 16/);
    assert.throws(() => load('profile: agent\ndelegate: { idle_close: 1m }\n'), /delegate\.idle_close must be a duration from 5m to 24h/);
    assert.throws(() => load('profile: agent\ndelegate: { turns: 3 }\n'), /unknown key "delegate\.turns"/);
  });

  it('a profile name that is not agent, runbook or frontdoor is still refused', () => {
    assert.throws(() => load('profile: relay\n'), /unknown profile "relay"/);
  });
});

describe('loadServiceConfig: the frontdoor profile', () => {
  it('keeps the raw relay block for the startup checks and parses nothing from it', () => {
    const { base, dir } = adminDir({ 'service.json': JSON.stringify({ profile: 'frontdoor', relay: { phone_listen: { port: 8443 }, push: {} } }) });
    const cfg = loadServiceConfig(path.join(base, 'data'), {}, { adminConfigDir: dir, geteuid: () => -1, adminUid: EUID });
    assert.equal(cfg.profile, 'frontdoor');
    assert.equal(cfg.relay, null);
    assert.deepEqual(cfg.relayRaw, { phone_listen: { port: 8443 }, push: {} });
  });

  it('parsePushConfig reads relay.push the way the relay does', () => {
    assert.deepEqual(parsePushConfig(undefined, 'service.json'), {});
    assert.deepEqual(parsePushConfig({ fcm: { service_account_file: '/etc/king-louie/fcm.json' } }, 'service.json'), { fcm: { serviceAccountFile: '/etc/king-louie/fcm.json' } });
    assert.throws(() => parsePushConfig({ gcm: {} }, 'service.json'), /unknown key "relay\.push\.gcm"/);
  });

  it("hostPushConfig reads a front door's raw relay.push and a relay host's parsed one", () => {
    const fcm = { fcm: { serviceAccountFile: '/etc/king-louie/fcm.json' } };
    assert.deepEqual(hostPushConfig({ profile: 'frontdoor', relayRaw: { push: { fcm: { service_account_file: '/etc/king-louie/fcm.json' } } } }), fcm);
    assert.deepEqual(hostPushConfig({ relayRaw: null }, { frontdoor: true }), {});
    assert.throws(() => hostPushConfig({ profile: 'frontdoor', relayRaw: { push: { gcm: {} } } }), /relay\.push\.gcm/);
    assert.deepEqual(hostPushConfig({ profile: 'agent', relay: { push: fcm } }), fcm);
    assert.deepEqual(hostPushConfig({ profile: 'agent', relay: {} }), {});
    assert.equal(hostPushConfig({ profile: 'agent', relay: null }), null);
  });

  it('parsePushConfig refuses a relative service_account_file, naming the key', () => {
    assert.throws(() => parsePushConfig({ fcm: { service_account_file: 'push/fcm.json' } }, 'service.json'),
      /relay\.push\.fcm\.service_account_file must be an absolute path/);
    assert.throws(() => parsePushConfig({ fcm: { service_account_file: './fcm.json' } }, 'service.json'),
      /relay\.push\.fcm\.service_account_file must be an absolute path/);
  });
});

describe('readServiceAccountFile: the FCM credential checked at relay start', () => {
  const FILE = '/etc/king-louie/push/fcm.json';
  const KEY = { type: 'service_account', project_id: 'kl-example-push', client_email: 'push@kl-example-push.iam.example.com', private_key: 'PRIVATE-KEY-SENTINEL' };
  const reading = (text) => ({ readFile: (f) => { assert.equal(f, FILE); return text; } });
  const refusal = (fn) => { try { fn(); } catch (err) { return err; } assert.fail('expected a refusal'); };

  it('returns the parsed key when every field is there', () => {
    assert.deepEqual(readServiceAccountFile(FILE, reading(JSON.stringify(KEY))), KEY);
  });

  for (const field of ['type', 'project_id', 'client_email', 'private_key']) {
    it(`names a missing ${field} and the path, never a value from the file`, () => {
      const partial = { ...KEY };
      delete partial[field];
      const err = refusal(() => readServiceAccountFile(FILE, reading(JSON.stringify(partial))));
      assert.equal(err.code, 'PUSH_CREDENTIAL_INVALID');
      assert.equal(err.field, field);
      assert.match(err.message, new RegExp(`"${field}"`));
      assert.ok(err.message.includes(FILE));
      for (const v of Object.values(KEY)) if (v !== 'service_account') assert.ok(!err.message.includes(v), `leaked ${v}`);
    });
  }

  it('refuses a type that is not service_account, and a field that is not a string', () => {
    const wrongType = refusal(() => readServiceAccountFile(FILE, reading(JSON.stringify({ ...KEY, type: 'authorized_user' }))));
    assert.equal(wrongType.field, 'type');
    assert.ok(!wrongType.message.includes('authorized_user'));
    const notString = refusal(() => readServiceAccountFile(FILE, reading(JSON.stringify({ ...KEY, private_key: 42 }))));
    assert.equal(notString.field, 'private_key');
  });

  it('refuses a file that does not parse without echoing it', () => {
    const err = refusal(() => readServiceAccountFile(FILE, reading('{"private_key": "PRIVATE-KEY-SENTINEL", broken')));
    assert.equal(err.code, 'PUSH_CREDENTIAL_INVALID');
    assert.ok(err.message.includes(FILE));
    assert.ok(!err.message.includes('SENTINEL'));
    const notObject = refusal(() => readServiceAccountFile(FILE, reading('["PRIVATE-KEY-SENTINEL"]')));
    assert.equal(notObject.code, 'PUSH_CREDENTIAL_INVALID');
    assert.ok(!notObject.message.includes('SENTINEL'));
  });

  it('refuses a file that cannot be read, naming the path', () => {
    const err = refusal(() => readServiceAccountFile(FILE, { readFile: () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); } }));
    assert.equal(err.code, 'PUSH_CREDENTIAL_UNREADABLE');
    assert.ok(err.message.includes(FILE));
    assert.match(err.message, /ENOENT/);
  });

  it('defaultSenders checks the file before building the FCM sender', () => {
    const partial = { ...KEY };
    delete partial.client_email;
    assert.throws(() => defaultSenders({ fcm: { serviceAccountFile: FILE } }, reading(JSON.stringify(partial))), /"client_email"/);
    const senders = defaultSenders({ fcm: { serviceAccountFile: FILE } }, reading(JSON.stringify(KEY)));
    assert.deepEqual(senders.map((s) => s.id), ['fcm']);
  });
});
