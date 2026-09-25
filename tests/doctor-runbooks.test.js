// tests/doctor-runbooks.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkRunbookCommands, resolveCommand } = require('../src/service/doctor-runbooks');

const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-doctor-rb-')); temps.push(d); return d; };
const touch = (file, mode = 0o755) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  fs.chmodSync(file, mode);
  return file;
};

// One runbook per call; `steps` are argv arrays.
const runbooks = (name, steps, params = {}) => new Map([[name, { name, params, steps: steps.map((run) => ({ run })) }]]);
const never = () => { throw new Error('spawnSync must not be called here'); };
const linux = (extra = {}) => ({ platform: 'linux', env: { PATH: '' }, cwd: '/', geteuid: () => 1000, spawnSync: never, ...extra });
const failDetails = (rows) => rows.filter((r) => !r.ok).map((r) => r.detail);

describe('resolveCommand', () => {
  it('on win32 finds a bare name in the current directory before PATH', () => {
    const cwd = tmp();
    const pathDir = tmp();
    const planted = touch(path.join(cwd, 'git.exe'));
    touch(path.join(pathDir, 'git.exe'));
    const r = resolveCommand('git', { platform: 'win32', env: { Path: pathDir }, cwd });
    assert.deepEqual(r, { path: planted, via: 'cwd' });
  });

  it('on win32 falls back to PATH, trying .com then .exe', () => {
    const cwd = tmp();
    const pathDir = tmp();
    const exe = touch(path.join(pathDir, 'tool.exe'));
    assert.deepEqual(resolveCommand('tool', { platform: 'win32', env: { PATH: pathDir }, cwd }), { path: exe, via: 'path' });
  });

  it('on win32 reports a .cmd shim that spawn cannot start', () => {
    const cwd = tmp();
    const pathDir = tmp();
    const shim = touch(path.join(pathDir, 'npm.cmd'));
    assert.deepEqual(resolveCommand('npm', { platform: 'win32', env: { PATH: pathDir }, cwd }), { path: null, via: null, cmdShim: shim });
  });

  it('on POSIX looks a bare name up on PATH only', { skip: process.platform === 'win32' ? 'a POSIX PATH cannot hold a drive-letter temp dir' : false }, () => {
    const cwd = tmp();
    const pathDir = tmp();
    touch(path.join(cwd, 'tool'));
    const onPath = touch(path.join(pathDir, 'tool'));
    assert.deepEqual(resolveCommand('tool', { platform: 'linux', env: { PATH: pathDir }, cwd }), { path: onPath, via: 'path' });
  });

  it('marks an absolute program that exists as absolute', () => {
    assert.deepEqual(resolveCommand(process.execPath, { platform: process.platform, env: {}, cwd: '/' }), { path: process.execPath, via: 'absolute' });
  });
});

