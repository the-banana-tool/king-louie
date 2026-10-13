// tests/gui-config.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseGuiConfig, GUI_KEYS } = require('../src/gui/config');
const { GuiError, GUI_ERROR_CODES, toToolResult, fromWire, isGuiError } = require('../src/gui/errors');
const { loadNodeConfig, NODE_YAML_KEYS } = require('../src/service/node-config');

const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const cleanups = [];
after(() => { for (const c of cleanups) c(); });

function configDirWith(yaml) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gui-config-'));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const config = path.join(base, 'config');
  fs.mkdirSync(config, { mode: 0o755 });
  if (process.platform !== 'win32') { fs.chmodSync(base, 0o755); fs.chmodSync(config, 0o755); }
  fs.writeFileSync(path.join(config, 'node.yaml'), yaml, { mode: 0o644 });
  return config;
}

describe('GuiError', () => {
  it('carries a code and turns into a tool refusal', () => {
    const err = new GuiError('capability_unavailable', 'gui');
    assert.ok(isGuiError(err));
    assert.equal(err.message, 'capability_unavailable: gui');
    assert.deepEqual(toToolResult(err), { ok: false, error: 'capability_unavailable: gui' });
    assert.deepEqual(toToolResult(new GuiError('approval_unavailable')), { ok: false, error: 'signed approval unavailable' });
    assert.deepEqual(toToolResult(new GuiError('rate_limited', null, { retryAfter: 7 })), { ok: false, error: 'rate_limited', retry_after: 7 });
    assert.deepEqual(toToolResult(new Error('boom')), { ok: false, error: 'gui_error: boom' });
  });

  it('maps helper errors, and an unknown code to backend_failed', () => {
    const e = fromWire({ code: 'foreground_mismatch', message: 'x', detail: { image: 'C:\\Windows\\explorer.exe', pid: 4 } });
    assert.equal(e.code, 'foreground_mismatch');
    assert.deepEqual(e.info, { image: 'C:\\Windows\\explorer.exe', pid: 4 });
    assert.equal(fromWire({ code: 'rm -rf', message: 'x' }).code, 'backend_failed');
    assert.equal(fromWire(null).code, 'backend_failed');
  });

  it('R-F5-7: has the two job codes', () => {
    assert.ok(GUI_ERROR_CODES.includes('job_required'));
    assert.ok(GUI_ERROR_CODES.includes('job_closed'));
    assert.deepEqual(toToolResult(new GuiError('job_required', 'this run has no job or chat to bind a lease to')), { ok: false, error: 'job_required: this run has no job or chat to bind a lease to' });
  });
});

