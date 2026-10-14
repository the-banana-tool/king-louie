// tests/renderer-progress-text.test.js
// Cases stage 8 (plan Task 13): the case panel's Progress block and the
// scope and close cards show case text (criteria, the objective, abandoned
// approaches, fix lines, a verify note) as plain text only. A static check
// over the stage-8 block of renderer.js, like renderer-playbooks-text.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MARKER = '/* --- Cases stage 8: progress';
const END = '/* --- end of cases stage 8: progress --- */';

const source = () => fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

function progressBlock() {
  const src = source();
  const start = src.indexOf(MARKER);
  const end = src.indexOf(END, start);
  assert.ok(start >= 0 && end > start, 'the stage-8 block is found');
  return src.slice(start, end);
}

// The source of one top-level function of the block, up to the next one.
function functionSource(block, name) {
  const m = new RegExp(`\\n(?:async )?function ${name}\\(`).exec(block);
  assert.ok(m, `function ${name} is in the stage-8 block`);
  const rest = block.slice(m.index + 1);
  const next = /\n(?:async function|function|const|if|\/\*|\/\/) /.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

describe('renderer case progress text', () => {
  it('never parses text as HTML: innerHTML only clears, no insertAdjacentHTML, outerHTML or marked', () => {
    const block = progressBlock();
    const uses = block.match(/\.innerHTML\s*=[^;\n]*/g) || [];
    assert.ok(uses.length > 0, 'the block clears its container');
    for (const use of uses) assert.match(use, /^\.innerHTML\s*=\s*''$/, use);
    assert.doesNotMatch(block, /innerHTML\s*\+=/);
    assert.doesNotMatch(block, /insertAdjacentHTML|outerHTML|DOMParser|createContextualFragment|document\.write/);
    assert.doesNotMatch(block, /\bmarked\b|renderMarkdown|formatMessage/);
  });

  it('the panel block and the two cards are drawn by the stage-8 block', () => {
    const block = progressBlock();
    const src = source();
    functionSource(block, 'renderCaseProgressSection');
    functionSource(block, 'fillCaseProgressLive');
    // The panel has the slot, and the question card hands the two types over.
    assert.match(src, /case-progress-section/);
    const card = src.slice(src.indexOf('function fillChatQuestionCard('), src.indexOf('function refreshChatQuestionCards('));
    assert.match(card, /caseProgressCardLive\(q, 'scope'\)/);
    assert.match(card, /caseProgressCardLive\(q, 'close'\)/);
    assert.match(block, /'scope-confirm'/);
    assert.match(block, /'close-proposal'/);
    assert.doesNotMatch(card, /innerHTML|insertAdjacentHTML|outerHTML/);
  });

  it('each evidence id is drawn with its provenance', () => {
    const block = progressBlock();
    const draw = functionSource(block, 'caseProgressEvidenceList');
    // One line per entry: its id and, in words, where it comes from.
    assert.match(draw, /caseProgressProvenance\(e\)/);
    assert.match(draw, /textContent/);
    const words = functionSource(block, 'caseProgressProvenance');
    assert.match(words, /\.provenance/);
    for (const text of ['from the owner', 'sourced', 'reported by an executor']) assert.ok(block.includes(`'${text}'`), text);
    // Every place that reads a row's evidence draws it through that one function.
    const reads = block.match(/[^\n]*\.evidence\b[^\n]*/g) || [];
    assert.ok(reads.length >= 1, 'a row draws its evidence');
    for (const line of reads) assert.match(line, /caseProgressEvidenceList\(/, line);
    // The panel and both cards draw a criterion through the one row function.
    assert.match(functionSource(block, 'caseProgressRow'), /caseProgressEvidenceList\(row\.evidence\)/);
    for (const name of ['renderCaseProgressSection', 'caseProgressCloseCard', 'caseProgressScopeCard']) {
      assert.match(functionSource(block, name), /caseProgressRow\(row\)/, name);
    }
  });

  it('the state tag is text, set with textContent from the state name', () => {
    const block = progressBlock();
    const tag = functionSource(block, 'caseProgressStateTag');
    assert.match(tag, /\.textContent = state;/);
    for (const state of ['met', 'stale', 'failing', 'unmet', 'proposed']) assert.ok(block.includes(`'${state}'`), state);
  });

  it('a button sends the hash its row was drawn with, and a stale one says so', () => {
    const block = progressBlock();
    assert.match(block, /hash: row\.hash/);
    assert.ok(block.includes('This changed; check it again.'));
    assert.match(block, /SCOPE_STALE/);
    assert.ok(block.includes('from before progress was tracked'));
    assert.ok(block.includes('changed outside the app'));
    assert.ok(block.includes('Closed before progress was tracked.'));
  });

  // Owner ruling 2026-10-13: "Check now" runs a verify pass on the owner's press.
  it('Check now is shown for an open case, is disabled while a pass runs, and shows the result line as text', () => {
    const block = progressBlock();
    const check = functionSource(block, 'caseProgressCheckRow');
    assert.match(check, /caseButton\('Check now'/);
    assert.match(check, /window\.electron\.cases\.verifyNow\(\{ caseId \}\)/);
    // Disabled while this press, or any check or turn of the case, runs.
    assert.match(check, /caseProgressChecks\.has\(caseId\)/);
    assert.match(check, /\.disabled = /);
    assert.match(check, /\.textContent = /);
    assert.doesNotMatch(check, /innerHTML/);
    // While it runs the row has a Stop, which is the chat's own Stop.
    assert.match(check, /caseButton\('Stop'/);
    assert.match(check, /window\.electron\.chat\.stopResponse\(chat\.id\)/);
    // A check never swaps the chat's Send for Stop (R-C8-11: a message sent
    // meanwhile wins), on the notification and on the read at chat switch.
    const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    assert.match(renderer, /if \(payload\.source === 'check'\) return;\s+if \(payload\.running\) appState\.runningCaseTurns\.add/);
    assert.match(renderer, /state\?\.running && state\.source !== 'check'/);
    // A pass that lands after the reply says so with what: 'progress', and
    // the block is drawn again then.
    assert.match(block, /const CASE_PROGRESS_REDRAW = \[[^\]]*'progress'[^\]]*\]/);
    assert.match(block, /CASE_PROGRESS_REDRAW\.includes\(payload\.what\)[\s\S]{0,400}renderCaseProgressSection\(chat, slot\)/);
    // Only an open case gets the row.
    const section = functionSource(block, 'renderCaseProgressSection');
    assert.match(section, /if \(editable\) container\.appendChild\(caseProgressCheckRow\(/);
    // The preload sends the case id and nothing else.
    const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    assert.match(preload, /ipcRenderer\.invoke\('case:verifyNow', \{ caseId: payload\.caseId \}\)/);
  });

  // Cases stage 8 (R-C8-3): the check command's row.
  it('the check command row is text, offers nothing while checks are off, and sends only a command or approved: false', () => {
    const block = progressBlock();
    const row = functionSource(block, 'caseProgressCommandRow');
    assert.doesNotMatch(row, /innerHTML|insertAdjacentHTML|marked/);
    // The command is case text: an element's text, never markup.
    assert.match(row, /caseProgressEl\('span', 'case-progress-text case-progress-command-text', check\.command\)/);
    // Off: the reason, then nothing else.
    assert.match(row, /if \(!check\.enabled\) \{[\s\S]*?return box;\s+\}/);
    assert.ok(row.indexOf('return box;') < row.indexOf('setCheck'), 'no field and no button before the off return');
    assert.match(row, /waiting for your approval/);
    assert.match(row, /window\.electron\.cases\.setCheck\(\{ caseId, \.\.\.fields \}\)/);
    assert.match(row, /send\(\{ command: value \}\)/);
    assert.match(row, /send\(\{ approved: false \}\)/);
    // "Stop running it" only for an approved command; no button approves one.
    assert.match(row, /if \(check\.approved\) \{\s+const stop = caseButton\('Stop running it'/);
    assert.doesNotMatch(row, /approved: true/);
    // Only an open software-repo case gets the row (check is null otherwise).
    const section = functionSource(block, 'renderCaseProgressSection');
    assert.match(section, /if \(editable && p\.check\) container\.appendChild\(caseProgressCommandRow\(/);
    const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    assert.match(preload, /ipcRenderer\.invoke\('case:setCheck', \{ caseId: payload\.caseId, command: payload\.command \}\)/);
    assert.match(preload, /ipcRenderer\.invoke\('case:setCheck', \{ caseId: payload\.caseId, approved: false \}\)/);
  });

  it('the Done confirm shows the summary and the open items first, and the close card never disables its buttons for an open item', () => {
    const block = progressBlock();
    const src = source();
    functionSource(block, 'caseProgressCloseLines');
    const section = src.slice(src.indexOf('async function renderCaseUnattendedSection('), src.indexOf('/* --- Cases stage 5: related cases'));
    assert.match(section, /caseProgressCloseLines\(chat\.caseId\)/);
    assert.match(section, /showConfirmDialog\(action\.confirm, \{ before \}\)/);
    // The live part of a close card draws no control at all.
    const close = functionSource(block, 'caseProgressCloseCard');
    assert.doesNotMatch(close, /disabled|caseButton\(/);
  });
});
