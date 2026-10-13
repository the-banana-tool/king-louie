// tests/renderer-history-import.test.js
// Static checks on the import dialog (recall spec §10.2, stage H4): the
// wording, the warning the owner sees before confirming (R-H4-2), the
// markup, the channels in preload, and that the file's name, title, samples
// and errors (untrusted) are set with textContent, never parsed as HTML.
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

// A top-level element of index.html's container, by id, up to its closing tag.
function element(id) {
  const i = html.indexOf(`id="${id}"`);
  const j = html.indexOf('\n    </div>\n', i);
  assert.ok(i >= 0 && j > i, `found #${id}`);
  return html.slice(i, j);
}

const NO_HTML = /innerHTML|insertAdjacentHTML|outerHTML/;
const WARNING = 'This conversation becomes a chat that recall can search. If it contains passwords or keys, they become searchable too, and can be shown to the chat model. Its text is never sent to an embedding service or to typesafe.ai.';
const NO_CASE = 'An imported chat cannot be attached to a case.';

const texts = () => block('const IMPORT_WARNING_TEXT', '\nfunction closeImportDialog(');
const load = () => new Function(
  `${texts()}; return { IMPORT_WARNING_TEXT, IMPORT_NO_CASE_TEXT, importKindText, importSenderText, importTurnsText };`
)();
const dialog = () => block('function closeImportDialog(', '\nasync function commitImportDialog(');
const render = () => block('function renderImportDialog(', '\nasync function loadImportPreview(');
const commit = () => block('async function commitImportDialog(', '\n// --- Export chat as JSON ---');

