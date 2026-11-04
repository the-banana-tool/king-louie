// tests/service-cli-install-personal.test.js
// `install --personal` / `uninstall --personal` (personal node spec §8). No
// test runs a real schtasks, whoami or reg, touches the real %LOCALAPPDATA%
// or runs elevated: everything is injected, and the data dir is a temp dir.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runPersonalInstall, renderPersonalTaskXml, PERSONAL_TASK_NAME, renderServiceCli } = require('../src/service/personal-install');
const { loadNodeConfig } = require('../src/service/node-config');
const { main } = require('../src/service/cli');

const cleanups = [];
after(() => { for (const c of cleanups) c(); });

const SID = 'S-1-5-21-1-2-3-1001';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;

function setup() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-personal-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const localAppData = path.join(base, 'LocalAppData');
  const dataDir = path.join(localAppData, 'KingLouie', 'node', 'data');
  const configDir = path.join(localAppData, 'KingLouie', 'node', 'config');
  return { base, localAppData, dataDir, configDir, yamlPath: path.join(configDir, 'node.yaml') };
}

function io() {
  const out = [];
  const err = [];
  return {
    out, err,
    text: () => out.join(''),
    errors: () => err.join(''),
    io: { stdout: { write: (t) => { out.push(String(t)); return true; } }, stderr: { write: (t) => { err.push(String(t)); return true; } }, stdin: null }
  };
}

function deps(s, extra = {}) {
  const executed = [];
  return {
    executed,
    platform: 'win32',
    env: { LOCALAPPDATA: s.localAppData, SystemRoot: 'C:\\Windows', PATH: '' },
    isAdmin: () => false,
    isTTY: () => true,
    confirm: async () => true,
    whoAmI: () => ({ user: 'laptop\\owner', sid: SID }),
    findChrome: () => CHROME,
    findFfmpeg: () => 'C:\\ffmpeg\\bin\\ffmpeg.exe',
    fleetInstalled: () => ({ task: false, marker: null }),
    taskRegistered: () => true,
    taskDataDir: () => null,
    // Only the temp tree exists, never the machine's real ProgramData.
    exists: (p) => p.startsWith(s.base) && fs.existsSync(p),
    hostname: () => 'laptop',
    tmpDir: s.base,
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    entryPath: 'C:\\kl\\bin\\king-louie-service.js',
    execute: async (steps) => { executed.push(steps); },
    runningServicePid: () => null,
    stopNode: async () => { throw new Error('stopNode called with no node running'); },
    ...extra
  };
}

const run = (command, s, d, flags = {}, t = io()) => runPersonalInstall({ command, flags: { dataDir: s.dataDir, ...flags }, io: t.io, deps: d }).then((code) => ({ code, t }));
const argvs = (d) => d.executed.flat().filter((step) => step.run).map((step) => step.run);

// Attach stage 2 §6.4 (C-6): no Chrome is no reason to refuse; a node whose
// client is the window needs neither a browser nor a relay.
describe('install --personal: with no Chrome', () => {
  const NO_CHROME = { findChrome: () => null };

  it('writes gui enabled: false and no apps, prints the one line, and goes on', async () => {
    const s = setup();
    const d = deps(s, NO_CHROME);
    const { code, t } = await run('install', s, d);
    assert.equal(code, 0, t.errors());
    const yaml = fs.readFileSync(s.yamlPath, 'utf8');
    assert.match(yaml, /^gui:\n {2}enabled: false\n$/m);
    assert.doesNotMatch(yaml, /apps|take|browser/);
    const lines = t.text().split('\n').filter((l) => l.includes('no chrome.exe found'));
    assert.deepEqual(lines, ['no chrome.exe found: takes and desktop apps are off; add gui.apps.chrome and gui.browser to node.yaml to turn them on']);
    assert.doesNotMatch(t.text(), /ffmpeg is not on PATH/, 'nothing to record without a browser');
    assert.ok(argvs(d).some((a) => a.includes('/Create')));
    const config = loadNodeConfig({ adminConfigDir: s.configDir, adminUid: UID });
    assert.equal(config.hosting, 'personal');
    assert.equal(config.gui.enabled, false);
  });

  it('--browser still writes the full block, with or without one found', async () => {
    const s = setup();
    const { code } = await run('install', s, deps(s, NO_CHROME), { browser: CHROME });
    assert.equal(code, 0);
    const yaml = fs.readFileSync(s.yamlPath, 'utf8');
    assert.match(yaml, /enabled: true/);
    assert.match(yaml, /browser: chrome/);
  });

  it('a second install over that file has nothing to add', async () => {
    const s = setup();
    await run('install', s, deps(s, NO_CHROME));
    const { t } = await run('install', s, deps(s, NO_CHROME));
    assert.match(t.text(), /it has every line install would write/);
  });

  it('a file with gui off does not nag for the browser lines when a Chrome is found, and does with --browser', async () => {
    const s = setup();
    await run('install', s, deps(s, NO_CHROME));
    const found = await run('install', s, deps(s));
    assert.match(found.t.text(), /it has every line install would write/);
    const asked = await run('install', s, deps(s), { browser: CHROME });
    assert.match(asked.t.text(), /it lacks these lines[\s\S]*gui\.apps\.chrome/);
  });

  it('a kept node.yaml that names its own browser is not told takes are off, or to turn gui off', async () => {
    const s = setup();
    await run('install', s, deps(s));
    const { t } = await run('install', s, deps(s, NO_CHROME));
    assert.doesNotMatch(t.text(), /no chrome\.exe found/);
    assert.match(t.text(), /it has every line install would write/);
    assert.doesNotMatch(t.text(), /gui\.enabled: false/);
  });
});

