// tests/renderer-setup-view.test.js
// Static checks on the setup view (attach stage 2 spec §6.2, §6.3) and on the panes
// a window with no node shows: what the node, the CLI, a path or the old profile says
// reaches the DOM with textContent; a refusal is never drawn as "none".
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const src = read('renderer.js');
const html = read('index.html');
const preload = read('preload.js');
const css = read('styles.css');

function block(start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

const NO_HTML = /innerHTML|insertAdjacentHTML|outerHTML/;
const view = () => block('// -- setup view: start', '// -- setup view: end');

describe('the setup view', () => {
  it('sits beside the wizard and starts hidden', () => {
    const at = html.indexOf('<section id="setup-view"');
    assert.ok(at > 0 && html.indexOf('id="wizard-overlay"') > 0);
    assert.ok(html.slice(at, at + 80).includes('hidden'));
  });

  it('draws with textContent, the pre in a <pre>, and actions by id', () => {
    assert.doesNotMatch(view(), NO_HTML);
    assert.match(html, /<pre id="setup-pre"/);
    assert.match(view(), /`setup-action-\$\{action\.id\}`/);
  });

  it('every action id describeSetup can answer has a press', () => {
    const idsIn = (f) => [...read(f).matchAll(/\bid: '(\w+)'/g)].map((m) => m[1]);
    // The pane's other views: the setup draws its actions only for a pairing under way.
    const PANE_ONLY = new Set(['import', 'detach', 'unpair', 'standaloneOnce', 'nodeInstallCancel']);
    const fromPane = idsIn('src/desktop-bridge/pane-model.js').filter((id) => !PANE_ONLY.has(id)).map((id) => (id === 'pair' ? 'pairStart' : id));
    const ids = new Set([...idsIn('src/desktop-bridge/setup-flow.js'), ...fromPane]);
    assert.ok(ids.has('pairStart') && ids.has('skip') && ids.has('migrationApply'), 'the regex found them');
    for (const id of ids) {
      assert.match(view(), new RegExp(`\\b${id}:`), `no press for ${id}`);
    }
    assert.match(view(), /nodeInstall: \(\) => desktop\.nodeInstall\(\{ confirmed: true \}\)/);
    assert.match(view(), /migrationApply: \(\) => desktop\.migrationApply\(\{ confirmed: true \}\)/);
    assert.match(view(), /pairRestartConfirm: \(\) => desktop\.pairRestartConfirm\(\{ confirmed: true \}\)/);
    assert.match(view(), /skip: \(\) => desktop\.setupFinish\(\{ skip: setupView\.answer\.step \}\)/);
  });

  it('holds no copy of the rules: it asks for the step and draws the answer', () => {
    assert.match(view(), /desktop\.setupStep\(\)/);
    assert.doesNotMatch(view(), /completedAt|finishedForNow|providersConfigured|oldProfile/);
  });

  it('while shown, the input, the sidebar and the settings button are hidden', () => {
    for (const sel of ['body.setup-active .container', 'body.setup-active #user-input', 'body.setup-active .sidebar', 'body.setup-active #open-settings-btn']) {
      assert.ok(css.includes(sel), `no rule for ${sel}`);
    }
  });

  it('long paths wrap or scroll inside the view', () => {
    const rules = css.slice(css.indexOf('/* --- Setup view'));
    assert.match(rules, /overflow-wrap: anywhere/);
    assert.match(rules, /\.setup-pre[^}]*overflow: auto/);
    assert.match(rules, /\.setup-pre[^}]*white-space: pre-wrap/);
  });

  it('the wizard does not open over a window with a setup', () => {
    const first = block('async function checkFirstRun(', '\nasync function startWizard(');
    assert.match(first, /launch/);
    assert.match(first, /'attached'/);
  });

  it('no keyboard shortcut reaches past the view', () => {
    const at = src.indexOf('// Ctrl+K');
    const near = src.slice(Math.max(0, at - 400), at);
    assert.match(near, /setup-active/);
  });

  it('the renderer asks for the step: the preload has no second reading of it', () => {
    assert.doesNotMatch(preload, /describeSetup/);
  });

  it('an attached launch hides the shell from the first parse; a standalone one is as it was', () => {
    const main = read('main.js');
    assert.match(main, /loadFile\('index\.html', attached \? \{ query: \{ launch: 'attached' \} \} : undefined\)/);
    const at = html.indexOf('<script src="renderer-helpers/launch-class.js"></script>');
    assert.ok(at > 0 && at < html.indexOf('</head>'), 'in the head, before the body is parsed');
    assert.match(css, /html\.setup-pending \.container/);
    assert.match(read('renderer-helpers/launch-class.js'), /launch=attached|get\('launch'\) === 'attached'/);
  });

  it('every way out of the first status shows the shell again', () => {
    const refresh = block('async function refreshServiceStatus(', '\nif (window.electron.desktop) {');
    assert.match(refresh, /status\.ok === false\) \{[\s\S]*?drawSetupAnswer\(\{ ok: false[\s\S]*?finally \{\n\s*revealShell\(\);[\s\S]*?\n\s*revealShell\(\);\n\s*return;\n\s*\}\n\s*serviceStatusRead = true;/);
    const setup = block('async function refreshSetupView(', 'async function drawSetupAnswer(');
    assert.strictEqual((setup.match(/revealShell\(\)/g) || []).length, 3);
    assert.match(setup, /finally \{\n\s*revealShell\(\);/);
  });

  it('a status that fails before any good read draws the failure screen, not an empty shell', () => {
    const refresh = block('async function refreshServiceStatus(', '\nif (window.electron.desktop) {');
    assert.match(refresh, /if \(!serviceStatusRead\) \{/);
    assert.match(refresh, /drawSetupAnswer\(\{ ok: false, error: status && status\.error \}, \{\}, \+\+setupView\.generation\)/);
  });

  it('the skills pane fetches on a press, and loading it does not', () => {
    assert.match(html, /id="skills-check-updates-btn"/);
    assert.match(src, /checkUpdates\(\{ fetch: true \}\)/);
    assert.match(src, /window\.electron\.skill\.checkUpdates\(\)\.then/, 'the load compares with what is known');
    assert.match(preload, /checkUpdates: \(payload = \{\}\) => ipcRenderer\.invoke\('skill:checkUpdates', \{ fetch: Boolean\(payload && payload\.fetch === true\) \}\)/);
  });

  it('a press leaves re-enabling to the draw, which honours a disabled action', () => {
    assert.doesNotMatch(view(), /btn\.disabled = false|setSetupPressesDisabled\(false\)/);
    assert.match(view(), /btn\.disabled = setupView\.pressing \|\| Boolean\(action\.disabled\)/);
  });

  it('the form takes no key for Ollama', () => {
    assert.match(view(), /option\[value="ollama"\]'\)\?\.remove\(\)/);
  });
});

describe('a node-supplied string in the webhook list', () => {
  const list = () => block('async function loadWebhookList(', '\nif (dom.webhookCreateBtn)');

  it('reaches the row by textContent', () => {
    assert.doesNotMatch(list().replace(/dom\.webhookList\.innerHTML = ''/g, ''), NO_HTML);
  });

  it('delete is unwrapped, so a refusal is said', () => {
    assert.match(src, /unwrapIpcResult\(await window\.electron\.webhook\.delete\(\{ id \}\)/);
  });
});

describe('panes with the node down say so', () => {
  it('skills: a refusal is not an empty list', () => {
    const skills = block('async function loadSkillSettingsTabs(', '\nfunction formatMemoryEntry(');
    assert.match(skills, /unwrapIpcResult\(await window\.electron\.skill\.listWithSettings\(\)/);
    assert.match(skills, /dom\.skillsStatus\.textContent = /);
  });

  it('settings that will not load: the hooks and the other panes are told or asked', () => {
    const load = block('async function loadSettings(', '\nfunction setProviderListFallback(');
    const failed = load.slice(load.indexOf('catch (error)'));
    assert.match(failed, /dom\.hooksStatus\.textContent = /);
    assert.match(failed, /loadSkillSettingsTabs\(\)/);
    assert.match(failed, /loadWorkflows\(\)/);
    assert.match(failed, /loadWebhookList\(\)/);
  });

  it('diagnostics says why it failed', () => {
    const run = block('if (dom.diagnosticsRunBtn) {', '/* --- Mesh Network');
    assert.match(run, /result\?\.error/);
  });

  it('a node that comes back fills the panes again', () => {
    const refresh = block('async function refreshServiceStatus(', '\nif (window.electron.desktop) {');
    assert.match(refresh, /loadSettings\(\)/);
  });
});
