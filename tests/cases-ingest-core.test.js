// tests/cases-ingest-core.test.js
// Host wiring for cases stage 7 (spec §3.5, §7): createCore builds the
// IngestService unless deps.ingest is 'none', resumes it at start, and at
// shutdown closes it (ruling M16) and stops every PDF worker before the case
// locks are released.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Shutdown-order spies, installed before create-core loads (it keeps its
// own references to these exports).
const shutdownOrder = { log: null };
const contactHostModule = require('../src/cases/contact-host');
const realCreateContactHost = contactHostModule.createContactHost;
contactHostModule.createContactHost = (opts) => {
  const host = realCreateContactHost(opts);
  const stop = host.stop;
  host.stop = (...args) => {
    shutdownOrder.log?.push('contact:stop');
    return stop.apply(host, args);
  };
  return host;
};
const pdfSandboxModule = require('../src/cases/ingest/pdf-sandbox');
const realShutdownPdfSandbox = pdfSandboxModule.shutdownPdfSandbox;
pdfSandboxModule.shutdownPdfSandbox = (...args) => {
  shutdownOrder.log?.push('pdf:shutdown');
  return realShutdownPdfSandbox(...args);
};

const core = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { IngestService, ingestServiceFor } = require('../src/cases/ingest');
const shutdownPdfSandbox = realShutdownPdfSandbox;
const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const { makePdf } = require('./helpers/ingest-fixtures');

// As src/service/cli.js passes it (ruling M4).
const NO_ADMIN_EXECUTORS = Object.freeze({ entries: Object.freeze({}), packageRoots: Object.freeze([]) });

const dirs = [];
const savedRoot = process.env.KL_CASES_ROOT;
after(async () => {
  await shutdownPdfSandbox();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  if (savedRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedRoot;
});

function makeDeps(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ingest-core-'));
  dirs.push(dataDir);
  return {
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    ui: { send: () => {} },
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    adminExecutors: NO_ADMIN_EXECUTORS,
    ...extra
  };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('createCore ingest wiring', () => {
  it('builds the IngestService for the case runtime and resumes it at start', async () => {
    delete process.env.KL_CASES_ROOT;
    const c = core.createCore(makeDeps());
    const svc = c.context.getIngestService();
    assert.ok(svc instanceof IngestService);
    assert.strictEqual(ingestServiceFor(c.context.getCaseRuntime()), svc);
    let resumed = 0;
    svc.resume = async () => { resumed += 1; };
    await c.start();
    try {
      assert.strictEqual(resumed, 1);
    } finally {
      await c.shutdown();
    }
  });

  it("has no IngestService with deps.ingest 'none'", () => {
    delete process.env.KL_CASES_ROOT;
    const c = core.createCore(makeDeps({ ingest: 'none' }));
    assert.strictEqual(c.context.getIngestService(), null);
    assert.ok(c.context.getCaseRuntime());
  });

  it('shutdown stops contact, then closes ingest, then the PDF readers, then releases the case locks (M16)', async () => {
    delete process.env.KL_CASES_ROOT;
    const c = core.createCore(makeDeps());
    await c.start();
    const svc = c.context.getIngestService();
    const runtime = c.context.getCaseRuntime();
    const order = [];
    const realClose = svc.close.bind(svc);
    svc.close = async () => {
      order.push('close:start');
      // An in-flight publish that takes a moment to finish.
      await new Promise((r) => setTimeout(r, 50));
      await realClose();
      order.push('close:end');
    };
    const realRelease = runtime.releaseAll.bind(runtime);
    runtime.releaseAll = () => {
      order.push('releaseAll');
      return realRelease();
    };
    shutdownOrder.log = order;
    try {
      await c.shutdown();
    } finally {
      shutdownOrder.log = null;
    }
    assert.deepStrictEqual(order, ['contact:stop', 'close:start', 'close:end', 'pdf:shutdown', 'releaseAll']);
    await assert.rejects(svc.extract('any-case', 'doc-000000000000'), (e) => e.code === 'SHUTTING_DOWN');
  });

  it('shutdown finishes within shutdownTimeoutMs when closing ingest hangs', async () => {
    delete process.env.KL_CASES_ROOT;
    const c = core.createCore(makeDeps({ shutdownTimeoutMs: 50 }));
    const svc = c.context.getIngestService();
    // A close that hangs the way a real one can: on work that still holds a
    // handle (a model call's socket, a git child), here a timer far past the
    // bound. withTimeout's own timer is unref'd by design, so a promise that
    // holds no handle at all lets the process end mid-shutdown (Linux).
    let hung = null;
    svc.close = () => new Promise((resolve) => { hung = setTimeout(resolve, 60000); });
    let released = false;
    const runtime = c.context.getCaseRuntime();
    const realRelease = runtime.releaseAll.bind(runtime);
    runtime.releaseAll = () => {
      released = true;
      return realRelease();
    };
    const started = Date.now();
    try {
      await c.shutdown();
    } finally {
      clearTimeout(hung);
    }
    assert.ok(Date.now() - started < 3000, `shutdown took ${Date.now() - started} ms`);
    assert.strictEqual(released, true);
  });

  it('no PDF worker child survives shutdown: a scan read waiting on OCR', { skip: HAS_GIT ? false : 'git is not on PATH' }, async () => {
    delete process.env.KL_CASES_ROOT;
    const c = core.createCore(makeDeps());
    const runtime = c.context.getCaseRuntime();
    const svc = c.context.getIngestService();
    const meta = await runtime.createCase({ title: 'Lakeside lot' });
    runtime.store.updateMeta(meta.id, { status: 'active' });
    runtime.roleModel = () => ({ provider: 'anthropic', model: 'claude-sonnet-4-5', tier: 'standard' });
    let release;
    const gate = new Promise((r) => { release = r; });
    let entered;
    const inOcr = new Promise((r) => { entered = r; });
    const calls = [];
    svc.callModel = async (req) => {
      calls.push(req.purpose);
      entered();
      await gate;
      return { text: 'Lakeside lot, invented page text', usage: { provider: 'anthropic', model: 'claude-sonnet-4-5', inputTokens: 900, outputTokens: 100, totalTokens: 1000, cost: 0.01 } };
    };
    const childProcess = require('node:child_process');
    const realSpawn = childProcess.spawn;
    const pids = [];
    childProcess.spawn = (...args) => {
      const child = realSpawn(...args);
      pids.push(child.pid);
      return child;
    };
    try {
      await svc.store(meta.id, { name: 'scan.pdf', bytes: await makePdf({ pages: [{ scan: true }, { scan: true }] }), origin: { kind: 'owner-drop' } });
      await inOcr;
    } finally {
      childProcess.spawn = realSpawn;
    }
    const reader = pids.at(-1);
    assert.ok(alive(reader), 'the reader of the scan runs while OCR waits');
    // The OCR reply comes back while shutdown waits for it.
    setTimeout(release, 100);
    await c.shutdown();
    assert.deepStrictEqual(calls, ['ocr']);
    assert.strictEqual(alive(reader), false, 'the worker is gone once shutdown resolves');
    assert.ok(pids.every((pid) => !alive(pid)));
  });
});