// §6.4: a node whose client is the window runs on the bridge alone.
describe('install --personal: startable with the desktop bridge on', () => {
  const noStartableDep = (s, extra) => { const d = deps(s, { findChrome: () => null, ...extra }); delete d.startable; return d; };
  const prepare = async (s) => { await run('install', s, noStartableDep(s)); };
  const STARTED = (d) => argvs(d).some((a) => a.includes('/Run'));

  it('service.json with features.desktopBridge true and no relay starts the task', async () => {
    const s = setup();
    await prepare(s);
    fs.writeFileSync(path.join(s.configDir, 'service.json'), JSON.stringify({ features: { desktopBridge: true } }));
    const d = noStartableDep(s);
    const { code, t } = await run('install', s, d);
    assert.equal(code, 0, t.errors());
    assert.ok(STARTED(d), t.text());
    assert.match(t.text(), /is registered and started/);
  });

  it('neither a relay nor the bridge: not started, with the same reason as before', async () => {
    for (const body of [null, { features: { desktopBridge: false } }, { features: {} }]) {
      const s = setup();
      await prepare(s);
      if (body) fs.writeFileSync(path.join(s.configDir, 'service.json'), JSON.stringify(body));
      const d = noStartableDep(s);
      const { t } = await run('install', s, d);
      assert.equal(STARTED(d), false);
      assert.match(t.text(), /has no approvers\.relay and there is no front-door\.json yet/);
    }
  });

  it('startable reads the install\'s own data dir, not a sibling called data', async () => {
    const s = setup();
    const dataDir = path.join(path.dirname(s.dataDir), 'mine');
    const flags = { dataDir };
    await run('install', s, noStartableDep(s), flags);
    fs.writeFileSync(path.join(s.configDir, 'service.json'), JSON.stringify({ features: { desktopBridge: true } }));
    // A broken file beside the wrong path says nothing; beside the right one it does.
    fs.mkdirSync(s.dataDir, { recursive: true });
    fs.writeFileSync(path.join(s.dataDir, 'service.json'), '{ not json');
    const ok = noStartableDep(s);
    await run('install', s, ok, flags);
    assert.ok(STARTED(ok));
    fs.writeFileSync(path.join(dataDir, 'service.json'), '{ not json');
    const bad = noStartableDep(s);
    const { t } = await run('install', s, bad, flags);
    assert.equal(STARTED(bad), false);
    assert.match(t.text(), /service\.json does not load/);
  });

  it('a service.json that does not load is not startable, with why', async () => {
    const s = setup();
    await prepare(s);
    fs.writeFileSync(path.join(s.configDir, 'service.json'), JSON.stringify({ features: { desktopBridge: true, nonsense: true } }));
    const d = noStartableDep(s);
    const { t } = await run('install', s, d);
    assert.equal(STARTED(d), false);
    assert.match(t.text(), /service\.json does not load/);
  });
});

