const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const { assertEnabledListenersBound } = require('../src/service/run');

// createCore treats a failed listener bind as non-fatal on purpose (it only
// log.warn's). In service mode that is a silent fail-open: an unprivileged
// local user can bind 127.0.0.1:<port> before boot, the service comes up
// reporting {"event":"ready"} with features.gateway on and no gateway, and
// ensureGatewayToken has still written a usable bearer token in the clear to
// <dataDir>/gateway-token. Neither `status` nor `doctor` looks at listeners.
const boundCore = () => ({ getGatewayServer: () => ({ wss: {} }), getWebhookServer: () => ({ httpServer: {} }) });
const unboundCore = () => ({ getGatewayServer: () => ({ wss: null }), getWebhookServer: () => ({ httpServer: null }) });

describe('assertEnabledListenersBound', () => {
  it('passes when nothing is enabled, whatever the listeners did', () => {
    const features = { gateway: false, webhooks: false };
    assertEnabledListenersBound(unboundCore(), features);
  });

  it('passes when every enabled listener bound', () => {
    assertEnabledListenersBound(boundCore(), { gateway: true, webhooks: true });
  });

  it('refuses when an enabled gateway did not bind', () => {
    assert.throws(
      () => assertEnabledListenersBound(unboundCore(), { gateway: true, webhooks: false }),
      /refusing to run without gateway.*could not bind/s
    );
  });

  it('refuses when an enabled webhook listener did not bind', () => {
    assert.throws(
      () => assertEnabledListenersBound(unboundCore(), { gateway: false, webhooks: true }),
      /refusing to run without webhooks/
    );
  });

  it('names both when both are enabled and neither bound', () => {
    assert.throws(
      () => assertEnabledListenersBound(unboundCore(), { gateway: true, webhooks: true }),
      /gateway and webhooks/
    );
  });

  it('tolerates a core that never constructed the servers', () => {
    const core = { getGatewayServer: () => undefined, getWebhookServer: () => undefined };
    assertEnabledListenersBound(core, { gateway: false, webhooks: false });
    assert.throws(() => assertEnabledListenersBound(core, { gateway: true, webhooks: false }), /refusing to run/);
  });
});

// Copilot review comment C8 (PR #28): the pidfile was written unconditionally,
// after the core had started, so a second `run` against the same data dir just
// overwrote the first one's pid. Both then shared the data dir — two cron
// schedulers, two writers racing on the cached JSON stores — and whichever shut
// down first deleted the shared pidfile, after which `status` reported "not
// running" for a live service. With the default feature set no listener binds,
// so a port clash never caught it.
describe('acquireInstanceLock', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { acquireInstanceLock, readPidfile } = require('../src/service/pidfile');

  const dirs = [];
  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-lock-')); dirs.push(d); return d; };

  it('claims the data dir and names this process', () => {
    const dir = tmp();
    const lock = acquireInstanceLock(dir);
    assert.strictEqual(readPidfile(dir), process.pid);
    lock.release();
    assert.strictEqual(fs.existsSync(path.join(dir, 'service.pid')), false);
  });

  it('refuses a data dir a live process already owns', () => {
    const dir = tmp();
    // A pid that is certainly alive and is not this process: the parent. On a
    // detached runner that can be 1/0, so fall back to this process's own pid
    // written by hand, which the lock also has to refuse.
    const owner = process.ppid > 1 ? process.ppid : process.pid;
    fs.writeFileSync(path.join(dir, 'service.pid'), String(owner));
    if (owner === process.pid) {
      // A pidfile naming *this* process is our own lock; take it and release.
      acquireInstanceLock(dir).release();
      return;
    }
    assert.throws(() => acquireInstanceLock(dir), /already owns/);
    assert.strictEqual(readPidfile(dir), owner, 'the live owner must keep its claim');
  });

  it('clears a pidfile left behind by a process that is gone', () => {
    const dir = tmp();
    // A pid that cannot be running: process.kill(0) on it reports ESRCH.
    fs.writeFileSync(path.join(dir, 'service.pid'), '2147483646');
    const lock = acquireInstanceLock(dir);
    assert.strictEqual(readPidfile(dir), process.pid);
    lock.release();
  });

  it('ignores an unparseable pidfile rather than wedging', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'service.pid'), 'not-a-pid');
    const lock = acquireInstanceLock(dir);
    assert.strictEqual(readPidfile(dir), process.pid);
    lock.release();
  });

  it('release does not remove a pidfile that names someone else', () => {
    const dir = tmp();
    const lock = acquireInstanceLock(dir);
    fs.writeFileSync(path.join(dir, 'service.pid'), '4242');
    lock.release();
    assert.strictEqual(readPidfile(dir), 4242, 'a successor claim must survive our release');
  });
});
