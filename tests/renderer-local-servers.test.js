// tests/renderer-local-servers.test.js
// Static checks on Settings → Models' "Local servers" card (local inference
// spec 2026-10-13 §15; R-LI-21, R-LI-29, R-LI-31): the words for an
// address class and a guarantee grade, the add dialog's two fixed sentences,
// the read-only card in service mode, the profile card's local-only
// switches, and that every server name, model id, address and probe text
// is set with textContent, never parsed as HTML.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const src = read('renderer.js');
const html = read('index.html');
const preload = read('preload.js');

function block(start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

const NO_HTML = /innerHTML|insertAdjacentHTML|outerHTML/;
const helpers = () => new Function(`${block('function formatCompactUsd(', '/* --- end local inference L1 helpers --- */')}
  return { localServerClassWords, localServerGradeText, LOCAL_ADD_SENTENCES, LOCAL_CGNAT_SENTENCE, LOCAL_ADMIN_SENTENCE, localUsageLines, pickerChoiceView };`)();
const ui = () => block('/* --- Local inference L1: the UI (spec 2026-10-13 §15) --- */', '\nfunction renderCatalogSettings() {');

describe('renderer: local servers in the Models tab', () => {
  it('words for each address class, and an address it cannot place', () => {
    const { localServerClassWords } = helpers();
    assert.strictEqual(localServerClassWords('loopback'), 'this machine');
    assert.strictEqual(localServerClassWords('lan'), 'your network');
    assert.strictEqual(localServerClassWords('cgnat'), 'your overlay network');
    assert.strictEqual(localServerClassWords('public'), 'an address King Louie cannot place');
    assert.strictEqual(localServerClassWords(undefined), 'an address King Louie cannot place');
    assert.strictEqual(localServerClassWords('toString'), 'an address King Louie cannot place');
  });

  it('R-LI-30: words for the guarantee grade', () => {
    const { localServerGradeText } = helpers();
    assert.strictEqual(localServerGradeText('guarantee'), 'private chats can use it');
    assert.strictEqual(localServerGradeText('cost-only'), 'for cost only: a private chat needs https with a pinned certificate');
    assert.strictEqual(localServerGradeText(undefined), 'for cost only: a private chat needs https with a pinned certificate');
  });

  it('R-LI-21: the add dialog says a forwarding server cannot be detected', () => {
    const { LOCAL_ADD_SENTENCES } = helpers();
    assert.deepStrictEqual([...LOCAL_ADD_SENTENCES], [
      'This server runs on hardware you control. King Louie will treat its models as local.',
      'King Louie cannot tell whether this server sends your text on. Mark it local only if it does not.'
    ]);
    const dialog = block('function showAddLocalServerDialog(', '\nasync function addLocalServerFlow(');
    assert.match(dialog, /for \(const sentence of LOCAL_ADD_SENTENCES\)/);
    assert.match(dialog, /p\.textContent = sentence/);
  });

  it('R-LI-29: an address in 100.64.0.0/10 needs the overlay confirmation, which sends allowCgnat', () => {
    const dialog = block('function showAddLocalServerDialog(', '\nasync function addLocalServerFlow(');
    assert.match(dialog, /LOCAL_CGNAT_SENTENCE/);
    assert.match(dialog, /Confirm that this is your own overlay network\./);
    assert.match(dialog, /allowCgnat: true/);
    // The range test the dialog uses, taken from its source and run here.
    const literal = /\/\^https\?:\\\/\\\/100\\\.\(6\[4-9\]\|\[7-9\]\\d\|1\[01\]\\d\|12\[0-7\]\)\\\.\//.exec(dialog);
    assert.ok(literal, 'the dialog tests the address against 100.64.0.0/10');
    const test = new Function(`return ${literal[0]};`)();
    for (const a of ['http://100.64.0.1', 'http://100.127.255.1', 'https://100.100.1.2']) assert.ok(test.test(a), a);
    for (const a of ['http://100.63.0.1', 'http://100.128.0.1', 'http://10.0.0.1']) assert.ok(!test.test(a), a);
  });

  it('is read-only in service mode and attached, with the administrator\'s sentence', () => {
    const { LOCAL_ADMIN_SENTENCE } = helpers();
    assert.strictEqual(LOCAL_ADMIN_SENTENCE, 'Set by the administrator in service.json.');
    const render = block('function renderLocalServers(', '\nasync function renderLocalUsage(');
    assert.match(render, /const readOnly = Boolean\(view\?\.adminOnly\)/);
    assert.match(render, /dom\.modelsLocalActions\.hidden = readOnly/);
    assert.match(render, /setLocalStatus\(LOCAL_ADMIN_SENTENCE\)/);
    const card = block('function localServerCard(', '\nfunction renderLocalServers(');
    assert.match(card, /if \(!readOnly\) \{\n\s+actions\.appendChild\(button\('Check again', 'recheck'\)\);\n\s+actions\.appendChild\(button\('Remove', 'remove'/);
  });

  it('shows each server and model with textContent only', () => {
    assert.doesNotMatch(ui(), NO_HTML);
    const card = block('function localServerCard(', '\nfunction renderLocalServers(');
    assert.match(card, /title\.textContent = server\.name \|\| server\.id/);
    const model = block('function localModelLine(', '\nfunction localServerCard(');
    assert.match(model, /name\.textContent = m\.id/);
    assert.match(model, /runs on Ollama\\'s cloud: not local/);
    assert.match(model, /tools: \$\{r\.toolCall === 'yes' \? 'yes' : r\.toolCall === 'no' \? 'no' : 'not known'\}/);
  });

  it('"Check again" shows the old and new addresses, then asks, then pins what it showed', () => {
    const recheck = block('async function recheckLocalServer(', '\nasync function removeLocalServer(');
    assert.match(recheck, /Was: \$\{before\}/);
    assert.match(recheck, /Now: \$\{after\}/);
    assert.match(recheck, /confirm: true, expected: first\.resolved\.addresses/);
  });

  it('R-LI-31: "Use this Ollama as a local server" adds it, then lists the profile targets before moving them', () => {
    const flow = block('async function useOllamaAsLocal(', '\n// A profile card');
    assert.match(flow, /fromOllama\(\{\}\)/);
    assert.match(flow, /Move these profile models onto the local server\?/);
    assert.match(flow, /fromOllama\(\{ rewrite: true \}\)/);
    assert.ok(html.includes('id="models-local-ollama-btn"'));
  });

  it('a profile card has a local-only switch per role; turning one off asks, then uses its own channel', () => {
    const row = block('function localOnlyRow(', '\nasync function setLocalOnly(');
    assert.doesNotMatch(row, NO_HTML);
    assert.match(row, /has no local model: its calls are refused\./);
    assert.match(row, /fails over to a hosted model\./);
    const set = block('async function setLocalOnly(', '\nfunction wireLocalInferenceUi(');
    assert.match(set, /showConfirmDialog\(`Let \$\{role\} in \$\{profile\.name\} use hosted models again\?`\)/);
    assert.match(set, /window\.electron\.models\.local\.unsetLocalOnly\(\{ profileId: profile\.id, role \}\)/);
    assert.match(set, /localOnly: \[\.\.\.new Set\(\[\.\.\.\(profile\.localOnly \|\| \[\]\), role\]\)\]/);
    assert.match(src, /card\.appendChild\(localOnlyRow\(profile\)\)/);
    assert.match(preload, /'models:local\.unsetLocalOnly', \{ profileId: payload\.profileId, role: payload\.role \}/);
  });

  it('a picker shows a local model with its server, and in a private chat disables a hosted one', () => {
    const { pickerChoiceView } = helpers();
    const names = new Map([['workstation', 'Workstation']]);
    const local = { provider: 'local', model: 'workstation/qwen3:8b', name: 'qwen3:8b' };
    const hosted = { provider: 'openai', model: 'gpt-5.5', name: 'GPT-5.5' };
    assert.deepStrictEqual(pickerChoiceView(local, { names }), { text: 'qwen3:8b (local · Workstation)', disabled: false });
    assert.deepStrictEqual(pickerChoiceView(hosted, { names }), { text: 'GPT-5.5 (openai)', disabled: false });
    assert.deepStrictEqual(pickerChoiceView(hosted, { names, isPrivate: true }), { text: 'GPT-5.5 (openai): not local', disabled: true });
    assert.deepStrictEqual(pickerChoiceView(local, { names, isPrivate: true }), { text: 'qwen3:8b (local · Workstation)', disabled: false });
    assert.deepStrictEqual(pickerChoiceView({ ...hosted, inMain: true }, { names }), { text: 'GPT-5.5 (profile\'s main)', disabled: false });
  });

  it('local calls by server, at $0', () => {
    const { localUsageLines } = helpers();
    const names = new Map([['workstation', 'Workstation']]);
    assert.deepStrictEqual(localUsageLines({ workstation: { calls: 3, tokens: 1200 }, 'gpu-box': { calls: 1, tokens: 7 } }, names), [
      `gpu-box: 1 call, ${(7).toLocaleString()} tokens, $0.0000`,
      `Workstation: 3 calls, ${(1200).toLocaleString()} tokens, $0.0000`
    ]);
    assert.deepStrictEqual(localUsageLines(null, names), []);
  });

  it('the card is in the Models tab, and the four buttons\' channels are in preload', () => {
    assert.ok(html.includes('id="models-local-servers-card"'));
    assert.ok(html.includes('id="models-local-add-btn"'));
    for (const ch of ['models:local.list', 'models:local.add', 'models:local.remove', 'models:local.recheck', 'models:local.probe', 'models:local.fromOllama']) {
      assert.ok(preload.includes(`'${ch}'`), ch);
    }
  });
});
