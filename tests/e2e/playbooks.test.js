// tests/e2e/playbooks.test.js
// Run with: unset ELECTRON_RUN_AS_NODE && node --test tests/e2e/playbooks.test.js
// Cases stage 6 spec §10 e2e: a case created with example:contractor-quotes
// asks its gating questions, and answering them clears the gating pass.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { execFileSync } = require('child_process');
const { launchApp, closeApp, evaluate, waitFor } = require('./helpers');

let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitAvailable = false; }

describe('E2E: playbooks', { skip: gitAvailable ? false : 'git is not on PATH' }, () => {
  let ctx;
  let casesRoot;
  let sourceRoot;

  before(async () => {
    // Ruling M4: launchApp pins KL_CASES_ROOT per launch and ignores this
    // process's env for it, so the temp root goes through opts.env. The
    // launch also gets its own temp --user-data-dir.
    casesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-playbooks-'));
    sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-pbsrc-'));
    ctx = await launchApp({ env: { KL_CASES_ROOT: casesRoot } });
    await waitFor(ctx, `!!document.getElementById('new-chat-btn')`);
    await evaluate(ctx, `document.getElementById('wizard-skip-btn')?.click(); true`);
  });

  after(async () => {
    await closeApp(ctx);
    fs.rmSync(casesRoot, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  });

  it('creates a case with contractor-quotes, asks its gating questions, and clears them once answered', async () => {
    await evaluate(ctx, `document.getElementById('new-chat-btn').click(); true`);
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await waitFor(ctx, `!!document.getElementById('chat-case-select')`);
    await evaluate(ctx, `(() => {
      const s = document.getElementById('chat-case-select');
      s.value = '__new__';
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await waitFor(ctx, `!!document.getElementById('chat-case-playbook-example-contractor-quotes')`);
    await evaluate(ctx, `(() => {
      document.getElementById('chat-case-new-title').value = 'E2E deck repair quotes';
      document.getElementById('chat-case-playbook-example-contractor-quotes').checked = true;
      document.getElementById('chat-case-playbook-accept-budget').checked = true;
      document.getElementById('chat-case-create-btn').click();
      return true;
    })()`);
    await waitFor(ctx, `(() => {
      const s = document.getElementById('chat-case-select');
      return s && s.value && s.value !== '__new__';
    })()`, 30000);
    await waitFor(ctx, `!!document.querySelector('#case-playbook-list [data-playbook="contractor-quotes"]')`, 15000);
    const row = await evaluate(ctx, `document.querySelector('#case-playbook-list [data-playbook="contractor-quotes"]').textContent`);
    assert.match(row, /contractor-quotes@1\.0\.0 \(vendored, ok\)/);
    await waitFor(ctx, `(document.getElementById('case-playbook-pending')?.textContent || '').startsWith('Waiting for your answers:')`);

    const caseId = await evaluate(ctx, `document.getElementById('chat-case-select').value`);
    const [slug] = fs.readdirSync(casesRoot).filter((n) => !n.startsWith('.'));
    const dir = path.join(casesRoot, slug);
    assert.ok(fs.existsSync(path.join(dir, 'playbooks', 'contractor-quotes', 'steps.md')));
    const meta = yaml.load(fs.readFileSync(path.join(dir, 'case.yaml'), 'utf8'));
    assert.strictEqual(meta.type, 'outreach');
    assert.deepStrictEqual(meta.budget, { usd: 25, contactsPerDay: 30, questionsPerDay: 6 }, 'raises accepted at create');

    // The owner fills the brief by editing brief.md (an owner edit, committed next turn).
    const briefFile = path.join(dir, 'brief.md');
    const text = fs.readFileSync(briefFile, 'utf8');
    const end = text.indexOf('\n---', 4);
    const data = yaml.load(text.slice(4, end));
    Object.assign(data, { objective: 'Get three comparable deck repair quotes', why: 'The deck is unsafe', successCriteria: ['Three quotes on the same scope'] });
    fs.writeFileSync(briefFile, `---\n${yaml.dump(data).trimEnd()}\n---\n\n`);

    const open = await evaluate(ctx, `window.electron.cases.questions({ caseId: ${JSON.stringify(caseId)} })
      .then((r) => r.questions.filter((q) => q.payload && q.payload.type === 'gating').map((q) => ({ id: q.id, options: q.options })))`);
    assert.strictEqual(open.length, 4, 'scope, labor-only, budget-ceiling and access-window');
    for (const q of open) {
      const answer = q.options && q.options.length ? { optionId: q.options[0].id } : { text: 'Replace twelve deck boards; weekday mornings; up to 3000' };
      const r = await evaluate(ctx, `window.electron.cases.answerQuestion(${JSON.stringify({ caseId, questionId: q.id, ...answer })})`);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
    }

    const listed = await evaluate(ctx, `window.electron.cases.playbooks({ caseId: ${JSON.stringify(caseId)} })`);
    assert.deepStrictEqual(listed.pendingGating, [], 'every required playbook question is answered');
    const facts = fs.readFileSync(path.join(dir, 'facts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((f) => f.kind === 'fact');
    const ceiling = facts.find((f) => f.subject === 'job' && f.attr === 'budget-ceiling');
    assert.strictEqual(ceiling.provenance, 'user');
    assert.strictEqual(ceiling.disclosable, false, 'a financial answer is not disclosable');
  });

  // Ruling T5-recorded, from the panel: a recorded local folder that no
  // allowlist entry covers is read on "Check for updates" only after the
  // owner confirms that one playbook. Runs on the case the test above made.
  it('offers "Confirm source" on the row of a recorded folder, and re-checks it once confirmed', async () => {
    const folder = path.join(sourceRoot, 'property-sale');
    fs.cpSync(path.join(__dirname, '..', '..', 'examples', 'playbooks', 'property-sale'), folder, { recursive: true });
    await evaluate(ctx, `(() => {
      document.getElementById('case-playbook-add-source').value = ${JSON.stringify(folder)};
      document.getElementById('case-playbook-add-btn').click();
      return true;
    })()`);
    const rowOf = (name) => `document.querySelector('#case-playbook-list [data-playbook="${name}"]')`;
    const confirmIn = (name) => `[...(${rowOf(name)}?.querySelectorAll('button') || [])].find((b) => b.textContent === 'Confirm source')`;
    await waitFor(ctx, `!!${rowOf('property-sale')}`, 30000);

    await evaluate(ctx, `document.getElementById('case-playbook-check-btn').click(); true`);
    await waitFor(ctx, `!!(${confirmIn('property-sale')})`, 30000);
    assert.match(await evaluate(ctx, `document.getElementById('case-playbooks-status').textContent`), /property-sale: The recorded source .* Confirm it before/);
    assert.strictEqual(await evaluate(ctx, `!!(${confirmIn('contractor-quotes')})`), false, 'an example source needs no confirmation');

    // Cancel sends nothing and keeps the offer.
    await evaluate(ctx, `${confirmIn('property-sale')}.click(); true`);
    await waitFor(ctx, `!!document.querySelector('.rename-chat-modal')`);
    assert.match(await evaluate(ctx, `document.querySelector('.rename-chat-modal').textContent`), /recorded folder of playbook property-sale/);
    await evaluate(ctx, `document.querySelector('.rename-chat-modal .btn:not(.btn-primary)').click(); true`);
    assert.strictEqual(await evaluate(ctx, `!!(${confirmIn('property-sale')})`), true);

    await evaluate(ctx, `${confirmIn('property-sale')}.click(); true`);
    await waitFor(ctx, `!!document.querySelector('.rename-chat-modal')`);
    await evaluate(ctx, `document.querySelector('.rename-chat-modal .btn-primary').click(); true`);
    await waitFor(ctx, `/^property-sale: up to date$/.test(document.getElementById('case-playbooks-status').textContent)`, 30000);
    assert.strictEqual(await evaluate(ctx, `!!(${confirmIn('property-sale')})`), false, 'the offer is used once');
  });
});
