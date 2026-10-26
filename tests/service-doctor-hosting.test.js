// tests/service-doctor-hosting.test.js
//
// doctor's rows under personal hosting (spec 2026-10-25-personal-node-design.md
// §6, §8): a "hosting" row right after "node configuration loaded", and the
// session-helper and identity-record rows saying they are not used. Temp
// dirs only; the owner read and the schtasks query are injected.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runDoctor } = require('../src/service/doctor');
const { deriveNodeId } = require('../src/mesh/node-identity');
const { writeGuiStatus } = require('../src/gui/status');
const { IDENTITY_RECORD_TEST_OPTIONS } = require('./helpers/identity-record');

const POSIX = process.platform !== 'win32';
const UID = POSIX ? process.getuid() : 0;
const cleanups = [];
after(() => { for (const c of cleanups) c(); });

function setup({ hosting = null } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-doctor-hosting-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.mkdirSync(configDir, { mode: 0o755 });
  if (POSIX) { fs.chmodSync(base, 0o755); fs.chmodSync(configDir, 0o755); }
  const yaml = ['name: laptop', 'profile: agent', ...(hosting ? [`hosting: ${hosting}`] : [])].join('\n');
  fs.writeFileSync(path.join(configDir, 'node.yaml'), `${yaml}\n`, { mode: 0o644 });
  // A node identity in the store, so the fleet layout has an identity row.
  const pair = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'der' } });
  fs.writeFileSync(path.join(dataDir, 'chat-data.json'), JSON.stringify({ mesh: { identity: { publicKey: pair.publicKey.toString('hex'), nodeId: deriveNodeId(pair.publicKey) } } }));
  return { dataDir, configDir };
}

const owners = (me, owner = me) => ({ platform: 'win32', inspectOwners: (paths) => ({ me, entries: paths.map(() => ({ owner, link: false })) }) });

async function doctor(s, extra = {}) {
  let queried = 0;
  const results = await runDoctor({
    dataDir: s.dataDir, configDir: s.configDir, adminUid: UID,
    deps: { identityRecord: IDENTITY_RECORD_TEST_OPTIONS, queryTask: () => { queried++; return 'Ready'; }, ...extra }
  });
  return { results, queried: () => queried };
}
const rowIndex = (results, check) => results.findIndex((r) => r.check === check);

describe('doctor: hosting', () => {
  it('the fleet layout says "service" right after the node configuration row, and nothing else changes', async () => {
    const s = setup();
    const { results, queried } = await doctor(s);
    const i = rowIndex(results, 'node configuration loaded');
    assert.ok(i >= 0);
    assert.deepEqual(results[i + 1], { check: 'hosting', ok: true, detail: 'service' });
    assert.equal(queried(), 0, 'no task query in the fleet layout');
    assert.equal(rowIndex(results, 'recorded identity'), -1);
    assert.equal(rowIndex(results, 'session helper'), -1);
    // The identity row is the fleet one (there is no record here: a warning).
    const id = results.find((r) => r.check === 'node identity record');
    assert.equal(id.ok, true);
    assert.equal(id.warn, true);
  });

  it('personal: the owner account and the task state; not-used rows for the helper and the record', async () => {
    const s = setup({ hosting: 'personal' });
    const { results, queried } = await doctor(s, { personalOwner: owners('PC\\owner') });
    const i = rowIndex(results, 'node configuration loaded');
    assert.deepEqual(results[i + 1], {
      check: 'hosting', ok: true,
      detail: `personal (runs as ${os.userInfo().username}; the owner account is the trust boundary); task KingLouie Node: Ready`
    });
    assert.equal(queried(), 1);
    assert.deepEqual(results.find((r) => r.check === 'recorded identity'), { check: 'recorded identity', ok: true, detail: 'not used on a personal node' });
    assert.deepEqual(results.find((r) => r.check === 'session helper'), { check: 'session helper', ok: true, detail: 'not used on a personal node (the GUI runs in-process)' });
    assert.equal(rowIndex(results, 'node identity record'), -1);
    assert.equal(rowIndex(results, 'session helper file'), -1);
    assert.equal(rowIndex(results, 'desktop apps (running service)'), -1);
  });

  it('personal: a running service that turned desktop apps off is still said', async () => {
    const s = setup({ hosting: 'personal' });
    fs.writeFileSync(path.join(s.dataDir, 'service.pid'), String(process.pid));
    writeGuiStatus(s.dataDir, {
      v: 1, pid: process.pid, hosting: 'personal', available: false, reason: 'gui_start_failed', detail: 'no backend', user: null, platform: null,
      capabilities: [], probes: [], limits: [], apps: [], since: 'x', updated_at: new Date().toISOString(), lease: null
    });
    const { results } = await doctor(s, { personalOwner: owners('PC\\owner') });
    const row = results.find((r) => r.check === 'desktop apps (running service)');
    assert.equal(row.ok, false);
    assert.match(row.detail, /^off, gui_start_failed: no backend\. To fix it, /);
    assert.equal(results.find((r) => r.check === 'session helper').ok, true);
  });

  it('personal: a task that is not registered warns; Running is passed through', async () => {
    const s = setup({ hosting: 'personal' });
    let { results } = await doctor(s, { personalOwner: owners('PC\\owner'), queryTask: () => 'not registered' });
    let row = results.find((r) => r.check === 'hosting');
    assert.equal(row.ok, true);
    assert.equal(row.warn, true);
    assert.match(row.detail, /task KingLouie Node: not registered$/);
    ({ results } = await doctor(s, { personalOwner: owners('PC\\owner'), queryTask: () => 'Running' }));
    row = results.find((r) => r.check === 'hosting');
    assert.equal(row.warn, undefined);
    assert.match(row.detail, /task KingLouie Node: Running$/);
  });

  it('personal: an owner check that fails is a FAIL with its problem as the detail', async () => {
    const s = setup({ hosting: 'personal' });
    const { results } = await doctor(s, { personalOwner: owners('PC\\owner', 'BUILTIN\\Administrators') });
    const row = results.find((r) => r.check === 'hosting');
    assert.equal(row.ok, false);
    assert.equal(row.detail, `${s.dataDir} is owned by BUILTIN\\Administrators, not this account (PC\\owner)`);
  });
});

describe('doctor: the default schtasks read', () => {
  const { queryPersonalTask } = require('../src/service/doctor');
  it('maps exit 0 with a Status line to its state, and anything else to "not registered"', () => {
    const calls = [];
    const fake = (out, fail = false) => (file, args) => { calls.push([file, args]); if (fail) throw new Error('exit 1'); return out; };
    const env = { SystemRoot: 'C:\\Windows' };
    assert.equal(queryPersonalTask({ env, execFileSync: fake('Folder: \\\r\nTaskName  Next Run Time  Status\r\nStatus: Ready\r\n') }), 'Ready');
    assert.deepEqual(calls[0], ['C:\\Windows\\System32\\schtasks.exe', ['/Query', '/TN', 'KingLouie Node', '/FO', 'LIST']]);
    assert.equal(queryPersonalTask({ env, execFileSync: fake('Status:        Running\n') }), 'Running');
    assert.equal(queryPersonalTask({ env, execFileSync: fake('Status: Disabled\n') }), 'not registered');
    assert.equal(queryPersonalTask({ env, execFileSync: fake('no status here\n') }), 'not registered');
    assert.equal(queryPersonalTask({ env, execFileSync: fake('', true) }), 'not registered');
  });
});
