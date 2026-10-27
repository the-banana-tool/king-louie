// tests/service-stop.test.js
// `king-louie-service stop`: the stop request the service obeys
// (src/service/stop-request.js, runService) and the CLI that writes it
// (src/service/commands/stop.js). No test kills or signals a process it did
// not start: the CLI's process checks, kill, sleep and clock are injected.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  stopRequestPath, readStopRequest, writeStopRequest, clearStaleStopRequest, watchStopRequest
} = require('../src/service/stop-request');
const { runStopCommand, isServiceCommandLine, stopCommandText, stopFirstText } = require('../src/service/commands/stop');
const { runService } = require('../src/service/run');
const { main } = require('../src/service/cli');

const cleanups = [];
after(() => { for (const c of cleanups.reverse()) c(); });

function tmpDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-stop-')));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture() {
  const out = [];
  const err = [];
  return {
    out: () => out.join(''),
    err: () => err.join(''),
    io: { stdout: { write: (t) => { out.push(String(t)); return true; } }, stderr: { write: (t) => { err.push(String(t)); return true; } }, stdin: null }
  };
}

// A fake interval the test fires by hand.
function manualInterval() {
  const timers = [];
  return {
    timers,
    setIntervalImpl: (fn) => { const t = { fn, cleared: false, unref() { this.unrefd = true; } }; timers.push(t); return t; },
    clearIntervalImpl: (t) => { if (t) t.cleared = true; },
    tick: () => { for (const t of timers) if (!t.cleared) t.fn(); }
  };
}

describe('the stop request (service side)', () => {
  it('a request naming this pid calls onStop once and removes the file; the interval is unref\'d', () => {
    const dir = tmpDir();
    const iv = manualInterval();
    let stops = 0;
    const w = watchStopRequest(dir, () => { stops += 1; }, { pid: 4242, ...iv });
    assert.equal(iv.timers[0].unrefd, true);
    iv.tick();
    assert.equal(stops, 0, 'no file, no stop');
    writeStopRequest(dir, 4242);
    assert.equal(readStopRequest(dir).pid, 4242);
    iv.tick();
    assert.equal(stops, 1);
    assert.equal(fs.existsSync(stopRequestPath(dir)), false);
    assert.equal(iv.timers[0].cleared, true);
    writeStopRequest(dir, 4242);
    w.check();
    assert.equal(stops, 1, 'only once');
    w.close();
  });

  it('a request naming another pid is removed and not obeyed; so is one that does not parse, or a directory', () => {
    const dir = tmpDir();
    const iv = manualInterval();
    let stops = 0;
    watchStopRequest(dir, () => { stops += 1; }, { pid: 4242, ...iv });
    writeStopRequest(dir, 999);
    iv.tick();
    assert.equal(fs.existsSync(stopRequestPath(dir)), false);
    fs.writeFileSync(stopRequestPath(dir), 'not json');
    iv.tick();
    assert.equal(fs.existsSync(stopRequestPath(dir)), false);
    fs.mkdirSync(stopRequestPath(dir));
    iv.tick();
    assert.equal(fs.existsSync(stopRequestPath(dir)), false);
    assert.equal(stops, 0);
  });

  it('at start, a stale request (another pid) is removed; one naming this process is kept', () => {
    const dir = tmpDir();
    writeStopRequest(dir, 999);
    assert.equal(clearStaleStopRequest(dir, { pid: 4242 }), true);
    assert.equal(fs.existsSync(stopRequestPath(dir)), false);
    writeStopRequest(dir, 4242);
    assert.equal(clearStaleStopRequest(dir, { pid: 4242 }), false);
    assert.equal(fs.existsSync(stopRequestPath(dir)), true);
    assert.equal(clearStaleStopRequest(tmpDir(), { pid: 4242 }), false, 'no file');
  });
});

