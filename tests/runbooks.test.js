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

// The loader checks the runbooks dir itself is admin-owned and not writable
// by others, so it can't be os.tmpdir() (1777 on POSIX): nest a 0700 dir
// inside a fresh temp dir.
function makeRunbooksDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-rb-'));
  const dir = path.join(base, 'runbooks');
  fs.mkdirSync(dir, { mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  return { base, dir };
}

function writeRunbook(dir, fileName, yaml) {
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, yaml, 'utf8');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return file;
}

function engineFor(dir, extra = {}) {
  return new RunbookEngine({ runbooksDir: dir, allowedRoots: [dir], geteuid: () => currentUid, adminUid: currentUid, ...extra });
}

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
    const { base, dir: tmpDir } = makeRunbooksDir();
    try {

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
      fs.rmSync(base, { recursive: true, force: true });
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

  it('gives back a recorded run that never started', () => {
    const engine = new RunbookEngine();
    engine.runbooks.set('limited.run', { name: 'limited.run', rate_limit: { max: 1, per: '1h' } });
    const stamp = engine.recordExecution('limited.run');
    assert.equal(engine.checkRateLimit('limited.run').allowed, false);
    assert.equal(engine.releaseExecution('limited.run', stamp), true);
    assert.equal(engine.checkRateLimit('limited.run').allowed, true);
    assert.equal(engine.releaseExecution('limited.run', stamp), false);
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

describe('integer and substitution hardening', () => {
  it('accepts only real integers or plain decimal digit strings', () => {
    const def = { type: 'integer', min: -100, max: 100 };
    assert.equal(validateParam(def, 42), 42);
    assert.equal(validateParam(def, '42'), 42);
    assert.equal(validateParam(def, '-3'), -3);
    for (const bad of ['', ' ', true, false, '0x10', '1e1', '1.0', 1.5, '+5', [], {}]) {
      assert.throws(() => validateParam(def, bad), /is not an integer/, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  it('validates a default like a supplied value', () => {
    assert.equal(validateParam({ type: 'integer', min: 1, max: 10, default: '7' }, undefined), 7);
    assert.throws(() => validateParam({ type: 'integer', min: 1, max: 10, default: 70 }, undefined), /exceeds maximum/);
  });

  it('substitutes in one pass, so a value cannot pull in another parameter', () => {
    assert.deepEqual(substituteArgv(['{{a}}'], { a: '{{b}}', b: 'INJECT' }), ['{{b}}']);
    assert.deepEqual(substituteArgv(['{{b}}-{{a}}'], { a: '{{b}}', b: 'x' }), ['x-{{b}}']);
    assert.deepEqual(substituteArgv(['{{a}}{{a}}', '{{missing}}'], { a: '1' }), ['11', '{{missing}}']);
  });
});

function runbookYaml({ params = 'params: {}', steps = 'steps:\n  - run: [echo, hi]', extra = '' } = {}) {
  return `name: t.case\ntier: routine\n${params}\n${steps}\n${extra}\n`;
}

describe('runbook load-time validation', () => {
  const cases = [
    ['params that is a list', { params: 'params: [a, b]' }, /"params" must be a mapping/],
    ['a param that is not a mapping', { params: 'params:\n  a: string' }, /param "a" must be a mapping/],
    ['an unknown param type', { params: 'params:\n  a: { type: float }' }, /param "a" has type "float"/],
    ['a param with no type', { params: "params:\n  a: { pattern: '^x$' }" }, /param "a" has type "undefined"/],
    ['a string param without a pattern', { params: 'params:\n  a: { type: string }' }, /needs a "pattern"/],
    ['a string param whose pattern is not a regex', { params: "params:\n  a: { type: string, pattern: '(' }" }, /not a valid regex/],
    ['an integer param without max', { params: 'params:\n  a: { type: integer, min: 1 }' }, /numeric "min" and "max"/],
    ['an integer param without min', { params: 'params:\n  a: { type: integer, max: 1 }' }, /numeric "min" and "max"/],
    ['an integer param with min above max', { params: 'params:\n  a: { type: integer, min: 5, max: 1 }' }, /greater than max/],
    ['an enum with no values', { params: 'params:\n  a: { type: enum, values: [] }' }, /non-empty "values"/],
    ['an enum with no values key', { params: 'params:\n  a: { type: enum }' }, /non-empty "values"/],
    ['a default that fails its own pattern', { params: "params:\n  a: { type: string, pattern: '^[a-z]+$', default: ABC }" }, /default that fails/],
    ['an integer default out of range', { params: 'params:\n  a: { type: integer, min: 1, max: 5, default: 9 }' }, /default that fails/],
    ['an enum default not in values', { params: 'params:\n  a: { type: enum, values: [x, y], default: z }' }, /default that fails/],
    ['no steps', { steps: '' }, /"steps" must be a non-empty list/],
    ['an empty steps list', { steps: 'steps: []' }, /"steps" must be a non-empty list/],
    ['a step with both run and check', { steps: "steps:\n  - run: [echo]\n    check: { http_get: 'http://x/' }" }, /exactly one of "run" or "check"/],
    ['a step with neither run nor check', { steps: 'steps:\n  - shell: echo hi' }, /exactly one of "run" or "check"/],
    ['a run that is not a list', { steps: "steps:\n  - run: 'echo hi'" }, /non-empty argv list/],
    ['an empty run list', { steps: 'steps:\n  - run: []' }, /non-empty argv list/],
    ['an empty command', { steps: "steps:\n  - run: ['', x]" }, /empty command/],
    ['an unquoted version number in argv', { steps: 'steps:\n  - run: [pip, install, pkg==1.10]\n  - run: [echo, 1.10]' }, /step 2 argv\[1\] is 1\.1 .*quote it/],
    ['an unquoted mode in argv', { steps: 'steps:\n  - run: [chmod, 0755, /x]' }, /argv\[1\] is 755 .*quote it/],
    ['a boolean in argv', { steps: 'steps:\n  - run: [echo, true]' }, /argv\[1\] is true .*quote it/],
    ['a placeholder for an undeclared param', { steps: "steps:\n  - run: [echo, 'x{{nope}}']" }, /\{\{nope\}\}, which is not a declared param/],
    ['a placeholder with spaces around the name', { params: "params:\n  ref: { type: string, pattern: '^x$', default: x }", steps: "steps:\n  - run: [echo, '{{ ref }}']" }, /not a declared param/],
    ['a check that is not a mapping', { steps: "steps:\n  - check: 'http://x/'" }, /"check" must be a mapping/],
    ['an unknown check kind', { steps: "steps:\n  - check: { tcp_connect: 'x:22' }" }, /unknown check kind "tcp_connect"/],
    ['a check with no kind', { steps: 'steps:\n  - check: { retries: 2 }' }, /exactly one kind/],
    ['a non-http check URL', { steps: "steps:\n  - check: { http_get: 'file:///etc/passwd' }" }, /http:\/\/ or https:\/\//],
    ['a string expect_status', { steps: "steps:\n  - check: { http_get: 'http://x/', expect_status: '200' }" }, /expect_status must be an integer/],
    ['zero retries', { steps: "steps:\n  - check: { http_get: 'http://x/', retries: 0 }" }, /retries must be a positive integer/],
    ['a zero timeout', { extra: 'timeout_s: 0' }, /timeout_s must be a positive integer/],
    ['a fractional timeout', { extra: 'timeout_s: 1.5' }, /timeout_s must be a positive integer/],
    ['a string timeout', { extra: "timeout_s: '60'" }, /timeout_s must be a positive integer/],
    ['a rate_limit period with an unknown unit', { extra: 'rate_limit: { max: 2, per: 1w }' }, /rate_limit\.per is "1w"/],
    ['a rate_limit period with no unit', { extra: 'rate_limit: { max: 2, per: 60 }' }, /rate_limit\.per is 60/],
    ['a zero rate_limit period', { extra: 'rate_limit: { max: 2, per: 0h }' }, /rate_limit\.per/],
    ['a zero rate_limit max', { extra: 'rate_limit: { max: 0, per: 1h }' }, /rate_limit\.max must be a positive integer/],
    ['a rate_limit that is not a mapping', { extra: 'rate_limit: 5' }, /rate_limit must be a mapping/]
  ];

  for (const [label, parts, expected] of cases) {
    it(`rejects ${label}`, () => {
      const { base, dir } = makeRunbooksDir();
      try {
        const file = writeRunbook(dir, 'case.yaml', runbookYaml(parts));
        const engine = engineFor(dir);
        assert.throws(() => engine.loadRunbooks(), (err) => {
          assert.ok(err.message.startsWith(`Invalid runbook in ${file}: `), err.message);
          assert.match(err.message, expected);
          return true;
        });
        assert.equal(engine.runbooks.size, 0);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });
  }

  it('rejects malformed YAML and names the file', () => {
    const { base, dir } = makeRunbooksDir();
    try {
      const file = writeRunbook(dir, 'bad.yaml', 'name: t\nsteps: [\n');
      assert.throws(() => engineFor(dir).loadRunbooks(), (err) => err.message.startsWith(`Invalid runbook in ${file}: `));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects two files that declare the same runbook name, and keeps none of them', () => {
    const { base, dir } = makeRunbooksDir();
    try {
      writeRunbook(dir, 'a.yaml', runbookYaml());
      writeRunbook(dir, 'b.yaml', runbookYaml());
      const engine = engineFor(dir);
      assert.throws(() => engine.loadRunbooks(), /name "t\.case" is already used by/);
      assert.equal(engine.runbooks.size, 0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('loads the §5.4 examples (with the reboot delay quoted) and a day-long rate limit', () => {
    const { base, dir } = makeRunbooksDir();
    try {
      writeRunbook(dir, 'site.yaml', `
name: site.pull_and_restart
description: Fetch the given ref, fast-forward, rebuild, restart the site.
tier: unsafe
params:
  ref:
    type: string
    pattern: '^[A-Za-z0-9._/-]{1,64}$'
    default: main
  workers:
    type: integer
    min: 1
    max: 8
    default: 2
  env:
    type: enum
    values: [dev, prod]
  force:
    type: boolean
    default: false
steps:
  - run: [git, -C, /srv/site, fetch, --prune, origin]
  - run: [git, -C, /srv/site, checkout, --detach, 'origin/{{ref}}']
  - run: [/srv/site/bin/build, '--workers={{workers}}', '{{env}}']
  - check: { http_get: 'https://www.example.com/healthz', expect_status: 200, retries: 5 }
timeout_s: 600
rate_limit: { max: 6, per: 1d }
`);
      writeRunbook(dir, 'reboot.yaml', `
name: server.reboot
description: Reboot this machine.
tier: unsafe
params: {}
steps:
  - run: [sudo, -n, /sbin/shutdown, -r, '+1', 'king-louie: remote reboot']
`);
      const engine = engineFor(dir);
      engine.loadRunbooks();
      const site = engine.getRunbook('site.pull_and_restart');
      assert.equal(site.timeout_s, 600);
      assert.deepEqual(site.rate_limit, { max: 6, per: '1d' });
      assert.equal(engine.getRunbook('server.reboot').timeout_s, 300);

      // 1d means a day: after six runs the wait is close to 24 hours.
      for (let i = 0; i < 6; i++) engine.recordExecution('site.pull_and_restart');
      const rc = engine.checkRateLimit('site.pull_and_restart');
      assert.equal(rc.allowed, false);
      assert.ok(rc.retryAfterSeconds > 23 * 3600 && rc.retryAfterSeconds <= 24 * 3600, String(rc.retryAfterSeconds));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('refuses the unquoted +1 from a reboot argv, since YAML reads it as the number 1', () => {
    const { base, dir } = makeRunbooksDir();
    try {
      writeRunbook(dir, 'reboot.yaml', "name: server.reboot\nsteps:\n  - run: [sudo, -n, /sbin/shutdown, -r, +1, 'bye']\n");
      assert.throws(() => engineFor(dir).loadRunbooks(), /argv\[4\] is 1 .*quote it/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('runbook error contract', () => {
  function engineWith(runbook) {
    const engine = new RunbookEngine({ evidenceLedger: { record() {} } });
    engine.runbooks.set(runbook.name, runbook);
    return engine;
  }

  it('reports an unknown runbook as runbook_not_found', async () => {
    const engine = new RunbookEngine();
    assert.throws(() => engine.validateParameters('nope'), (err) => err.code === 'runbook_not_found');
    await assert.rejects(engine.executeRunbook('nope'), (err) => err.code === 'runbook_not_found' && /nope/.test(err.message));
  });

  it('reports bad parameters as invalid_params naming the parameter, and runs nothing', async () => {
    const engine = engineWith({
      name: 'p.check',
      params: { count: { type: 'integer', min: 1, max: 5 } },
      steps: [{ run: [process.execPath, '-e', 'process.exit(3)'] }]
    });
    for (const params of [{}, { count: '0x10' }, { count: 9 }, 'not-an-object']) {
      await assert.rejects(engine.executeRunbook('p.check', params), (err) => {
        assert.equal(err.code, 'invalid_params');
        if (typeof params === 'object') assert.match(err.message, /Parameter "count"/);
        return true;
      });
    }
    assert.equal((engine.executionHistory.get('p.check') || []).length, 0);
  });

  it('reports a rate limit as rate_limited with an integer retryAfterSeconds', async () => {
    const engine = engineWith({
      name: 'limited',
      params: {},
      steps: [{ run: [process.execPath, '-e', ''] }],
      rate_limit: { max: 1, per: '10m' }
    });
    assert.equal((await engine.executeRunbook('limited')).success, true);
    const rc = engine.checkRateLimit('limited');
    assert.equal(rc.allowed, false);
    assert.equal(rc.retryAfters, undefined);
    assert.ok(Number.isInteger(rc.retryAfterSeconds) && rc.retryAfterSeconds > 0 && rc.retryAfterSeconds <= 600);
    await assert.rejects(engine.executeRunbook('limited'), (err) => {
      assert.equal(err.code, 'rate_limited');
      assert.ok(Number.isInteger(err.retryAfterSeconds) && err.retryAfterSeconds > 0);
      return true;
    });
  });

  it('neither checks nor records the rate limit for a run the caller already admitted', async () => {
    const engine = engineWith({
      name: 'limited',
      params: {},
      steps: [{ run: [process.execPath, '-e', ''] }],
      rate_limit: { max: 1, per: '10m' }
    });
    engine.recordExecution('limited');
    assert.equal((await engine.executeRunbook('limited', {}, { admitted: true })).success, true);
    assert.equal(engine.executionHistory.get('limited').length, 1);
    // Without the option, the same call is refused as before.
    await assert.rejects(engine.executeRunbook('limited'), (err) => err.code === 'rate_limited');
  });

  it('refuses a rate limit it cannot parse instead of guessing an hour', () => {
    const engine = engineWith({ name: 'odd', params: {}, steps: [], rate_limit: { max: 1, per: 'fortnight' } });
    assert.throws(() => engine.checkRateLimit('odd'), /invalid rate_limit/);
  });

  it('throws on a step that is neither run nor check instead of skipping it', async () => {
    const engine = engineWith({ name: 'odd.step', params: {}, steps: [{ shell: 'echo hi' }] });
    await assert.rejects(engine.executeRunbook('odd.step'), /neither "run" nor "check"/);
  });
});

describe('check steps', () => {
  it('fails an unknown check kind and records it as failed evidence', async () => {
    const recorded = [];
    const engine = new RunbookEngine({ evidenceLedger: { record: (_cwd, e) => recorded.push(e) } });
    assert.equal((await engine.executeCheckStep({ tcp_connect: 'x:22' })).success, false);
    assert.equal((await engine.executeCheckStep({})).success, false);

    engine.runbooks.set('odd.check', { name: 'odd.check', params: {}, steps: [{ check: { tcp_connect: 'x:22' } }] });
    const result = await engine.executeRunbook('odd.check');
    assert.equal(result.success, false);
    assert.deepEqual(recorded.map((e) => e.status), ['failed']);
  });

  it('fails an http_get whose URL is not http(s)', async () => {
    const engine = new RunbookEngine();
    for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'not a url', 42]) {
      assert.equal((await engine.executeCheckStep({ http_get: url })).success, false, String(url));
    }
  });

  it('passes on the expected status and fails on another', async () => {
    const http = require('http');
    const server = http.createServer((req, res) => {
      res.statusCode = req.url === '/ok' ? 200 : 503;
      res.end('x'.repeat(100000));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address();
      const engine = new RunbookEngine();
      assert.equal((await engine.executeCheckStep({ http_get: `http://127.0.0.1:${port}/ok` })).success, true);
      assert.equal((await engine.executeCheckStep({ http_get: `http://127.0.0.1:${port}/down` })).success, false);
      assert.equal((await engine.executeCheckStep({ http_get: `http://127.0.0.1:${port}/down`, expect_status: 503 })).success, true);
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function waitUntilDead(pid, ms = 3000) {
  const end = Date.now() + ms;
  while (isAlive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return !isAlive(pid);
}

function pidFromLogs(logs) {
  const line = logs.find((l) => /^PID \d+$/.test(l));
  return line ? Number(line.slice(4)) : null;
}

describe('stopping steps', () => {
  // Prints its pid, then idles for a minute.
  const LONG_STEP = [process.execPath, '-e', 'console.log("PID " + process.pid); setTimeout(() => {}, 60000)'];

  it('kills the running step and returns cancelled when the signal aborts', async () => {
    const engine = new RunbookEngine({ evidenceLedger: { record() {} } });
    engine.runbooks.set('long', { name: 'long', params: {}, steps: [{ run: LONG_STEP }, { run: [process.execPath, '-e', 'console.log("SECOND")'] }] });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 500);
    const result = await engine.executeRunbook('long', {}, { signal: controller.signal });
    assert.equal(result.success, false);
    assert.equal(result.error, 'cancelled');
    assert.ok(Array.isArray(result.logs));
    assert.ok(Date.now() - started < 10000);
    assert.ok(!result.logs.some((l) => l.includes('SECOND')), 'no later step runs');
    const pid = pidFromLogs(result.logs);
    assert.ok(pid, `pid in logs: ${JSON.stringify(result.logs)}`);
    assert.equal(await waitUntilDead(pid), true);
  });

  it('runs nothing when the signal is already aborted', async () => {
    const engine = new RunbookEngine();
    engine.runbooks.set('long', { name: 'long', params: {}, steps: [{ run: LONG_STEP }] });
    const result = await engine.executeRunbook('long', {}, { signal: AbortSignal.abort() });
    assert.deepEqual(result, { success: false, error: 'cancelled', logs: [] });
  });

  it('escalates a timed-out step that ignores SIGTERM to SIGKILL and waits for it to exit', async () => {
    const engine = new RunbookEngine({ killGraceMs: 300 });
    engine.runbooks.set('stubborn', {
      name: 'stubborn',
      params: {},
      timeout_s: 1,
      steps: [{ run: [process.execPath, '-e', 'process.on("SIGTERM", () => {}); console.log("PID " + process.pid); setInterval(() => {}, 1000)'] }]
    });
    const result = await engine.executeRunbook('stubborn');
    assert.equal(result.success, false);
    assert.equal(result.stepIndex, 0);
    assert.match(result.error, /Step 1 timed out after 1s/);
    const pid = pidFromLogs(result.logs);
    assert.ok(pid, `pid in logs: ${JSON.stringify(result.logs)}`);
    // Settled only after exit, so the process should already be gone.
    assert.equal(await waitUntilDead(pid, 500), true);
  });

  it('caps captured output per stream and says so in the logs', async () => {
    const engine = new RunbookEngine({ maxOutputBytes: 1000 });
    engine.runbooks.set('chatty', {
      name: 'chatty',
      params: {},
      steps: [{ run: [process.execPath, '-e', 'process.stdout.write("x".repeat(200000)); process.stderr.write("short")'] }]
    });
    const result = await engine.executeRunbook('chatty');
    assert.equal(result.success, true);
    const out = result.logs.find((l) => /^x+$/.test(l));
    assert.equal(out.length, 1000);
    assert.ok(result.logs.includes('[step 1 stdout truncated after 1000 bytes]'));
    assert.ok(result.logs.includes('short'));
    assert.ok(!result.logs.some((l) => l.includes('stderr truncated')));
  });

  it('reports a failing step with its exit status', async () => {
    const engine = new RunbookEngine();
    engine.runbooks.set('fails', { name: 'fails', params: {}, steps: [{ run: [process.execPath, '-e', 'process.exit(3)'] }] });
    const result = await engine.executeRunbook('fails');
    assert.deepEqual({ success: result.success, error: result.error, stepIndex: result.stepIndex }, { success: false, error: 'Step 1 exited with status 3', stepIndex: 0 });
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
