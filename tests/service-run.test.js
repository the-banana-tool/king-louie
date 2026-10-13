const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const { assertEnabledListenersBound, answerLeaseListsWithNone } = require('../src/service/run');
const { closeOpenHistoryStores } = require('./helpers/close-history-stores');

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
// R-F5-20 (fourth security review, finding 2): a node with computer use off
// still answers lease.list, with a listing that names nothing.
describe('answerLeaseListsWithNone', () => {
  const identity = { nodeId: 'kl-test', publicKey: Buffer.alloc(0) };
  const relay = () => { const methods = new Map(); return { methods, registerMethod: (name, fn) => methods.set(name, fn) }; };

  it('registers lease.list where there is no lease manager, and leaves a node that has one alone', async () => {
    const off = relay();
    assert.strictEqual(answerLeaseListsWithNone({ relayClient: off, identity, approverStore: { get: () => null } }, null), true);
    assert.deepStrictEqual([...off.methods.keys()], ['lease.list']);
    assert.deepStrictEqual(await off.methods.get('lease.list')({ device_id: 'd-aaaaaaaaaaaaaaaa', nonce: 'n'.repeat(43) }), { statuses: [] }, 'a device this node does not know gets nothing');
    // A subsystem that is off (no lease manager): the same.
    const unavailable = relay();
    assert.strictEqual(answerLeaseListsWithNone({ relayClient: unavailable, identity, approverStore: null }, { unavailable: { reason: 'x' }, leases: null }), true);
    assert.strictEqual(unavailable.methods.size, 1);
    // A lease manager answers for itself (src/gui/index.js registered it).
    const on = relay();
    assert.strictEqual(answerLeaseListsWithNone({ relayClient: on, identity, approverStore: null }, { leases: {} }), false);
    assert.strictEqual(on.methods.size, 0);
    // No relay link, or no identity: nobody to answer, nothing to sign with.
    assert.strictEqual(answerLeaseListsWithNone({ relayClient: null, identity }, null), false);
    assert.strictEqual(answerLeaseListsWithNone({ relayClient: relay(), identity: null }, null), false);
  });
});

