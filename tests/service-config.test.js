const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadServiceConfig } = require('../src/service/config');
const { addSink } = require('../src/logging');

// Every temp dir this file creates is removed once all tests have run.
const createdTempDirs = [];
after(() => { for (const d of createdTempDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-cfg-')); createdTempDirs.push(d); return d; };
const writeCfg = (dir, cfg) => fs.writeFileSync(path.join(dir, 'service.json'), JSON.stringify(cfg));

describe('loadServiceConfig', () => {
  it('defaults to agent profile with listeners and chat channels off, on the service ports', () => {
    assert.deepStrictEqual(loadServiceConfig(tmp()), {
      profile: 'agent',
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      ports: { gateway: 18791, webhook: 18792 }
    });
  });
  it('reads service.json and lets CLI overrides win', () => {
    const dir = tmp();
    writeCfg(dir, { profile: 'agent', features: { gateway: true } });
    const cfg = loadServiceConfig(dir, { profile: 'runbook' });
    assert.strictEqual(cfg.profile, 'runbook');
    assert.strictEqual(cfg.features.gateway, true);
  });
  it('rejects unknown profiles', () => {
    assert.throws(() => loadServiceConfig(tmp(), { profile: 'frontdoor' }), /Unknown profile "frontdoor"/);
  });
  it('forces mesh off even when service.json asks for it, and warns', () => {
    const dir = tmp();
    writeCfg(dir, { features: { mesh: true } });
    const warnings = [];
    const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    let cfg;
    try {
      cfg = loadServiceConfig(dir);
    } finally {
      remove();
    }
    assert.strictEqual(cfg.features.mesh, false);
    assert.ok(warnings.some((m) => /mesh/.test(m)), `expected a mesh warning, got ${JSON.stringify(warnings)}`);
  });
  it('lets service.json override the ports', () => {
    const dir = tmp();
    writeCfg(dir, { ports: { gateway: 28791 } });
    assert.deepStrictEqual(loadServiceConfig(dir).ports, { gateway: 28791, webhook: 18792 });
  });
  it('rejects invalid ports', () => {
    for (const ports of [{ gateway: 0 }, { gateway: 70000 }, { webhook: '18792' }, { mesh: 1 }, [1]]) {
      const dir = tmp();
      writeCfg(dir, { ports });
      assert.throws(() => loadServiceConfig(dir), /ports/, JSON.stringify(ports));
    }
  });
});
