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
});
