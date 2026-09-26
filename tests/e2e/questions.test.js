// tests/e2e/questions.test.js — cases stage 4 §3.8: a seeded question appears
// in #questions-section, is answered inline, and disappears.
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/questions.test.js
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

describe('E2E: questions section', { skip: gitAvailable ? false : 'git is not on PATH' }, () => {
  let ctx;
  let casesRoot;
  let caseDir;
  const record = {
    id: 'q-0001', kind: 'question', caseId: null, text: 'Is the well on the lakeside lot shared with the neighbour?',
    options: [], urgency: 'high', createdAt: new Date().toISOString(), expiresAt: null, defaultOnSilence: 'hold',
    deliveries: [], payload: { type: 'ask', mcpAnswerable: true }, answer: null, closed: null, notes: []
  };

  before(async () => {
    casesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-questions-'));
    const info = await new CaseStore({ root: casesRoot }).create({ title: 'E2E questions lot', objective: 'Sell the lot' });
    caseDir = info.dir;
    fs.mkdirSync(path.join(caseDir, '.kl', 'questions'), { recursive: true });
    fs.writeFileSync(path.join(caseDir, '.kl', 'questions', 'q-0001.json'), JSON.stringify({ ...record, caseId: info.id }));
    // M7: launchEnv (tests/e2e/helpers.js) pins KL_CASES_ROOT under the launch's
    // own temp profile and overrides anything inherited from process.env, so the
    // seeded root must be passed as an explicit env override, not just set on
    // process.env before launch.
    ctx = await launchApp({ env: { KL_CASES_ROOT: casesRoot } });
    await waitFor(ctx, `!!document.getElementById('new-chat-btn')`);
    await evaluate(ctx, `document.getElementById('wizard-skip-btn')?.click(); true`);
  });

  after(async () => {
    await closeApp(ctx);
    fs.rmSync(casesRoot, { recursive: true, force: true });
  });

  it('shows the seeded question, answers it inline, and the answer becomes an owner fact', async () => {
    await evaluate(ctx, `renderQuestionsSection(); true`);
    await waitFor(ctx, `!!document.querySelector('#questions-section [data-question-id="q-0001"]')`, 20000);
    const shown = await evaluate(ctx, `document.querySelector('#questions-section [data-question-id="q-0001"] .questions-text').textContent`);
    assert.strictEqual(shown, record.text);
    assert.strictEqual(await evaluate(ctx, `!!document.getElementById('questions-presence-dot')`), true);

    await evaluate(ctx, `(() => {
      const card = document.querySelector('#questions-section [data-question-id="q-0001"]');
      card.querySelector('.questions-input').value = 'Yes, with the north lot';
      card.querySelector('.questions-answer').click();
      return true;
    })()`);

    let fact = null;
    for (let i = 0; i < 100 && !fact; i += 1) {
      const lines = fs.readFileSync(path.join(caseDir, 'facts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      fact = lines.find((f) => f.source?.kind === 'question' && f.source.ref === 'q-0001') || null;
      if (!fact) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fact, 'the answer became a fact');
    assert.strictEqual(fact.provenance, 'user');
    await waitFor(ctx, `!document.querySelector('#questions-section [data-question-id="q-0001"]')`);
  });
});
