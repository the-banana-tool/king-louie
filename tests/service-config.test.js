const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadServiceConfig } = require('../src/service/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-cfg-'));

describe('loadServiceConfig', () => {
  it('defaults to agent profile with listeners off', () => {
    assert.deepStrictEqual(loadServiceConfig(tmp()), {
      profile: 'agent',
      features: { gateway: false, webhooks: false, mesh: false, channels: true, appDiscovery: false }
    });
  });
  it('reads service.json and lets CLI overrides win', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'service.json'), JSON.stringify({ profile: 'agent', features: { gateway: true } }));
    const cfg = loadServiceConfig(dir, { profile: 'runbook' });
    assert.strictEqual(cfg.profile, 'runbook');
    assert.strictEqual(cfg.features.gateway, true);
  });
  it('rejects unknown profiles', () => {
    assert.throws(() => loadServiceConfig(tmp(), { profile: 'frontdoor' }), /Unknown profile "frontdoor"/);
  });
});
