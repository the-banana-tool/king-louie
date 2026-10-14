// tests/e2e/case-progress.test.js — cases stage 8 (spec §8.3; plan Task 17):
// the case panel's Progress block and the close card, in the real app. The
// case is built before launch with the real stores: one confirmed criterion
// that is unmet, one the model proposed, and an open close proposal. A press
// on the panel's Confirm makes the proposed one count; "Keep working" on the
// close card settles it and the case stays active.
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/case-progress.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchApp, closeApp, evaluate, waitFor } = require('./helpers');
const { CaseRuntime } = require('../../src/cases');
const { closeQuestionText, CLOSE_TYPE } = require('../../src/cases/verify/questions');
const { readinessFingerprint } = require('../../src/cases/verify/readiness');

let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitAvailable = false; }

const card = (id) => `.chat-question-card[data-question-id="${id}"]`;
const row = (id) => `#case-progress-rows .case-progress-row[data-criterion-id="${id}"]`;

describe('E2E: case progress', { skip: gitAvailable ? false : 'git is not on PATH' }, () => {
  let ctx;
  let casesRoot;
  let caseId;
  let closeId;

  before(async () => {
    casesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-progress-'));
    const rt = new CaseRuntime({ root: casesRoot });
    const info = await rt.createCase({ title: 'E2E progress lot', objective: 'Sell the lot', objectiveBy: 'owner' });
    caseId = info.id;
    rt.brief(caseId).update('why', 'Cash is needed for another repair', { provenance: 'user' });
    await rt.applyScopeAction(caseId, { action: 'add', text: 'Signed contract at or above the floor', by: 'owner-action' });
    rt.completeGating(caseId);
    rt.brief(caseId).append('successCriteria', 'Title search is clean', { provenance: 'model' });
    // The close proposal as the Progress tool writes it (the tool itself
    // refuses while sc-001 is unmet; the owner's card is what is tested).
    const p = rt.progress(caseId);
    const q = rt.createQuestion(caseId, {
      kind: 'question',
      urgency: 'normal',
      text: closeQuestionText(rt.getCase(caseId), p, 'The contract is close.'),
      options: [{ id: 'done', label: 'Mark done' }, { id: 'keep', label: 'Keep working' }],
      defaultOnSilence: 'hold',
      payload: { type: CLOSE_TYPE, key: CLOSE_TYPE, mcpAnswerable: false, disclosable: false, fingerprint: readinessFingerprint(p.readiness), turnId: 'turn-1' }
    }, { charge: false });
    closeId = q.id;
    const at = new Date(Date.now() - 60000).toISOString();
    const messages = [
      { id: 'm-1', sender: 'user', text: 'Work the lot.', timestamp: at },
      { id: 'm-q1', sender: 'assistant', text: `E2E progress lot: ${closeId}`, timestamp: at, question: { caseId, questionId: closeId } }
    ];
    const chats = [{ id: 'case-chat', title: 'E2E progress lot', caseId, createdAt: at, updatedAt: at, messages }];
    ctx = await launchApp({
      env: { KL_CASES_ROOT: casesRoot },
      seed: { 'chat-data.json': { onboardingComplete: true, activeChatId: 'case-chat', chats } }
    });
    await waitFor(ctx, `!!document.getElementById('new-chat-btn')`);
    await evaluate(ctx, `document.getElementById('wizard-skip-btn')?.click(); true`);
  });

  after(async () => {
    await closeApp(ctx);
    fs.rmSync(casesRoot, { recursive: true, force: true });
  });

  it('the panel shows the summary and a proposed row; Confirm makes it count as unmet', async () => {
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await waitFor(ctx, `!!document.querySelector('${row('sc-002')} .case-progress-confirm')`, 20000);
    assert.match(await evaluate(ctx, `document.getElementById('case-progress-summary').textContent`),
      /^0 of 1 confirmed criteria met · 1 unmet · 1 proposed \(not counted\) · not ready to close/);
    assert.strictEqual(await evaluate(ctx, `document.querySelector('${row('sc-002')} .case-progress-tag').textContent`), 'proposed');
    assert.strictEqual(await evaluate(ctx, `document.querySelector('${row('sc-001')} .case-progress-tag').textContent`), 'unmet');

    await evaluate(ctx, `document.querySelector('${row('sc-002')} .case-progress-confirm').click(); true`);
    await waitFor(ctx, `document.querySelector('${row('sc-002')} .case-progress-tag')?.textContent === 'unmet'`, 20000);
    assert.strictEqual(await evaluate(ctx, `!!document.querySelector('${row('sc-002')} .case-progress-confirm')`), false);
    assert.match(await evaluate(ctx, `document.getElementById('case-progress-summary').textContent`), /^0 of 2 confirmed criteria met · 2 unmet · not ready to close/);
    const scope = JSON.parse(fs.readFileSync(path.join(casesRoot, 'e2e-progress-lot', '.kl', 'scope.json'), 'utf8'));
    const entry = scope.criteria.find((e) => e.id === 'sc-002');
    assert.ok(entry, 'the press is in the scope record');
    assert.deepStrictEqual([entry.state, entry.confirmed.by, entry.confirmed.channel], ['confirmed', 'owner-action', 'in-app']);
  });

  it('the close card shows the summary, an open item and its two buttons; "Keep working" settles it and the case stays active', async () => {
    // The card's live part is redrawn on case:changed after the panel's press.
    await waitFor(ctx, `/^0 of 2 /.test(document.querySelector('${card(closeId)} .case-progress-live-close .case-progress-summary')?.textContent || '')`, 20000);
    assert.match(await evaluate(ctx, `document.querySelector('${card(closeId)} .case-progress-live-close .case-progress-summary').textContent`),
      /^0 of 2 confirmed criteria met · 2 unmet · not ready to close/);
    const items = await evaluate(ctx, `[...document.querySelectorAll('${card(closeId)} .case-progress-item')].map((li) => li.textContent)`);
    assert.ok(items.some((t) => /sc-001/.test(t)), JSON.stringify(items));
    const buttons = await evaluate(ctx, `[...document.querySelectorAll('${card(closeId)} .chat-question-option-btn')].map((b) => [b.dataset.optionId, b.textContent])`);
    assert.deepStrictEqual(buttons, [['done', 'Mark done'], ['keep', 'Keep working']]);

    await evaluate(ctx, `document.querySelector('${card(closeId)} .chat-question-option-btn[data-option-id="keep"]').click(); true`);
    await waitFor(ctx, `/Keep working$/.test(document.querySelector('${card(closeId)} .chat-question-outcome')?.textContent || '')`, 20000);
    assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('${card(closeId)} .chat-question-option-btn').length`), 0);
    const rt = new CaseRuntime({ root: casesRoot });
    assert.strictEqual(rt.getCase(caseId).status, 'active');
    assert.ok(rt.questions(caseId).get(closeId).answer, 'the press was recorded');
  });
});
