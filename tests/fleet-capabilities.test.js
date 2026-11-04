// What a node says it can do (tasks spec docs/superpowers/specs/2026-11-03-tasks-stage1-design.md
// §4.2): the declared list, then what is detected. Every input is injected: nothing here looks at
// this machine's browsers.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectCapabilities, agentCapabilityProbes, MAX_CAPABILITIES } = require('../src/fleet/capabilities');

const AGENT = { name: 'n', profile: 'agent', capabilities: [] };
const RUNBOOK = { name: 'n', profile: 'runbook', capabilities: [] };

describe('detectCapabilities', () => {
  it('interactive under personal hosting, or with a working session helper, and not otherwise', () => {
    assert.ok(detectCapabilities({ nodeConfig: AGENT, hosting: 'personal', platform: 'win32' }).includes('interactive'));
    assert.ok(detectCapabilities({ nodeConfig: AGENT, hosting: 'service', gui: { available: true }, platform: 'win32' }).includes('interactive'));
    assert.ok(!detectCapabilities({ nodeConfig: AGENT, hosting: 'service', gui: { available: false }, platform: 'win32' }).includes('interactive'));
  });

  it('hosting defaults to the node config\'s', () => {
    assert.ok(detectCapabilities({ nodeConfig: { ...AGENT, hosting: 'personal' }, platform: 'win32' }).includes('interactive'));
  });

  it('gui while the helper is up, as before', () => {
    assert.ok(detectCapabilities({ nodeConfig: AGENT, gui: { available: true }, platform: 'linux' }).includes('gui'));
    assert.ok(!detectCapabilities({ nodeConfig: AGENT, gui: { available: false }, platform: 'linux' }).includes('gui'));
  });

  it('browser:logins when the king-louie profile dir exists, and only that one', () => {
    assert.ok(detectCapabilities({ nodeConfig: AGENT, profileDirs: ['take', 'king-louie'], platform: 'linux' }).includes('browser:logins'));
    assert.ok(detectCapabilities({ nodeConfig: AGENT, profileDirs: () => ['king-louie'], platform: 'linux' }).includes('browser:logins'));
    assert.ok(!detectCapabilities({ nodeConfig: AGENT, profileDirs: ['take', 'kl-cases'], platform: 'linux' }).includes('browser:logins'));
    assert.ok(!detectCapabilities({ nodeConfig: AGENT, platform: 'linux' }).includes('browser:logins'));
  });

  it('browser:headless when the injected probe says so', () => {
    assert.ok(detectCapabilities({ nodeConfig: AGENT, chromiumRunnable: () => true, platform: 'linux' }).includes('browser:headless'));
    assert.ok(!detectCapabilities({ nodeConfig: AGENT, chromiumRunnable: () => false, platform: 'linux' }).includes('browser:headless'));
    assert.ok(!detectCapabilities({ nodeConfig: AGENT, platform: 'linux' }).includes('browser:headless'));
  });

  it('a probe that throws reports nothing, and detection goes on', () => {
    const caps = detectCapabilities({
      nodeConfig: AGENT, platform: 'linux',
      chromiumRunnable: () => { throw new Error('no'); },
      profileDirs: () => { throw new Error('no'); },
      localModelServers: () => { throw new Error('no'); }
    });
    assert.deepEqual(caps, ['shell', 'os:linux']);
  });

  it('shell on an agent node, not on a runbook node', () => {
    assert.ok(detectCapabilities({ nodeConfig: AGENT, platform: 'linux' }).includes('shell'));
    assert.ok(!detectCapabilities({ nodeConfig: RUNBOOK, platform: 'linux' }).includes('shell'));
  });

  it('local-models with a usable server only', () => {
    assert.ok(detectCapabilities({ nodeConfig: AGENT, localModelServers: [{ usable: false }, { usable: true }], platform: 'linux' }).includes('local-models'));
    assert.ok(!detectCapabilities({ nodeConfig: AGENT, localModelServers: [{ usable: false }], platform: 'linux' }).includes('local-models'));
    assert.ok(!detectCapabilities({ nodeConfig: AGENT, localModelServers: [], platform: 'linux' }).includes('local-models'));
  });

  it('os:<windows|macos|linux>', () => {
    assert.ok(detectCapabilities({ nodeConfig: RUNBOOK, platform: 'win32' }).includes('os:windows'));
    assert.ok(detectCapabilities({ nodeConfig: RUNBOOK, platform: 'darwin' }).includes('os:macos'));
    assert.ok(detectCapabilities({ nodeConfig: RUNBOOK, platform: 'linux' }).includes('os:linux'));
    assert.deepEqual(detectCapabilities({ nodeConfig: RUNBOOK, platform: 'aix' }), []);
  });

  it('keeps the declared list first, each once', () => {
    const caps = detectCapabilities({ nodeConfig: { ...AGENT, capabilities: ['gpu', 'shell', 'large-disk'] }, platform: 'linux' });
    assert.deepEqual(caps, ['gpu', 'shell', 'large-disk', 'os:linux']);
  });

  it('at most 32, and every entry a string of at most 64 characters (what the router keeps)', () => {
    const declared = Array.from({ length: 40 }, (_, i) => `cap-${i}`);
    assert.equal(MAX_CAPABILITIES, 32);
    assert.equal(detectCapabilities({ nodeConfig: { ...AGENT, capabilities: declared }, platform: 'linux' }).length, 32);
    const odd = detectCapabilities({ nodeConfig: { ...RUNBOOK, capabilities: ['ok', 7, 'x'.repeat(65)] }, platform: 'aix' });
    assert.deepEqual(odd, ['ok']);
  });

  it('the agent\'s probes read the data dir\'s profiles and the core\'s local servers, on each read', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-caps-'));
    try {
      let rows = [];
      const core = { context: { getLocalServers: () => ({ list: () => rows }) } };
      // The Chromium probe looks at this machine, so it stays out of this test.
      const { chromiumRunnable, ...probes } = agentCapabilityProbes({ core, dataDir, hosting: 'personal' });
      assert.equal(typeof chromiumRunnable, 'function');
      const caps = () => detectCapabilities({ nodeConfig: AGENT, ...probes, platform: 'linux' });
      assert.deepEqual(caps(), ['interactive', 'shell', 'os:linux']);
      fs.mkdirSync(path.join(dataDir, 'browser-profiles', 'king-louie'), { recursive: true });
      rows = [{ usable: true }];
      assert.deepEqual(caps(), ['interactive', 'browser:logins', 'shell', 'local-models', 'os:linux']);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('a config with no list is an empty declared list', () => {
    assert.deepEqual(detectCapabilities({ nodeConfig: { name: 'n', profile: 'runbook' }, platform: 'aix' }), []);
  });
});
