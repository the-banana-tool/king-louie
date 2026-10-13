// tests/e2e/session-helper.test.js
//
// Drives real desktop apps through the real helper: Windows (Calculator,
// Notepad) or macOS (Calculator, TextEdit), in an interactive session, only
// with KL_E2E_GUI=1. No Electron, and nothing from the real profile: temp
// config and data dirs, KL_SESSION_FILE, a fake phone. Do not touch the
// mouse or keyboard while it runs (it would, correctly, yield to you).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter, once } = require('events');
const { open } = require('../../src/approvals/envelope');
const { createGuiSubsystem } = require('../../src/gui');
const { parseGuiConfig } = require('../../src/gui/config');
const S = require('../../src/gui/session-secret');
const { createAesGcmCipher } = require('../../src/platform/cipher');
const { ToolRegistry } = require('../../src/tools/tool-registry');
const { createFakePhone, testNodeIdentity } = require('../helpers/fake-phone');
const { approverStoreWith } = require('../helpers/approver-set');

const WIN = process.platform === 'win32';
const RUN = (WIN || process.platform === 'darwin') && process.env.KL_E2E_GUI === '1';
const UID = WIN ? 0 : process.getuid();
const GID = WIN ? 0 : process.getgid();

const APPS = WIN
  ? { calculator: { name: 'Calculator', path: 'C:\\Windows\\System32\\calc.exe', processes: ['CalculatorApp.exe', 'calc.exe'] },
      notepad: { name: 'Notepad', path: 'C:\\Windows\\System32\\notepad.exe', processes: ['notepad.exe'] } }
  : { calculator: { name: 'Calculator', path: '/System/Applications/Calculator.app' },
      notepad: { name: 'TextEdit', path: '/System/Applications/TextEdit.app' } };

class FakeRelay extends EventEmitter {
  constructor() { super(); this.sent = []; this.methods = new Map(); }
  isConnected() { return true; }
  async send(envelope, opts) { this.sent.push({ envelope, opts, message: open(envelope).message }); return { ok: true }; }
  registerMethod(name, fn) { this.methods.set(name, fn); }
  lastRequest() { return [...this.sent].reverse().find((s) => s.message.type === 'kl.lease.request'); }
}

