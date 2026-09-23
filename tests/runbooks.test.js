const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RunbookEngine,
  JobManager,
  validateParam,
  substituteArgv,
  isSanitisedParamValue
} = require('../src/runbooks/runbook-engine');

const currentUid = process.getuid ? process.getuid() : 0;

describe('Runbook Parameter Validation & Fuzzing', () => {
  it('validates string parameter with pattern regex', () => {
    const paramDef = { type: 'string', pattern: '^[A-Za-z0-9._/-]{1,64}$', default: 'main' };
    assert.equal(validateParam(paramDef, 'main'), 'main');
    assert.equal(validateParam(paramDef, 'v1.0.2'), 'v1.0.2');
  });

  it('fuzzes string parameter with malicious injection payloads', () => {
    const paramDef = { type: 'string', pattern: '^[A-Za-z0-9._/-]{1,64}$' };
    const maliciousPayloads = [
      '; rm -rf /',
      '$(whoami)',
      '`id`',
      '| cat /etc/passwd',
      'main & calc.exe',
      'main\nrm -rf /',
      'main\r\nreboot',
      '../../../../etc/shadow',
      '..\u0000/etc/passwd',
      'foo\uFF0Fbar', // Unicode fullwidth slash
      'foo\u2215bar', // Unicode division slash
      'foo\u2216bar'  // Unicode set minus
    ];

    for (const payload of maliciousPayloads) {
      assert.throws(
        () => validateParam(paramDef, payload),
        (err) => err instanceof Error,
        `Expected payload "${payload}" to be rejected by pattern validation`
      );
    }
  });

  it('rejects Unicode lookalikes and null bytes in parameters', () => {
    assert.equal(isSanitisedParamValue('hello/world'), true);
    assert.equal(isSanitisedParamValue('hello\u0000world'), false);
    assert.equal(isSanitisedParamValue('hello\uFF0Fworld'), false); // Fullwidth solidus
    assert.equal(isSanitisedParamValue('hello\u2215world'), false); // Division slash
    assert.equal(isSanitisedParamValue('hello\u2216world'), false); // Set minus
  });

  it('validates integer parameter min/max', () => {
    const paramDef = { type: 'integer', min: 1, max: 10 };
    assert.equal(validateParam(paramDef, 5), 5);
    assert.throws(() => validateParam(paramDef, 15), /exceeds maximum/);
    assert.throws(() => validateParam(paramDef, 'abc'), /is not an integer/);
    assert.throws(() => validateParam(paramDef, '1; DROP TABLE'), /is not an integer/);
  });

  it('validates enum parameter', () => {
    const paramDef = { type: 'enum', values: ['dev', 'prod'] };
    assert.equal(validateParam(paramDef, 'dev'), 'dev');
    assert.throws(() => validateParam(paramDef, 'staging'), /not one of allowed enum values/);
    assert.throws(() => validateParam(paramDef, 'dev; rm -rf /'), /not one of allowed enum values/);
  });

  it('validates path parameter under allowed_roots and rejects traversal attempts', () => {
    const allowedRoots = [path.resolve('/srv/app')];
    const paramDef = { type: 'path' };
    assert.equal(validateParam(paramDef, '/srv/app/src', allowedRoots), path.resolve('/srv/app/src'));

    const traversalPayloads = [
      '/srv/app/../other',
      '/srv/app/../../etc/passwd',
      '../etc/shadow',
      '/etc/passwd'
    ];

    for (const payload of traversalPayloads) {
      assert.throws(
        () => validateParam(paramDef, payload, allowedRoots),
        (err) => err instanceof Error,
        `Expected path payload "${payload}" to be rejected`
      );
    }
  });

  it('substitutes {{param}} placeholders safely inside argv', () => {
    const argv = ['git', '-C', '/srv/site', 'checkout', 'origin/{{ref}}'];
    const substituted = substituteArgv(argv, { ref: 'main' });
    assert.deepEqual(substituted, ['git', '-C', '/srv/site', 'checkout', 'origin/main']);
  });
});

