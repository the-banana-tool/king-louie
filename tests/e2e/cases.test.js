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

  before(async () => {
    // launchApp itself now defaults KL_CASES_ROOT under the launch's own temp
    // profile (fix round 1, I2) and never inherits this process's env for it,
    // so this test's case repos are pointed at their own temp dir explicitly
    // through opts.env rather than by mutating process.env.
    casesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-cases-'));
    ctx = await launchApp({ env: { KL_CASES_ROOT: casesRoot } });
    await waitFor(ctx, `!!document.getElementById('new-chat-btn')`);
    await evaluate(ctx, `document.getElementById('wizard-skip-btn')?.click(); true`);
  });

  after(async () => {
    await closeApp(ctx);
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
    await waitFor(ctx, `!!document.getElementById('chat-case-new-input')`);
    await evaluate(ctx, `(() => {
      document.getElementById('chat-case-new-input').value = 'E2E lakeside lot';
      document.getElementById('chat-case-new-confirm').click();
      return true;
    })()`);
    await waitFor(ctx, `!document.getElementById('chat-case-new-dialog')`);

    await waitFor(ctx, `(() => {
      const s = document.getElementById('chat-case-select');
      return s && s.value && s.value !== '__new__';
    })()`);
    await evaluate(ctx, `document.getElementById('chat-case-orientation-btn').click(); true`);
    await waitFor(ctx, `(document.getElementById('chat-case-orientation')?.textContent || '').includes('E2E lakeside lot')`);

    // The cross-case index lives in <casesRoot>/.index (cases stage 5).
    // The contact host lock lives in <casesRoot>/.contact.lock (cases stage 4).
    const slugs = fs.readdirSync(casesRoot).filter((n) => !n.startsWith('.'));
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

  it('the case panel shows status and budget, and no questions: they are cards in the chat (management surfaces §3.5)', async () => {
    // The chat is detached by the test above; attach a new case.
    await evaluate(ctx, `(() => {
      const s = document.getElementById('chat-case-select');
      s.value = '__new__';
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await waitFor(ctx, `!!document.getElementById('chat-case-new-input')`);
    await evaluate(ctx, `(() => {
      document.getElementById('chat-case-new-input').value = 'E2E question case';
      document.getElementById('chat-case-new-confirm').click();
      return true;
    })()`);
    // Case creation runs git init/add/commit under the hood, which can take
    // over a second; wait for the select to reflect the attached case.
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

    // Close and reopen Chat Info so the panel renders again.
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await waitFor(ctx, `/^Status: /.test(document.getElementById('case-status-text')?.textContent || '')`);
    assert.strictEqual(await evaluate(ctx, `!!document.getElementById('case-grant-btn')`), true);
    assert.strictEqual(await evaluate(ctx, `!!document.getElementById('case-question-list')`), false);
    assert.strictEqual(await evaluate(ctx, `!!document.getElementById('case-questions-bar')`), false);
    assert.strictEqual(await evaluate(ctx, `!!document.querySelector('[data-question-id="q-0001"]')`), false);
  });

  it('shows related cases in the case panel, and no detours block', async () => {
    // The chat is attached to "E2E question case" by the test above. Seed a
    // second case, a relation and a routing proposal from this process.
    const { CaseRuntime } = require('../../src/cases');
    const rt = new CaseRuntime({ root: casesRoot });
    const attached = rt.getCase('e2e-question-case');
    const other = await rt.createCase({ title: 'E2E phone agent maintenance', objective: 'Keep the phone agent answering calls', force: true });
    rt.addRelation(attached.id, { id: other.id, relation: 'related' });
    const proposed = await rt.detours.propose(attached.id, { summary: 'Fix the phone agent status polling', reason: 'A different project' });
    assert.strictEqual(proposed.ok, true);

    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await waitFor(ctx, `!!document.getElementById('case-related-list')`);
    const lines = await evaluate(ctx, `[...document.querySelectorAll('#case-related-list li')].map((li) => li.textContent)`);
    assert.deepStrictEqual(lines, ['related: E2E phone agent maintenance (draft)']);
    assert.strictEqual(await evaluate(ctx, `!!document.getElementById('case-detours-section')`), false);
    assert.strictEqual(await evaluate(ctx, `!!document.getElementById('case-detour-d-0001')`), false);
  });
});
