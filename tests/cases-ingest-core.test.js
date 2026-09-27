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
const core = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { IngestService, ingestServiceFor } = require('../src/cases/ingest');
const { openPdf } = require('../src/cases/ingest/pdf');
const { shutdownPdfSandbox } = require('../src/cases/ingest/pdf-sandbox');
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

  it('shutdown closes the IngestService before it releases the case locks (M16)', async () => {
    delete process.env.KL_CASES_ROOT;
    const c = core.createCore(makeDeps());
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
    await c.shutdown();
    assert.deepStrictEqual(order, ['close:start', 'close:end', 'releaseAll']);
    await assert.rejects(svc.extract('any-case', 'doc-000000000000'), (e) => e.code === 'SHUTTING_DOWN');
  });

  it('shutdown finishes within shutdownTimeoutMs when closing ingest never settles', async () => {
    delete process.env.KL_CASES_ROOT;
    const c = core.createCore(makeDeps({ shutdownTimeoutMs: 50 }));
    const svc = c.context.getIngestService();
    svc.close = () => new Promise(() => {});
    let released = false;
    const runtime = c.context.getCaseRuntime();
    const realRelease = runtime.releaseAll.bind(runtime);
    runtime.releaseAll = () => {
      released = true;
      return realRelease();
    };
    const started = Date.now();
    await c.shutdown();
    assert.ok(Date.now() - started < 3000, `shutdown took ${Date.now() - started} ms`);
    assert.strictEqual(released, true);
  });

  it('no PDF worker child survives shutdown', async () => {
    delete process.env.KL_CASES_ROOT;
    const c = core.createCore(makeDeps());
    const pids = [];
    const childProcess = require('node:child_process');
    const spawn = (...args) => {
      const child = childProcess.spawn(...args);
      pids.push(child.pid);
      return child;
    };
    // A document left open: its worker lives until the idle timeout (60 s)
    // unless shutdown stops it.
    const pdf = await openPdf(await makePdf({ pages: [{ text: 'An invented page of words for the reader.' }] }), { name: 'open.pdf', spawn });
    assert.strictEqual(pdf.pageCount, 1);
    assert.strictEqual(pids.length, 1);
    assert.ok(alive(pids[0]), 'the worker runs before shutdown');
    await c.shutdown();
    assert.strictEqual(alive(pids[0]), false, 'the worker is gone once shutdown resolves');
  });
});
