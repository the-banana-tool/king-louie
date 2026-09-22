const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadServiceConfig, DEFAULT_PORTS } = require('../src/service/config');
const { adminConfigDir } = require('../src/platform/paths');
const { addSink } = require('../src/logging');

// Every temp dir this file creates is removed once all tests have run.
const createdTempDirs = [];
after(() => { for (const d of createdTempDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-cfg-')); createdTempDirs.push(d); return d; };
const writeCfg = (dir, cfg) => fs.writeFileSync(path.join(dir, 'service.json'), JSON.stringify(cfg));
// The admin-owned config file. Tests run as an ordinary user, so the
// "is it owned by the account reading it" check is steered with an injected
// geteuid, the same way master-key.js takes an injected getuid.
const writeAdmin = (dir, cfg) => {
  const file = path.join(dir, 'service.json');
  fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o644 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
  return file;
};
const opts = (dir) => ({ adminConfigDir: dir, geteuid: () => -1 });

describe('loadServiceConfig', () => {
  it('defaults to agent profile with listeners and chat channels off, on the service ports', () => {
    assert.deepStrictEqual(loadServiceConfig(tmp()), {
      profile: 'agent',
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      ports: { gateway: 18793, webhook: 18794 }
    });
  });
  it('reads the profile from service.json and lets CLI overrides win', () => {
    const dir = tmp();
    writeCfg(dir, { profile: 'agent' });
    assert.strictEqual(loadServiceConfig(dir).profile, 'agent');
    assert.strictEqual(loadServiceConfig(dir, { profile: 'runbook' }).profile, 'runbook');
  });
  it('rejects unknown profiles', () => {
    assert.throws(() => loadServiceConfig(tmp(), { profile: 'frontdoor' }), /Unknown profile "frontdoor"/);
  });
  it('forces mesh off even when the admin config asks for it, and warns', () => {
    const admin = tmp();
    writeAdmin(admin, { features: { mesh: true } });
    const warnings = [];
    const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    let cfg;
    try {
      cfg = loadServiceConfig(tmp(), {}, opts(admin));
    } finally {
      remove();
    }
    assert.strictEqual(cfg.features.mesh, false);
    assert.ok(warnings.some((m) => /mesh/.test(m)), `expected a mesh warning, got ${JSON.stringify(warnings)}`);
  });
  it('lets the admin config override the ports', () => {
    const admin = tmp();
    writeAdmin(admin, { ports: { gateway: 28791 } });
    assert.deepStrictEqual(loadServiceConfig(tmp(), {}, opts(admin)).ports, { gateway: 28791, webhook: DEFAULT_PORTS.webhook });
  });
  it('rejects invalid ports', () => {
    for (const ports of [{ gateway: 0 }, { gateway: 70000 }, { webhook: '18792' }, { mesh: 1 }, [1]]) {
      const admin = tmp();
      writeAdmin(admin, { ports });
      assert.throws(() => loadServiceConfig(tmp(), {}, opts(admin)), /ports/, JSON.stringify(ports));
    }
  });
});

// The data dir is 0700 *owned by the service account* on every platform, so
// <dataDir>/service.json is writable by the very account a compromise lands
// in. One write_file call -- no shell, no approval gate -- used to be enough
// to switch the gateway, the webhook listener, chat channels and app
// discovery back on for the next restart (which Restart=on-failure /
// KeepAlive / RestartOnFailure supply on their own). Only `mesh` was pinned
// off. Every listener now comes from the admin-owned config dir the
// installers create root-owned.
describe('loadServiceConfig: only an admin-owned file may enable a listener', () => {
  for (const feature of ['gateway', 'webhooks', 'channels', 'appDiscovery']) {
    it(`ignores features.${feature} in the service-writable <dataDir>/service.json, and says so`, () => {
      const dir = tmp();
      writeCfg(dir, { features: { [feature]: true } });
      const warnings = [];
      const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
      let cfg;
      try { cfg = loadServiceConfig(dir, {}, opts(tmp())); } finally { remove(); }
      assert.strictEqual(cfg.features[feature], false, `${feature} must stay off`);
      assert.ok(
        warnings.some((m) => m.includes('service.json') && /ignor/i.test(m)),
        `expected a warning naming the file, got ${JSON.stringify(warnings)}`
      );
    });
  }

  it('ignores ports in the service-writable <dataDir>/service.json', () => {
    const dir = tmp();
    writeCfg(dir, { ports: { gateway: 20001, webhook: 20002 } });
    assert.deepStrictEqual(loadServiceConfig(dir, {}, opts(tmp())).ports, DEFAULT_PORTS);
  });

  it('honours features from the admin config dir and names the file that enabled each one', () => {
    const dir = tmp();
    const admin = tmp();
    writeAdmin(admin, { features: { gateway: true, channels: true } });
    const records = [];
    const remove = addSink((r) => records.push(r.message));
    let cfg;
    try { cfg = loadServiceConfig(dir, {}, opts(admin)); } finally { remove(); }
    assert.strictEqual(cfg.features.gateway, true);
    assert.strictEqual(cfg.features.channels, true);
    assert.strictEqual(cfg.features.webhooks, false);
    const named = records.filter((m) => m.includes(path.join(admin, 'service.json')));
    assert.ok(named.some((m) => /gateway/.test(m)), `expected the gateway enablement to name the file, got ${JSON.stringify(records)}`);
    assert.ok(named.some((m) => /channels/.test(m)));
  });

  it('still forces mesh off even from the admin config', () => {
    const admin = tmp();
    writeAdmin(admin, { features: { mesh: true } });
    assert.strictEqual(loadServiceConfig(tmp(), {}, opts(admin)).features.mesh, false);
  });

  it('refuses an admin config file that is group- or world-writable', { skip: process.platform === 'win32' ? 'POSIX mode bits only' : false }, () => {
    const admin = tmp();
    const file = writeAdmin(admin, { features: { gateway: true } });
    fs.chmodSync(file, 0o666);
    assert.throws(() => loadServiceConfig(tmp(), {}, opts(admin)), /writable/);
  });

  it('refuses an admin config file owned by the account reading it', { skip: process.platform === 'win32' ? 'POSIX ownership only' : false }, () => {
    const admin = tmp();
    const file = writeAdmin(admin, { features: { gateway: true } });
    // Root owning its own config is correct and must stay accepted; what is
    // refused is the *service account* owning it. As root, stage that by
    // handing the file to an unprivileged uid.
    if (process.getuid() === 0) fs.chownSync(file, 12345, 12345);
    const uid = fs.statSync(file).uid;
    assert.notStrictEqual(uid, 0, 'this test needs a non-root owner to be meaningful');
    assert.throws(
      () => loadServiceConfig(tmp(), {}, { adminConfigDir: admin, geteuid: () => uid }),
      /owned by the account/
    );
    // ...and root's own file is still fine.
    const rootish = tmp();
    writeAdmin(rootish, { features: { gateway: true } });
    assert.strictEqual(loadServiceConfig(tmp(), {}, { adminConfigDir: rootish, geteuid: () => 0 }).features.gateway, true);
  });

  it('defaults every feature off when there is no admin config at all', () => {
    assert.deepStrictEqual(loadServiceConfig(tmp(), {}, opts(path.join(tmp(), 'nope'))).features, {
      gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false
    });
  });
});

describe('adminConfigDir', () => {
  it('is the root/admin-owned dir beside the data dir, and /etc/king-louie on Linux', () => {
    assert.strictEqual(adminConfigDir({ platform: 'linux', dataDir: '/var/lib/king-louie' }), '/etc/king-louie');
    assert.strictEqual(adminConfigDir({ platform: 'linux', dataDir: '/srv/kl' }), '/etc/king-louie');
    assert.strictEqual(
      adminConfigDir({ platform: 'darwin', dataDir: '/Library/Application Support/KingLouie/data' }),
      '/Library/Application Support/KingLouie/config'
    );
    assert.strictEqual(
      adminConfigDir({ platform: 'win32', dataDir: 'C:\\ProgramData\\KingLouie\\data' }),
      'C:\\ProgramData\\KingLouie\\config'
    );
  });
});