describe('parseGuiConfig', () => {
  it('fills every default on an agent node', () => {
    const g = parseGuiConfig(undefined, { profile: 'agent', platform: 'linux' });
    assert.equal(g.enabled, true);
    assert.deepEqual(g.apps, {});
    assert.deepEqual(g.screenshot, { maxWidth: 1280, quality: 70 });
    assert.deepEqual(g.liveView, { intervalS: 3, maxWidth: 960, quality: 60, maxFrameBytes: 184320 });
    assert.deepEqual(g.lease, { defaultMinutes: 15, maxMinutes: 60, yieldMs: 2000, maxInputsPerMinute: 120 });
    assert.deepEqual(g.warnings, []);
  });

  it('is forced off on the runbook and frontdoor profiles, even when written', () => {
    for (const profile of ['runbook', 'frontdoor']) {
      const g = parseGuiConfig({ enabled: true, apps: { calc: '/usr/bin/gnome-calculator' } }, { profile, platform: 'linux' });
      assert.equal(g.enabled, false);
      assert.deepEqual(g.apps, {});
    }
  });

  it('reads the string shorthand and the full form', () => {
    const g = parseGuiConfig({
      apps: {
        textedit: '/System/Applications/TextEdit.app',
        calculator: { name: 'Calculator', path: '/System/Applications/Calculator.app', processes: ['/System/Applications/Calculator.app/Contents/MacOS/*'], args: ['--x=*'] }
      }
    }, { platform: 'darwin' });
    assert.deepEqual(g.apps.textedit, { id: 'textedit', name: 'textedit', path: '/System/Applications/TextEdit.app', processes: [], args: [] });
    assert.equal(g.apps.calculator.name, 'Calculator');
    assert.deepEqual(g.apps.calculator.args, ['--x=*']);
  });

  it('warns about a bare process basename and accepts it', () => {
    const g = parseGuiConfig({ apps: { calculator: { path: 'C:\\Windows\\System32\\calc.exe', processes: ['CalculatorApp.exe'] } } }, { platform: 'win32' });
    assert.deepEqual(g.apps.calculator.processes, ['CalculatorApp.exe']);
    assert.equal(g.warnings.length, 1);
    assert.match(g.warnings[0], /gui\.apps\.calculator\.processes.*CalculatorApp\.exe.*bare name/);
  });

  it('refuses malformed keys, with the key path named', () => {
    const bad = [
      [{ nope: 1 }, /unknown key "gui\.nope"/],
      [{ apps: { Calc: '/usr/bin/x' } }, /gui\.apps\.Calc/],
      [{ apps: { calc: { path: '/usr/bin/x', colour: 'red' } } }, /unknown key "gui\.apps\.calc\.colour"/],
      [{ apps: { calc: 'relative/x' } }, /absolute path/],
      [{ apps: { calc: '/usr/../bin/x' } }, /"\.\."/],
      [{ apps: { calc: '/usr/bin/x\u2215y' } }, /lookalike/],
      [{ screenshot: { max_width: 100 } }, /gui\.screenshot\.max_width must be an integer from 320 to 1920/],
      [{ live_view: { max_frame_bytes: 200000 } }, /gui\.live_view\.max_frame_bytes/],
      [{ lease: { default_minutes: 30, max_minutes: 20 } }, /default_minutes must not exceed gui\.lease\.max_minutes/],
      [{ apps: { calc: { path: '/usr/bin/x', processes: Array(17).fill('/usr/bin/y') } } }, /at most 16/],
      [{ enabled: 'yes' }, /gui\.enabled must be true or false/],
      ['on', /gui must be a mapping/]
    ];
    for (const [raw, re] of bad) assert.throws(() => parseGuiConfig(raw, { platform: 'linux', file: '/etc/king-louie/node.yaml' }), re, JSON.stringify(raw));
  });

  it('needs an .exe on Windows', () => {
    assert.throws(() => parseGuiConfig({ apps: { calc: 'C:\\Tools\\calc.bat' } }, { platform: 'win32' }), /\.exe/);
    assert.throws(() => parseGuiConfig({ apps: { calc: '\\\\server\\share\\calc.exe' } }, { platform: 'win32' }), /absolute path/);
  });

  it('exposes its key lists', () => {
    assert.deepEqual(GUI_KEYS.top, ['enabled', 'apps', 'screenshot', 'live_view', 'lease']);
  });
});

describe('node.yaml gui:', () => {
  it('loadNodeConfig parses gui and lists it in NODE_YAML_KEYS', () => {
    assert.ok(NODE_YAML_KEYS.top.includes('gui'));
    assert.deepEqual(NODE_YAML_KEYS.gui, GUI_KEYS.top);
    const appPath = process.platform === 'win32' ? 'C:\\Windows\\System32\\notepad.exe' : '/usr/bin/gedit';
    const config = configDirWith(`name: mac\nprofile: agent\ngui:\n  apps:\n    notes: '${appPath}'\n`);
    const node = loadNodeConfig({ adminConfigDir: config, adminUid: UID, geteuid: () => -1 });
    assert.equal(node.gui.enabled, true);
    assert.equal(node.gui.apps.notes.path, appPath);
  });

  it('a runbook node.yaml with gui loads, with gui off', () => {
    const config = configDirWith('name: web-01\nprofile: runbook\ngui:\n  enabled: true\n');
    const node = loadNodeConfig({ adminConfigDir: config, adminUid: UID, geteuid: () => -1 });
    assert.equal(node.gui.enabled, false);
  });

  it('a malformed gui block stops the node from loading', () => {
    const config = configDirWith('name: mac\ngui:\n  bogus: 1\n');
    assert.throws(() => loadNodeConfig({ adminConfigDir: config, adminUid: UID, geteuid: () => -1 }), /unknown key "gui\.bogus"/);
  });

  it('no node.yaml at all still gives the gui defaults', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-gui-none-'));
    cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
    const node = loadNodeConfig({ adminConfigDir: base, adminUid: UID, geteuid: () => -1 });
    assert.equal(node.gui.enabled, true);
    assert.deepEqual(node.gui.apps, {});
  });
});