describe('RunbookEngine Execution', () => {
  it('loads runbooks from admin-owned directory and executes steps', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runbook-test-'));
    try {
      if (process.platform !== 'win32') fs.chmodSync(tmpDir, 0o700);

      const runbookYaml = `
name: echo.test
description: Echo a message
tier: routine
params:
  msg:
    type: string
    pattern: '^[a-zA-Z0-9 ]+$'
    default: hello
steps:
  - run: [node, -e, 'console.log(process.argv[1])', '{{msg}}']
timeout_s: 10
`;
      const file = path.join(tmpDir, 'echo.yaml');
      fs.writeFileSync(file, runbookYaml, 'utf8');
      if (process.platform !== 'win32') fs.chmodSync(file, 0o600);

      const engine = new RunbookEngine({
        runbooksDir: tmpDir,
        allowedRoots: [tmpDir],
        geteuid: () => currentUid,
        adminUid: currentUid
      });

      engine.loadRunbooks();
      assert.ok(engine.getRunbook('echo.test'));

      const result = await engine.executeRunbook('echo.test', { msg: 'world' });
      assert.equal(result.success, true);
      assert.ok(result.logs.some((l) => l.includes('world')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('enforces rate limits on runbook execution', () => {
    const engine = new RunbookEngine();
    engine.runbooks.set('limited.run', {
      name: 'limited.run',
      rate_limit: { max: 2, per: '1h' }
    });

    assert.equal(engine.checkRateLimit('limited.run').allowed, true);
    engine.recordExecution('limited.run');
    assert.equal(engine.checkRateLimit('limited.run').allowed, true);
    engine.recordExecution('limited.run');
    assert.equal(engine.checkRateLimit('limited.run').allowed, false);
  });
});

describe('JobManager', () => {
  it('manages job state transitions', () => {
    const manager = new JobManager();
    const job1 = manager.createJob({ machine: 'gpu-box', runbook: 'models.download', params: {}, tier: 'routine' });
    assert.equal(job1.status, 'queued');

    const job2 = manager.createJob({ machine: 'web-01', runbook: 'site.reboot', params: {}, tier: 'unsafe' });
    assert.equal(job2.status, 'awaiting_approval');

    manager.updateJob(job1.job_id, { status: 'running' });
    assert.equal(manager.getJob(job1.job_id).status, 'running');

    manager.updateJob(job1.job_id, { status: 'succeeded' });
    assert.equal(manager.getJob(job1.job_id).status, 'succeeded');

    assert.equal(manager.cancelJob(job2.job_id), true);
    assert.equal(manager.getJob(job2.job_id).status, 'cancelled');
  });
});

describe('JobManager concurrency limit', () => {
  it('refuses a new runnable job once max_concurrent_jobs are queued or running', () => {
    const manager = new JobManager({ maxConcurrentJobs: 1 });
    const first = manager.createJob({ machine: 'm', runbook: 'a', tier: 'routine' });
    assert.throws(() => manager.createJob({ machine: 'm', runbook: 'b', tier: 'routine' }), /max_concurrent_jobs/);

    // An unsafe job only waits for approval, so it does not take a slot.
    assert.equal(manager.createJob({ machine: 'm', runbook: 'c', tier: 'unsafe' }).status, 'awaiting_approval');

    manager.updateJob(first.job_id, { status: 'succeeded' });
    assert.equal(manager.createJob({ machine: 'm', runbook: 'b', tier: 'routine' }).status, 'queued');
  });
});

describe('path parameters and symlinks', () => {
  it('rejects a path that reaches outside allowed_roots through a symlink', (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-roots-'));
    try {
      const root = path.join(base, 'root');
      const outside = path.join(base, 'outside');
      fs.mkdirSync(root);
      fs.mkdirSync(outside);
      try {
        fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
      } catch (err) {
        t.skip(`cannot create a link here: ${err.code}`);
        return;
      }
      assert.throws(() => validateParam({ type: 'path' }, path.join(root, 'escape', 'x'), [root]), /allowed_roots/);
      assert.equal(validateParam({ type: 'path' }, path.join(root, 'new', 'file'), [root]), path.join(fs.realpathSync.native(root), 'new', 'file'));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('runbook engine module graph', () => {
  it('does not load the agent stack, so the runbook profile can use it', () => {
    const { execFileSync } = require('child_process');
    const root = path.join(__dirname, '..');
    const out = execFileSync(process.execPath, ['-e',
      "require('./src/runbooks/runbook-engine'); process.stdout.write(JSON.stringify(Object.keys(require.cache)))"
    ], { cwd: root, env: { ...process.env, KING_LOUIE_LOG_LEVEL: 'silent' } }).toString();
    const loaded = JSON.parse(out).map((p) => path.relative(root, p).split(path.sep).join('/'));
    const forbidden = ['src/providers/', 'src/execution/', 'src/tools/', 'src/browser/', 'src/channels/', 'src/mcp/', 'src/core/create-core'];
    assert.deepEqual(loaded.filter((p) => forbidden.some((f) => p.startsWith(f))), []);
  });
});
