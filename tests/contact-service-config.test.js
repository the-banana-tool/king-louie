// tests/contact-service-config.test.js — cases stage 4 §6, §8: in service
// mode the owner identity and contact addresses come only from the admin
// service.json; the Vault tool refuses and hides contact.* credentials.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadServiceConfig } = require('../src/service/config');
const { validateContactConfig, resolveContactConfig, mergeContactSettings } = require('../src/cases/contact-settings');
const { mergeSettings, DEFAULT_SETTINGS } = require('../src/core/settings');
const vaultTool = require('../src/tools/builtin/vault-tool');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-contact-cfg-')); dirs.push(d); return d; };
const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const writeCfg = (dir, cfg) => {
  const file = path.join(dir, 'service.json');
  fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o644 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
};
const opts = (dir) => ({ adminConfigDir: dir, geteuid: () => -1, adminUid: selfUid });

const CONTACT = {
  telegram: { ownerUserId: '123456789' },
  discord: { ownerUserId: '234567890123456789' },
  ntfy: { baseUrl: 'https://ntfy.sh', topic: '' },
  email: { owner: 'Owner@Example.com', from: 'kl@example.com', relay: 'main', imap: { host: 'imap.example.com', port: 993, user: 'kl@example.com', trustedAuthServId: 'mx.example.com', pollSec: 60 } },
  sms: { owner: '+1 555 010 0', from: '+15550199', relay: 'main' },
  voice: { owner: '+15550100', from: '+15550199', relay: 'main' },
  relays: { main: { baseUrl: 'https://relay.example.com', pollSec: 30 } }
};

function recordingLogger() {
  const lines = [];
  return { lines, warn: (m) => lines.push(m), info() {}, debug() {}, error() {} };
}

describe('the admin service.json contact block', () => {
  it('is read from the admin dir only; the data-dir copy is ignored', () => {
    const admin = tmp();
    const data = tmp();
    writeCfg(admin, { contact: CONTACT });
    writeCfg(data, { contact: { telegram: { ownerUserId: '999' } } });
    const cfg = loadServiceConfig(data, {}, opts(admin));
    assert.strictEqual(cfg.contact.telegram.ownerUserId, '123456789');
    assert.strictEqual(cfg.contact.email.owner, 'owner@example.com');
    assert.strictEqual(cfg.contact.sms.owner, '+15550100');

    const onlyData = tmp();
    writeCfg(onlyData, { contact: { telegram: { ownerUserId: '999' } } });
    assert.strictEqual(loadServiceConfig(onlyData, {}, opts(tmp())).contact, null);
  });

  it('an unknown key in the admin block fails the load, naming the admin file and key path', () => {
    const admin = tmp();
    writeCfg(admin, { contact: { telegram: { ownerUserId: '1', chatId: '2' } } });
    assert.throws(
      () => loadServiceConfig(tmp(), {}, opts(admin)),
      (err) => err.message.includes(path.join(admin, 'service.json')) && /unknown key "contact\.telegram\.chatId"/.test(err.message)
    );
  });

  it('rejects unknown keys and bad values with the key path named (R55)', () => {
    assert.throws(() => validateContactConfig({ telegram: { ownerUserId: '1', chatId: '2' } }, 'service.json'), /unknown key "contact\.telegram\.chatId"/);
    assert.throws(() => validateContactConfig({ pager: {} }, 'service.json'), /unknown key "contact\.pager"/);
    assert.throws(() => validateContactConfig({ telegram: { ownerUserId: 123 } }, 'service.json'), /contact\.telegram\.ownerUserId must be a numeric user id/);
    assert.throws(() => validateContactConfig({ sms: { owner: '555-0100' } }, 'service.json'), /contact\.sms\.owner must be an E\.164 number/);
    assert.throws(() => validateContactConfig({ relays: { main: { baseUrl: 'http://relay.example.com' } } }, 'service.json'), /contact\.relays\.main\.baseUrl must be https:, or http: to loopback/);
    assert.throws(() => validateContactConfig({ relays: { main: { baseUrl: 'not a url' } } }, 'service.json'), /contact\.relays\.main\.baseUrl is not a URL/);
    assert.throws(() => validateContactConfig({ ntfy: { baseUrl: 'http://ntfy.example.com' } }, 'service.json'), /contact\.ntfy\.baseUrl must be an https: URL/);
    assert.throws(() => validateContactConfig({ sms: { owner: '+15550100', relay: 'other' } }, 'service.json'), /contact\.sms\.relay names "other"/);
    assert.deepStrictEqual(validateContactConfig({ relays: { local: { baseUrl: 'http://127.0.0.1:8080' } } }, 'service.json'), { relays: { local: { baseUrl: 'http://127.0.0.1:8080' } } });
    assert.strictEqual(validateContactConfig(undefined, 'service.json'), null);
  });
});