describe('install --personal: refusals', () => {
  it('refuses elevated, off Windows, and with a fleet node installed', async () => {
    const cases = [
      [{ isAdmin: () => true }, /install --personal runs as you, not elevated: open a normal prompt/],
      [{ platform: 'linux' }, /install --personal is Windows-only for now/],
      [{ fleetInstalled: () => ({ task: true, marker: null }) }, /a fleet node is installed on this machine \(the KingLouie scheduled task\); run uninstall \/ session uninstall first/],
      [{ fleetInstalled: () => ({ task: true, marker: 'C:\\ProgramData\\KingLouie\\config\\node.yaml' }) }, /a fleet node is installed on this machine \(the KingLouie scheduled task; C:\\ProgramData\\KingLouie\\config\\node\.yaml exists\); run uninstall \/ session uninstall first/],
      // A marker file alone: named, and removed by hand (the uninstalls would not remove it).
      [{ fleetInstalled: () => ({ task: false, marker: 'C:\\ProgramData\\KingLouie\\config\\service.json' }) }, /^a fleet node's file is on this machine \(C:\\ProgramData\\KingLouie\\config\\service\.json\) with no KingLouie task: if no fleet node is meant to run here, remove that file by hand, then run this again$/m]
    ];
    for (const [extra, message] of cases) {
      const s = setup();
      const d = deps(s, extra);
      const { code, t } = await run('install', s, d);
      assert.equal(code, 2, t.errors());
      assert.match(t.errors(), message);
      assert.equal(t.errors().trim().split('\n').length, 1, 'one line on stderr');
      assert.equal(d.executed.length, 0);
      assert.equal(fs.existsSync(s.configDir), false, 'nothing written');
    }
  });

  it('a --browser that is not an absolute .exe is refused before anything is written', async () => {
    const s = setup();
    const d = deps(s);
    const { code, t } = await run('install', s, d, { browser: 'chrome' });
    assert.equal(code, 2);
    assert.match(t.errors(), /--browser/);
    assert.equal(d.executed.length, 0);
    assert.equal(fs.existsSync(s.configDir), false);
  });

  it('no data dir (LOCALAPPDATA unset and no --data-dir) is refused', async () => {
    const s = setup();
    const d = deps(s);
    const { code, t } = await run('install', s, d, { dataDir: null });
    assert.equal(code, 2);
    assert.match(t.errors(), /--data-dir/);
    assert.equal(d.executed.length, 0);
  });

  it('off a TTY without --yes: exit 2 before anything is read', async () => {
    const s = setup();
    const boom = () => { throw new Error('read'); };
    const d = deps(s, { isTTY: () => false, isAdmin: boom, whoAmI: boom, findChrome: boom, fleetInstalled: boom, findFfmpeg: boom, confirm: boom });
    const { code, t } = await run('install', s, d);
    assert.equal(code, 2);
    assert.match(t.errors(), /--yes/);
    assert.equal(d.executed.length, 0);
    assert.equal(fs.existsSync(s.configDir), false);
  });

  it('a "no" at the question writes nothing', async () => {
    const s = setup();
    const d = deps(s, { confirm: async () => false });
    const { code, t } = await run('install', s, d);
    assert.equal(code, 1);
    assert.match(t.errors(), /Nothing was written/);
    assert.equal(d.executed.length, 0);
    assert.equal(fs.existsSync(s.configDir), false);
  });
});

describe('install --personal', () => {
  it('dry run prints the consent text and the node.yaml and writes nothing', async () => {
    const s = setup();
    const d = deps(s, { isTTY: () => false, confirm: async () => { throw new Error('asked'); } });
    const { code, t } = await run('install', s, d, { dryRun: true });
    assert.equal(code, 0, t.errors());
    const out = t.text();
    const order = [`laptop\\owner (${SID})`, s.dataDir, s.configDir, PERSONAL_TASK_NAME,
      'the service will run as this account; the owner account is the trust boundary: anything running as you can drive it as a local mcp client and change its approver set, and a shell the phone approves can do anything you can',
      s.yamlPath];
    let at = -1;
    for (const piece of order) {
      const next = out.indexOf(piece, at + 1);
      assert.ok(next > at, `"${piece}" in order in:\n${out}`);
      at = next;
    }
    assert.match(out, /^hosting: personal$/m);
    assert.match(out, /\[dry-run\] .*\/Create/);
    assert.equal(d.executed.length, 0);
    assert.equal(fs.existsSync(s.dataDir), false);
    assert.equal(fs.existsSync(s.configDir), false);
  });

  it('first run: writes node.yaml and the config dir, registers the task, does not start it (no relay yet), prints the five remaining steps', async () => {
    const s = setup();
    const d = deps(s);
    const { code, t } = await run('install', s, d);
    assert.equal(code, 0, t.errors());
    assert.ok(fs.statSync(s.dataDir).isDirectory());
    const yaml = fs.readFileSync(s.yamlPath, 'utf8');
    assert.equal(yaml, [
      "name: 'laptop'",
      'profile: agent',
      'hosting: personal',
      'gui:',
      '  enabled: true',
      '  apps:',
      `    chrome: '${CHROME}'`,
      '  take:',
      '    enabled: true',
      '    max_minutes: 240',
      '  browser: chrome',
      ''
    ].join('\n'));
    assert.ok(d.executed.flat().some((step) => step.run && step.run.includes('/Create') && step.run.includes(PERSONAL_TASK_NAME) && step.run.includes('/F')));
    const xml = d.executed.flat().find((step) => step.writeFile);
    assert.match(xml.writeFile.content, /<UserId>S-1-5-21-1-2-3-1001<\/UserId>/);
    assert.ok(!argvs(d).some((argv) => argv.includes('/Run')));
    const out = t.text();
    assert.match(out, /not started/);
    const left = ['token set <provider>', 'pair wss://<relay>', 'enroll-device', 'vault set browser_cred:<profile>:<host>', 'king-louie-service mcp'];
    let at = out.indexOf('What is left');
    assert.ok(at >= 0, out);
    for (const piece of left) {
      const next = out.indexOf(piece, at + 1);
      assert.ok(next > at, `"${piece}" in order in:\n${out}`);
      at = next;
    }
    if (process.platform === 'win32') assert.doesNotMatch(out, /--data-dir/, 'the default data dir is what the CLI picks, so no flag');
    assert.doesNotMatch(out, /may be removed/, 'no leftover fleet data dir here');
  });

  it('a leftover fleet data dir (no fleet node.yaml) is a warning, not a refusal, and the steps still need no --data-dir', async () => {
    const s = setup();
    const fleetData = 'C:\\ProgramData\\KingLouie\\data';
    const d = deps(s, { exists: (p) => p === fleetData || (p.startsWith(s.base) && fs.existsSync(p)) });
    const { code, t } = await run('install', s, d);
    assert.equal(code, 0, t.errors());
    const out = t.text();
    assert.ok(out.includes(`${fleetData} exists but no fleet config file is beside it: every command ignores it, and it may be removed.`), out);
    if (process.platform === 'win32') assert.doesNotMatch(out, /--data-dir/);
  });

  it('a data dir other than the default is spelled out in the remaining steps', async () => {
    const s = setup();
    const d = deps(s);
    const other = path.join(s.base, 'elsewhere', 'data');
    const { code, t } = await run('install', s, d, { dataDir: other });
    assert.equal(code, 0, t.errors());
    assert.ok(t.text().includes(`pair wss://<relay> --data-dir "${other}"`), t.text());
  });

  it('a kept node.yaml with a relay but not hosting: personal, or one that does not load, is registered and not started, with why', async () => {
    const cases = [
      ['name: laptop\nprofile: agent\napprovers:\n  relay: wss://relay.example.com:8443\n', /not started: node\.yaml lacks hosting: personal\./],
      ['name: laptop\nprofile: agent\nhosting: personal\n', /not started: node\.yaml has no approvers\.relay and there is no front-door\.json yet: pair \(wss:\/\/<relay> or https:\/\/mcp\.<domain>\)/],
      ['name: laptop\nprofile: agent\nhosting: personal\nbogus_key: 1\napprovers:\n  relay: wss://relay.example.com:8443\n', /not started: node\.yaml does not load \(/]
    ];
    for (const [yaml, why] of cases) {
      const s = setup();
      fs.mkdirSync(s.configDir, { recursive: true });
      fs.writeFileSync(s.yamlPath, yaml);
      const d = deps(s);
      const { code, t } = await run('install', s, d);
      assert.equal(code, 0, t.errors());
      assert.ok(!argvs(d).some((argv) => argv.includes('/Run')), yaml);
      assert.match(t.text(), why);
    }
  });

  it('a kept personal node.yaml with a front-door.json beside it (no approvers.relay) is started', async () => {
    const s = setup();
    fs.mkdirSync(s.configDir, { recursive: true });
    fs.writeFileSync(s.yamlPath, 'name: laptop\nprofile: agent\nhosting: personal\n');
    fs.writeFileSync(path.join(s.configDir, 'front-door.json'), '{}\n');
    const d = deps(s);
    const { code, t } = await run('install', s, d);
    assert.equal(code, 0, t.errors());
    assert.ok(argvs(d).some((argv) => argv.includes('/Run')), t.text());
    assert.doesNotMatch(t.text(), /not started/);
  });

  it('a front-door.json that is not a regular file is not startable, with why', async () => {
    const s = setup();
    fs.mkdirSync(path.join(s.configDir, 'front-door.json'), { recursive: true });
    fs.writeFileSync(s.yamlPath, 'name: laptop\nprofile: agent\nhosting: personal\n');
    const d = deps(s);
    const { code, t } = await run('install', s, d);
    assert.equal(code, 0, t.errors());
    assert.ok(!argvs(d).some((argv) => argv.includes('/Run')));
    assert.match(t.text(), /not started: front-door\.json is not a regular file/);
  });

  // (Off Windows the win32 default data dir never equals a temp POSIX path, so the steps carry --data-dir.)
  it('the remaining steps name both pair forms', { skip: process.platform !== 'win32' && 'the default data dir is a win32 path' }, async () => {
    const s = setup();
    const { code, t } = await run('install', s, deps(s));
    assert.equal(code, 0, t.errors());
    assert.ok(t.text().includes('pair wss://<relay>   or   pair https://mcp.<domain>   (a relay or a front door: writes the pin and starts the node)'), t.text());
  });

  it('a numeric --model and a numeric hostname load back as strings', { skip: process.platform !== 'win32' && 'gui.apps paths are checked for the running platform' }, async () => {
    const s = setup();
    const d = deps(s, { hostname: () => '12345' });
    const { code, t } = await run('install', s, d, { provider: 'anthropic', model: '123' });
    assert.equal(code, 0, t.errors());
    const yaml = fs.readFileSync(s.yamlPath, 'utf8');
    assert.match(yaml, /^name: '12345'$/m);
    assert.match(yaml, /^ {2}model: '123'$/m);
    const config = loadNodeConfig({ adminConfigDir: s.configDir, geteuid: () => UID, adminUid: UID });
    assert.equal(config.name, '12345');
    assert.equal(config.delegate.model, '123');
  });

  it('the node.yaml it writes loads through loadNodeConfig', { skip: process.platform !== 'win32' && 'gui.apps paths are checked for the running platform' }, async () => {
    const s = setup();
    const d = deps(s);
    const { code, t } = await run('install', s, d, { provider: 'anthropic', model: 'claude-opus-5-5' });
    assert.equal(code, 0, t.errors());
    const config = loadNodeConfig({ adminConfigDir: s.configDir, geteuid: () => UID, adminUid: UID });
    assert.equal(config.hosting, 'personal');
    assert.equal(config.profile, 'agent');
    assert.equal(config.gui.enabled, true);
    assert.equal(config.gui.browser, 'chrome');
    assert.equal(config.gui.apps.chrome.path, CHROME);
    assert.equal(config.delegate.provider, 'anthropic');
    assert.equal(config.delegate.model, 'claude-opus-5-5');
  });

  it('Review Focus 3: a second run keeps node.yaml, prints the lines it lacks, re-registers with /F, exit 0', async () => {
    const s = setup();
    fs.mkdirSync(s.configDir, { recursive: true });
    const mine = 'name: desk\nprofile: agent\ngui:\n  enabled: true\n';
    fs.writeFileSync(s.yamlPath, mine);
    const d = deps(s);
    const { code, t } = await run('install', s, d);
    assert.equal(code, 0, t.errors());
    assert.equal(fs.readFileSync(s.yamlPath, 'utf8'), mine, 'kept as it was');
    const out = t.text();
    assert.match(out, /keeps it/);
    assert.match(out, /^ {2}hosting: 'personal'$/m);
    assert.match(out, /^ {2}gui\.take\.enabled: true$/m);
    assert.match(out, /^ {2}gui\.browser: 'chrome'$/m);
    assert.doesNotMatch(out, /^ {2}gui\.enabled: true$/m, 'a line it has is not printed');
    assert.doesNotMatch(out, /^ {2}profile: 'agent'$/m);
    assert.ok(d.executed.flat().some((step) => step.run && step.run.includes('/Create') && step.run.includes('/F')));
  });

  it('with approvers.relay already set, the task is started', async () => {
    const s = setup();
    fs.mkdirSync(s.configDir, { recursive: true });
    fs.writeFileSync(s.yamlPath, 'name: laptop\nprofile: agent\nhosting: personal\napprovers:\n  relay: wss://relay.example.com:8443\n');
    const d = deps(s);
    const { code, t } = await run('install', s, d);
    assert.equal(code, 0, t.errors());
    const all = argvs(d);
    const create = all.findIndex((argv) => argv.includes('/Create'));
    const start = all.findIndex((argv) => argv.includes('/Run') && argv.includes(PERSONAL_TASK_NAME));
    assert.ok(create >= 0 && start > create, JSON.stringify(all));
  });

  it('--provider and --model write the delegate block', async () => {
    const s = setup();
    const d = deps(s);
    const { code, t } = await run('install', s, d, { provider: 'anthropic', model: 'claude-opus-5-5' });
    assert.equal(code, 0, t.errors());
    const yaml = fs.readFileSync(s.yamlPath, 'utf8');
    assert.match(yaml, /\ndelegate:\n {2}provider: 'anthropic'\n {2}model: 'claude-opus-5-5'\n$/);
    assert.match(t.text(), /token set anthropic/);
  });

  it('--browser names the chrome app; ffmpeg missing is a warning with the winget line', async () => {
    const s = setup();
    const d = deps(s, { findChrome: () => { throw new Error('not asked'); }, findFfmpeg: () => null });
    const browser = 'D:\\Apps\\Chrome\\chrome.exe';
    const { code, t } = await run('install', s, d, { browser });
    assert.equal(code, 0, t.errors());
    assert.match(fs.readFileSync(s.yamlPath, 'utf8'), /^ {4}chrome: 'D:\\Apps\\Chrome\\chrome\.exe'$/m);
    assert.match(t.text(), /winget install Gyan\.FFmpeg/);
  });
});

describe('install --personal: under the desktop app\'s binary, and with a node running', () => {
  const APP = 'C:\\Program Files\\King Louie\\King Louie.exe';
  const RELAY_YAML = 'name: laptop\nprofile: agent\nhosting: personal\napprovers:\n  relay: wss://relay.example.com:8443\n';
  const argsOf = (xml) => /<Arguments>(.*)<\/Arguments>/.exec(xml)[1].replace(/&amp;/g, '&');

  it('runAsNode: the task sets ELECTRON_RUN_AS_NODE, and the consent names the binary and what it means', async () => {
    const s = setup();
    const d = deps(s, { runAsNode: true, nodePath: APP });
    const { code, t } = await run('install', s, d);
    assert.equal(code, 0, t.errors());
    assert.match(t.text(), /^ {2}binary: {5}C:\\Program Files\\King Louie\\King Louie\.exe, run as Node: the node then runs the desktop app's version, and stops starting if the app is removed$/m);
    const write = d.executed.flat().find((step) => step.writeFile);
    assert.match(argsOf(write.writeFile.content), /-Command \$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\Program Files\\King Louie\\King Louie\.exe' 'C:\\kl\\bin\\king-louie-service\.js' run --data-dir /);
  });

  describe('the launcher a window-installed owner runs', () => {
    const launcherStep = (d) => d.executed.flat().find((step) => step.writeFile && step.writeFile.path.endsWith('king-louie-service.cmd'));

    it('written beside the config dir with the pinned paths, by execute, in the consent and the dry run', async () => {
      const s = setup();
      const d = deps(s, { runAsNode: true, nodePath: APP });
      const { code, t } = await run('install', s, d, { yes: true });
      assert.equal(code, 0, t.errors());
      const step = launcherStep(d);
      assert.equal(step.writeFile.path, path.join(path.dirname(path.resolve(s.dataDir)), 'king-louie-service.cmd'));
      assert.equal(step.ignoreFailure, true);
      assert.equal(step.writeFile.content, renderServiceCli({ nodePath: APP, entryPath: 'C:\\kl\\bin\\king-louie-service.js' }));
      assert.ok(t.text().includes('king-louie-service.cmd'));

      const dry = deps(s, { runAsNode: true, nodePath: APP });
      const out = await run('install', s, dry, { dryRun: true });
      assert.equal(out.code, 0, out.t.errors());
      assert.match(out.t.text(), /\[dry-run\] [^\n]*king-louie-service\.cmd/);
      assert.ok(!fs.existsSync(step.writeFile.path), 'written only by execute');
    });

    it('a checkout install (node.exe) writes none', async () => {
      const s = setup();
      const d = deps(s, { runAsNode: false });
      const { code, t } = await run('install', s, d, { yes: true });
      assert.equal(code, 0, t.errors());
      assert.equal(launcherStep(d), undefined);
      assert.ok(!t.text().includes('king-louie-service.cmd'));
    });

    it('renders quoted, CRLF, with the variable set, spaces and shell characters inert', () => {
      const text = renderServiceCli({ nodePath: 'C:\\Program Files\\King & Louie\\King Louie.exe', entryPath: 'C:\\Program Files\\King & Louie\\resources\\app.asar\\bin\\king-louie-service.js' });
      assert.deepEqual(text.split('\r\n'), [
        '@rem King Louie Node launcher, written by install --personal.',
        '@echo off',
        'setlocal',
        'set "ELECTRON_RUN_AS_NODE=1"',
        '"C:\\Program Files\\King & Louie\\King Louie.exe" "C:\\Program Files\\King & Louie\\resources\\app.asar\\bin\\king-louie-service.js" %*',
        'exit /b %errorlevel%',
        ''
      ]);
    });

    it('a percent in a path is doubled; a non-ASCII path sets the code page; a quote is refused', () => {
      assert.ok(renderServiceCli({ nodePath: 'C:\\a%b\\k.exe', entryPath: 'C:\\k.js' }).includes('"C:\\a%%b\\k.exe"'));
      const accented = renderServiceCli({ nodePath: 'C:\\Users\\Jos\u00e9\\k.exe', entryPath: 'C:\\k.js' });
      // setlocal first, the page saved before it changes, and put back after the
      // node exits with the node's exit code kept.
      assert.deepEqual(accented.split('\r\n'), [
        '@rem King Louie Node launcher, written by install --personal.',
        '@echo off',
        'setlocal',
        'for /f "tokens=2 delims=:." %%a in (\'chcp\') do set "KLCP=%%a"',
        'chcp 65001 >nul',
        'set "ELECTRON_RUN_AS_NODE=1"',
        '"C:\\Users\\Jos\u00e9\\k.exe" "C:\\k.js" %*',
        'set "KLEXIT=%errorlevel%"',
        'if defined KLCP chcp %KLCP% >nul',
        'exit /b %KLEXIT%',
        ''
      ]);
      assert.ok(!renderServiceCli({ nodePath: 'C:\\k.exe', entryPath: 'C:\\k.js' }).includes('chcp'));
      assert.throws(() => renderServiceCli({ nodePath: 'C:\\a"b\\k.exe', entryPath: 'C:\\k.js' }), /double quote/);
    });

    it('uninstall removes it, with the task and with no task; the dry run lists it; none there, no step', async () => {
      const s = setup();
      const cli = path.join(path.dirname(path.resolve(s.dataDir)), 'king-louie-service.cmd');
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      fs.writeFileSync(cli, renderServiceCli({ nodePath: 'C:\\elsewhere\\k.exe', entryPath: 'C:\\elsewhere\\k.js' }));
      const d = deps(s);
      const { code, t } = await run('uninstall', s, d, { yes: true });
      assert.equal(code, 0, t.errors());
      assert.ok(d.executed.flat().some((step) => step.unlink === cli));

      const noTask = deps(s, { taskRegistered: () => false });
      const second = await run('uninstall', s, noTask, { yes: true });
      assert.equal(second.code, 0, second.t.errors());
      assert.ok(noTask.executed.flat().some((step) => step.unlink === cli));

      const dry = deps(s);
      const out = await run('uninstall', s, dry, { dryRun: true });
      assert.match(out.t.text(), /\[dry-run\] [^\n]*king-louie-service\.cmd/);
      assert.ok(fs.existsSync(cli), 'a dry run removes nothing');

      fs.unlinkSync(cli);
      const none = deps(s);
      await run('uninstall', s, none, { yes: true });
      assert.ok(!none.executed.flat().some((step) => step.unlink));
    });

    it('install does not write over a file of that name it did not write, and says so; its own it replaces', async () => {
      const s = setup();
      const cli = path.join(path.dirname(path.resolve(s.dataDir)), 'king-louie-service.cmd');
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      fs.writeFileSync(cli, '@echo off\r\necho my own script\r\n');
      const d = deps(s, { runAsNode: true, nodePath: APP });
      const { code, t } = await run('install', s, d, { yes: true });
      assert.equal(code, 0, t.errors());
      assert.equal(launcherStep(d), undefined);
      assert.match(t.text(), /king-louie-service\.cmd[^\n]* left /);

      fs.writeFileSync(cli, renderServiceCli({ nodePath: 'C:\\old\\k.exe', entryPath: 'C:\\old\\k.js' }));
      const again = deps(s, { runAsNode: true, nodePath: APP, taskRegistered: () => false });
      await run('install', s, again, { yes: true });
      assert.ok(launcherStep(again), 'an older launcher of ours is replaced');
    });

    it('uninstall with no --data-dir stops the node where its task says it runs (the uninstaller passes none)', async () => {
      const s = setup();
      const custom = path.join(path.dirname(path.resolve(s.dataDir)), 'elsewhere', 'data');
      const stopped = [];
      const d = deps(s, { taskDataDir: () => custom, runningServicePid: (dir) => (dir === custom ? 4242 : null), stopNode: async (dir) => { stopped.push(dir); return 0; } });
      const { code, t } = await run('uninstall', s, d, { yes: true, dataDir: undefined });
      assert.equal(code, 0, t.errors());
      assert.deepStrictEqual(stopped, [custom]);
    });

    it('uninstall with no --data-dir looks at the default place, and with no default says what to pass', async () => {
      const s = setup();
      const cli = path.join(path.dirname(path.resolve(s.dataDir)), 'king-louie-service.cmd');
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      fs.writeFileSync(cli, renderServiceCli({ nodePath: APP, entryPath: 'C:\\k.js' }));
      for (const taskRegistered of [() => true, () => false]) {
        const d = deps(s, { taskRegistered });
        const { code, t } = await run('uninstall', s, d, { yes: true, dataDir: undefined });
        assert.equal(code, 0, t.errors());
        assert.ok(d.executed.flat().some((step) => step.unlink === cli), 'the launcher goes');
      }
      const none = deps(s, { env: { SystemRoot: 'C:\\Windows', PATH: '' } });
      const { code, t } = await run('uninstall', s, none, { yes: true, dataDir: undefined });
      assert.notEqual(code, 0);
      assert.match(t.errors(), /--data-dir/);
    });

    it('uninstall removes what carries the marker, and leaves anyone else\'s, saying so', async () => {
      const s = setup();
      const cli = path.join(path.dirname(path.resolve(s.dataDir)), 'king-louie-service.cmd');
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      fs.writeFileSync(cli, renderServiceCli({ nodePath: APP, entryPath: 'C:\\kl\\bin\\king-louie-service.js' }));
      const same = deps(s, { nodePath: APP });
      await run('uninstall', s, same, { yes: true });
      assert.ok(same.executed.flat().some((step) => step.unlink === cli));

      for (const taskRegistered of [() => true, () => false]) {
        fs.writeFileSync(cli, '@echo off\r\necho my own script\r\n');
        const d = deps(s, { taskRegistered });
        const { code, t } = await run('uninstall', s, d, { yes: true });
        assert.equal(code, 0, t.errors());
        assert.ok(!d.executed.flat().some((step) => step.unlink), 'not ours: not removed');
        assert.match(t.text(), /king-louie-service\.cmd[^\n]* left /);
      }
      const dry = deps(s);
      const out = await run('uninstall', s, dry, { dryRun: true });
      assert.doesNotMatch(out.t.text(), /\[dry-run\] [^\n]*king-louie-service\.cmd/);
      assert.match(out.t.text(), /king-louie-service\.cmd[^\n]* left /);
      assert.ok(fs.existsSync(cli));
    });

    it('a launcher with a non-ASCII path keeps the node\'s exit code and puts the console\'s page back', { skip: process.platform !== 'win32' }, () => {
      const s = setup();
      const dir = path.join(s.base, 'Jos\u00e9');
      fs.mkdirSync(dir);
      const entry = path.join(dir, 'k.js');
      fs.writeFileSync(entry, 'process.exit(7);\n');
      const file = path.join(s.base, 'launcher.cmd');
      fs.writeFileSync(file, renderServiceCli({ nodePath: process.execPath, entryPath: entry }));
      const script = path.join(s.base, 'outer.cmd');
      fs.writeFileSync(script, ['@echo off', 'chcp 437 >nul', 'call "%~1"', 'echo exit=%errorlevel%', 'chcp', ''].join('\r\n'));
      const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', script, file], { encoding: 'utf8', windowsHide: true });
      assert.match(r.stdout, /exit=7/, r.stdout + r.stderr);
      assert.match(r.stdout, /: 437\b/, r.stdout);
    });
  });

  it('run from node.exe: no variable in the task and no binary line in the consent', async () => {
    const s = setup();
    const d = deps(s, { runAsNode: false });
    const { code, t } = await run('install', s, d);
    assert.equal(code, 0, t.errors());
    assert.doesNotMatch(t.text(), /binary:/);
    const write = d.executed.flat().find((step) => step.writeFile);
    assert.doesNotMatch(write.writeFile.content, /ELECTRON_RUN_AS_NODE/);
  });

  it('a node already running on the data dir: no /Run step, and it says the task starts it at the next logon', async () => {
    const s = setup();
    fs.mkdirSync(s.configDir, { recursive: true });
    fs.writeFileSync(s.yamlPath, RELAY_YAML);
    const asked = [];
    const d = deps(s, { runningServicePid: (dir) => { asked.push(dir); return 4242; } });
    const { code, t } = await run('install', s, d);
    assert.equal(code, 0, t.errors());
    assert.ok(asked.length > 0 && asked.every((dir) => dir === s.dataDir), JSON.stringify(asked));
    const all = argvs(d);
    assert.ok(all.some((argv) => argv.includes('/Create')), JSON.stringify(all));
    assert.ok(!all.some((argv) => argv.includes('/Run')), JSON.stringify(all));
    assert.match(t.text(), /^King Louie Node is already running \(pid 4242\); the task starts it at your next logon\.$/m);
    assert.doesNotMatch(t.text(), /registered and started/);
  });

  it('a node running: the dry run shows no /Run step either', async () => {
    const s = setup();
    fs.mkdirSync(s.configDir, { recursive: true });
    fs.writeFileSync(s.yamlPath, RELAY_YAML);
    const d = deps(s, { runningServicePid: () => 4242 });
    const { code, t } = await run('install', s, d, { dryRun: true });
    assert.equal(code, 0, t.errors());
    assert.doesNotMatch(t.text(), /\/Run/);
    assert.match(t.text(), /^King Louie Node is already running \(pid 4242\); the task starts it at your next logon\.$/m);
  });
});

describe('renderPersonalTaskXml', () => {
  it('renderPersonalTaskXml: LogonTrigger for the SID, InteractiveToken, LeastPrivilege, run --data-dir', () => {
    const xml = renderPersonalTaskXml({ sid: SID, nodePath: 'C:\\Program Files\\nodejs\\node.exe', entryPath: 'C:\\kl\\bin\\king-louie-service.js', dataDir: 'C:\\Users\\owner\\AppData\\Local\\KingLouie\\node\\data', env: { SystemRoot: 'C:\\Windows' } });
    assert.match(xml, /<Description>King Louie personal node<\/Description>/);
    assert.match(xml, /<LogonTrigger><Enabled>true<\/Enabled><UserId>S-1-5-21-1-2-3-1001<\/UserId><\/LogonTrigger>/);
    assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
    assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(xml, /<RestartOnFailure>/);
    assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
    assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
    assert.match(xml, /<Command>C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe<\/Command>/);
    assert.match(xml, /run --data-dir 'C:\\Users\\owner\\AppData\\Local\\KingLouie\\node\\data'/);
  });

  it('runAsNode: true sets ELECTRON_RUN_AS_NODE before the call to the binary; without it, no variable is set', () => {
    const base = { sid: SID, nodePath: 'C:\\Program Files\\King Louie\\King Louie.exe', entryPath: 'C:\\Program Files\\King Louie\\resources\\app.asar\\bin\\king-louie-service.js', dataDir: 'C:\\d\\data', env: { SystemRoot: 'C:\\Windows' } };
    const argsOf = (xml) => /<Arguments>(.*)<\/Arguments>/.exec(xml)[1].replace(/&amp;/g, '&');
    const call = "& 'C:\\Program Files\\King Louie\\King Louie.exe' 'C:\\Program Files\\King Louie\\resources\\app.asar\\bin\\king-louie-service.js' run --data-dir 'C:\\d\\data'";
    assert.equal(argsOf(renderPersonalTaskXml({ ...base, runAsNode: true })), `-WindowStyle Hidden -NoProfile -NonInteractive -Command $env:ELECTRON_RUN_AS_NODE='1'; ${call}`);
    assert.equal(argsOf(renderPersonalTaskXml(base)), `-WindowStyle Hidden -NoProfile -NonInteractive -Command ${call}`);
  });

  it('refuses a malformed SID and a path with a double quote', () => {
    const base = { sid: SID, nodePath: 'C:\\n\\node.exe', entryPath: 'C:\\kl\\e.js', dataDir: 'C:\\d\\data' };
    assert.throws(() => renderPersonalTaskXml({ ...base, sid: 'owner' }));
    assert.throws(() => renderPersonalTaskXml({ ...base, dataDir: 'C:\\d"\\data' }));
  });
});

describe('uninstall --personal', () => {
  it('uninstall --personal ends and deletes the task and says the data dir stays', async () => {
    const s = setup();
    const d = deps(s);
    const { code, t } = await run('uninstall', s, d);
    assert.equal(code, 0, t.errors());
    const all = argvs(d);
    assert.ok(all.some((argv) => argv.includes('/End') && argv.includes(PERSONAL_TASK_NAME)));
    assert.ok(all.some((argv) => argv.includes('/Delete') && argv.includes(PERSONAL_TASK_NAME) && argv.includes('/F')));
    assert.ok(all.every((argv) => argv[0] === 'C:\\Windows\\System32\\schtasks.exe'));
    assert.match(t.text(), /stays/);
    assert.ok(t.text().includes(s.dataDir));
  });

  it('stops a running node (king-louie-service stop) before it ends and deletes the task', async () => {
    const s = setup();
    const order = [];
    const d = deps(s, {
      runningServicePid: (dir) => { assert.equal(dir, path.resolve(s.dataDir)); return 4321; },
      stopNode: async (dir) => { order.push(`stop ${dir}`); return 0; }
    });
    d.execute = async (steps) => { order.push('execute'); d.executed.push(steps); };
    const { code, t } = await run('uninstall', s, d, { yes: true });
    assert.equal(code, 0, t.errors());
    assert.deepEqual(order, [`stop ${path.resolve(s.dataDir)}`, 'execute']);
  });

  it('a node that does not stop: the task is left registered, and the refusal names stop --force', async () => {
    const s = setup();
    const d = deps(s, { runningServicePid: () => 4321, stopNode: async () => 1 });
    const { code, t } = await run('uninstall', s, d, { yes: true });
    assert.equal(code, 1);
    assert.equal(d.executed.length, 0);
    assert.match(t.errors(), /did not stop, so the logon task was not removed/);
    assert.match(t.errors(), /king-louie-service stop --data-dir .* --force/);
  });

  it('--dry-run says it would stop the node first, and stops nothing', async () => {
    const s = setup();
    const d = deps(s, { runningServicePid: () => 4321 });
    const { code, t } = await run('uninstall', s, d, { dryRun: true });
    assert.equal(code, 0, t.errors());
    const out = t.text();
    assert.ok(out.indexOf('stop the node running on') !== -1 && out.indexOf('stop the node running on') < out.indexOf('/End'), out);
    assert.equal(d.executed.length, 0);
  });

  it('a task that is not registered: says so, removes nothing, exit 0', async () => {
    const s = setup();
    const d = deps(s, { taskRegistered: () => false });
    const { code, t } = await run('uninstall', s, d, { yes: true });
    assert.equal(code, 0, t.errors());
    assert.equal(d.executed.length, 0);
    assert.match(t.text(), /is not registered: nothing to remove/);
  });

  it('off a TTY without --yes it refuses; --yes goes on', async () => {
    const s = setup();
    const d = deps(s, { isTTY: () => false });
    const refused = await run('uninstall', s, d);
    assert.equal(refused.code, 2);
    assert.equal(d.executed.length, 0);
    const yes = await run('uninstall', s, d, { yes: true });
    assert.equal(yes.code, 0, yes.t.errors());
    assert.equal(d.executed.length, 1);
  });
});

describe('the CLI', () => {
  const cli = async (argv) => {
    const t = io();
    const code = await main(argv, t.io);
    return { code, t };
  };

  it('help lists both forms', async () => {
    const { t } = await cli(['help']);
    assert.match(t.text(), /king-louie-service install --personal/);
    assert.match(t.text(), /king-louie-service uninstall --personal/);
  });

  it('--yes is a usage error on the fleet install and uninstall', async () => {
    for (const command of ['install', 'uninstall']) {
      const { code, t } = await cli([command, '--yes', '--dry-run']);
      assert.equal(code, 2);
      assert.match(t.errors(), /"--yes" is only valid for/);
      assert.match(t.errors(), /"install --personal"/);
    }
  });

  it('--profile and --user with --personal are usage errors naming the flag', async () => {
    for (const [argv, flag] of [[['install', '--personal', '--profile', 'agent', '--dry-run'], '--profile'], [['uninstall', '--personal', '--user', 'owner', '--dry-run'], '--user']]) {
      const { code, t } = await cli(argv);
      assert.equal(code, 2, argv.join(' '));
      assert.ok(t.errors().includes(`Flag "${flag}" is not valid with "--personal"`), t.errors());
    }
  });

  it('the fleet install plans into the fleet data dir even where only a personal node exists', { skip: process.platform !== 'win32' && 'a personal node and its default data dir are Windows only' }, async () => {
    const s = setup();
    fs.mkdirSync(s.dataDir, { recursive: true });
    const programData = path.join(s.base, 'ProgramData');
    const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, ProgramData: process.env.ProgramData };
    process.env.LOCALAPPDATA = s.localAppData;
    process.env.ProgramData = programData;
    try {
      const { code, t } = await cli(['install', '--dry-run']);
      assert.equal(code, 0, t.errors());
      assert.ok(!t.text().includes(s.dataDir), t.text());
      assert.ok(t.text().includes(path.win32.join(programData, 'KingLouie', 'data')), t.text());
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('--browser, --provider and --model need install --personal; --personal needs install or uninstall', async () => {
    for (const argv of [['install', '--browser', 'C:\\c.exe', '--dry-run'], ['status', '--provider', 'anthropic'], ['uninstall', '--personal', '--model', 'm'], ['status', '--personal']]) {
      const { code, t } = await cli(argv);
      assert.equal(code, 2, argv.join(' '));
      assert.match(t.errors(), /only valid for/);
    }
  });
});
