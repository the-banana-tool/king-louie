// tests/service-cli-install-personal.test.js
// `install --personal` / `uninstall --personal` (personal node spec §8). No
// test runs a real schtasks, whoami or reg, touches the real %LOCALAPPDATA%
// or runs elevated: everything is injected, and the data dir is a temp dir.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPersonalInstall, renderPersonalTaskXml, PERSONAL_TASK_NAME } = require('../src/service/personal-install');
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
    fleetInstalled: () => ({ task: false, configDir: null }),
    hostname: () => 'laptop',
    tmpDir: s.base,
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    entryPath: 'C:\\kl\\bin\\king-louie-service.js',
    execute: async (steps) => { executed.push(steps); },
    ...extra
  };
}

const run = (command, s, d, flags = {}, t = io()) => runPersonalInstall({ command, flags: { dataDir: s.dataDir, ...flags }, io: t.io, deps: d }).then((code) => ({ code, t }));
const argvs = (d) => d.executed.flat().filter((step) => step.run).map((step) => step.run);

describe('install --personal: refusals', () => {
  it('refuses elevated, off Windows, with a fleet node installed, and with no chrome', async () => {
    const cases = [
      [{ isAdmin: () => true }, /install --personal runs as you, not elevated: open a normal prompt/],
      [{ platform: 'linux' }, /install --personal is Windows-only for now/],
      [{ fleetInstalled: () => ({ task: true, configDir: null }) }, /a fleet node is installed on this machine \(.*KingLouie.*\); run uninstall \/ session uninstall first/],
      [{ fleetInstalled: () => ({ task: false, configDir: 'C:\\ProgramData\\KingLouie\\config' }) }, /a fleet node is installed on this machine \(C:\\ProgramData\\KingLouie\\config.*\); run uninstall \/ session uninstall first/],
      [{ findChrome: () => null }, /no chrome\.exe found; pass --browser <path>/]
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
      'name: laptop',
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
    assert.match(out, /^ {2}hosting: personal$/m);
    assert.match(out, /^ {2}gui\.take\.enabled: true$/m);
    assert.match(out, /^ {2}gui\.browser: chrome$/m);
    assert.doesNotMatch(out, /^ {2}gui\.enabled: true$/m, 'a line it has is not printed');
    assert.doesNotMatch(out, /^ {2}profile: agent$/m);
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
    assert.match(yaml, /\ndelegate:\n {2}provider: anthropic\n {2}model: claude-opus-5-5\n$/);
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

  it('--browser, --provider and --model need install --personal; --personal needs install or uninstall', async () => {
    for (const argv of [['install', '--browser', 'C:\\c.exe', '--dry-run'], ['status', '--provider', 'anthropic'], ['uninstall', '--personal', '--model', 'm'], ['status', '--personal']]) {
      const { code, t } = await cli(argv);
      assert.equal(code, 2, argv.join(' '));
      assert.match(t.errors(), /only valid for/);
    }
  });
});