const until = async (check, what, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

describe('session helper end to end', { skip: !RUN && 'set KL_E2E_GUI=1 on Windows or macOS, in an interactive session' }, () => {
  let base;
  let gui;
  let child;
  let tools;
  let relay;
  let phone;
  let identity;
  const opts = { origin: { client: 'e2e', session: null, job_id: 'job-e2e' } };

  before(async () => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-gui-')));
    const configDir = path.join(base, 'config');
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(configDir, { mode: 0o755 });
    fs.mkdirSync(dataDir, { mode: 0o700 });
    if (!WIN) { fs.chmodSync(base, 0o755); fs.chmodSync(configDir, 0o755); }
    fs.writeFileSync(path.join(dataDir, 'service.pid'), String(process.pid));
    identity = testNodeIdentity({ key: 'gpu-box' });
    const cipher = createAesGcmCipher(crypto.randomBytes(32));
    const user = os.userInfo().username;
    const whoami = WIN ? path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe') : null;
    const sid = WIN ? execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim().split(',').pop().replace(/"/g, '') : null;
    const { secret, endpointId } = S.mintSessionSecret();
    const endpoint = WIN ? S.endpointPath({ platform: 'win32', endpointId }) : path.join(base, 'h.sock');
    S.writeCanonical({ configDir, cipher, secret, endpointId, nodeId: identity.nodeId, sessionUser: user });
    const file = S.writeUserCopy({
      platform: process.platform, configDir, user, uid: UID, gid: GID, sid,
      content: { v: 1, node_id: identity.nodeId, endpoint, secret: secret.toString('hex'), rotated_at: new Date().toISOString() }, runIcacls: () => {}
    });
    phone = createFakePhone();
    const store = await approverStoreWith([phone.approverRecord()]);
    relay = new FakeRelay();
    const nodeConfig = { name: 'gpu-box', profile: 'agent', capabilities: [], policy: { allowed_roots: [base], remote_sessions: { always_confirm: [], deny: [] } }, gui: parseGuiConfig({ apps: APPS }, { platform: process.platform }) };
    gui = createGuiSubsystem({
      nodeConfig, dataDir, configDir, cipher, adminUid: UID, geteuid: () => UID,
      approvals: { identity, approverStore: store, relayClient: relay, phoneApprover: { isAvailable: () => true }, auditLedger: { append: async () => {} } },
      // R-F5-7: the subsystem knows no open job unless its host says so.
      jobOpen: (jobId) => jobId === 'job-e2e',
      deps: { endpoint }
    });
    await gui.start();
    const ready = once(gui.channel, 'ready');
    child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'session-helper-child.js')], {
      env: { ...process.env, KL_SESSION_FILE: file, KL_E2E_ROOT_UID: String(UID), KING_LOUIE_LOG_LEVEL: 'warn' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc']
    });
    await ready;
    const registry = new ToolRegistry();
    gui.registerTools(registry);
    tools = (name) => registry.get(name);
  });

  after(async () => {
    try { await tools('CloseApp').execute({ app: 'calculator', force: true }, opts); } catch { /* best effort */ }
    try { await tools('CloseApp').execute({ app: 'notepad', force: true }, opts); } catch { /* best effort */ }
    if (child && child.exitCode === null) {
      // Closing the channel lets the helper stop its backend worker; kill is the fallback.
      const exited = once(child, 'exit');
      const fallback = setTimeout(() => child.kill(), 10000);
      if (child.connected) child.disconnect(); else child.kill();
      await exited;
      clearTimeout(fallback);
    }
    if (gui) await gui.stop();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  const foregroundIs = (appId) => until(async () => {
    const fg = await gui.broker.foregroundApp([appId]);
    return fg && fg.appId === appId;
  }, `${appId} in the foreground`);

  it('launches, leases, types, captures, suspends on a foreign window, resumes, and is revoked', async () => {
    assert.equal((await tools('LaunchApp').execute({ app: 'calculator' }, opts)).ok, true);
    await foregroundIs('calculator');

    const leasing = tools('RequestLease').execute({ apps: ['calculator'], minutes: 5, reason: 'e2e' }, opts);
    await until(() => relay.lastRequest(), 'the lease request');
    await relay.methods.get('lease.grant')({ envelope: phone.leaseGrant(relay.lastRequest().envelope, { minutes: 5 }) });
    const lease = await leasing;
    assert.equal(lease.ok, true);

    assert.equal((await tools('Type').execute({ text: '12+30=' }, opts)).ok, true);
    const shot = await tools('Screenshot').execute({ app: 'calculator' }, opts);
    assert.equal(shot.ok, true);
    const jpeg = Buffer.from(shot._images[0].base64, 'base64');
    assert.ok(jpeg.length > 1000 && jpeg[0] === 0xff && jpeg[1] === 0xd8, 'a JPEG');

    assert.equal((await tools('LaunchApp').execute({ app: 'notepad' }, opts)).ok, true);
    await foregroundIs('notepad');
    assert.match((await tools('Type').execute({ text: 'x' }, opts)).error, /^foreground_mismatch/);
    assert.match((await tools('Key').execute({ keys: 'escape' }, opts)).error, /^lease_suspended/);

    const resume = relay.lastRequest();
    assert.equal(resume.message.lease.resumes, lease.lease_id);
    await relay.methods.get('lease.grant')({ envelope: phone.leaseGrant(resume.envelope, { minutes: resume.message.lease.max_minutes }) });
    await foregroundIs('calculator');
    assert.equal((await tools('Key').execute({ keys: 'escape' }, opts)).ok, true);

    await relay.methods.get('lease.revoke')({ envelope: phone.leaseRevoke(identity.nodeId, lease.lease_id) });
    assert.match((await tools('Key').execute({ keys: 'escape' }, opts)).error, /^lease_revoked/);

    assert.equal((await tools('CloseApp').execute({ app: 'notepad', force: true }, opts)).ok, true);
    assert.equal((await tools('CloseApp').execute({ app: 'calculator', force: true }, opts)).ok, true);
  });
});
