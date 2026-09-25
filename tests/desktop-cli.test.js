// tests/desktop-cli.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { NodeIdentity, deriveNodeId } = require('../src/mesh/node-identity');
const keys = require('../src/desktop-bridge/keys');
const pairing = require('../src/desktop-bridge/pairing');
const { assertAdminOwned } = require('../src/service/config');
const { runDesktopCommand, grantDirectoryReadControl, applyWindowsAcls, PAIR_WARNING } = require('../src/service/commands/desktop');
const { main, parseArgs } = require('../src/service/cli');

const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function layout({ serviceJson = null, identity = new NodeIdentity({ nodeName: 'gpu-box' }) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-desktop-cli-'));
  dirs.push(root);
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.mkdirSync(configDir, { mode: 0o755 });
  if (identity) fs.writeFileSync(path.join(dataDir, 'chat-data.json'), JSON.stringify({ mesh: { identity: { publicKey: identity.publicKey.toString('hex') } } }));
  if (serviceJson) fs.writeFileSync(path.join(configDir, 'service.json'), JSON.stringify(serviceJson), { mode: 0o644 });
  return { root, dataDir, configDir, identity };
}

function capture() {
  const out = { stdout: '', stderr: '' };
  return { out, io: { stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } }, ownership: { getuid: () => 1000 } } };
}

function request(label = 'web-01 desk') {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return pairing.encodePairRequest({ publicKeyRaw: keys.rawFromPublicKeyObject(publicKey), label });
}

const deps = (l, extra = {}) => ({
  isAdmin: () => true,
  configDir: l.configDir,
  runningServicePid: () => null,
  withServiceCore: () => { throw new Error('withServiceCore must not be called'); },
  applyWindowsAcls: () => {},
  now: () => new Date('2026-09-23T14:02:11.123Z'),
  // fix round 1 (I1): pairing now confirms before writing. Tests that don't
  // care about that flow simulate an already-confirmed TTY; the tests below
  // that do care override these.
  isTTY: () => true,
  confirm: async () => true,
  ...extra
});