describe('resolveContactConfig', () => {
  const settings = { contact: { sms: { owner: '+15550177' } }, channels: { telegram: { contactOwnerUserId: '999' } } };

  it('service mode: data-dir settings.contact and contactOwnerUserId are ignored with a warning', () => {
    const logger = recordingLogger();
    const out = resolveContactConfig({ settings, contactConfig: validateContactConfig(CONTACT, 'service.json'), isService: true, logger });
    assert.strictEqual(out.telegram.ownerUserId, '123456789');
    assert.strictEqual(out.sms.owner, '+15550100');
    assert.strictEqual(logger.lines.length, 2);
    assert.match(logger.lines.join('\n'), /ignoring settings\.contact/);
    assert.match(logger.lines.join('\n'), /ignoring channels\.telegram\.contactOwnerUserId/);
    resolveContactConfig({ settings, contactConfig: null, isService: true, logger });
    assert.strictEqual(logger.lines.length, 2, 'warned once');
    assert.deepStrictEqual(resolveContactConfig({ settings, contactConfig: null, isService: true, logger: recordingLogger() }), {});
  });

  it('desktop: settings.contact plus channels.<ch>.contactOwnerUserId', () => {
    const out = resolveContactConfig({ settings, isService: false });
    assert.deepStrictEqual(out, { sms: { owner: '+15550177' }, telegram: { ownerUserId: '999' } });
  });
});

describe('settings merge', () => {
  it('fills contactPolicy, contact and the channel contact keys, keeping existing channel settings', () => {
    const merged = mergeSettings({ channels: { telegram: { requireMention: true, contactEnabled: true } }, contactPolicy: { batchDelaySec: 10 } });
    assert.strictEqual(merged.contactPolicy.batchDelaySec, 10);
    assert.strictEqual(merged.contactPolicy.digest.at, '08:00');
    assert.deepStrictEqual(merged.channels.telegram, { contactEnabled: true, contactOwnerUserId: '', requireMention: true });
    assert.deepStrictEqual(merged.channels.email, { enabled: false, transport: 'relay' });
    assert.deepStrictEqual(merged.channels.ntfy, { enabled: false, includeText: false });
    assert.deepStrictEqual(merged.channels.slack, DEFAULT_SETTINGS.channels.slack);
    assert.deepStrictEqual(merged.contact, {});
    assert.deepStrictEqual(mergeContactSettings({}, DEFAULT_SETTINGS.channels).channels.discord.allowedGuilds, []);
  });
});

describe('Vault tool', () => {
  function fakeVault() {
    const data = new Map([['api_key', 'x'], ['contact', '{nested}'], ['contact.relay.main.token', 'secret']]);
    return {
      set: (k, v) => data.set(k, v), get: (k) => data.get(k) || null, delete: (k) => data.delete(k), list: () => [...data.keys()]
    };
  }

  it('refuses keys starting contact. and hides them from list', async () => {
    const vault = fakeVault();
    for (const action of ['retrieve', 'store', 'delete']) {
      const r = await vaultTool.execute({ action, key: 'contact.relay.main.token', value: 'x' }, { vault });
      assert.deepStrictEqual(r, { ok: false, error: 'contact credentials are managed in settings, not by the model' });
    }
    assert.strictEqual(vault.get('contact.relay.main.token'), 'secret');
    const listed = await vaultTool.execute({ action: 'list' }, { vault });
    assert.deepStrictEqual(listed, { ok: true, keys: ['api_key'], count: 1 });
    assert.strictEqual((await vaultTool.execute({ action: 'retrieve', key: 'api_key' }, { vault })).value, 'x');
  });

  it('keeps working for keys outside contact.', async () => {
    const vault = fakeVault();
    assert.strictEqual((await vaultTool.execute({ action: 'retrieve', key: 'contact' }, { vault })).ok, false);
    assert.strictEqual((await vaultTool.execute({ action: 'store', key: 'contacts_backup', value: 'v' }, { vault })).ok, true);
    assert.strictEqual(vault.get('contacts_backup'), 'v');
    assert.strictEqual((await vaultTool.execute({ action: 'retrieve', key: 'contacts_backup' }, { vault })).value, 'v');
    assert.strictEqual((await vaultTool.execute({ action: 'delete', key: 'api_key' }, { vault })).ok, true);
    assert.strictEqual(vault.get('api_key'), null);
    assert.deepStrictEqual(await vaultTool.execute({ action: 'list' }, { vault }), { ok: true, keys: ['contacts_backup'], count: 1 });
  });
});
