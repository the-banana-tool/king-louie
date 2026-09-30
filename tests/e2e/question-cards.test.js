// tests/e2e/question-cards.test.js — management surfaces §3.4: a case's
// questions are cards in the case's chat. A pressed card answers with its
// buttons; a spoken card answered elsewhere redraws as answered; a question
// the runtime asks while the app runs is posted to the chat and drawn live.
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/question-cards.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchApp, closeApp, evaluate, waitFor } = require('./helpers');
const { CaseStore } = require('../../src/cases/case-store');

let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitAvailable = false; }

const card = (id) => `.chat-question-card[data-question-id="${id}"]`;

describe('E2E: question cards in the case chat', { skip: gitAvailable ? false : 'git is not on PATH' }, () => {
  let ctx;
  let casesRoot;
  let caseDir;
  let caseId;
  const at = new Date(Date.now() - 60000).toISOString();
  const base = {
    caseId: null, createdAt: at, expiresAt: null, defaultOnSilence: 'hold', deliveries: [], answer: null, closed: null, notes: []
  };
  const records = [
    { ...base, id: 'q-0001', kind: 'approval', urgency: 'normal', text: 'Approve listing the lakeside lot with the county?',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }], payload: { type: 'ask', mcpAnswerable: true } },
    { ...base, id: 'q-0002', kind: 'question', urgency: 'normal', text: 'How often should I check the listing?',
      options: [{ id: 'weekly', label: 'Weekly' }, { id: 'monthly', label: 'Monthly' }], payload: { type: 'ask', mcpAnswerable: true },
      notes: [{ at, text: 'The first report goes out on Monday.' }] },
    { ...base, id: 'q-0003', kind: 'question', urgency: 'normal', text: 'The case spent its usd budget and is paused. Reply with a new limit to continue.',
      options: [], payload: { type: 'budget-grant', budget: 'usd', spent: 5, limit: 5, mcpAnswerable: false, key: 'budget-grant:usd' } },
    // A detour's similar-case follow-up (router.js). q-0000 keeps the next
    // id the runtime gives at q-0004.
    { ...base, id: 'q-0000', kind: 'question', urgency: 'normal', text: 'A similar case is open: "Garden shed". Create a new case "Build a garden shed" anyway?',
      options: [{ id: 'create-anyway', label: 'Create anyway' }, { id: 'attach-1', label: 'Attach to "Garden shed"' }],
      payload: { type: 'detour-similar', detourId: 'd-0002', blocks: false, targets: { 'create-anyway': null, 'attach-1': 'garden-shed' }, mcpAnswerable: false, key: 'detour:d-0002' } }
  ];

  before(async () => {
    casesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-qcards-'));
    const info = await new CaseStore({ root: casesRoot }).create({ title: 'E2E cards lot', objective: 'Sell the lot' });
    caseDir = info.dir;
    caseId = info.id;
    fs.mkdirSync(path.join(caseDir, '.kl', 'questions'), { recursive: true });
    for (const r of records) fs.writeFileSync(path.join(caseDir, '.kl', 'questions', `${r.id}.json`), JSON.stringify({ ...r, caseId }));
    const messages = [
      { id: 'm-1', sender: 'user', text: 'Work the lakeside lot.', timestamp: at },
      ...records.map((r, i) => ({ id: `m-q${i + 1}`, sender: 'assistant', text: `E2E cards lot: ${r.id}\n\n${r.text}`, timestamp: at, question: { caseId, questionId: r.id } }))
    ];
    const chats = [{ id: 'case-chat', title: 'E2E cards lot', caseId, createdAt: at, updatedAt: at, messages }];
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

  function readFacts() {
    return fs.readFileSync(path.join(caseDir, 'facts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('draws a pressed approval with Approve/Reject, and a click answers it in-app', async () => {
    await waitFor(ctx, `document.querySelectorAll('${card('q-0001')} .chat-question-option-btn').length === 2`, 20000);
    const labels = await evaluate(ctx, `[...document.querySelectorAll('${card('q-0001')} .chat-question-option-btn')].map((b) => b.textContent)`);
    assert.deepStrictEqual(labels, ['Approve', 'Reject']);
    assert.strictEqual(await evaluate(ctx, `document.querySelector('${card('q-0001')} .case-question-text').textContent`), records[0].text);

    await evaluate(ctx, `document.querySelector('${card('q-0001')} .chat-question-option-btn[data-option-id="approve"]').click(); true`);
    await waitFor(ctx, `/via in-app: Approve$/.test(document.querySelector('${card('q-0001')} .chat-question-outcome')?.textContent || '')`, 20000);
    assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('${card('q-0001')} button').length`), 0);
    const fact = readFacts().find((f) => f.source?.kind === 'question' && f.source.ref === 'q-0001');
    assert.ok(fact, 'the press became a fact');
    assert.deepStrictEqual([fact.provenance, fact.source.channel], ['user', 'in-app']);
  });

  it('shows a spoken question\'s options and "Reply below", and redraws it when it is answered elsewhere', async () => {
    await waitFor(ctx, `!!document.querySelector('${card('q-0002')}.is-spoken .chat-question-hint')`, 20000);
    assert.deepStrictEqual(
      await evaluate(ctx, `[...document.querySelectorAll('${card('q-0002')} .chat-question-option')].map((o) => o.textContent)`),
      ['1. Weekly', '2. Monthly']
    );
    assert.strictEqual(await evaluate(ctx, `document.querySelector('${card('q-0002')} .chat-question-hint').textContent`), 'Reply below.');
    // A note the runtime put on the question (F2) is on the card, as it was on the panel's.
    assert.strictEqual(await evaluate(ctx, `document.querySelector('${card('q-0002')} .case-question-note').textContent`), records[1].notes[0].text);
    assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('${card('q-0002')} button').length`), 0);

    // Not through the card: the main process answers it, as any other
    // surface would, and the case:changed notification redraws the card.
    const r = await evaluate(ctx, `window.electron.cases.answerQuestion({ caseId: '${caseId}', questionId: 'q-0002', optionId: 'weekly' })`);
    assert.strictEqual(r.ok, true);
    await waitFor(ctx, `/: Weekly$/.test(document.querySelector('${card('q-0002')} .chat-question-outcome')?.textContent || '')`, 20000);
  });

  it('posts a question the runtime asks while the app runs to the case chat, drawn live', async () => {
    // An unusable grant reply makes the runtime ask a fresh budget-grant
    // question (answer-handlers.js), which is posted at creation.
    await waitFor(ctx, `!!document.querySelector('${card('q-0003')} .chat-question-send')`, 20000);
    assert.strictEqual(await evaluate(ctx, `document.querySelector('${card('q-0003')} .chat-question-send').textContent`), 'Grant');
    await evaluate(ctx, `(() => {
      const c = document.querySelector('${card('q-0003')}');
      c.querySelector('.chat-question-input').value = 'lots';
      c.querySelector('.chat-question-send').click();
      return true;
    })()`);
    await waitFor(ctx, `!!document.querySelector('${card('q-0003')} .chat-question-outcome')`, 20000);
    await waitFor(ctx, `!!document.querySelector('${card('q-0004')} .chat-question-send')`, 20000);
    assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('${card('q-0004')}').length`), 1);

    const stored = await evaluate(ctx, `window.electron.chat.get('case-chat').then((r) => (r.chat || r).messages.filter((m) => m.question).map((m) => m.question.questionId))`);
    assert.deepStrictEqual(stored, ['q-0001', 'q-0002', 'q-0003', 'q-0000', 'q-0004']);
  });

  it('draws a detour\'s similar-case question as pressed, with "Create anyway" and "Attach to" buttons', async () => {
    await waitFor(ctx, `document.querySelectorAll('${card('q-0000')} .chat-question-option-btn').length === 2`, 20000);
    assert.ok(await evaluate(ctx, `document.querySelector('${card('q-0000')}').classList.contains('is-pressed')`));
    const buttons = await evaluate(ctx, `[...document.querySelectorAll('${card('q-0000')} .chat-question-option-btn')].map((b) => [b.dataset.optionId, b.textContent])`);
    assert.deepStrictEqual(buttons, [['create-anyway', 'Create anyway'], ['attach-1', 'Attach to "Garden shed"']]);
    assert.strictEqual(await evaluate(ctx, `document.querySelector('${card('q-0000')} .case-question-text').textContent`), records[3].text);
    assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('${card('q-0000')} .chat-question-hint').length`), 0);
  });

  it('a press refused because the question was settled meanwhile redraws the card as it is now', async () => {
    // Closed behind the window's back (no notification): the card still
    // offers Grant until a press is refused.
    const file = path.join(caseDir, '.kl', 'questions', 'q-0004.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...rec, closed: { at: new Date().toISOString(), reason: 'superseded', by: 'system' } }));
    await evaluate(ctx, `(() => {
      const c = document.querySelector('${card('q-0004')}');
      c.querySelector('.chat-question-input').value = '20';
      c.querySelector('.chat-question-send').click();
      return true;
    })()`);
    await waitFor(ctx, `/^Closed .*\\(superseded\\)$/.test(document.querySelector('${card('q-0004')} .chat-question-outcome')?.textContent || '')`, 20000);
    assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('${card('q-0004')} button').length`), 0);
    assert.ok(await evaluate(ctx, `(document.querySelector('${card('q-0004')} .case-question-error')?.textContent || '').length > 0`));
  });
});
