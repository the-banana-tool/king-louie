// tests/session-autostart.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../src/session/autostart');
const { windowsSchtasksExe, windowsPowerShellExe } = require('../src/platform/windows-paths');

const POSIX = process.platform !== 'win32';
const cleanups = [];
after(() => { for (const c of cleanups) c(); });
const env = { SystemRoot: 'C:\\Windows' };
const code = (fn) => { try { fn(); return null; } catch (e) { return e.code || e.message; } };

describe('Windows logon task', () => {
  const xml = A.renderLogonTaskXml({
    sid: 'S-1-5-21-1-2-3-1001', nodePath: 'C:\\Program Files\\nodejs\\node.exe', entryPath: "C:\\Program Files\\King Louie\\bin\\king-louie-service.js",
    sessionFile: "C:\\ProgramData\\KingLouie\\config\\session\\users\\S-1-5-21-1-2-3-1001.json", env
  });

  it('starts at the user\'s logon, in their session, least privilege, restarting on failure', () => {
    assert.match(xml, /<LogonTrigger><Enabled>true<\/Enabled><UserId>S-1-5-21-1-2-3-1001<\/UserId><\/LogonTrigger>/);
    assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
    assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(xml, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>3<\/Count><\/RestartOnFailure>/);
    assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
    assert.ok(xml.includes(`<Command>${windowsPowerShellExe(env)}</Command>`));
    assert.match(xml, /<Arguments>-WindowStyle Hidden -NoProfile -NonInteractive -Command &amp; 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Program Files\\King Louie\\bin\\king-louie-service.js' session --session-file 'C:\\ProgramData\\KingLouie\\config\\session\\users\\S-1-5-21-1-2-3-1001.json'<\/Arguments>/);
  });

  it('doubles single quotes and refuses double quotes and bad SIDs', () => {
    const quoted = A.renderLogonTaskXml({ sid: 'S-1-5-21-1-2-3-1001', nodePath: "C:\\it's\\node.exe", entryPath: 'C:\\kl\\e.js', sessionFile: 'C:\\kl\\f.json', env });
    assert.ok(quoted.includes("'C:\\it''s\\node.exe'"));
    assert.match(code(() => A.renderLogonTaskXml({ sid: 'S-1-5-21-1-2-3-1001', nodePath: 'C:\\a"b\\node.exe', entryPath: 'C:\\e.js', sessionFile: 'C:\\f.json', env })), /double quote/);
    assert.equal(code(() => A.renderLogonTaskXml({ sid: 'S-1-5-21-1<x>', nodePath: 'C:\\n.exe', entryPath: 'C:\\e.js', sessionFile: 'C:\\f.json', env })), 'invalid_params');
    assert.equal(A.windowsTaskName('alice'), 'KingLouie Session alice');
    assert.equal(code(() => A.windowsTaskName('a;b')), 'invalid_params');
  });

  it('plans schtasks by absolute path, and cleans up the temp XML', () => {
    const steps = A.planAutostartInstall({ platform: 'win32', account: { user: 'alice', sid: 'S-1-5-21-1-2-3-1001' }, nodePath: 'C:\\n\\node.exe', entryPath: 'C:\\kl\\e.js', sessionFile: 'C:\\kl\\f.json', tmpDir: 'C:\\Temp', env });
    const write = steps.find((s) => s.writeFile);
    assert.equal(write.writeFile.encoding, 'utf16le');
    const create = steps.find((s) => s.run && s.run.includes('/Create'));
    assert.deepEqual(create.run.slice(0, 4), [windowsSchtasksExe(env), '/Create', '/TN', 'KingLouie Session alice']);
    assert.ok(steps.find((s) => s.unlink === write.writeFile.path && s.always));
    const removal = A.planAutostartUninstall({ platform: 'win32', account: { user: 'alice' }, env });
    assert.deepEqual(removal[0].run, [windowsSchtasksExe(env), '/Delete', '/TN', 'KingLouie Session alice', '/F']);
  });
});

describe('macOS LaunchAgent and Linux autostart', () => {
  it('the plist loads in the Aqua session and restarts on a crash', () => {
    const plist = A.renderLaunchAgentPlist({ nodePath: '/usr/local/bin/node', entryPath: '/opt/king louie/bin/king-louie-service.js', sessionFile: '/Library/Application Support/KingLouie/config/session/users/alice.json' });
    assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
    assert.ok(plist.includes('<string>/opt/king louie/bin/king-louie-service.js</string>'));
    assert.ok(plist.includes('<string>--session-file</string>'));
    assert.throws(() => A.renderLaunchAgentPlist({ nodePath: 'node', entryPath: '/e.js', sessionFile: '/f.json' }), /absolute/);
    assert.ok(A.renderLaunchAgentPlist({ nodePath: '/a&b/node', entryPath: '/e.js', sessionFile: '/f.json' }).includes('/a&amp;b/node'));
  });

  it('the .desktop Exec line quotes paths and escapes %', () => {
    const entry = A.renderDesktopEntry({ nodePath: '/usr/bin/node', entryPath: '/opt/king louie/e.js', sessionFile: '/etc/king-louie/session/users/alice.json' });
    assert.match(entry, /^Exec=\/usr\/bin\/node "\/opt\/king louie\/e.js" session --session-file \/etc\/king-louie\/session\/users\/alice.json$/m);
    assert.ok(A.renderDesktopEntry({ nodePath: '/usr/bin/node', entryPath: '/opt/100%/e.js', sessionFile: '/f.json' }).includes(' /opt/100%%/e.js '));
    assert.throws(() => A.renderDesktopEntry({ nodePath: '/usr/bin/node', entryPath: '/opt/a\nb.js', sessionFile: '/f.json' }), /control character/);
  });

  it('plans: user-home files go through a child running as the user; launchctl bootstrap gui/<uid>', () => {
    const mac = A.planAutostartInstall({ platform: 'darwin', account: { user: 'alice', uid: 501, gid: 20, home: '/Users/alice' }, nodePath: '/usr/local/bin/node', entryPath: '/opt/kl/e.js', sessionFile: '/f.json' });
    const write = mac.find((s) => s.asUser);
    assert.deepEqual({ uid: write.asUser.uid, gid: write.asUser.gid, file: write.asUser.file }, { uid: 501, gid: 20, file: '/Users/alice/Library/LaunchAgents/com.kinglouie.session.plist' });
    assert.deepEqual(mac.find((s) => s.run && s.run[1] === 'bootstrap').run, ['/bin/launchctl', 'bootstrap', 'gui/501', '/Users/alice/Library/LaunchAgents/com.kinglouie.session.plist']);
    const linux = A.planAutostartInstall({ platform: 'linux', account: { user: 'alice', uid: 1001, gid: 1001, home: '/home/alice' }, nodePath: '/usr/bin/node', entryPath: '/opt/kl/e.js', sessionFile: '/f.json' });
    assert.equal(linux[0].asUser.file, '/home/alice/.config/autostart/king-louie-session.desktop');
    assert.ok(A.planAutostartUninstall({ platform: 'linux', account: { user: 'alice', uid: 1001, gid: 1001, home: '/home/alice' } })[0].removeAsUser);
  });

  it('executes a user-home write as a child with the user\'s uid and gid, content on stdin', async () => {
    const calls = [];
    const spawnSync = (file, argv, opts) => { calls.push({ file, argv, opts }); return { status: 0 }; };
    const steps = [{ description: 'write it', asUser: { uid: 1001, gid: 1001, home: '/home/alice', file: '/home/alice/.config/autostart/king-louie-session.desktop', content: 'X' } }];
    const io = { stdout: { write: () => {} } };
    await A.executeAutostartSteps(steps, { io, entryPath: '/opt/kl/e.js', nodePath: '/usr/bin/node', spawnSync });
    assert.equal(calls[0].file, '/usr/bin/node');
    assert.deepEqual(calls[0].argv, ['/opt/kl/e.js', 'session', '_write-autostart', '/home/alice/.config/autostart/king-louie-session.desktop']);
    assert.equal(calls[0].opts.uid, 1001);
    assert.equal(calls[0].opts.gid, 1001);
    assert.equal(calls[0].opts.input, 'X');
    assert.equal(calls[0].opts.env.HOME, '/home/alice');
    const dry = [];
    await A.executeAutostartSteps(steps, { dryRun: true, io: { stdout: { write: (t) => dry.push(t) } }, entryPath: '/opt/kl/e.js', nodePath: '/usr/bin/node', spawnSync });
    assert.equal(calls.length, 1, 'dry run spawns nothing');
    assert.match(dry.join(''), /\[dry-run\] write it/);
    await assert.rejects(A.executeAutostartSteps(steps, { io, entryPath: '/e.js', nodePath: '/node', spawnSync: () => ({ status: 1 }) }), /failed/);
  });
});

describe('the user-side writer', { skip: !POSIX }, () => {
  function home() {
    const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-home-')));
    cleanups.push(() => fs.rmSync(h, { recursive: true, force: true }));
    return h;
  }

  it('creates the dirs and writes the file; a second write replaces it', () => {
    const h = home();
    const file = path.join(h, '.config', 'autostart', 'king-louie-session.desktop');
    A.writeAutostartFile({ file, content: 'one', userInfo: { homedir: h } });
    A.writeAutostartFile({ file, content: 'two', userInfo: { homedir: h } });
    assert.equal(fs.readFileSync(file, 'utf8'), 'two');
    A.removeAutostartFile({ file, userInfo: { homedir: h } });
    assert.equal(fs.existsSync(file), false);
  });

  it('refuses a planted symlink at a component or the file, and anything outside the home', () => {
    const h = home();
    const elsewhere = home();
    fs.symlinkSync(elsewhere, path.join(h, '.config'));
    assert.equal(code(() => A.writeAutostartFile({ file: path.join(h, '.config', 'autostart', 'k.desktop'), content: 'x', userInfo: { homedir: h } })), 'unsafe_path');
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    const h2 = home();
    fs.mkdirSync(path.join(h2, 'Library', 'LaunchAgents'), { recursive: true });
    const target = path.join(elsewhere, 'victim');
    fs.writeFileSync(target, 'keep');
    fs.symlinkSync(target, path.join(h2, 'Library', 'LaunchAgents', 'com.kinglouie.session.plist'));
    assert.equal(code(() => A.writeAutostartFile({ file: path.join(h2, 'Library', 'LaunchAgents', 'com.kinglouie.session.plist'), content: 'x', userInfo: { homedir: h2 } })), 'unsafe_path');
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
    assert.equal(code(() => A.writeAutostartFile({ file: '/etc/passwd', content: 'x', userInfo: { homedir: h2 } })), 'unsafe_path');
  });
});