describe('runService and the stop request', () => {
  const cwd = process.cwd();
  after(() => process.chdir(cwd));

  // runService with the profile's start replaced: it resolves once stopped.
  async function startService(dataDir, extra = {}) {
    let stopped = 0;
    let ready;
    const readyP = new Promise((r) => { ready = r; });
    const stdout = { write: (t) => { if (String(t).includes('"ready"')) ready(); return true; } };
    const done = runService({
      dataDir,
      profile: 'agent',
      stdout,
      deps: {
        startProfile: async () => ({ masterKeySource: 'test', stop: async () => { stopped += 1; } }),
        stopRequest: { intervalMs: 10 },
        ...extra
      }
    });
    await readyP;
    return { done, stopped: () => stopped };
  }

  it('a stop request naming the service shuts it down the way SIGINT does, and the file and pidfile are gone', async () => {
    const dataDir = tmpDir();
    // A ref'd timer keeps the loop alive while the unref'd watcher waits.
    const keepAlive = setTimeout(() => {}, 20000);
    try {
      const svc = await startService(dataDir);
      process.chdir(cwd);
      assert.equal(fs.readFileSync(path.join(dataDir, 'service.pid'), 'utf8').trim(), String(process.pid));
      writeStopRequest(dataDir, process.pid);
      await svc.done;
      assert.equal(svc.stopped(), 1);
      assert.equal(fs.existsSync(stopRequestPath(dataDir)), false);
      assert.equal(fs.existsSync(path.join(dataDir, 'service.pid')), false);
    } finally {
      clearTimeout(keepAlive);
      process.chdir(cwd);
    }
  });

  it('a stale request found at start is removed, not obeyed', async () => {
    const dataDir = tmpDir();
    fs.mkdirSync(dataDir, { recursive: true });
    writeStopRequest(dataDir, process.pid + 1000000);
    const ac = new AbortController();
    const keepAlive = setTimeout(() => {}, 20000);
    try {
      let stopped = 0;
      let ready;
      const readyP = new Promise((r) => { ready = r; });
      const done = runService({
        dataDir,
        profile: 'agent',
        signal: ac.signal,
        stdout: { write: (t) => { if (String(t).includes('"ready"')) ready(); return true; } },
        deps: { startProfile: async () => ({ stop: async () => { stopped += 1; } }), stopRequest: { intervalMs: 10 } }
      });
      await readyP;
      process.chdir(cwd);
      assert.equal(fs.existsSync(stopRequestPath(dataDir)), false);
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(stopped, 0, 'still running');
      ac.abort();
      await done;
      assert.equal(stopped, 1);
    } finally {
      clearTimeout(keepAlive);
      process.chdir(cwd);
    }
  });
});

describe('isServiceCommandLine', () => {
  it('is the CLI entry with run as its command, and nothing else', () => {
    const yes = [
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a b\\kl\\bin\\king-louie-service.js" run --data-dir "C:\\Users\\a b\\data"',
      'node /opt/kl/bin/king-louie-service.js --data-dir /var/lib/kl run',
      'node bin/king-louie-service.js run --profile agent',
      '/usr/local/bin/king-louie-service run'
    ];
    const no = [
      'node /opt/kl/bin/king-louie-service.js relay run',
      'node /opt/kl/bin/king-louie-service.js status --data-dir run',
      'node /opt/kl/bin/not-king-louie-service.js run',
      'node other.js run',
      'notepad.exe',
      '',
      null
    ];
    for (const c of yes) assert.equal(isServiceCommandLine(c), true, c);
    for (const c of no) assert.equal(isServiceCommandLine(c), false, String(c));
  });
});