describe('checkRunbookCommands', () => {
  it('returns one ok row when every program is absolute and present', () => {
    const rows = checkRunbookCommands(runbooks('ok', [[process.execPath, '--version']]), { ...linux(), platform: process.platform });
    assert.deepEqual(rows, [{ check: 'runbook commands present', ok: true, detail: '1 checked' }]);
  });

  it('refuses a program that is a parameter', () => {
    const rows = checkRunbookCommands(runbooks('p', [['{{prog}}', 'x']], { prog: { type: 'string', pattern: '^x$' } }), linux());
    assert.deepEqual(rows, [{ check: 'runbook p step 1', ok: false, detail: 'the program must be fixed, not a parameter' }]);
  });

  it('on win32 fails a bare name and says which planted file would run', () => {
    const cwd = tmp();
    const pathDir = tmp();
    const planted = touch(path.join(cwd, 'git.exe'));
    const rows = checkRunbookCommands(runbooks('b', [['git', 'status']]), { platform: 'win32', env: { PATH: pathDir }, cwd, geteuid: () => -1, spawnSync: never });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].check, 'runbook b step 1');
    assert.equal(rows[0].ok, false);
    assert.equal(
      rows[0].detail,
      `"git" is not an absolute path; Windows looks in the current directory (${cwd}) before PATH, so a planted git.exe would run. Use the full path; resolves to ${planted} via cwd`
    );
  });

  it('on win32 fails a .cmd-only shim twice: bare, and not startable without a shell', () => {
    const cwd = tmp();
    const pathDir = tmp();
    touch(path.join(pathDir, 'npm.cmd'));
    const details = failDetails(checkRunbookCommands(runbooks('n', [['npm', 'ci']]), { platform: 'win32', env: { PATH: pathDir }, cwd, geteuid: () => -1, spawnSync: never }));
    assert.equal(details.length, 2);
    assert.match(details[0], /^"npm" is not an absolute path; Windows looks in the current directory/);
    assert.equal(details[1], 'runbook steps run without a shell and cannot start .cmd/.bat files; call the .exe (npm: node.exe npm-cli.js)');
  });

  it('on win32 fails an absolute .cmd path even when it exists', () => {
    const dir = tmp();
    const shim = touch(path.join(dir, 'build.cmd'));
    const details = failDetails(checkRunbookCommands(runbooks('c', [[shim]]), { platform: 'win32', env: {}, cwd: dir, geteuid: () => -1, spawnSync: never }));
    assert.deepEqual(details, ['runbook steps run without a shell and cannot start .cmd/.bat files; call the .exe (npm: node.exe npm-cli.js)']);
  });

  it('on win32 fails any sudo step', () => {
    const details = failDetails(checkRunbookCommands(runbooks('s', [['/usr/bin/sudo', '-n', '/usr/bin/systemctl', 'restart', 'site.service']]), { platform: 'win32', env: {}, cwd: tmp(), geteuid: () => -1, spawnSync: never }));
    assert.deepEqual(details, ['sudo steps run only on Linux and macOS']);
  });

  it('an absolute program that does not exist is not found, on both OS families', () => {
    const hf = String.raw`C:\KingLouie\tools\py\Scripts\hf.exe`;
    assert.deepEqual(
      failDetails(checkRunbookCommands(runbooks('h', [[hf, 'download']]), { platform: 'win32', env: {}, cwd: tmp(), geteuid: () => -1, spawnSync: never })),
      [`${hf} not found`]
    );
    assert.deepEqual(
      failDetails(checkRunbookCommands(runbooks('h', [['/nonexistent-kl-test/bin/hf', 'download']]), linux())),
      ['/nonexistent-kl-test/bin/hf not found']
    );
  });

  it('on POSIX fails a bare name that is not on PATH', () => {
    const details = failDetails(checkRunbookCommands(runbooks('x', [['kl-no-such-program']]), linux({ env: { PATH: tmp() } })));
    assert.deepEqual(details, ['kl-no-such-program is not on PATH']);
  });

  it('on POSIX fails a relative path with a slash', () => {
    const details = failDetails(checkRunbookCommands(runbooks('r', [['bin/build']]), linux({ cwd: '/opt/king-louie/mcp/work' })));
    assert.deepEqual(details, ['"bin/build" is not an absolute path; it resolves against the current directory (/opt/king-louie/mcp/work). Use the full path']);
  });

  it('fails sudo without -n, and a sudo target that is not absolute', () => {
    const noN = failDetails(checkRunbookCommands(runbooks('s', [['/usr/bin/sudo', '/usr/bin/systemctl', 'restart', 'site.service']]), linux()));
    assert.ok(noN.includes('sudo without -n would wait for a password'), JSON.stringify(noN));
    const relative = failDetails(checkRunbookCommands(runbooks('s', [['/usr/bin/sudo', '-n', 'systemctl', 'restart', 'site.service']]), linux()));
    assert.ok(relative.includes('sudo target must be absolute to match sudoers'), JSON.stringify(relative));
  });

  const noRealSudo = process.platform === 'win32' ? '/usr/bin/sudo does not exist on this filesystem, so resolveCommand reports it not found and the F15 skip-probe guard fires before the mocked spawnSync is reached' : false;

  it('asks sudo -n -l about the exact command, with parameter defaults filled in', { skip: noRealSudo }, () => {
    const calls = [];
    const spawnSync = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: '/usr/bin/systemctl restart site.service\n', stderr: '' }; };
    const rows = checkRunbookCommands(
      runbooks('site.pull_and_restart', [['/usr/bin/sudo', '-n', '/usr/bin/systemctl', 'restart', '{{unit}}']], { unit: { type: 'string', pattern: '^[a-z.]+$', default: 'site.service' } }),
      linux({ spawnSync })
    );
    assert.deepEqual(calls, [{ cmd: '/usr/bin/sudo', args: ['-n', '-l', '/usr/bin/systemctl', 'restart', 'site.service'], opts: { timeout: 5000, encoding: 'utf8' } }]);
    assert.ok(rows.some((r) => r.ok && r.check === 'runbook site.pull_and_restart step 1'
      && r.detail === 'permitted: /usr/bin/sudo -n /usr/bin/systemctl restart site.service'), JSON.stringify(rows));
  });

  it('reports a sudo -l refusal naming the command', { skip: noRealSudo }, () => {
    const spawnSync = () => ({ status: 1, stdout: '', stderr: 'Sorry, user king-louie is not allowed to execute \'/usr/sbin/shutdown -r +1\' as root on web-01.\n' });
    const rows = checkRunbookCommands(runbooks('server.reboot', [['/usr/bin/sudo', '-n', '/usr/sbin/shutdown', '-r', '+1']]), linux({ spawnSync }));
    const row = rows.find((r) => r.check === 'runbook server.reboot step 1' && r.detail.startsWith('not permitted by sudoers'));
    assert.ok(row, JSON.stringify(rows));
    assert.equal(row.ok, false);
    assert.equal(row.detail, 'not permitted by sudoers: Sorry, user king-louie is not allowed to execute \'/usr/sbin/shutdown -r +1\' as root on web-01.');
  });

  it('treats a sudo -l timeout as not permitted', { skip: noRealSudo }, () => {
    const spawnSync = () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync /usr/bin/sudo ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
    const rows = checkRunbookCommands(runbooks('t', [['/usr/bin/sudo', '-n', '/usr/sbin/shutdown', '-r', '+1']]), linux({ spawnSync }));
    assert.ok(rows.some((r) => !r.ok && r.detail === 'not permitted by sudoers: spawnSync /usr/bin/sudo ETIMEDOUT'), JSON.stringify(rows));
  });

  it('does not probe a sudo step whose parameters have no default', { skip: noRealSudo }, () => {
    const rows = checkRunbookCommands(
      runbooks('u', [['/usr/bin/sudo', '-n', '/usr/bin/systemctl', 'restart', '{{unit}}']], { unit: { type: 'string', pattern: '^[a-z.]+$' } }),
      linux()
    );
    assert.ok(rows.some((r) => r.ok && r.detail === 'not checked: uses parameters without defaults'), JSON.stringify(rows));
  });

  it('as root, gives one sudo rules FAIL and probes nothing', () => {
    const rows = checkRunbookCommands(
      runbooks('two', [['/usr/bin/sudo', '-n', '/usr/sbin/shutdown', '-r', '+1'], ['/usr/bin/sudo', '-n', '/usr/bin/systemctl', 'restart', 'site.service']]),
      linux({ geteuid: () => 0 })
    );
    const sudoRows = rows.filter((r) => r.check === 'sudo rules');
    assert.deepEqual(sudoRows, [{ check: 'sudo rules', ok: false, detail: 'run doctor as the service account (sudo -u <account> …)' }]);
  });

  it('checks a repeated argv once and counts unique steps', () => {
    const argv = [process.execPath, '--version'];
    const both = new Map([
      ['a', { name: 'a', params: {}, steps: [{ run: argv }, { check: { http_get: 'http://127.0.0.1:8080/healthz' } }] }],
      ['b', { name: 'b', params: {}, steps: [{ run: argv }, { run: [process.execPath, '-e', '0'] }] }]
    ]);
    const rows = checkRunbookCommands(both, { ...linux(), platform: process.platform });
    assert.deepEqual(rows, [{ check: 'runbook commands present', ok: true, detail: '2 checked' }]);
  });

  it('skips the sudo -l probe when the program is not found (one FAIL row, not two)', () => {
    // linux()'s spawnSync is `never`: if the F15 guard did not skip the probe,
    // calling it on a missing sudo binary would throw here (a real spawnSync
    // would instead throw/return ENOENT, producing a second FAIL row).
    const sudo = '/nonexistent-kl-test/bin/sudo';
    const details = failDetails(checkRunbookCommands(runbooks('m', [[sudo, '-n', '/usr/bin/systemctl', 'restart', 'site.service']]), linux()));
    assert.deepEqual(details, [`${sudo} not found`]);
  });
});
