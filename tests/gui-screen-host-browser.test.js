// tests/gui-screen-host-browser.test.js
// Boot-node-tray Task 6: a personal node started at boot (`--screen-host app`)
// never opens a saved browser profile itself. A persistent start goes through
// the screen-host launcher (the King Louie app's launch_browser) and attaches
// over CDP; before the app connects it is refused. Bundled headless Chromium
// only (tests/helpers/debuggable-chromium.js), never the installed Chrome.
const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { chromium } = require('playwright');
const PlaywrightBrowser = require('../src/browser/playwright-browser');
const registry = require('../src/tools/builtin/browser-registry');
const browserTool = require('../src/tools/builtin/browser-tool');
const { GuiBroker } = require('../src/gui/broker');
const { parseGuiConfig, NO_BROWSER_REMEDY } = require('../src/gui/config');
const { createScreenHostLauncher, refusingScreenHostLauncher, SCREEN_HOST_MISSING } = require('../src/gui/screen-host-browser');
const { CHROME_FLAGS } = require('../src/browser/chrome-flags');
const { launchDebuggableChromium } = require('./helpers/debuggable-chromium');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const guiConfig = (extra = {}) => parseGuiConfig({
  enabled: true,
  apps: { chrome: { name: 'Chrome', path: CHROME, processes: ['chrome.exe'] } },
  browser: 'chrome',
  ...extra
}, { platform: 'win32' });

// The HelperChannel surface the broker reads: connected, info, request.
function fakeChannel({ connected = false, answer = null } = {}) {
  const ch = Object.assign(new EventEmitter(), {
    connected,
    info: { capabilities: ['gui.launch'], limits: [], user: 'alice', platform: 'win32', since: null, probes: [] },
    requests: [],
    async request(op, params, opts) {
      ch.requests.push({ op, params, opts });
      // closeLaunched: the close is sent, and the process listing no longer shows it.
      if (op === 'close') return { closed: params.pids };
      if (op === 'processes') return [];
      if (op !== 'launch_browser') throw new Error(`unexpected op ${op}`);
      return answer ? answer(params) : { pid: 7, cdp: { port: 9222, path: '/devtools/browser/x' } };
    }
  });
  return ch;
}

let dataDir;
let profilesRoot;
let channel;
let launcher;
let lastBroker;
const launcherBroker = () => lastBroker;

function setUp({ connected = false, answer = null, config = guiConfig() } = {}) {
  channel = fakeChannel({ connected, answer });
  const broker = new GuiBroker({ channel, guiConfig: config, platform: 'win32', hosting: 'personal', screenHost: 'app' });
  lastBroker = broker;
  launcher = createScreenHostLauncher({ broker, guiConfig: config, profilesRoot });
  registry.setScreenHostLauncher(launcher);
}

// What the browser tool's context carries on a node: the data dir as userDataPath.
const ctx = () => ({ userDataPath: dataDir, browserKey: null });

beforeEach(() => {
  registry.reset();
  dataDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-shb-')));
  profilesRoot = path.join(dataDir, 'browser-profiles');
});

