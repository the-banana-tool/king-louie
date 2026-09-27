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
      document.getElementById('chat-case-new-input').value = 'E2E deck repair quotes';
      document.getElementById('chat-case-playbook-example-contractor-quotes').checked = true;
      document.getElementById('chat-case-playbook-accept-budget').checked = true;
      document.getElementById('chat-case-new-confirm').click();
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

    // Update takes the same path: refused until the owner confirms that
    // playbook, then re-sent with its name and confirmSource.
    const updateIn = `[...${rowOf('property-sale')}.querySelectorAll('button')].find((b) => b.textContent === 'Update')`;
    await evaluate(ctx, `${updateIn}.click(); true`);
    await waitFor(ctx, `!!(${confirmIn('property-sale')})`, 30000);
    assert.match(await evaluate(ctx, `document.getElementById('case-playbooks-status').textContent`), /^The recorded source of "property-sale" .* Confirm it before/);
    await evaluate(ctx, `${confirmIn('property-sale')}.click(); true`);
    await waitFor(ctx, `!!document.querySelector('.rename-chat-modal')`);
    await evaluate(ctx, `document.querySelector('.rename-chat-modal .btn-primary').click(); true`);
    await waitFor(ctx, `document.getElementById('case-playbooks-status')?.textContent === 'property-sale is up to date.'`, 30000);
  });

  // Fix round 1: accepting a playbook's budget offer raises every limit it
  // offers, so the panel shows one row and one Accept per playbook and the
  // dialog names each change.
  it('offers the budget raises one playbook at a time, naming every limit the Accept changes', async () => {
    await evaluate(ctx, `document.getElementById('new-chat-btn').click(); true`);
    await evaluate(ctx, `document.getElementById('chat-info-btn').click(); true`);
    await waitFor(ctx, `!!document.getElementById('chat-case-select') && !document.getElementById('case-playbook-list')`);
    await evaluate(ctx, `(() => {
      const s = document.getElementById('chat-case-select');
      s.value = '__new__';
      s.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await waitFor(ctx, `!!document.getElementById('chat-case-playbook-example-contractor-quotes')`);
    await evaluate(ctx, `(() => {
      document.getElementById('chat-case-new-input').value = 'E2E gutter cleaning quotes without raises';
      document.getElementById('chat-case-playbook-example-contractor-quotes').checked = true;
      document.getElementById('chat-case-new-confirm').click();
      return true;
    })()`);
    // C5 may ask about the similar case the first test made: create anyway.
    await waitFor(ctx, `(() => {
      // The confirm opens on top of the New case dialog; both are modals.
      const m = [...document.querySelectorAll('.rename-chat-modal')].find((el) => /similar case/.test(el.textContent));
      if (m) m.querySelector('.btn-primary').click();
      const s = document.getElementById('chat-case-select');
      return s && s.value && s.value !== '__new__';
    })()`, 30000);
    const caseId = await evaluate(ctx, `document.getElementById('chat-case-select').value`);
    const dir = fs.readdirSync(casesRoot).filter((n) => !n.startsWith('.')).map((n) => path.join(casesRoot, n))
      .find((d) => yaml.load(fs.readFileSync(path.join(d, 'case.yaml'), 'utf8')).id === caseId);
    const budget = () => yaml.load(fs.readFileSync(path.join(dir, 'case.yaml'), 'utf8')).budget;
    assert.deepStrictEqual(budget(), { questionsPerDay: 6 }, 'only the value that is not a raise is applied without consent');

    const raiseRow = `document.querySelector('.playbook-raise[data-playbook="contractor-quotes"]')`;
    await waitFor(ctx, `!!${raiseRow}`, 15000);
    assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('.playbook-raise').length`), 1, 'one row per playbook');
    assert.strictEqual(await evaluate(ctx, `${raiseRow}.querySelectorAll('button').length`), 1, 'one Accept per playbook');
    await evaluate(ctx, `${raiseRow}.querySelector('button').click(); true`);
    await waitFor(ctx, `!!document.querySelector('.rename-chat-modal')`);
    const dialog = await evaluate(ctx, `document.querySelector('.rename-chat-modal').textContent`);
    assert.match(dialog, /usd 20 → 25/);
    assert.match(dialog, /contactsPerDay 20 → 30/);
    await evaluate(ctx, `document.querySelector('.rename-chat-modal .btn-primary').click(); true`);
    await waitFor(ctx, `!${raiseRow}`, 15000);
    assert.deepStrictEqual(budget(), { questionsPerDay: 6, usd: 25, contactsPerDay: 30 }, 'every listed limit is raised');
  });
});