describe('acquireInstanceLock', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { acquireInstanceLock, readPidfile } = require('../src/service/pidfile');

  const dirs = [];
  after(() => { closeOpenHistoryStores(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
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

// The guard above is only worth anything if the object `runService` holds
// actually answers these. It did not: `getGatewayServer`/`getWebhookServer`
// lived on `core.context`, not on the object createCore returns, so
// assertEnabledListenersBound threw "core.getGatewayServer is not a function"
// the moment features.gateway or features.webhooks was on — the service
// refused to start with a listener enabled, whether or not it bound, and the
// squatted-port case it exists to catch was never reached. Copilot review
// comment C10 (PR #28) is the other half: the webhook bind is fire-and-forget,
// so its handle reads as non-null while the bind is still in flight.
describe('loadProfile("agent") listener readiness', { timeout: 120000 }, () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const http = require('http');
  const { loadProfile } = require('../src/service/run');
  const { ensureServicePaths, ensurePrivateDir } = require('../src/platform/paths');

  const dirs = [];
  after(() => { closeOpenHistoryStores(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  function dataDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-listen-'));
    dirs.push(d);
    ensureServicePaths(d);
    const workspace = path.join(d, 'workspace');
    ensurePrivateDir(workspace);
    return { dataDir: d, workspace };
  }
  const allOff = { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false };

  async function freePort() {
    const s = http.createServer();
    await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
    const port = s.address().port;
    await new Promise((resolve) => s.close(resolve));
    return port;
  }

  it('starts with the gateway and webhook listeners enabled and bound', async () => {
    const { dataDir: dir, workspace } = dataDir();
    const ports = { gateway: await freePort(), webhook: await freePort() };
    const running = await loadProfile('agent').start({
      dataDir: dir,
      features: { ...allOff, gateway: true, webhooks: true },
      ports,
      workspace
    });
    await running.stop();
  });

  it('refuses to run when an enabled gateway port is already taken', async () => {
    const { dataDir: dir, workspace } = dataDir();
    const squatter = http.createServer(() => {});
    await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const ports = { gateway: squatter.address().port, webhook: await freePort() };
    try {
      await assert.rejects(
        () => loadProfile('agent').start({
          dataDir: dir,
          features: { ...allOff, gateway: true },
          ports,
          workspace
        }),
        /refusing to run without gateway/
      );
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  // The C10 race: the webhook handle is assigned synchronously inside start(),
  // so without awaiting whenListenersSettled this read as bound.
  it('refuses to run when an enabled webhook port is already taken', async () => {
    const { dataDir: dir, workspace } = dataDir();
    const squatter = http.createServer(() => {});
    await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const ports = { gateway: await freePort(), webhook: squatter.address().port };
    try {
      await assert.rejects(
        () => loadProfile('agent').start({
          dataDir: dir,
          features: { ...allOff, webhooks: true },
          ports,
          workspace
        }),
        /refusing to run without webhooks/
      );
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  // Fix round 1 (opus review, ruling I2): createCore and core.start() are in
  // one try that stops approvals on failure. There is no dependency-injection
  // seam for createCore itself, so this substitutes require.cache's entry
  // for '../core' with a stub that throws — the same lazy `require('../core')`
  // inside start() picks it up — and restores the real module afterward.
  //
  // Asserting only that the promise rejects with the right message is not
  // enough: an async function auto-wraps ANY synchronous throw in a
  // rejection, including one from code that was never inside a try at all —
  // that was exactly the bug this ruling fixes (createCore was constructed
  // outside the try, so a throw from it skipped approvals.stop() entirely
  // while still producing a passing-looking rejection). setInterval/
  // clearInterval are wrapped so the test can see whether startApprovals's
  // prune timer — the one live handle this scenario creates (no relay is
  // configured, so there is no trackDeviceStates timer too) — was actually
  // cleared by approvals.stop(), not just that the error propagated.
  it('createCore throwing leaves approvals stopped (its prune timer cleared), not just a rejected promise', async () => {
    const { dataDir: dir, workspace } = dataDir();
    const coreEntry = require.resolve('../src/core');
    const original = require.cache[coreEntry];
    require.cache[coreEntry] = {
      id: coreEntry, filename: coreEntry, loaded: true,
      exports: { createCore: () => { throw new Error('createCore boom'); } }
    };
    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;
    const live = new Set();
    global.setInterval = (...args) => { const t = realSetInterval(...args); live.add(t); return t; };
    global.clearInterval = (t) => { live.delete(t); return realClearInterval(t); };
    try {
      await assert.rejects(
        loadProfile('agent').start({ dataDir: dir, features: allOff, ports: {}, workspace }),
        /createCore boom/
      );
    } finally {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
      if (original) require.cache[coreEntry] = original; else delete require.cache[coreEntry];
    }
    assert.equal(live.size, 0);
  });

  // Fix round 2 (opus re-review, minor): core.start() rejecting is different
  // from createCore() itself throwing — core.start() may have partially
  // started the core (cron timers, a listener bind in flight) before it
  // rejects, so it still needs a best-effort core.shutdown() ahead of
  // stopping approvals, not just approvals.stop() on its own.
  it("core.start() rejecting also calls core.shutdown() (best effort) before stopping approvals", async () => {
    const { dataDir: dir, workspace } = dataDir();
    const coreEntry = require.resolve('../src/core');
    const original = require.cache[coreEntry];
    let shutdownCalled = false;
    require.cache[coreEntry] = {
      id: coreEntry, filename: coreEntry, loaded: true,
      exports: {
        createCore: () => ({
          start: async () => { throw new Error('core.start boom'); },
          shutdown: async () => { shutdownCalled = true; }
        })
      }
    };
    try {
      await assert.rejects(
        loadProfile('agent').start({ dataDir: dir, features: allOff, ports: {}, workspace }),
        /core\.start boom/
      );
    } finally {
      if (original) require.cache[coreEntry] = original; else delete require.cache[coreEntry];
    }
    assert.equal(shutdownCalled, true);
  });

  // Cases stage 3 (M22, R42): the agent profile hands createCore the admin
  // service.json executors (their presence is what puts the registry in
  // service mode), the service adminUid (the executor root check), and the
  // signing trust from startApprovals (the signed-grant audit path).
  it('passes adminExecutors, adminUid and the approval trust to createCore', async () => {
    const { dataDir: dir, workspace } = dataDir();
    const coreEntry = require.resolve('../src/core');
    const original = require.cache[coreEntry];
    const seen = [];
    require.cache[coreEntry] = {
      id: coreEntry, filename: coreEntry, loaded: true,
      exports: {
        createCore: (deps) => {
          seen.push(deps);
          return {
            start: async () => {},
            whenListenersSettled: async () => {},
            getGatewayServer: () => ({ wss: null }),
            getWebhookServer: () => ({ httpServer: null }),
            shutdown: async () => {},
            // Fleet stage 4 (M10): the agent profile hosts DelegateSessions,
            // which needs the core's agent context.
            context: { getAgentExecutorAdapter: () => ({ execute: async () => ({}) }), getAgent: () => ({ id: 'main' }), listAgents: () => [{ id: 'main' }] }
          };
        }
      }
    };
    const executors = { entries: { 'phone-agent': { package: 'phone-agent' } }, packageRoots: [path.resolve('/opt/kl/executors')] };
    try {
      const running = await loadProfile('agent').start({ dataDir: dir, features: allOff, ports: {}, workspace, executors });
      const second = dataDir();
      const plain = await loadProfile('agent').start({ dataDir: second.dataDir, features: allOff, ports: {}, workspace: second.workspace });
      await running.stop();
      await plain.stop();
      assert.deepStrictEqual(seen[0].adminExecutors, executors);
      assert.deepStrictEqual(seen[1].adminExecutors, { entries: {}, packageRoots: [] }, 'always present: the service is always in service mode');
      assert.strictEqual('adminUid' in seen[1], false, 'production leaves adminUid to the default');
      const { approverStore, identity } = running.approvals;
      assert.ok(approverStore && identity && identity.nodeId && identity.publicKey);
      assert.deepStrictEqual(seen[0].approvalTrust, { approverStore, nodeId: identity.nodeId, nodePublicKey: identity.publicKey });
      assert.strictEqual(seen[0].approvalTrust.approverStore, approverStore, 'the admin-owned store startApprovals built');
    } finally {
      if (original) require.cache[coreEntry] = original; else delete require.cache[coreEntry];
    }
  });

  // Cases stage 4 (preflight M2): runService loads service.json once (with
  // adminUid) and threads its admin-only `contact` block through start(), like
  // `audit`; createCore always gets the key, whose presence means service mode.
  for (const [label, contact, expected] of [
    ['the admin contact block', { telegram: { ownerUserId: '123456789' } }, { telegram: { ownerUserId: '123456789' } }],
    ['null when service.json has none', undefined, null]
  ]) {
    it(`hands createCore ${label} as deps.contactConfig`, async () => {
      const { dataDir: dir, workspace } = dataDir();
      const coreEntry = require.resolve('../src/core');
      const original = require.cache[coreEntry];
      let seen = null;
      require.cache[coreEntry] = {
        id: coreEntry, filename: coreEntry, loaded: true,
        exports: {
          createCore: (deps) => {
            seen = deps;
            return {
              start: async () => {},
              whenListenersSettled: async () => {},
              getGatewayServer: () => ({ wss: null }),
              getWebhookServer: () => ({ httpServer: null }),
              shutdown: async () => {},
              // Fleet stage 4 (M10): the agent profile hosts DelegateSessions,
              // which needs the core's agent context.
              context: { getAgentExecutorAdapter: () => ({ execute: async () => ({}) }), getAgent: () => ({ id: 'main' }), listAgents: () => [{ id: 'main' }] }
            };
          }
        }
      };
      try {
        const running = await loadProfile('agent').start({ dataDir: dir, features: allOff, ports: {}, workspace, contact });
        await running.stop();
      } finally {
        if (original) require.cache[coreEntry] = original; else delete require.cache[coreEntry];
      }
      assert.ok(Object.prototype.hasOwnProperty.call(seen, 'contactConfig'));
      assert.deepStrictEqual(seen.contactConfig, expected);
    });
  }

  // Cases stage 4 Task 17: the phone contact channel gets F3's approvals
  // result, whose approver store reads the ADMIN <configDir>/approvers/, never
  // a data-dir set. configDir is a temp dir, never the real admin dir.
  it('hands createCore the F3 approvals (admin approver store) as deps.approvals', async () => {
    const { dataDir: dir, workspace } = dataDir();
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-admin-cfg-'));
    dirs.push(configDir);
    const coreEntry = require.resolve('../src/core');
    const original = require.cache[coreEntry];
    let seen = null;
    require.cache[coreEntry] = {
      id: coreEntry, filename: coreEntry, loaded: true,
      exports: {
        createCore: (deps) => {
          seen = deps;
          return {
            start: async () => {},
            whenListenersSettled: async () => {},
            getGatewayServer: () => ({ wss: null }),
            getWebhookServer: () => ({ httpServer: null }),
            shutdown: async () => {},
            // Fleet stage 4 (M10): the agent profile hosts DelegateSessions,
            // which needs the core's agent context.
            context: { getAgentExecutorAdapter: () => ({ execute: async () => ({}) }), getAgent: () => ({ id: 'main' }), listAgents: () => [{ id: 'main' }] }
          };
        }
      }
    };
    try {
      const running = await loadProfile('agent').start({ dataDir: dir, features: allOff, ports: {}, workspace, configDir });
      await running.stop();
    } finally {
      if (original) require.cache[coreEntry] = original; else delete require.cache[coreEntry];
    }
    assert.ok(seen.approvals && seen.approvals.approverStore && seen.approvals.identity);
    assert.strictEqual(seen.approvals.phoneApprover, seen.phoneApprover);
    assert.strictEqual(seen.isService, true, 'service mode is passed explicitly (final review M6)');
    assert.strictEqual(path.resolve(seen.approvals.approverStore.dir), path.resolve(configDir, 'approvers'));
    assert.ok(!path.resolve(seen.approvals.approverStore.dir).startsWith(path.resolve(dir)), 'not a data-dir approver set');
  });

  // Fleet stage 5 (owner ruling R-F5-11), with a live core: the session
  // helper file decides whether desktop apps are on, never whether the
  // service starts.
  describe('the GUI subsystem under a live core (R-F5-11)', () => {
    const crypto = require('crypto');
    const S = require('../src/gui/session-secret');
    const { readGuiStatusRecord } = require('../src/gui/status');
    const POSIX = process.platform !== 'win32';
    const UID = POSIX ? process.getuid() : 0;
    // R-F5-17: the administrator's record of the node identity, which a
    // helper install needs, written and read the way a temp dir allows.
    const { recordIdentity, IDENTITY_RECORD_TEST_OPTIONS } = require('./helpers/identity-record');

    // These tests' own dirs, removed here and with retries: a live core
    // probes its workspace with a git child (system-sections.js) that can
    // outlive shutdown() by a moment, and on Windows a directory that is a
    // running process's cwd cannot be removed until that process exits.
    const mine = [];
    after(async () => {
      closeOpenHistoryStores();
      for (const d of mine) await fs.promises.rm(d, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
    });
    function liveDataDir() {
      const made = dataDir();
      dirs.splice(dirs.indexOf(made.dataDir), 1);
      mine.push(made.dataDir);
      return made;
    }
    function adminDir({ enabled = true } = {}) {
      // Native realpath: session-secret.js wants the config dir to be its own.
      const configDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-run-gui-cfg-')));
      mine.push(configDir);
      if (POSIX) fs.chmodSync(configDir, 0o755);
      // R-F5-14: desktop apps are off until node.yaml enables them.
      if (enabled) fs.writeFileSync(path.join(configDir, 'node.yaml'), 'name: unnamed-node\ngui:\n  enabled: true\n', { mode: 0o644 });
      return configDir;
    }
    function installHelper(dir, configDir, { record = true } = {}) {
      const { buildServicePorts } = require('../src/service/ports');
      const { CHAT_DATA_DEFAULTS } = require('../src/core/settings');
      const { getOrGenerateNodeIdentity } = require('../src/mesh/node-identity');
      const ports = buildServicePorts({ dataDir: dir, chatDataDefaults: CHAT_DATA_DEFAULTS });
      const identity = getOrGenerateNodeIdentity(ports.store, ports.cipher, 'unnamed-node');
      if (record) recordIdentity(configDir, identity);
      const { secret, endpointId } = S.mintSessionSecret();
      S.writeCanonical({ configDir, cipher: ports.cipher, secret, endpointId, nodeId: identity.nodeId, sessionUser: 'alice' });
      fs.writeFileSync(path.join(dir, 'service.pid'), String(process.pid));
      return identity;
    }

    it('(e) R-F5-14: a valid helper file with no "gui: enabled: true" in node.yaml starts no GUI; the service is up', async () => {
      for (const yaml of [null, 'name: unnamed-node\n', 'name: unnamed-node\ngui:\n  enabled: false\n']) {
        const { dataDir: dir, workspace } = liveDataDir();
        const configDir = adminDir({ enabled: false });
        if (yaml !== null) fs.writeFileSync(path.join(configDir, 'node.yaml'), yaml, { mode: 0o644 });
        installHelper(dir, configDir);
        const running = await start(dir, workspace, configDir);
        try {
          assert.strictEqual(running.gui, null, String(yaml));
          assert.ok(running.fleet && running.fleet.jobManager);
        } finally {
          await running.stop();
        }
      }
    });
    const endpoint = (configDir) => (POSIX ? path.join(configDir, 'h.sock') : `\\\\.\\pipe\\kl-run-gui-${crypto.randomBytes(6).toString('hex')}`);
    const start = (dir, workspace, configDir) => loadProfile('agent').start({
      dataDir: dir, features: allOff, ports: {}, workspace, configDir, adminUid: UID, deps: { gui: { endpoint: endpoint(configDir) }, identityRecord: IDENTITY_RECORD_TEST_OPTIONS }
    });

    it('(a) no helper installed: the GUI is off and the service is up', async () => {
      const { dataDir: dir, workspace } = liveDataDir();
      const running = await start(dir, workspace, adminDir());
      try {
        assert.strictEqual(running.gui, null);
        assert.ok(running.fleet && running.fleet.jobManager, 'the rest of the service started');
      } finally {
        await running.stop();
      }
    });

    it('(b) an invalid helper file: the GUI is off with session_file_invalid and the service is up', async () => {
      const { dataDir: dir, workspace } = liveDataDir();
      const configDir = adminDir();
      fs.mkdirSync(path.join(configDir, 'session'), { mode: 0o755 });
      fs.writeFileSync(S.canonicalPath(configDir), '{ not json', { mode: 0o640 });
      fs.writeFileSync(path.join(dir, 'service.pid'), String(process.pid));
      const running = await start(dir, workspace, configDir);
      try {
        assert.ok(running.gui, 'a subsystem that is off, not a missing one');
        assert.strictEqual(running.gui.unavailable.reason, 'session_file_invalid');
        assert.strictEqual(running.gui.channel, null, 'no helper channel was opened');
        assert.strictEqual(running.gui.capability().available, false);
        assert.strictEqual(running.gui.capability().reason, 'session_file_invalid');
        assert.strictEqual(readGuiStatusRecord({ dataDir: dir }).reason, 'session_file_invalid');
        assert.ok(running.fleet && running.fleet.jobManager, 'the rest of the service started');
      } finally {
        await running.stop();
      }
    });

    it('(d) security review finding 2: a GUI that cannot start (its endpoint is taken) is off with a reason and the service is up', async () => {
      const { dataDir: dir, workspace } = liveDataDir();
      const configDir = adminDir();
      const { buildServicePorts } = require('../src/service/ports');
      const { CHAT_DATA_DEFAULTS } = require('../src/core/settings');
      const { getOrGenerateNodeIdentity } = require('../src/mesh/node-identity');
      const ports = buildServicePorts({ dataDir: dir, chatDataDefaults: CHAT_DATA_DEFAULTS });
      const identity = getOrGenerateNodeIdentity(ports.store, ports.cipher, 'unnamed-node');
      // R-F5-17: an administrator recorded that identity.
      recordIdentity(configDir, identity);
      const { secret, endpointId } = S.mintSessionSecret();
      S.writeCanonical({ configDir, cipher: ports.cipher, secret, endpointId, nodeId: identity.nodeId, sessionUser: 'alice' });
      fs.writeFileSync(path.join(dir, 'service.pid'), String(process.pid));
      // Something else holds the endpoint: a pipe on Windows, elsewhere a
      // directory the channel cannot replace.
      const ep = endpoint(configDir);
      let squatter = null;
      if (POSIX) {
        fs.mkdirSync(ep);
        fs.writeFileSync(path.join(ep, 'x'), '');
      } else {
        squatter = require('net').createServer(() => {});
        await new Promise((resolve, reject) => { squatter.once('error', reject); squatter.listen(ep, resolve); });
      }
      let running;
      try {
        running = await loadProfile('agent').start({ dataDir: dir, features: allOff, ports: {}, workspace, configDir, adminUid: UID, deps: { gui: { endpoint: ep }, identityRecord: IDENTITY_RECORD_TEST_OPTIONS } });
        assert.ok(running.gui);
        assert.strictEqual(running.gui.unavailable.reason, 'gui_start_failed');
        assert.strictEqual(running.gui.capability().available, false);
        assert.strictEqual(readGuiStatusRecord({ dataDir: dir }).reason, 'gui_start_failed');
        assert.ok(running.fleet && running.fleet.jobManager, 'the rest of the service started');
      } finally {
        if (running) await running.stop();
        if (squatter) await new Promise((resolve) => squatter.close(() => resolve()));
      }
    });

    it('(c) a valid helper file: started after the fleet node, stopped first, with jobOpen bound to the real JobManager', async () => {
      const { dataDir: dir, workspace } = liveDataDir();
      const configDir = adminDir();
      // The service's own master key and node identity, made the way it makes them.
      const { buildServicePorts } = require('../src/service/ports');
      const { CHAT_DATA_DEFAULTS } = require('../src/core/settings');
      const { getOrGenerateNodeIdentity } = require('../src/mesh/node-identity');
      const ports = buildServicePorts({ dataDir: dir, chatDataDefaults: CHAT_DATA_DEFAULTS });
      const identity = getOrGenerateNodeIdentity(ports.store, ports.cipher, 'unnamed-node');
      // R-F5-17: an administrator recorded that identity.
      recordIdentity(configDir, identity);
      const { secret, endpointId } = S.mintSessionSecret();
      S.writeCanonical({ configDir, cipher: ports.cipher, secret, endpointId, nodeId: identity.nodeId, sessionUser: 'alice' });
      fs.writeFileSync(path.join(dir, 'service.pid'), String(process.pid));

      const running = await start(dir, workspace, configDir);
      const order = [];
      try {
        assert.ok(running.gui && !running.gui.unavailable, 'the real subsystem');
        assert.ok(running.gui.channel.server, 'the helper channel is listening');
        assert.strictEqual(running.gui.capability().available, false, 'no helper has connected');
        const record = readGuiStatusRecord({ dataDir: dir });
        assert.ok(record && record.available === false && !record.reason, 'the broker started and wrote its status');
        // jobOpen is the real one: a job the fleet JobManager has is open
        // until it ends, and nothing else is.
        const { jobOpen } = running.gui.leases;
        const job = running.fleet.jobManager.createDelegateJob({ machine: 'unnamed-node', task: 'x', cwd: null });
        assert.strictEqual(jobOpen(job.job_id), true);
        assert.strictEqual(jobOpen('job-0-nobody'), false);
        assert.strictEqual(jobOpen('chat:no-such-chat'), false);
        running.fleet.jobManager.cancelJob(job.job_id);
        assert.strictEqual(jobOpen(job.job_id), false, 'a job that ended is closed');
        for (const [name, part] of [['gui', running.gui], ['fleet', running.fleet], ['approvals', running.approvals]]) {
          const stop = part.stop.bind(part);
          part.stop = async () => { order.push(name); return stop(); };
        }
      } finally {
        await running.stop();
      }
      assert.deepStrictEqual(order, ['gui', 'fleet', 'approvals'], 'the GUI stops first, approvals last');
      assert.strictEqual(running.gui.channel.server, null, 'the helper channel is closed');
    });

    // R-F5-20 (fourth security review, finding 2): every node with an
    // identity and the relay link answers lease.list. With computer use off
    // (not enabled, no helper, no record of the identity; a runbook node) it
    // signs "nothing"; a node with a lease manager answers from that.
    it('(i) R-F5-20: a node with computer use off still answers lease.list; an agent node with a lease manager answers from it', async () => {
      const { EventEmitter } = require('events');
      const P = require('../src/gui/lease-protocol');
      const W = require('../src/approvals/service-wiring');
      const realOff = P.offLeaseListing;
      const realStart = W.startApprovals;
      const made = [];
      const links = [];
      P.offLeaseListing = (options) => { made.push(options.identity.nodeId); return realOff(options); };
      // These temp nodes are paired with no relay, so approvals come back
      // with no link. Give each one a link that records what is registered.
      W.startApprovals = async (options) => {
        const approvals = await realStart(options);
        const link = Object.assign(new EventEmitter(), {
          methods: new Map(), registerMethod(name, fn) { this.methods.set(name, fn); }, isConnected: () => false,
          send: async () => { throw new Error('no relay in this test'); }, notify() {}, onMessage() {}
        });
        links.push(link);
        return { ...approvals, relayClient: link };
      };
      const NONCE = 'n'.repeat(43);
      try {
        // Not enabled in node.yaml, and no helper installed.
        const a = liveDataDir();
        const off = await start(a.dataDir, a.workspace, adminDir({ enabled: false }));
        try {
          assert.strictEqual(off.gui, null);
          assert.deepStrictEqual(made, [off.approvals.identity.nodeId]);
          assert.deepStrictEqual([...links[0].methods.keys()].filter((m) => m.startsWith('lease.')), ['lease.list']);
          assert.deepStrictEqual(await links[0].methods.get('lease.list')({ device_id: 'd-aaaaaaaaaaaaaaaa', nonce: NONCE }), { statuses: [] }, 'nothing for a device that is not enrolled here');
        } finally {
          await off.stop();
        }
        // Enabled and installed, but no administrator's record: a subsystem that is off.
        const b = liveDataDir();
        const bConfig = adminDir();
        installHelper(b.dataDir, bConfig, { record: false });
        const unrecorded = await start(b.dataDir, b.workspace, bConfig);
        try {
          assert.strictEqual(unrecorded.gui.unavailable.reason, 'node_identity_unrecorded');
          assert.deepStrictEqual(made.slice(1), [unrecorded.approvals.identity.nodeId]);
          assert.deepStrictEqual([...links[1].methods.keys()].filter((m) => m.startsWith('lease.')), ['lease.list']);
        } finally {
          await unrecorded.stop();
        }
        // On: the lease manager's own lease.list is the one registered; nothing is put over it.
        const c = liveDataDir();
        const cConfig = adminDir();
        installHelper(c.dataDir, cConfig);
        const on = await start(c.dataDir, c.workspace, cConfig);
        try {
          assert.ok(on.gui && on.gui.leases, 'computer use is on');
          assert.strictEqual(made.length, 2);
          assert.deepStrictEqual([...links[2].methods.keys()].filter((m) => m.startsWith('lease.')), ['lease.grant', 'lease.revoke', 'lease.watch', 'lease.list']);
        } finally {
          await on.stop();
        }
        // A runbook node never runs computer use, and says so.
        const d = liveDataDir();
        const runbook = await loadProfile('runbook').start({ dataDir: d.dataDir, configDir: adminDir({ enabled: false }), adminUid: UID, deps: { identityRecord: IDENTITY_RECORD_TEST_OPTIONS } });
        try {
          assert.deepStrictEqual(made.slice(2), [runbook.approvals.identity.nodeId]);
          assert.ok(links[3].methods.has('lease.list'));
        } finally {
          await runbook.stop();
        }
      } finally {
        P.offLeaseListing = realOff;
        W.startApprovals = realStart;
      }
    });

    // R-F5-17 (owner ruling, built 2026-10-13): the service holds the
    // identity in its data dir against the administrator's record of it.
    describe('R-F5-17: the administrator\'s record of the node identity', () => {
      const R = require('../src/service/identity-record');
      const { NodeIdentity } = require('../src/mesh/node-identity');

      it('(f) no record (an install from before the ruling): the service is up and signs as before; computer use is off and says what to run', async () => {
        const { dataDir: dir, workspace } = liveDataDir();
        const configDir = adminDir();
        const identity = installHelper(dir, configDir, { record: false });
        const running = await start(dir, workspace, configDir);
        try {
          assert.ok(running.fleet && running.fleet.jobManager, 'the service is up');
          assert.strictEqual(running.approvals.identity.nodeId, identity.nodeId);
          assert.ok(running.gui && running.gui.unavailable, 'a subsystem that is off');
          assert.strictEqual(running.gui.unavailable.reason, 'node_identity_unrecorded');
          assert.strictEqual(running.gui.channel, null);
          const record = readGuiStatusRecord({ dataDir: dir });
          assert.strictEqual(record.reason, 'node_identity_unrecorded');
        } finally {
          await running.stop();
        }
        assert.strictEqual(R.readIdentityRecord({ configDir, adminUid: UID, ...IDENTITY_RECORD_TEST_OPTIONS }).state, 'none', 'the service never writes the record itself');
      });

      it('(g) the data dir holds another identity than the one recorded: the service refuses to start, with the remedy, on both node profiles', async () => {
        for (const profile of ['agent', 'runbook']) {
          const { dataDir: dir, workspace } = liveDataDir();
          const configDir = adminDir();
          const identity = installHelper(dir, configDir, { record: false });
          const vouched = new NodeIdentity({ nodeName: 'unnamed-node' });
          recordIdentity(configDir, vouched);
          await assert.rejects(
            loadProfile(profile).start({ dataDir: dir, features: allOff, ports: {}, workspace, configDir, adminUid: UID, deps: { gui: { endpoint: endpoint(configDir) }, identityRecord: IDENTITY_RECORD_TEST_OPTIONS } }),
            (err) => {
              assert.strictEqual(err.code, 'NODE_IDENTITY_MISMATCH', profile);
              assert.match(err.message, /^Refusing to start: /);
              assert.ok(err.message.includes(identity.nodeId) && err.message.includes(vouched.nodeId), 'names both identities');
              assert.ok(err.message.includes(`king-louie-service identity record --replace --data-dir ${dir}`), 'the administrator\'s remedy');
              return true;
            }
          );
          assert.strictEqual(fs.existsSync(path.join(dir, 'audit')), false, `${profile}: nothing was signed or opened with that identity`);
        }
      });

      it('(h) a record that cannot be trusted or read: the service refuses to start (fail closed), never as if there were none', async () => {
        const cases = [
          ['is not valid JSON', (configDir) => fs.writeFileSync(R.recordPath(configDir), '{ broken'), IDENTITY_RECORD_TEST_OPTIONS],
          // Windows: a directory this process can write (the real probe), and owners nobody could read.
          ['is writable by the account running the service', () => {}, { ...IDENTITY_RECORD_TEST_OPTIONS, platform: 'win32', serviceProbe: true }],
          ['could not be read', () => {}, { platform: 'win32', serviceProbe: false, inspectOwners: () => { throw new Error('powershell failed'); } }]
        ];
        if (POSIX) cases.push(['is not owned by the administrator', () => {}, { adminUid: UID + 1 }]);
        for (const [why, damage, identityRecord] of cases) {
          const { dataDir: dir, workspace } = liveDataDir();
          const configDir = adminDir();
          installHelper(dir, configDir);
          damage(configDir);
          await assert.rejects(
            loadProfile('agent').start({ dataDir: dir, features: allOff, ports: {}, workspace, configDir, adminUid: UID, deps: { gui: { endpoint: endpoint(configDir) }, identityRecord } }),
            (err) => {
              assert.strictEqual(err.code, 'NODE_IDENTITY_RECORD_INVALID', why);
              assert.ok(err.message.includes(why), err.message);
              assert.ok(!err.message.includes('broken'), 'the file is never quoted');
              return true;
            }
          );
        }
      });
    });
  });

  // Fix round 2 (opus re-review, minor, explicitly requested test): the
  // returned stop() already runs core.shutdown() in a try with
  // approvals.stop() in the finally (round 1); this pins that a rejecting
  // core.shutdown() still leaves approvals genuinely stopped (its prune
  // timer cleared), not merely that stop() itself rejects.
  it('a rejecting core.shutdown() still stops approvals', async () => {
    const { dataDir: dir, workspace } = dataDir();
    const coreEntry = require.resolve('../src/core');
    const original = require.cache[coreEntry];
    require.cache[coreEntry] = {
      id: coreEntry, filename: coreEntry, loaded: true,
      exports: {
        createCore: () => ({
          start: async () => {},
          whenListenersSettled: async () => {},
          getGatewayServer: () => ({ wss: null }),
          getWebhookServer: () => ({ httpServer: null }),
          shutdown: async () => { throw new Error('shutdown boom'); },
          // Fleet stage 4 (M10): the agent profile hosts DelegateSessions,
          // which needs the core's agent context.
          context: { getAgentExecutorAdapter: () => ({ execute: async () => ({}) }), getAgent: () => ({ id: 'main' }), listAgents: () => [{ id: 'main' }] }
        })
      }
    };
    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;
    const live = new Set();
    global.setInterval = (...args) => { const t = realSetInterval(...args); live.add(t); return t; };
    global.clearInterval = (t) => { live.delete(t); return realClearInterval(t); };
    try {
      const running = await loadProfile('agent').start({ dataDir: dir, features: allOff, ports: {}, workspace });
      await assert.rejects(running.stop(), /shutdown boom/);
    } finally {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
      if (original) require.cache[coreEntry] = original; else delete require.cache[coreEntry];
    }
    assert.equal(live.size, 0);
  });
});
