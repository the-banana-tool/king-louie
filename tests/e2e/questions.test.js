// tests/e2e/questions.test.js — management surfaces §3.5: the Questions
// sidebar is gone (a case's questions are cards in its chat, see
// question-cards.test.js), and the contact policy is edited at
// Settings > Contact.
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/questions.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchApp, closeApp, evaluate, waitFor, openSettingsTab } = require('./helpers');
const { CaseStore } = require('../../src/cases/case-store');

let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitAvailable = false; }

describe('E2E: no questions sidebar; contact policy in Settings', { skip: gitAvailable ? false : 'git is not on PATH' }, () => {
  let ctx;
  let casesRoot;

  before(async () => {
    casesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-questions-'));
    // An open question in a case: the sidebar used to list it.
    const info = await new CaseStore({ root: casesRoot }).create({ title: 'E2E questions lot', objective: 'Sell the lot' });
    fs.mkdirSync(path.join(info.dir, '.kl', 'questions'), { recursive: true });
    fs.writeFileSync(path.join(info.dir, '.kl', 'questions', 'q-0001.json'), JSON.stringify({
      id: 'q-0001', kind: 'question', caseId: info.id, text: 'Is the well on the lakeside lot shared with the neighbour?',
      options: [], urgency: 'high', createdAt: new Date().toISOString(), expiresAt: null, defaultOnSilence: 'hold',
      deliveries: [], payload: { type: 'ask', mcpAnswerable: true }, answer: null, closed: null, notes: []
    }));
    ctx = await launchApp({ env: { KL_CASES_ROOT: casesRoot } });
    await waitFor(ctx, `!!document.getElementById('new-chat-btn')`);
    await evaluate(ctx, `document.getElementById('wizard-skip-btn')?.click(); true`);
  });

  after(async () => {
    await closeApp(ctx);
    fs.rmSync(casesRoot, { recursive: true, force: true });
  });

  it('has no Questions sidebar section, and no case-panel questions bar', async () => {
    await waitFor(ctx, `!!document.getElementById('chat-list')`);
    assert.strictEqual(await evaluate(ctx, `!!document.getElementById('questions-section')`), false);
    assert.strictEqual(await evaluate(ctx, `!!document.getElementById('case-questions-bar')`), false);
    assert.strictEqual(await evaluate(ctx, `typeof renderQuestionsSection`), 'undefined');
    assert.strictEqual(await evaluate(ctx, `!!document.querySelector('[data-question-id="q-0001"]')`), false);
  });

  it('edits the contact policy at Settings > Contact as it changes, keeping an away set meanwhile', async () => {
    await openSettingsTab(ctx, 'contact');
    await waitFor(ctx, `!!document.querySelector('.settings-tab-content.active[data-tab="contact"] #contact-ladder-high')`, 20000);
    assert.strictEqual(await evaluate(ctx, `!!document.getElementById('contact-policy-save')`), false, 'saves as it changes');
    assert.match(await evaluate(ctx, `document.getElementById('contact-away-note').textContent`), /^Not away\./);
    assert.ok(await evaluate(ctx, `document.querySelectorAll('#contact-policy-channels li').length`) > 0, 'channel readiness is listed');

    // Away set after the pane drew (as set_away would): a save keeps it.
    const until = new Date(Date.now() + 2 * 86400000).toISOString();
    const current = await evaluate(ctx, `window.electron.contact.getPolicy()`);
    const set = await evaluate(ctx, `window.electron.contact.setPolicy(${JSON.stringify({ ...current.policy, away: { mode: 'email-only', until } })})`);
    assert.strictEqual(set.ok, true, JSON.stringify(set));

    // A ladder line saves when it loses focus.
    await evaluate(ctx, `(() => {
      const el = document.getElementById('contact-ladder-high');
      el.focus();
      el.value = 'present, telegram@15, email@60';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.blur();
      return true;
    })()`);
    await waitFor(ctx, `window.electron.contact.getPolicy().then((r) => r.policy.ladders.high.length === 3 && r.policy.ladders.high[1].afterMin === 15)`, 20000);
    // Quiet hours save as they change.
    await evaluate(ctx, `(() => {
      for (const [id, v] of [['contact-quiet-start', '22:00'], ['contact-quiet-end', '07:00']]) {
        const el = document.getElementById(id);
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    })()`);
    await waitFor(ctx, `window.electron.contact.getPolicy().then((r) => r.policy.quietHours && r.policy.quietHours.end === '07:00')`, 20000);
    await waitFor(ctx, `document.getElementById('settings-save-state').textContent === 'Saved'`);
    const saved = await evaluate(ctx, `window.electron.contact.getPolicy()`);
    assert.deepStrictEqual(saved.policy.ladders.high, [{ channel: 'present', afterMin: 0 }, { channel: 'telegram', afterMin: 15 }, { channel: 'email', afterMin: 60 }]);
    assert.deepStrictEqual([saved.policy.quietHours.start, saved.policy.quietHours.end], ['22:00', '07:00']);
    assert.deepStrictEqual(saved.policy.away, { mode: 'email-only', until });
    await waitFor(ctx, `/^Away \\(email-only\\) until /.test(document.getElementById('contact-away-note').textContent)`);

    // A step that does not parse is refused beside its line; nothing is saved.
    const lowBefore = JSON.stringify(saved.policy.ladders.low);
    await evaluate(ctx, `(() => {
      const el = document.getElementById('contact-ladder-low');
      el.focus();
      el.value = 'email@soon';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.blur();
      return true;
    })()`);
    await waitFor(ctx, `(document.querySelector('.settings-field-error[data-for="contact-ladder-low"]')?.textContent || '').includes('is not a step')`);
    await new Promise((r) => setTimeout(r, 1000));
    const after = await evaluate(ctx, `window.electron.contact.getPolicy()`);
    assert.strictEqual(JSON.stringify(after.policy.ladders.low), lowBefore);
  });
});