describe('renderer: the import dialog says what it found', () => {
  it('names the kind in words, never the kind itself', () => {
    const { importKindText } = load();
    assert.strictEqual(importKindText('claude-code-jsonl'), 'Claude Code session');
    assert.strictEqual(importKindText('markdown-transcript'), 'Markdown transcript');
    assert.strictEqual(importKindText('king-louie-json'), 'King Louie export');
    for (const other of ['csv', '', 'toString', '__proto__', '<b>x</b>', null, undefined, 7, {}]) {
      assert.strictEqual(importKindText(other), 'Conversation', String(other));
    }
  });

  it('names the sender of a sample line from a fixed table', () => {
    const { importSenderText } = load();
    assert.strictEqual(importSenderText('user'), 'User');
    assert.strictEqual(importSenderText('assistant'), 'Assistant');
    for (const other of ['system', '', 'constructor', '<i>', null, undefined]) {
      assert.strictEqual(importSenderText(other), 'Other', String(other));
    }
  });

  it('counts the turns', () => {
    const { importTurnsText } = load();
    assert.strictEqual(importTurnsText(1), '1 turn');
    assert.strictEqual(importTurnsText(12), '12 turns');
    assert.strictEqual(importTurnsText(0), '0 turns');
    for (const other of ['12', -1, 1.5, null, undefined, NaN]) {
      assert.strictEqual(importTurnsText(other), 'Turns not counted', String(other));
    }
  });

  it('shows the name, kind, title, turns, five samples and the headings of a Markdown file, all as text', () => {
    const body = render();
    assert.match(body, /importKindText\(preview\.kind\)/);
    assert.match(body, /importTurnsText\(preview\.turns\)/);
    assert.match(body, /preview\.title/);
    assert.match(body, /preview\.sample/);
    assert.match(body, /preview\.roles/);
    assert.match(body, /preview\.patterns/);
    assert.match(body, /\.slice\(0, 5\)/);
    assert.match(body, /importSenderText\(/);
    assert.match(body, /\.textContent = /);
    assert.doesNotMatch(texts() + dialog() + commit(), NO_HTML);
    assert.doesNotMatch(texts() + dialog() + commit(), /renderMarkdown|marked|DOMPurify/);
  });

  it('a Markdown transcript has a select of the patterns that fit; a change previews again', () => {
    assert.match(render(), /preview\.kind === 'markdown-transcript'/);
    assert.match(render(), /document\.createElement\('select'\)/);
    assert.match(render(), /loadImportPreview\(select\.value\)/);
    assert.match(dialog(), /window\.electron\.history\.previewImport\(/);
  });
});

describe('renderer: what the owner sees before confirming an import', () => {
  it('R-H4-2: the dialog\'s warning', () => {
    const { IMPORT_WARNING_TEXT } = load();
    assert.strictEqual(IMPORT_WARNING_TEXT, WARNING);
    assert.match(render(), /dom\.importChatWarning\.textContent = IMPORT_WARNING_TEXT;/, 'every render sets it');
    assert.doesNotMatch(src, /importChatWarning\.(hidden|remove|style|className|classList)/, 'nothing hides it');
    const markup = element('import-chat-dialog');
    assert.ok(markup.includes(`<p class="import-chat-warning" id="import-chat-warning">${WARNING}</p>`), 'the markup carries the same sentence');
    assert.ok(markup.indexOf('id="import-chat-warning"') < markup.indexOf('id="import-chat-commit-btn"'), 'above the Import button');
  });

  it('R-H4-7: an imported chat cannot be attached to a case', () => {
    const { IMPORT_NO_CASE_TEXT } = load();
    assert.strictEqual(IMPORT_NO_CASE_TEXT, NO_CASE);
    assert.ok(element('import-chat-dialog').includes(`id="import-chat-no-case">${NO_CASE}</p>`));
    assert.match(render(), /dom\.importChatNoCase\.textContent = IMPORT_NO_CASE_TEXT;/);
  });

  it('index.html has the button beside Export and the dialog, hidden', () => {
    const markup = element('import-chat-dialog');
    assert.match(markup, /id="import-chat-dialog"[^>]* hidden>/);
    for (const id of ['import-chat-preview', 'import-chat-state', 'import-chat-error', 'import-chat-cancel-btn', 'import-chat-open-btn', 'import-chat-commit-btn']) {
      assert.match(markup, new RegExp(`id="${id}"`), id);
    }
    assert.match(markup, /id="import-chat-commit-btn"[^>]*>Import</);
    const exportAt = html.indexOf('id="export-chat-btn"');
    const importAt = html.indexOf('id="import-chat-btn"');
    assert.ok(exportAt > 0 && importAt > exportAt, 'after the export button');
    assert.strictEqual(html.slice(exportAt, importAt).split('\n').length, 2, 'on the next line');
    assert.match(html.slice(importAt, html.indexOf('\n', importAt)), /title="Import a conversation…"/);
  });

  it('nothing is stored before the Import click', () => {
    assert.doesNotMatch(dialog(), /commitImport\(/, 'picking and previewing never commit');
    assert.match(commit(), /window\.electron\.history\.commitImport\(/);
    assert.match(src, /dom\.importChatCommitBtn\.addEventListener\('click', commitImportDialog\);/);
    assert.strictEqual(src.split('history.commitImport(').length, 2, 'one caller');
    assert.strictEqual(src.split('commitImportDialog(').length, 2, 'called only by the click');
  });

  it('a file already imported offers its chat and no Import button', () => {
    const body = render();
    assert.match(body, /This file was already imported\./);
    assert.match(body, /dom\.importChatCommitBtn\.hidden = /);
    assert.match(body, /dom\.importChatOpenBtn\.hidden = /);
    assert.match(body, /preview\.existingChatId/);
  });

  it('an unreachable service shows the preview and disables Import', () => {
    const body = render();
    assert.match(body, /The service is not reachable; the preview is shown, but the chat cannot be imported now\./);
    assert.match(body, /preview\.serviceUnreachable/);
    assert.match(body, /dom\.importChatCommitBtn\.disabled = /);
  });

  it('Import is one call with a busy state; a refusal is shown as text and the new chat is selected', () => {
    const body = commit();
    assert.match(body, /Importing…/);
    assert.match(body, /result\?\.error/);
    assert.match(body, /showImportError\(/);
    assert.match(body, /selectImportedChat\(result\.chatId\)/);
    assert.match(dialog(), /handleSelectChat\(chatId\)/);
    assert.doesNotMatch(body, /progress/i);
  });

  it('the command list has the entry beside "Export as JSON"', () => {
    const list = block('const commandPaletteActions = [', '\n];');
    const lines = list.split('\n');
    const at = lines.findIndex((l) => l.includes("name: 'Export as JSON'"));
    assert.ok(at >= 0);
    assert.match(lines[at + 1], /name: 'Import a conversation…'/);
    assert.match(lines[at + 1], /import-chat-btn/);
  });

  it('preload exposes pick, preview and commit, and none of the batch channels', () => {
    for (const [name, channel] of [['pickImport', 'history:import.pick'], ['previewImport', 'history:import.preview'], ['commitImport', 'history:import.commit']]) {
      assert.match(preload, new RegExp(`${name}: `), name);
      assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), channel);
    }
    for (const word of ['begin', 'append', 'finish', 'lookup']) {
      assert.ok(!preload.includes(`history:import.${word}`), word);
    }
    assert.doesNotMatch(src, /history\.(beginImport|appendImport|finishImport|lookupImport)/);
  });
});
