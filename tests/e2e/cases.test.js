// tests/e2e/cases.test.js
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/cases.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchApp, closeApp, evaluate, waitFor } = require('./helpers');

let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitAvailable = false; }

describe('E2E: cases', { skip: gitAvailable ? false : 'git is not on PATH' }, () => {
  let ctx;
  let casesRoot;
  const savedRoot = process.env.KL_CASES_ROOT;

  before(async () => {
    // helpers.launchApp passes process.env to the app, so case repos land in
    // a temp dir instead of the real profile.
    casesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-cases-'));
    process.env.KL_CASES_ROOT = casesRoot;
    ctx = await launchApp();
    await waitFor(ctx, `!!document.getElementById('new-chat-btn')`);
    await evaluate(ctx, `document.getElementById('wizard-skip-btn')?.click(); true`);
  });

  after(async () => {
    await closeApp(ctx);
    if (savedRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedRoot;
    fs.rmSync(casesRoot, { recursive: true, force: true });
  });

  it('creates a case from Chat Info, attaches it, and shows its orientation', async () => {
    await evaluate(ctx, `document.getElementById('new-chat-btn').click(); true`);
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await waitFor(ctx, `!!document.getElementById('chat-case-select')`);

    await evaluate(ctx, `(() => {
      const s = document.getElementById('chat-case-select');
      s.value = '__new__';
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await waitFor(ctx, `!document.getElementById('chat-case-new-title').closest('[hidden]')`);
    await evaluate(ctx, `(() => {
      document.getElementById('chat-case-new-title').value = 'E2E lakeside lot';
      document.getElementById('chat-case-create-btn').click();
      return true;
    })()`);

    await waitFor(ctx, `(() => {
      const s = document.getElementById('chat-case-select');
      return s && s.value && s.value !== '__new__';
    })()`);
    await evaluate(ctx, `document.getElementById('chat-case-orientation-btn').click(); true`);
    await waitFor(ctx, `(document.getElementById('chat-case-orientation')?.textContent || '').includes('E2E lakeside lot')`);

    const slugs = fs.readdirSync(casesRoot);
    assert.deepStrictEqual(slugs, ['e2e-lakeside-lot']);
    assert.ok(fs.existsSync(path.join(casesRoot, 'e2e-lakeside-lot', 'facts.jsonl')));
  });

  it('shows a missing case and lets the owner detach it', async () => {
    // Depends on the case created and attached by the test above.
    const moved = `${casesRoot}-moved`;
    fs.renameSync(path.join(casesRoot, 'e2e-lakeside-lot'), moved);
    try {
      // Close and reopen Chat Info so the section renders again.
      await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
      await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
      await waitFor(ctx, `(() => {
        const s = document.getElementById('chat-case-select');
        return !!s && (s.selectedOptions[0]?.textContent || '').startsWith('Missing case (');
      })()`);
      const state = await evaluate(ctx, `({
        error: document.getElementById('chat-case-error').textContent,
        orientationHidden: document.getElementById('chat-case-orientation-btn').hidden
      })`);
      assert.match(state.error, /no longer in the cases folder/);
      assert.strictEqual(state.orientationHidden, true);

      await evaluate(ctx, `(() => {
        const s = document.getElementById('chat-case-select');
        s.value = '';
        s.dispatchEvent(new Event('change'));
        return true;
      })()`);
      await waitFor(ctx, `(() => {
        const s = document.getElementById('chat-case-select');
        return !!s && s.value === '' && ![...s.options].some((o) => o.textContent.startsWith('Missing case'));
      })()`);
    } finally {
      fs.rmSync(moved, { recursive: true, force: true });
    }
  });

  it('shows a seeded question in the panel and the bar, and answering it records an owner fact', async () => {
    // The chat is detached by the test above; attach a new case.
    await evaluate(ctx, `(() => {
      const s = document.getElementById('chat-case-select');
      s.value = '__new__';
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await waitFor(ctx, `!document.getElementById('chat-case-new-title').closest('[hidden]')`);
    await evaluate(ctx, `(() => {
      document.getElementById('chat-case-new-title').value = 'E2E question case';
      document.getElementById('chat-case-create-btn').click();
      return true;
    })()`);
    // Case creation runs git init/add/commit under the hood, which can take
    // over a second; wait for the select to reflect the attached case (the
    // same signal the earlier "creates a case" test uses) before relying on
    // getActiveChat().caseId, instead of racing on facts.jsonl alone.
    await waitFor(ctx, `(() => {
      const s = document.getElementById('chat-case-select');
      return s && s.value && s.value !== '__new__';
    })()`);
    await waitFor(ctx, `!!document.getElementById('case-unattended-section')`);
    const dir = path.join(casesRoot, 'e2e-question-case');
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'facts.jsonl')); i += 1) await new Promise((r) => setTimeout(r, 100));

    const record = {
      id: 'q-0001', kind: 'question', caseId: 'seeded', text: 'Is the well on the lot shared with the neighbour?',
      options: [], urgency: 'normal', createdAt: new Date().toISOString(), expiresAt: null, defaultOnSilence: 'hold',
      deliveries: [], payload: { type: 'ask', mcpAnswerable: true }, answer: null, closed: null, notes: []
    };
    fs.mkdirSync(path.join(dir, '.kl', 'questions'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.kl', 'questions', 'q-0001.json'), JSON.stringify(record));

    // Close and reopen Chat Info so the section and the bar render again.
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await waitFor(ctx, `!!document.querySelector('#case-question-list [data-question-id="q-0001"]')`);
    await waitFor(ctx, `!!document.querySelector('#case-questions-bar [data-question-id="q-0001"]')`);
    const shown = await evaluate(ctx, `document.querySelector('#case-questions-bar [data-question-id="q-0001"] .case-question-text').textContent`);
    assert.strictEqual(shown, record.text);

    await evaluate(ctx, `(() => {
      const card = document.querySelector('#case-questions-bar [data-question-id="q-0001"]');
      card.querySelector('.case-question-input').value = 'Yes, with the north lot';
      card.querySelector('.case-question-answer').click();
      return true;
    })()`);

    const factsFile = path.join(dir, 'facts.jsonl');
    let fact = null;
    for (let i = 0; i < 100 && !fact; i += 1) {
      const lines = fs.readFileSync(factsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      fact = lines.find((f) => f.source?.kind === 'question' && f.source.ref === 'q-0001') || null;
      if (!fact) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fact, 'the answer became a fact');
    assert.strictEqual(fact.provenance, 'user');
    assert.match(fact.stmt, /Yes, with the north lot/);
    await waitFor(ctx, `!document.querySelector('#case-questions-bar [data-question-id="q-0001"]')`);
  });
});