afterEach(async () => {
  await browserTool._cleanup();
  registry.reset();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

after(() => registry.reset());

describe('saved browser profiles on a boot-started node', () => {
  it('a persistent start before the screen host connects refuses screen_host_missing with "Saved logins are available after you log in"', async () => {
    setUp({ connected: false });
    for (const params of [{ action: 'start' }, { action: 'start', profile: 'shop' }]) {
      const out = await browserTool.execute(params, ctx());
      assert.equal(out.ok, false);
      assert.equal(out.code, 'screen_host_missing');
      assert.match(out.error, /Saved logins are available after you log in/);
    }
    assert.equal(channel.requests.length, 0, 'nothing asked of the screen host');
    assert.equal(registry.activeProfileOf(registry.DEFAULT_KEY), null, 'no profile left marked open');
    assert.equal(registry.getBrowser(ctx()).isRunning, false, 'nothing launched locally');
  });

  it('ephemeral: true still launches headless locally', async () => {
    setUp({ connected: false });
    const seen = [];
    // A stub that refuses the installed Chrome channel, so the fallback is Playwright's own Chromium.
    const stub = {
      launch: (opts) => { seen.push(opts); if (opts.channel) throw new Error('no installed Chrome in tests'); return chromium.launch(opts); },
      launchPersistentContext: () => { throw new Error('not persistent'); },
      connectOverCDP: () => { throw new Error('not attached'); }
    };
    registry.setBrowser(registry.DEFAULT_KEY, new PlaywrightBrowser({ chromium: stub }));
    const out = await browserTool.execute({ action: 'start', ephemeral: true, headless: true }, ctx());
    assert.equal(out.ok, true, out.error);
    assert.equal(channel.requests.length, 0, 'the screen host is not used');
    assert.equal(seen.at(-1).headless, true);
    assert.equal(seen.at(-1).channel, undefined);
    assert.equal(registry.getBrowser(ctx())._attached, false);
  });

  it('after connecting, a persistent start runs launch_browser for the profile name and attaches over CDP', async () => {
    const dbg = await launchDebuggableChromium();
    try {
      setUp({ connected: true, answer: () => ({ pid: dbg.child.pid, cdp: { port: dbg.port, path: '/devtools/browser/x' } }) });
      const browser = new PlaywrightBrowser();
      const attachedWith = [];
      const attach = browser.attach.bind(browser);
      browser.attach = async (opts) => { attachedWith.push(opts); return attach(opts); };
      await browser.start({ userDataPath: path.join(profilesRoot, 'shop'), headless: true });
      assert.deepEqual(attachedWith, [{ cdpUrl: dbg.cdpUrl }]);
      assert.equal(browser._attached, true);
      assert.equal(browser._persistent, false, 'no local persistent context');
      assert.equal(browser.page.url(), 'about:blank');
      assert.equal(channel.requests.length, 1);
      const req = channel.requests[0];
      assert.equal(req.op, 'launch_browser');
      // The wire carries the profile name, never a directory.
      assert.deepEqual(req.params, { exe: CHROME, profile: 'shop', args: [...CHROME_FLAGS, '--headless=new'] });
      // stop() closes the Chrome the screen host launched for it, over CDP.
      const exited = new Promise((r) => dbg.child.once('exit', r));
      await browser.stop();
      let timer;
      const outcome = await Promise.race([exited.then(() => 'exited'), new Promise((r) => { timer = setTimeout(() => r('still running'), 10000); })]);
      clearTimeout(timer);
      assert.equal(outcome, 'exited');
    } finally {
      await dbg.close();
    }
  });

  it('an attach that fails after the launch ends the launched Chrome by its pid through the screen host', async () => {
    // A port nothing listens on: the launch answers, the CDP connect fails.
    setUp({ connected: true, answer: () => ({ pid: 4321, cdp: { port: 1, path: '/devtools/browser/x' } }) });
    const browser = new PlaywrightBrowser();
    await assert.rejects(browser.start({ userDataPath: path.join(profilesRoot, 'shop'), headless: true }));
    assert.equal(browser.isRunning, false);
    const close = channel.requests.find((r) => r.op === 'close');
    assert.ok(close, 'the screen host was asked to close it');
    assert.deepEqual(close.params, { pids: [4321], force: false });
    assert.equal(close.opts.jobId, channel.requests[0].opts.jobId, 'under the job the launch was recorded for');
  });

  it('a headed start asks for no --headless switch', async () => {
    setUp({ connected: true });
    const out = await launcher.launch({ userDataPath: path.join(profilesRoot, 'king-louie'), headless: false });
    assert.deepEqual(out, { cdpUrl: 'http://127.0.0.1:9222', pid: 7 });
    assert.deepEqual(channel.requests[0].params.args, [...CHROME_FLAGS]);
    assert.equal(channel.requests[0].params.profile, 'king-louie');
  });

  it('a raw userDataPath outside <dataDir>/browser-profiles is refused invalid_params in screen-host mode', async () => {
    setUp({ connected: true });
    const elsewhere = path.join(dataDir, 'elsewhere', 'shop');
    const out = await browserTool.execute({ action: 'start', userDataPath: elsewhere }, ctx());
    assert.equal(out.ok, false);
    assert.equal(out.code, 'invalid_params');
    for (const bad of [profilesRoot, path.join(profilesRoot, 'a', 'b'), path.join(profilesRoot, 'bad name'), path.join(os.tmpdir(), 'shop'), '']) {
      await assert.rejects(launcher.launch({ userDataPath: bad }), (e) => e.code === 'invalid_params', bad);
    }
    assert.equal(channel.requests.length, 0);
  });

  it('no gui.browser app configured: refuses with the existing NO_CHROME remedy', async () => {
    const config = parseGuiConfig({ enabled: true, apps: { calculator: { path: 'C:\\Windows\\System32\\calc.exe' } } }, { platform: 'win32' });
    setUp({ connected: true, config });
    const out = await browserTool.execute({ action: 'start', profile: 'shop' }, ctx());
    assert.equal(out.ok, false);
    assert.equal(out.code, 'invalid_params');
    assert.ok(out.error.includes(NO_BROWSER_REMEDY), out.error);
    assert.ok(NO_BROWSER_REMEDY.includes('gui.apps.chrome and gui.browser'));
    assert.equal(channel.requests.length, 0);
  });

  it('a GUI that is off on a screen-host node still refuses every saved profile', async () => {
    registry.setScreenHostLauncher(refusingScreenHostLauncher());
    const out = await browserTool.execute({ action: 'start', profile: 'shop' }, ctx());
    assert.equal(out.code, 'screen_host_missing');
    assert.ok(out.error.includes(SCREEN_HOST_MISSING));
  });

  it('with no launcher set, a persistent start is unchanged (a node in the owner\'s session)', async () => {
    const seen = [];
    const page = { on() {}, url: () => 'about:blank' };
    const stub = { launchPersistentContext: async (dir, opts) => { seen.push({ dir, opts }); return { pages: () => [page], newPage: async () => page, close: async () => {} }; } };
    const browser = new PlaywrightBrowser({ chromium: stub });
    await browser.start({ userDataPath: path.join(profilesRoot, 'shop'), executablePath: 'C:\\x\\chrome.exe', headless: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].dir, path.join(profilesRoot, 'shop'));
    await browser.stop();
  });
});

describe('the GUI subsystem sets and clears the launcher', { skip: process.platform !== 'win32' && 'the screen host is Windows only' }, () => {
  const { createGuiSubsystem } = require('../src/gui');
  const { testNodeIdentity } = require('./helpers/fake-phone');
  const identity = testNodeIdentity({ key: 'gpu-box' });
  class FakeRelay extends EventEmitter {
    isConnected() { return true; }
    async send() { return { ok: true }; }
    registerMethod() {}
  }
  const approvals = () => ({ identity, approverStore: { get: () => null }, relayClient: new FakeRelay(), phoneApprover: { isAvailable: () => true }, auditLedger: { append: async () => {} } });
  const nodeConfig = (gui) => ({
    name: 'gpu-box', profile: 'agent', hosting: 'personal', capabilities: [], policy: { allowed_roots: [], remote_sessions: { always_confirm: [], deny: [] }, max_concurrent_jobs: 2 },
    gui
  });
  const fakeNet = () => ({
    createServer() {
      const server = new EventEmitter();
      server.listen = (options, cb) => setImmediate(cb);
      server.close = (cb) => setImmediate(cb);
      return server;
    }
  });

  // A stop, then a start whose personal-helper.json write throws before the launcher is set
  // again: the registry still refuses (never null).
  async function startFailsAfterStop() {
    const reg = { current: null, setScreenHostLauncher(l) { this.current = l; }, screenHostLauncher() { return this.current; } };
    let failing = false;
    const randomBytes = (n) => { if (failing) throw new Error('no entropy'); return require('crypto').randomBytes(n); };
    const gui = createGuiSubsystem({
      nodeConfig: nodeConfig(guiConfig()), dataDir, approvals: approvals(), platform: 'win32', hosting: 'personal', screenHost: 'app',
      deps: { browserRegistry: reg, netImpl: fakeNet(), randomBytes }
    });
    await gui.start();
    await gui.stop();
    failing = true;
    await gui.start();
    assert.equal(gui.unavailable.reason, 'gui_start_failed');
    assert.ok(reg.current);
    await assert.rejects(reg.current.launch({ userDataPath: path.join(dataDir, 'browser-profiles', 'shop') }), (e) => e.code === 'screen_host_missing');
    await gui.stop();
  }

  it('a start that fails after a stop leaves saved profiles refused', async () => {
    await startFailsAfterStop();
  });

  it('screenHost app: set when built, a refusing launcher after stop; a refusal is fenced when gui is off', async () => {
    const reg = { current: null, setScreenHostLauncher(l) { this.current = l; }, screenHostLauncher() { return this.current; } };
    const gui = createGuiSubsystem({
      nodeConfig: nodeConfig(guiConfig()), dataDir, approvals: approvals(), platform: 'win32', hosting: 'personal', screenHost: 'app',
      deps: { browserRegistry: reg, netImpl: fakeNet() }
    });
    assert.ok(reg.current, 'set as soon as the subsystem exists');
    const live = reg.current;
    await gui.start();
    assert.equal(reg.current, live);
    await assert.rejects(live.launch({ userDataPath: path.join(dataDir, 'browser-profiles', 'shop') }), (e) => e.code === 'screen_host_missing');
    await gui.stop();
    // run.js stops the GUI before the core: a turn still running must not launch locally.
    assert.ok(reg.current, 'never null ("launch locally") after stop');
    assert.notEqual(reg.current, live);
    await assert.rejects(reg.current.launch({ userDataPath: path.join(dataDir, 'browser-profiles', 'shop') }),
      (e) => e.code === 'screen_host_missing' && e.message.includes(SCREEN_HOST_MISSING));

    const offReg = { current: null, setScreenHostLauncher(l) { this.current = l; }, screenHostLauncher() { return this.current; } };
    const off = createGuiSubsystem({
      nodeConfig: nodeConfig(parseGuiConfig({ enabled: false }, { platform: 'win32' })), dataDir, approvals: approvals(), platform: 'win32', hosting: 'personal', screenHost: 'app',
      deps: { browserRegistry: offReg }
    });
    assert.equal(off, null);
    await assert.rejects(offReg.current.launch({ userDataPath: path.join(dataDir, 'browser-profiles', 'shop') }), (e) => e.code === 'screen_host_missing');

    // A personal node run by hand (no screen host) sets nothing.
    const handReg = { current: null, setScreenHostLauncher(l) { this.current = l; }, screenHostLauncher() { return this.current; } };
    createGuiSubsystem({
      nodeConfig: nodeConfig(guiConfig()), dataDir, approvals: approvals(), platform: 'win32', hosting: 'personal',
      deps: { browserRegistry: handReg, channel: new EventEmitter() }
    });
    assert.equal(handReg.current, null);
  });
});

describe('screen-host mode: an ephemeral start runs headless', () => {
  afterEach(() => registry.reset());

  function fakeBrowser() {
    const starts = [];
    return { starts, isRunning: false, async start(opts) { starts.push(opts); } };
  }

  it('forces headless for ephemeral: true while a screen-host launcher is set', async () => {
    const b = fakeBrowser();
    registry.setBrowser(registry.DEFAULT_KEY, b);
    registry.setScreenHostLauncher({ launch: async () => { throw new Error('not for an ephemeral start'); } });
    const out = await browserTool.actions.start({ ephemeral: true }, {});
    assert.equal(out.ok, true);
    assert.equal(b.starts[0].headless, true);
    assert.equal(b.starts[0].userDataPath, undefined);
  });

  it('leaves headless as asked with no screen-host launcher', async () => {
    const b = fakeBrowser();
    registry.setBrowser(registry.DEFAULT_KEY, b);
    await browserTool.actions.start({ ephemeral: true }, {});
    assert.equal(b.starts[0].headless, false);
  });

  it('a profile start under a screen host is not forced headless (the screen host shows it)', async () => {
    const b = fakeBrowser();
    registry.setBrowser(registry.DEFAULT_KEY, b);
    registry.setScreenHostLauncher({ launch: async () => ({}) });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-eph-'));
    try {
      await browserTool.actions.start({ userDataPath: dir }, {});
      assert.equal(b.starts[0].headless, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('screen-host browser pids are forgotten when the browser goes', () => {
  // attach() stubbed: the CDP side is covered above; this is the broker's bookkeeping.
  function stubbedBrowser() {
    const b = new PlaywrightBrowser();
    b.attach = async () => {
      b.browser = { isConnected: () => true, close: async () => {} };
      b._attached = true;
    };
    return b;
  }

  it('the launched record does not grow across start/stop cycles', async () => {
    let next = 100;
    setUp({ connected: true, answer: () => ({ pid: next++, cdp: { port: 9222, path: '/devtools/browser/x' } }) });
    const b = stubbedBrowser();
    for (let i = 0; i < 5; i += 1) {
      await b.start({ userDataPath: path.join(profilesRoot, 'shop') });
      await b.stop();
    }
    const brokerOf = launcherBroker();
    assert.equal(brokerOf.launched.has('screen-host-browser'), false, 'no pid left recorded');
  });

  it('a Chrome that went away without a stop is forgotten at the next start', async () => {
    let next = 200;
    setUp({ connected: true, answer: () => ({ pid: next++, cdp: { port: 9222, path: '/devtools/browser/x' } }) });
    const b = stubbedBrowser();
    await b.start({ userDataPath: path.join(profilesRoot, 'shop') });
    b.browser = { isConnected: () => false, close: async () => {} }; // closed by hand
    await b.start({ userDataPath: path.join(profilesRoot, 'shop') });
    const pids = [...launcherBroker().launched.get('screen-host-browser').values()].flatMap((s) => [...s]);
    assert.deepEqual(pids, [201]);
    await b.stop();
    assert.equal(launcherBroker().launched.has('screen-host-browser'), false);
  });

  it('closeLaunched after a failed attach still finds the pid, and leaves nothing recorded', async () => {
    setUp({ connected: true, answer: () => ({ pid: 300, cdp: { port: 9222, path: '/devtools/browser/x' } }) });
    const b = new PlaywrightBrowser();
    b.attach = async () => { throw new Error('attach failed'); };
    await assert.rejects(b.start({ userDataPath: path.join(profilesRoot, 'shop') }), /attach failed/);
    assert.ok(channel.requests.some((r) => r.op === 'close' && r.params.pids.includes(300)), 'the launched Chrome was closed by its pid');
    assert.equal(launcherBroker().launched.has('screen-host-browser'), false);
  });
});