describe('desktop pair', () => {
  it('refuses without administrator rights', async () => {
    const l = layout();
    const c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'pair', arg: request(), dataDir: l.dataDir, io: c.io, deps: deps(l, { isAdmin: () => false }) }), 1);
    assert.strictEqual(c.out.stderr, `desktop pair writes ${l.configDir}; run it as root/an administrator.\n`);
  });

  it('refuses on profile: runbook, and a malformed request', async () => {
    const l = layout({ serviceJson: { profile: 'runbook' } });
    let c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'pair', arg: request(), dataDir: l.dataDir, io: c.io, deps: deps(l) }), 1);
    assert.strictEqual(c.out.stderr, 'desktopBridge needs profile: agent\n');
    const l2 = layout();
    c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'pair', arg: 'klpair1.nope', dataDir: l2.dataDir, io: c.io, deps: deps(l2) }), 2);
    // fix round 1: the malformed-request stderr text is pinned, not just the exit code.
    assert.match(c.out.stderr, /^Not a pairing request: /);
  });

  it('writes the devices file, the bridge file and merges service.json', async () => {
    const l = layout({ serviceJson: { profile: 'agent', features: { gateway: true }, ports: { gateway: 18793 } } });
    const req = request('web-01 desk');
    const decoded = pairing.decodePairRequest(req);
    const c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'pair', arg: req, dataDir: l.dataDir, io: c.io, deps: deps(l) }), 0);
    const devices = pairing.parseDevices(fs.readFileSync(path.join(l.configDir, 'desktop-devices.json'), 'utf8'));
    assert.deepStrictEqual(devices.devices, [{ deviceId: decoded.deviceId, publicKey: decoded.publicKey, label: 'web-01 desk', pairedAt: '2026-09-23T14:02:11Z' }]);
    const bridge = JSON.parse(fs.readFileSync(path.join(l.configDir, 'desktop-bridge.json'), 'utf8'));
    assert.deepStrictEqual(bridge, { v: 1, nodeId: l.identity.nodeId, publicKey: l.identity.publicKey.toString('hex'), host: '127.0.0.1', port: 18795, protocol: 1 });
    assert.strictEqual(deriveNodeId(bridge.publicKey), bridge.nodeId);
    const svc = JSON.parse(fs.readFileSync(path.join(l.configDir, 'service.json'), 'utf8'));
    assert.deepStrictEqual(svc, { profile: 'agent', features: { gateway: true, desktopBridge: true }, ports: { gateway: 18793, desktopBridge: 18795 } });
    assert.ok(c.out.stdout.includes(keys.fingerprintGroups(decoded.deviceId)));
    assert.ok(c.out.stdout.includes(keys.fingerprintGroups(l.identity.nodeId)));
    assert.ok(c.out.stdout.includes('Port: 18795'));
    assert.ok(c.out.stdout.includes(PAIR_WARNING));
    assert.ok(c.out.stdout.includes('Restart the service to open the desktop bridge.'));
    const again = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'pair', arg: request('second desk'), dataDir: l.dataDir, io: again.io, deps: deps(l) }), 0);
    assert.ok(!again.out.stdout.includes('Restart the service'), 'the feature was already on');
  });

  it('passes the service\'s own ownership check for its devices file', { skip: process.platform === 'win32' ? 'assertAdminOwned is a no-op on win32' : false }, async () => {
    const l = layout();
    const c = capture();
    await runDesktopCommand({ sub: 'pair', arg: request(), dataDir: l.dataDir, io: c.io, deps: deps(l) });
    const file = path.join(l.configDir, 'desktop-devices.json');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o640);
    assertAdminOwned(file, () => -1, selfUid, pairing.DEVICES_CONTROLS);
    assert.strictEqual(fs.statSync(path.join(l.configDir, 'desktop-bridge.json')).mode & 0o777, 0o644);
  });

  it('needs a stopped service to create a missing node identity', async () => {
    const l = layout({ identity: null });
    let c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'pair', arg: request(), dataDir: l.dataDir, io: c.io, deps: deps(l, { runningServicePid: () => 4242 }) }), 1);
    assert.strictEqual(c.out.stderr, 'No node identity yet. Stop the service once and rerun this command.\n');
    const created = new NodeIdentity({ nodeName: 'gpu-box' });
    let calls = 0;
    c = capture();
    const code = await runDesktopCommand({
      sub: 'pair', arg: request(), dataDir: l.dataDir, io: c.io,
      deps: deps(l, { withServiceCore: (_dir, _io, fn) => { calls += 1; return fn({ context: { getStore: () => null } }, { cipher: null }); }, createIdentity: () => created })
    });
    assert.strictEqual(code, 0, c.out.stderr);
    assert.strictEqual(calls, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(l.configDir, 'desktop-bridge.json'), 'utf8')).nodeId, created.nodeId);
  });

  it('creates a missing config dir with mode 0o755', { skip: process.platform === 'win32' ? 'POSIX modes only' : false }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-desktop-cli-'));
    dirs.push(root);
    const dataDir = path.join(root, 'data');
    const configDir = path.join(root, 'config'); // deliberately not created
    fs.mkdirSync(dataDir, { mode: 0o700 });
    const identity = new NodeIdentity({ nodeName: 'gpu-box' });
    fs.writeFileSync(path.join(dataDir, 'chat-data.json'), JSON.stringify({ mesh: { identity: { publicKey: identity.publicKey.toString('hex') } } }));
    const c = capture();
    const code = await runDesktopCommand({
      sub: 'pair', arg: request(), dataDir, io: c.io,
      deps: deps({ configDir }, {})
    });
    assert.strictEqual(code, 0, c.out.stderr);
    assert.strictEqual(fs.statSync(configDir).mode & 0o777, 0o755);
  });
});

