// tests/renderer-case-nudge.test.js
// Static checks on how the renderer draws the case nudge (recall spec §9,
// stage H4, owner ruling R-H4-5): a status message with a button that opens
// the chat's own "New case" flow; text set with textContent; the button off
// while a reply runs and gone once the chat has a case or is an import.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { NUDGE_ACTION } = require('../src/cases/case-nudge');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const src = read('renderer.js');

function block(start, end) {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `found ${start}`);
  return src.slice(i, j);
}

const NO_HTML = /innerHTML|insertAdjacentHTML|outerHTML/;
const rules = () => block('const CASE_NUDGE_ACTION', '\nfunction refreshCaseNudgeButtons(');
const load = () => new Function(`${rules()}; return { CASE_NUDGE_ACTION, CASE_NUDGE_BUTTON_TEXT, isCaseNudge, caseNudgeOffered };`)();
const all = () => block('const CASE_NUDGE_ACTION', '\nfunction renderChatMessages(');
const draw = () => block('function renderCaseNudge(', '\nasync function openNewCaseFromNudge(');
const open = () => block('async function openNewCaseFromNudge(', '\nfunction renderChatMessages(');

describe('renderer: the case nudge', () => {
  it('knows the nudge by the action the send path stores, on a status message only', () => {
    const { CASE_NUDGE_ACTION, isCaseNudge } = load();
    assert.strictEqual(CASE_NUDGE_ACTION, NUDGE_ACTION);
    assert.strictEqual(isCaseNudge({ sender: 'status', text: 'x', meta: { action: 'convertToCase' } }), true);
    assert.strictEqual(isCaseNudge({ sender: 'status', text: 'x' }), false);
    assert.strictEqual(isCaseNudge({ sender: 'status', text: 'x', meta: { action: 'other' } }), false);
    assert.strictEqual(isCaseNudge({ sender: 'status', text: 'x', action: 'convertToCase' }), false);
    // Only the host writes status rows; a reply or the owner's message that
    // carries the same field is drawn as what it is.
    assert.strictEqual(isCaseNudge({ sender: 'assistant', text: 'x', meta: { action: 'convertToCase' } }), false);
    assert.strictEqual(isCaseNudge({ sender: 'user', text: 'x', meta: { action: 'convertToCase' } }), false);
    assert.strictEqual(isCaseNudge(null), false);
  });

  it('the button is "Make this a case", absent for a chat with a case or a source', () => {
    const { CASE_NUDGE_BUTTON_TEXT, caseNudgeOffered } = load();
    assert.strictEqual(CASE_NUDGE_BUTTON_TEXT, 'Make this a case');
    assert.strictEqual(caseNudgeOffered({ id: 'a', title: 'Fence' }), true);
    assert.strictEqual(caseNudgeOffered({ id: 'a', caseId: 'case-lakeside' }), false);
    assert.strictEqual(caseNudgeOffered({ id: 'a', source: 'markdown-transcript' }), false);
    assert.strictEqual(caseNudgeOffered({ id: 'a', importedFromCase: true }), false);
    assert.strictEqual(caseNudgeOffered(null), false);
    assert.strictEqual(caseNudgeOffered(undefined), false);
  });

  it('draws the text and the button as text, never as HTML', () => {
    const body = draw();
    assert.match(body, /\.textContent = typeof message\.text === 'string' \? message\.text : '';/);
    assert.match(body, /button\.textContent = CASE_NUDGE_BUTTON_TEXT;/);
    assert.match(body, /button\.hidden = !caseNudgeOffered\(chat\);/);
    assert.match(body, /button\.disabled = appState\.activeResponses\.has\(chat\.id\);/);
    assert.doesNotMatch(all(), NO_HTML);
    assert.doesNotMatch(all(), /renderMarkdown|marked|DOMPurify/);
  });

  it('the chat render sends the nudge to renderCaseNudge and every other status message where it went', () => {
    const render = block('function renderChatMessages(', '\nfunction refreshUI(');
    const at = render.indexOf("if (message.sender === 'status') {");
    assert.ok(at >= 0);
    const branch = render.slice(at, render.indexOf("if (message.sender === 'toolUse')", at));
    assert.match(branch, /if \(isCaseNudge\(message\)\) \{\s+renderCaseNudge\(message, activeChat\);\s+return;\s+\}/);
    assert.match(branch, /addToolEventCompact\('Status', \{ message: message\.text \}, 'info', false\);/);
    assert.ok(branch.indexOf('isCaseNudge(') < branch.indexOf("addToolEventCompact('Status'"));
  });

  it('the button opens the chat\'s own "New case" flow, which keeps every attach rule', () => {
    const body = open();
    assert.match(body, /getElementById\('chat-case-select'\)/);
    assert.match(body, /select\.value = '__new__';/);
    assert.match(body, /select\.dispatchEvent\(new Event\('change'\)\);/);
    assert.match(body, /scrollIntoView\(/);
    assert.match(body, /appState\.activeResponses\.has\(chatId\)/, 'never while a reply runs');
    assert.doesNotMatch(all(), /electron\.cases\.(create|attach)\(/, 'the nudge creates and attaches nothing itself');
    assert.doesNotMatch(all(), /force/);
  });

  it('the button follows the chat: off while a reply runs, gone once the chat has a case', () => {
    const refresh = block('function refreshCaseNudgeButtons(', '\nfunction renderCaseNudge(');
    assert.match(refresh, /button\.hidden = !offered;/);
    assert.match(refresh, /button\.disabled = busy;/);
    assert.match(block('function setResponseActive(', '\n}\n'), /refreshCaseNudgeButtons\(\);/);
    assert.match(block('const adopt = async (updatedChat) => {', '\n  };'), /refreshCaseNudgeButtons\(\);/);
  });

  it('"Retry with…" stays on the reply, not on the nudge after it', () => {
    assert.ok(block('function renderRetryControl(', '\n}\n').includes("querySelectorAll('.message.assistant:not(.case-nudge)')"));
    assert.ok(draw().includes("messageDiv.className = 'message assistant tool-event high-stakes info case-nudge';"));
  });

  it('nothing sends the nudge to the model: the renderer never puts it in a message it sends', () => {
    assert.doesNotMatch(all(), /sendMessage\(|userInput/);
  });
});
