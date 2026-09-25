const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadServiceConfig, DEFAULT_PORTS } = require('../src/service/config');
const { adminConfigDir, adminCredentialPath } = require('../src/platform/paths');
const { addSink } = require('../src/logging');

// Every temp dir this file creates is removed once all tests have run.
const createdTempDirs = [];
after(() => { for (const d of createdTempDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-cfg-')); createdTempDirs.push(d); return d; };
const writeCfg = (dir, cfg) => fs.writeFileSync(path.join(dir, 'service.json'), JSON.stringify(cfg));
// The admin-owned config file. Tests run as an ordinary user and cannot create
// a root-owned file, so "who is the administrator" is steered with an injected
// adminUid, and the euid with an injected geteuid — the same way master-key.js
// takes an injected getuid.
const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const writeAdmin = (dir, cfg) => {
  const file = path.join(dir, 'service.json');
  fs.writeFileSync(file, JSON.stringify(cfg), { mode: 0o644 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
  return file;
};
const opts = (dir) => ({ adminConfigDir: dir, geteuid: () => -1, adminUid: selfUid });

describe('loadServiceConfig', () => {
  it('defaults to agent profile with listeners and chat channels off, on the service ports', () => {
    assert.deepStrictEqual(loadServiceConfig(tmp()), {
      profile: 'agent',
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: false },
      ports: { gateway: 18793, webhook: 18794, desktopBridge: 18796 }
    });
  });
  it('reads the profile from the admin config and lets CLI overrides win', () => {
    const admin = tmp();
    writeAdmin(admin, { profile: 'runbook' });
    assert.strictEqual(loadServiceConfig(tmp(), {}, opts(admin)).profile, 'runbook');
    assert.strictEqual(loadServiceConfig(tmp(), { profile: 'agent' }, opts(admin)).profile, 'agent');
  });

  // Which profile runs decides whether the agent stack loads at all, so it is
  // security-relevant config and must not come from the service-writable file.
  // Every unit's ExecStart passes --profile, so this was never reachable on an
  // installed service; it contradicted the rule all the same.
  it('ignores the profile in the service-writable <dataDir>/service.json, and says so', () => {
    const dir = tmp();
    writeCfg(dir, { profile: 'runbook' });
    const warnings = [];
    const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    let cfg;
    try { cfg = loadServiceConfig(dir, {}, opts(tmp())); } finally { remove(); }
    assert.strictEqual(cfg.profile, 'agent', 'the default must win over the service-writable file');
    assert.ok(
      warnings.some((m) => m.includes('service.json') && /profile/.test(m)),
      `expected a warning naming the file, got ${JSON.stringify(warnings)}`
    );
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
    assert.deepStrictEqual(loadServiceConfig(tmp(), {}, opts(admin)).ports, { gateway: 28791, webhook: DEFAULT_PORTS.webhook, desktopBridge: DEFAULT_PORTS.desktopBridge });
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
    if (process.getuid() === 0) {
      fs.chownSync(admin, 12345, 12345);
      fs.chownSync(file, 12345, 12345);
    }
    const uid = fs.statSync(file).uid;
    assert.throws(
      () => loadServiceConfig(tmp(), {}, { adminConfigDir: admin, geteuid: () => uid, adminUid: uid + 1 }),
      /owned by the account/
    );
    // ...and the administrator's own file is still fine.
    const ok = tmp();
    writeAdmin(ok, { features: { gateway: true } });
    assert.strictEqual(loadServiceConfig(tmp(), {}, opts(ok)).features.gateway, true);
  });

  // Copilot review comment C6 (PR #28): the check only rejected a file owned by
  // the service's own euid, so one planted by any *third* unprivileged uid was
  // accepted. With a hand-picked data dir under a shared parent (e.g.
  // `/tmp/kl/data`, whose admin config is `/tmp/kl/config`) another local user
  // could switch the gateway and webhook listeners on, or move their ports.
  it('refuses an admin config file owned by a third unprivileged uid', { skip: process.platform === 'win32' ? 'POSIX ownership only' : false }, () => {
    const admin = tmp();
    writeAdmin(admin, { features: { gateway: true, webhooks: true }, ports: { gateway: 1234 } });
    // The file is owned by selfUid; neither the administrator (selfUid + 1)
    // nor the account running the service (selfUid + 2).
    assert.throws(
      () => loadServiceConfig(tmp(), {}, {
        adminConfigDir: admin,
        geteuid: () => selfUid + 2,
        adminUid: selfUid + 1
      }),
      /not by root\/an administrator/
    );
  });

  it('refuses an admin config dir a non-administrator owns, even when the file looks right', { skip: process.platform === 'win32' ? 'POSIX ownership only' : false }, () => {
    const admin = tmp();
    writeAdmin(admin, { features: { gateway: true } });
    // Whoever can write the directory can rename their own file over the one
    // that was checked, so the directory has to be the administrator's too.
    assert.throws(
      () => loadServiceConfig(tmp(), {}, { adminConfigDir: admin, geteuid: () => -1, adminUid: selfUid + 1 }),
      /must be owned by root\/an administrator/
    );
  });

  it('refuses a group- or world-writable admin config dir', { skip: process.platform === 'win32' ? 'POSIX mode bits only' : false }, () => {
    const admin = tmp();
    writeAdmin(admin, { features: { gateway: true } });
    fs.chmodSync(admin, 0o777);
    assert.throws(() => loadServiceConfig(tmp(), {}, opts(admin)), /writable/);
  });

  it('defaults every feature off when there is no admin config at all', () => {
    assert.deepStrictEqual(loadServiceConfig(tmp(), {}, opts(path.join(tmp(), 'nope'))).features, {
      gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: false
    });
  });
});

describe('adminConfigDir', () => {
  it('is the root/admin-owned dir beside the data dir, and /etc/king-louie on Linux', () => {
    assert.strictEqual(adminConfigDir({ platform: 'linux', dataDir: '/var/lib/king-louie' }), '/etc/king-louie');
    assert.strictEqual(adminConfigDir({ platform: 'linux' }), '/etc/king-louie');
    assert.strictEqual(
      adminConfigDir({ platform: 'darwin', dataDir: '/Library/Application Support/KingLouie/data' }),
      '/Library/Application Support/KingLouie/config'
    );
    assert.strictEqual(
      adminConfigDir({ platform: 'win32', dataDir: 'C:\\ProgramData\\KingLouie\\data' }),
      'C:\\ProgramData\\KingLouie\\config'
    );
  });

  // Every Linux instance used to read the literal /etc/king-louie whatever
  // --data-dir said, so a second service inherited the first one's `ports`,
  // failed to bind and — since a failed bind of an enabled listener is now
  // fatal — refused to start, with no per-instance port override anywhere.
  it('derives a per-instance dir on Linux when the data dir is not the default', () => {
    assert.strictEqual(adminConfigDir({ platform: 'linux', dataDir: '/srv/kl-b/data' }), '/srv/kl-b/config');
    assert.notStrictEqual(
      adminConfigDir({ platform: 'linux', dataDir: '/srv/kl-a/data' }),
      adminConfigDir({ platform: 'linux', dataDir: '/srv/kl-b/data' })
    );
    // Dot segments and trailing slashes must not sneak an instance back onto
    // the shared location, or past a root-owned parent.
    assert.strictEqual(adminConfigDir({ platform: 'linux', dataDir: '/srv/kl-b/data/' }), '/srv/kl-b/config');
    assert.strictEqual(adminConfigDir({ platform: 'linux', dataDir: '/var/lib/../lib/king-louie' }), '/etc/king-louie');
  });

  it('derives a per-instance credential path the same way', () => {
    assert.strictEqual(adminCredentialPath({ platform: 'linux' }), '/etc/king-louie/credentials/kl-master-key');
    assert.strictEqual(
      adminCredentialPath({ platform: 'linux', dataDir: '/srv/kl-b/data' }),
      '/srv/kl-b/config/credentials/kl-master-key'
    );
  });
});

// Two services with different data dirs must be able to coexist: each reads
// its own admin config, so each can carry its own ports.
describe('two instances on one Linux box', () => {
  it('read their own admin config, not a shared one', () => {
    const adminA = tmp();
    const adminB = tmp();
    writeAdmin(adminA, { features: { gateway: true }, ports: { gateway: 20001 } });
    writeAdmin(adminB, { features: { gateway: true }, ports: { gateway: 20002 } });
    assert.strictEqual(loadServiceConfig(tmp(), {}, opts(adminA)).ports.gateway, 20001);
    assert.strictEqual(loadServiceConfig(tmp(), {}, opts(adminB)).ports.gateway, 20002);
  });
});

describe('loadServiceConfig: unknown keys in the admin service.json (R55)', () => {
  it('rejects an unknown features key and names it', () => {
    const admin = tmp();
    const file = writeAdmin(admin, { features: { gateway: false, webhook: true } });
    assert.throws(() => loadServiceConfig(tmp(), {}, opts(admin)), (err) => {
      assert.strictEqual(
        err.message,
        `Invalid ${file}: unknown key "features.webhook" (known: gateway, webhooks, mesh, channels, appDiscovery, desktopBridge)`
      );
      return true;
    });
  });

  it('rejects an unknown ports key with the same wording', () => {
    const admin = tmp();
    const file = writeAdmin(admin, { ports: { gateway: 18793, mesh: 18791 } });
    assert.throws(() => loadServiceConfig(tmp(), {}, opts(admin)), (err) => {
      assert.strictEqual(err.message, `Invalid ${file}: unknown key "ports.mesh" (known: gateway, webhook, desktopBridge)`);
      return true;
    });
  });

  it('rejects features that is not an object', () => {
    const admin = tmp();
    writeAdmin(admin, { features: ['gateway'] });
    assert.throws(() => loadServiceConfig(tmp(), {}, opts(admin)), /"features" must be an object/);
  });

  it('accepts every known features and ports key', () => {
    const admin = tmp();
    writeAdmin(admin, {
      profile: 'runbook',
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: false },
      ports: { gateway: 18793, webhook: 18794, desktopBridge: 18796 }
    });
    const cfg = loadServiceConfig(tmp(), {}, opts(admin));
    assert.strictEqual(cfg.profile, 'runbook');
    assert.deepStrictEqual(Object.keys(cfg.features).sort(), ['appDiscovery', 'channels', 'desktopBridge', 'gateway', 'mesh', 'webhooks']);
  });

  // The brief's own wording ("still only warns... whatever their names") never
  // checked the warning it describes; capture it with addSink, the same
  // pattern the profile/feature tests above use, so the warning is asserted
  // rather than merely possible.
  it('still only warns about features in the service-writable <dataDir>/service.json, whatever their names', () => {
    const dir = tmp();
    writeCfg(dir, { features: { bogus: true } });
    const warnings = [];
    const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    let cfg;
    try { cfg = loadServiceConfig(dir, {}, opts(tmp())); } finally { remove(); }
    assert.strictEqual(cfg.features.gateway, false);
    assert.strictEqual(cfg.features.bogus, undefined);
    assert.ok(
      warnings.some((m) => m.includes('service.json') && /features/.test(m)),
      `expected a warning naming the file, got ${JSON.stringify(warnings)}`
    );
  });
});