describe('desktop pair confirmation (fix round 1, I1)', () => {
  it('prints the fingerprints and warning before writing, then refuses when the owner declines', async () => {
    const l = layout({ serviceJson: { profile: 'agent' } });
    const c = capture();
    const code = await runDesktopCommand({
      sub: 'pair', arg: request(), dataDir: l.dataDir, io: c.io,
      deps: deps(l, { isTTY: () => true, confirm: async () => false })
    });
    assert.strictEqual(code, 1);
    assert.ok(c.out.stdout.includes(PAIR_WARNING), 'the info is printed before the refusal');
    assert.strictEqual(c.out.stderr, 'Not pairing without confirmation.\n');
    assert.ok(!fs.existsSync(path.join(l.configDir, 'desktop-devices.json')), 'nothing was written');
    assert.ok(!fs.existsSync(path.join(l.configDir, 'desktop-bridge.json')), 'nothing was written');
  });

  it('refuses without --yes when stdin is not a TTY, writing nothing', async () => {
    const l = layout({ serviceJson: { profile: 'agent' } });
    const c = capture();
    const code = await runDesktopCommand({
      sub: 'pair', arg: request(), dataDir: l.dataDir, io: c.io,
      deps: deps(l, { isTTY: () => false, confirm: async () => { throw new Error('must not prompt without a TTY'); } })
    });
    assert.strictEqual(code, 2);
    assert.ok(c.out.stdout.includes(PAIR_WARNING), 'the info is printed before the refusal');
    assert.match(c.out.stderr, /--yes/);
    assert.ok(!fs.existsSync(path.join(l.configDir, 'desktop-devices.json')), 'nothing was written');
  });

  it('skips the prompt and pairs with --yes on a non-TTY', async () => {
    const l = layout({ serviceJson: { profile: 'agent' } });
    const c = capture();
    const code = await runDesktopCommand({
      sub: 'pair', arg: request(), dataDir: l.dataDir, io: c.io, yes: true,
      deps: deps(l, { isTTY: () => false, confirm: async () => { throw new Error('must not prompt with --yes'); } })
    });
    assert.strictEqual(code, 0, c.out.stderr);
    assert.ok(fs.existsSync(path.join(l.configDir, 'desktop-devices.json')));
  });

  it('pairs after an explicit yes on a TTY, printing the unpair-if-different note', async () => {
    const l = layout({ serviceJson: { profile: 'agent' } });
    const req = request();
    const { deviceId } = pairing.decodePairRequest(req);
    const c = capture();
    let asked = null;
    const code = await runDesktopCommand({
      sub: 'pair', arg: req, dataDir: l.dataDir, io: c.io,
      deps: deps(l, { isTTY: () => true, confirm: async (question) => { asked = question; return true; } })
    });
    assert.strictEqual(code, 0, c.out.stderr);
    assert.match(asked, /Trust this device\? \[y\/N\]/);
    assert.ok(fs.existsSync(path.join(l.configDir, 'desktop-devices.json')));
    assert.ok(c.out.stdout.includes(`desktop unpair ${deviceId}`));
  });
});

describe('applyWindowsAcls (fix round 1, minor)', () => {
  it('grants the bridge-file ACL, sets its owner to Administrators, and checks configDir ownership', () => {
    const calls = [];
    const execFile = (exe, args) => {
      calls.push({ exe, args });
      // The ownership warning goes through the powershell-based inspector;
      // answer with a non-admin owner so the code path that reads the
      // result (and would warn) actually runs.
      if (/powershell\.exe$/i.test(exe)) return 'me S-1-5-21-1-2-3-1001\nS-1-5-21-1-2-3-1001 plain\n';
      return '';
    };
    applyWindowsAcls({ bridgeFile: 'C:\\kl\\config\\desktop-bridge.json', configDir: 'C:\\kl\\config', execFile, env: process.env });
    const icaclsCalls = calls.filter((c) => /icacls\.exe$/i.test(c.exe));
    assert.ok(icaclsCalls.some((c) => c.args[0] === 'C:\\kl\\config\\desktop-bridge.json' && c.args.includes('/inheritance:r') && c.args.includes('*S-1-5-18:F')));
    assert.ok(icaclsCalls.some((c) => c.args[0] === 'C:\\kl\\config\\desktop-bridge.json' && c.args.includes('/setowner') && c.args.includes('*S-1-5-32-544')), 'sets owner to Administrators');
    assert.ok(icaclsCalls.some((c) => c.args[0] === 'C:\\kl\\config' && c.args.includes('/grant')), 'grants read on configDir');
  });
});