describe('king-louie-service stop (CLI)', () => {
  const SERVICE_CMD = 'node C:\\kl\\bin\\king-louie-service.js run --data-dir C:\\d';

  // A fake clock that sleep moves, and a process that exits after `exitAfterMs`.
  function deps(extra = {}) {
    const state = { t: 0, alive: true, written: [], removed: 0, killed: [], ended: 0, exitAfterMs: 1000 };
    const d = {
      platform: 'win32',
      runningServicePid: () => (state.alive ? 4321 : null),
      isRunning: (pid) => pid === 4321 && state.alive,
      commandLine: () => SERVICE_CMD,
      writeStopRequest: (dir, pid) => { state.written.push({ dir, pid, at: state.t }); },
      removeStopRequest: () => { state.removed += 1; },
      kill: (pid) => { state.killed.push(pid); state.alive = false; },
      isPersonal: () => false,
      endTask: () => { state.ended += 1; },
      now: () => state.t,
      sleep: async (ms) => {
        state.t += ms;
        if (state.written.length && state.exitAfterMs !== null && state.t - state.written[0].at >= state.exitAfterMs) state.alive = false;
      },
      ...extra
    };
    return { d, state };
  }

  it('refuses when nothing runs, and writes nothing', async () => {
    const { d, state } = deps();
    state.alive = false;
    const c = capture();
    assert.equal(await runStopCommand({ dataDir: 'C:\\d', io: c.io, deps: d }), 1);
    assert.match(c.err(), /No service is running on C:\\d\./);
    assert.equal(state.written.length, 0);
  });

  it('refuses a pid that is not the service, and one whose command line cannot be read', async () => {
    for (const [cmd, re] of [['notepad.exe', /not a King Louie service; nothing was sent or killed/], [null, /cannot be read from this account; nothing was sent/]]) {
      const { d, state } = deps({ commandLine: () => cmd });
      const c = capture();
      assert.equal(await runStopCommand({ dataDir: 'C:\\d', io: c.io, deps: d }), 1);
      assert.match(c.err(), re);
      assert.equal(state.written.length, 0);
      assert.equal(state.killed.length, 0);
    }
  });

  it('writes the request for the pidfile\'s pid, waits for the pid to go, and only then says stopped', async () => {
    const { d, state } = deps();
    const c = capture();
    assert.equal(await runStopCommand({ dataDir: 'C:\\d', io: c.io, deps: d }), 0);
    assert.deepEqual(state.written.map((w) => [w.dir, w.pid]), [['C:\\d', 4321]]);
    assert.ok(state.t >= 1000, 'waited for the exit');
    assert.match(c.out(), /Asked the service \(pid 4321\) on C:\\d to stop; waiting up to 30 s\./);
    assert.match(c.out(), /Stopped the service on C:\\d\.\n$/);
    assert.equal(state.ended, 0, 'a fleet node has no logon task to end');
  });

  it('a personal node: the logon task is ended after the node exits', async () => {
    const { d, state } = deps({ isPersonal: () => true, endTask: () => { state.ended += 1; assert.equal(state.alive, false, 'ended only after the node exited'); } });
    const c = capture();
    assert.equal(await runStopCommand({ dataDir: 'C:\\d', io: c.io, deps: d }), 0);
    assert.equal(state.ended, 1);
    assert.match(c.out(), /the logon task "KingLouie Node" is ended/);
  });

  it('past --timeout it says so, suggests --force, and kills nothing', async () => {
    const { d, state } = deps();
    state.exitAfterMs = null;
    const c = capture();
    assert.equal(await runStopCommand({ dataDir: 'C:\\d', flags: { timeout: '5' }, io: c.io, deps: d }), 1);
    assert.ok(state.t >= 5000 && state.t < 6000, String(state.t));
    assert.match(c.err(), /still running after 5 s.*pass --force to kill it/);
    assert.equal(state.killed.length, 0);
    assert.equal(state.alive, true);
  });

  it('--force kills the pid at the timeout, after checking it is still the service', async () => {
    const { d, state } = deps();
    state.exitAfterMs = null;
    let checks = 0;
    d.commandLine = () => { checks += 1; return SERVICE_CMD; };
    const c = capture();
    assert.equal(await runStopCommand({ dataDir: 'C:\\d', flags: { timeout: '2', force: true }, io: c.io, deps: d }), 0);
    assert.equal(checks, 2, 'checked again before the kill');
    assert.deepEqual(state.killed, [4321]);
    assert.equal(state.removed, 1, 'the unread request is removed');
    assert.match(c.out(), /Killed the service \(pid 4321\) after 2 s/);
  });

  it('--force never kills a pid that stopped being the service while it waited', async () => {
    for (const change of ['commandLine', 'pidfile']) {
      const { d, state } = deps();
      state.exitAfterMs = null;
      let n = 0;
      if (change === 'commandLine') d.commandLine = () => (n++ === 0 ? SERVICE_CMD : 'notepad.exe');
      else d.runningServicePid = () => (n++ === 0 ? 4321 : 5555);
      const c = capture();
      assert.equal(await runStopCommand({ dataDir: 'C:\\d', flags: { timeout: '1', force: true }, io: c.io, deps: d }), 1);
      assert.deepEqual(state.killed, [], change);
      assert.match(c.err(), /no longer the service on C:\\d; not killing it/);
    }
  });

  it('--timeout must be whole seconds', async () => {
    for (const bad of ['-1', '1.5', 'abc', '99999']) {
      const { d, state } = deps();
      const c = capture();
      assert.equal(await runStopCommand({ dataDir: 'C:\\d', flags: { timeout: bad }, io: c.io, deps: d }), 2, bad);
      assert.equal(state.written.length, 0);
    }
  });

  it('the CLI knows stop, and --timeout/--force only with it', async () => {
    const help = capture();
    await main(['help'], help.io);
    assert.match(help.out(), /king-louie-service stop \[--data-dir DIR\] \[--timeout S\] \[--force\]/);
    for (const argv of [['status', '--force'], ['status', '--timeout', '3']]) {
      const c = capture();
      assert.equal(await main(argv, c.io), 2);
      assert.match(c.err(), /only valid for "stop"/);
    }
    const dir = tmpDir();
    const c = capture();
    assert.equal(await main(['stop', '--data-dir', dir], c.io), 1);
    assert.match(c.err(), /No service is running/);
  });

  it('every "stop it first" refusal names the stop command', () => {
    assert.equal(stopCommandText('C:\\d'), 'king-louie-service stop --data-dir C:\\d');
    assert.equal(stopCommandText('C:\\Users\\a b\\d'), 'king-louie-service stop --data-dir "C:\\Users\\a b\\d"');
    assert.equal(stopFirstText(7, '/d'), 'The service is running (pid 7) on /d. Stop it first (king-louie-service stop --data-dir /d), run this again, then start it.');
  });
});