describe('desktop unpair and list', () => {
  it('lists, removes and reports an unknown device', async () => {
    const l = layout();
    const req = request('web-01 desk');
    await runDesktopCommand({ sub: 'pair', arg: req, dataDir: l.dataDir, io: capture().io, deps: deps(l) });
    const { deviceId } = pairing.decodePairRequest(req);
    let c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'list', dataDir: l.dataDir, io: c.io, deps: deps(l) }), 0);
    assert.match(c.out.stdout, new RegExp(`${deviceId}\\s+web-01 desk\\s+paired 2026-09-23T14:02:11Z`));
    c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'unpair', arg: deviceId, dataDir: l.dataDir, io: c.io, deps: deps(l) }), 0);
    assert.deepStrictEqual(pairing.parseDevices(fs.readFileSync(path.join(l.configDir, 'desktop-devices.json'), 'utf8')).devices, []);
    c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'unpair', arg: deviceId, dataDir: l.dataDir, io: c.io, deps: deps(l) }), 1);
    assert.strictEqual(c.out.stderr, `No paired desktop ${deviceId}.\n`);
    c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'list', dataDir: l.dataDir, io: c.io, deps: deps(l, { isAdmin: () => false }) }), 1);
  });

  it('refuses unpair without administrator rights', async () => {
    const l = layout();
    const c = capture();
    assert.strictEqual(await runDesktopCommand({ sub: 'unpair', arg: 'kld-aaaaaaaaaaaaaaaa', dataDir: l.dataDir, io: c.io, deps: deps(l, { isAdmin: () => false }) }), 1);
    assert.strictEqual(c.out.stderr, `desktop unpair writes ${l.configDir}; run it as root/an administrator.\n`);
  });

  it('rejects an unpair id that is not a device id, without echoing it back', async () => {
    const l = layout();
    const c = capture();
    const code = await runDesktopCommand({ sub: 'unpair', arg: '../etc/passwd', dataDir: l.dataDir, io: c.io, deps: deps(l) });
    assert.strictEqual(code, 2);
    assert.strictEqual(c.out.stderr, 'Not a device id.\n');
    assert.ok(!c.out.stdout.includes('etc/passwd') && !c.out.stderr.includes('etc/passwd'));
  });
});

describe('import --from CLI wiring (fix round 1)', () => {
  it('parseArgs keeps --from\'s value out of the positional list', () => {
    const { positional, flags } = parseArgs(['import', '--from', '/some/dir']);
    assert.deepStrictEqual(positional, ['import']);
    assert.strictEqual(flags.from, '/some/dir');
  });

  it('reaches runImportCommand with flags.from, not as a positional', async () => {
    const importCommand = require('../src/service/commands/import');
    const original = importCommand.runImportCommand;
    let received = null;
    importCommand.runImportCommand = async (args) => { received = args; return 0; };
    try {
      const c = capture();
      const code = await main(['import', '--from', 'C:\\some\\desktop-profile', '--dry-run'], { stdin: process.stdin, ...c.io });
      assert.strictEqual(code, 0);
      assert.strictEqual(received.flags.from, 'C:\\some\\desktop-profile');
      assert.strictEqual(received.flags.dryRun, true);
      assert.strictEqual(received.dataDir === undefined, false);
    } finally {
      importCommand.runImportCommand = original;
    }
  });
});

describe('CLI dispatch', () => {
  it('routes desktop and import, printing usage without a subcommand', async () => {
    const c = capture();
    assert.strictEqual(await main(['desktop'], { stdin: process.stdin, ...c.io }), 2);
    assert.match(c.out.stderr, /king-louie-service desktop pair <request>/);
    const c2 = capture();
    assert.strictEqual(await main(['import'], { stdin: process.stdin, ...c2.io }), 2);
    assert.match(c2.out.stderr, /import --from/);
  });
});

describe('Windows ACE for the bridge-file directory (R56)', { skip: process.platform !== 'win32' ? 'Windows only' : false }, () => {
  it('grants Authenticated Users READ_CONTROL|FILE_READ_ATTRIBUTES, not inherited', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ace-'));
    dirs.push(dir);
    grantDirectoryReadControl(dir);
    const script = "(Get-Acl -LiteralPath $env:KL_ACE_DIR).Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-11' -and -not $_.IsInherited } | ForEach-Object { \"$($_.FileSystemRights)|$($_.InheritanceFlags)\" }";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, KL_ACE_DIR: dir }, encoding: 'utf8' }).trim();
    assert.match(out, /ReadAttributes/);
    assert.match(out, /ReadPermissions/);
    assert.match(out, /\|None$/m, 'no inheritance flags');
  });
});
