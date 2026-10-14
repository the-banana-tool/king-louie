// tests/cases-orientation-unattended.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildOrientation } = require('../src/cases/orientation');
const { Brief, BriefError, USER_ONLY_FIELDS } = require('../src/cases/brief');
const { CaseStore } = require('../src/cases/case-store');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-orient2-')); dirs.push(d); return d; };

const meta = { title: 'Lakeside lot', slug: 'lakeside-lot', status: 'active' };
const brief = {
  data: {
    objective: 'Convert the lot to cash',
    materiality: { tell: ['offer'], ignore: ['voicemail'] },
    safeDefaults: ['hold-price'],
    gating: { complete: true }
  }
};
const at = (text, needle) => text.indexOf(needle);

describe('orientation sections for unattended cases', () => {
  it('puts blocking re-orientation triggers first, then notes from turn-start hooks', () => {
    const text = buildOrientation({
      meta,
      brief,
      triggers: [
        { kind: 'time-gap', key: 'time-gap', blocking: true, detail: 'The owner last spoke 9 hours ago.' },
        { kind: 'note', key: 'n', blocking: false, detail: 'Non-blocking hint' }
      ],
      hookNotes: ['Detours: none open.']
    });
    assert.ok(at(text, '## Re-orientation required') > 0);
    assert.ok(at(text, '## Re-orientation required') < at(text, '## Since last turn'));
    assert.ok(at(text, '## Since last turn') < at(text, '## Brief'));
    assert.match(text, /- The owner last spoke 9 hours ago\.\nCall Reorient before Recommend, Decide or Fail\./);
    assert.match(text, /## Since last turn\n- Detours: none open\./);
    assert.doesNotMatch(text, /Non-blocking hint/);
  });

  it('leaves the new sections out when there is nothing to say', () => {
    const text = buildOrientation({ meta, brief });
    for (const h of ['## Re-orientation required', '## Since last turn', '## Status', '## Open questions', '## Budget', '## Next wake-up']) {
      assert.strictEqual(text.includes(h), false, h);
    }
  });

  it('shows the status reason and the failure report while waiting for direction', () => {
    const text = buildOrientation({
      meta: { ...meta, status: 'needs-direction' },
      brief,
      statusReason: { kind: 'failure', by: 'runtime', ref: 'journal/2026-09-23-1405-failure.md', note: '', at: '2026-09-23T14:05:00.000Z' },
      failure: { file: 'journal/2026-09-23-1405-failure.md', text: '# Failure report — County listing\n\nClass: dead-end\n' }
    });
    assert.match(text, /## Status\n- needs-direction \(failure, by runtime, 2026-09-23T14:05:00\.000Z\)/);
    assert.match(text, /Waiting for the owner's direction/);
    assert.match(text, /### Failure report \(journal\/2026-09-23-1405-failure\.md\)\n# Failure report — County listing/);
    assert.ok(at(text, '## Status') < at(text, '## Brief'));
    const paused = buildOrientation({ meta: { ...meta, status: 'paused' }, brief, statusReason: { kind: 'budget', by: 'runtime', ref: 'usd', note: '', at: '2026-09-23T14:05:00.000Z' } });
    assert.match(paused, /- paused \(budget, by runtime, 2026-09-23T14:05:00\.000Z\)\n- Paused: only reading is available/);
  });

  it('lists open questions and marks a held question past its expiry as overdue', () => {
    const text = buildOrientation({
      meta,
      brief,
      now: new Date('2026-09-23T00:00:00Z'),
      questions: [
        { id: 'q-0001', kind: 'question', urgency: 'high', text: 'Is the well shared?', expiresAt: '2026-09-22T00:00:00Z', defaultOnSilence: 'hold' },
        { id: 'q-0002', kind: 'briefing', urgency: 'low', text: 'Open house on Saturday.', expiresAt: null, defaultOnSilence: 'hold' }
      ]
    });
    assert.match(text, /## Open questions to the owner\n- q-0001 \[question, high\] Is the well shared\? — OVERDUE, still holding\n- q-0002 \[briefing, low\] Open house on Saturday\.\nDo not assume answers to open questions\./);
  });

  it('shows budgets with their thresholds and the unpriced-tokens warning', () => {
    const text = buildOrientation({
      meta,
      brief,
      budget: {
        usd: { spent: 12.5, limit: 20, crossed: [50], unpricedTokens: 3400, grantedBy: [], ratio: 0.625 },
        deadline: { at: '2026-11-30', crossed: [], grantedBy: [], ratio: 0.4 },
        turnsPerDay: { spent: 3, limit: 48, day: '2026-09-23', crossed: [], grantedBy: [], ratio: 0.0625 },
        contactsPerDay: { spent: 0, limit: null, day: '2026-09-23', crossed: [], grantedBy: [], ratio: null },
        questionsPerDay: { spent: 0, limit: 6, day: '2026-09-23', crossed: [], grantedBy: [], ratio: 0 }
      }
    });
    assert.match(text, /## Budget\n- usd: 12\.5 of 20 \(passed 50 %\)\n- deadline 2026-11-30: 40 % of the time used\n- turnsPerDay: 3 of 48 today \(2026-09-23\)\n- questionsPerDay: 0 of 6 today \(2026-09-23\)\n- 3400 tokens on providers with no price table are not counted against the \$ budget\./);
    assert.doesNotMatch(text, /contactsPerDay/);
  });

  it('names the next wake-up', () => {
    const text = buildOrientation({ meta, brief, nextWakeup: { id: 'w-0001', kind: 'daily-orientation', nextAt: '2026-09-24T09:00:00.000Z' } });
    assert.match(text, /## Next wake-up\n- w-0001 daily-orientation at 2026-09-24T09:00:00\.000Z/);
  });

  it('shows materiality and safe defaults in the brief section', () => {
    const text = buildOrientation({ meta, brief });
    assert.match(text, /- Materiality: tell offer; ignore voicemail/);
    assert.match(text, /- Safe defaults on silence: hold-price/);
  });
});

describe('owner-only brief fields', () => {
  it('adds materiality, deadline and safeDefaults to the owner-only fields', () => {
    assert.deepStrictEqual([...USER_ONLY_FIELDS], ['why', 'hardConstraints', 'alreadyTried', 'materiality', 'deadline', 'safeDefaults']);
  });

  it('refuses them from the model and takes them from the owner', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'brief.md'), '---\nobjective: Sell\n---\n\n');
    const b = new Brief(d);
    assert.throws(() => b.update('materiality', { tell: ['offer'], ignore: [] }, { provenance: 'model' }), BriefError);
    assert.throws(() => b.update('deadline', '2027-03-01', { provenance: 'model' }), /owner/);
    assert.throws(() => b.append('safeDefaults', 'hold-price', { provenance: 'model' }), BriefError);
    b.update('safeDefaults', ['hold-price'], { provenance: 'user' });
    b.append('safeDefaults', 'no', { provenance: 'user' });
    assert.deepStrictEqual(b.read().data.safeDefaults, ['hold-price', 'no']);
    assert.throws(() => b.update('safeDefaults', 'hold-price', { provenance: 'user' }), /array of strings/);
  });

  it('new cases start with an empty safeDefaults list', async () => {
    const store = new CaseStore({ root: tmp() });
    const info = await store.create({ title: 'Lakeside lot', objective: 'Sell' });
    assert.deepStrictEqual(new Brief(info.dir).read().data.safeDefaults, []);
  });
});

// Cases stage 8 (spec §6.8, §10; R-C8-10): what the runtime gives the
// orientation, in an owner turn, a wake-up and over MCP alike.
describe('the runtime orientation shows progress', () => {
  const { CaseRuntime } = require('../src/cases');
  const HEADING = '## Progress (computed by King Louie; you cannot set these)';
  const ABANDONED = '## Abandoned approaches (do not retry one without a new fact; say what changed if you do)';
  const src = { kind: 'url', ref: 'https://records.example.org/1' };
  const section = (text, heading) => {
    const from = text.indexOf(heading);
    assert.ok(from >= 0, `${heading} is there`);
    return text.slice(from, text.indexOf('\n\n', from)).split('\n');
  };
  // Every file of the case outside .git, with its bytes.
  const snapshot = (dir) => {
    const out = {};
    const walk = (rel) => {
      for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const next = path.join(rel, entry.name);
        if (entry.isDirectory()) walk(next);
        else out[next.split(path.sep).join('/')] = fs.readFileSync(path.join(dir, next), 'utf8');
      }
    };
    walk('');
    return out;
  };
  async function active(opts = {}) {
    const rt = new CaseRuntime({ root: tmp(), ...opts });
    const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the Lakeside lot', objectiveBy: 'owner' });
    rt.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
    await rt.applyScopeAction(info.id, { action: 'add', text: 'Signed contract at or above the floor', by: 'owner-action' });
    rt.completeGating(info.id);
    return { rt, id: info.id, dir: info.dir };
  }

  it('a case with no stage files gets the section from the in-memory view, and nothing is written', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'Lakeside lot', objective: 'Sell the Lakeside lot' });
    rt.brief(info.id).append('successCriteria', 'Closed within 90 days', { provenance: 'model' });
    // As a case from before this stage: no scope record, no other stage file.
    fs.rmSync(path.join(info.dir, '.kl', 'scope.json'), { force: true });
    for (const name of ['scope.json', 'verification.json', 'abandoned.jsonl']) assert.strictEqual(fs.existsSync(path.join(info.dir, '.kl', name)), false, name);
    const before = snapshot(info.dir);
    const text = rt.orientation(info.id);
    assert.deepStrictEqual(section(text, HEADING).slice(0, 3), [
      HEADING,
      '- 0 of 0 confirmed criteria met · 1 proposed (not counted) · not ready to close (2 open)',
      '- sc-001 [proposed, not counted] Closed within 90 days'
    ]);
    assert.match(text, /\n- Ready to close: no\. Owner: objective-confirmed, criteria-confirmed \(sc-001\)\.\n/);
    assert.match(text, /\n- Objective: Sell the Lakeside lot \(from before progress was tracked; the owner has not confirmed it\)\n/);
    assert.match(text, /\n- Success criteria: 0 confirmed, 1 proposed; see Progress\n/);
    assert.strictEqual(text.includes('## Abandoned approaches'), false);
    assert.deepStrictEqual(snapshot(info.dir), before);
  });

  it('a turn starts from the computed states and the abandoned approaches', async () => {
    const { rt, id } = await active();
    const fact = rt.ledger(id).assert({ stmt: 'The contract was signed at 81,000', subject: 'contract', attr: 'signed', value: 81000, source: src });
    const row = rt.scopeView(id).criteria[0];
    rt.verification(id).addRecord({ criterion: row.id, criterionHash: row.hash, evidence: [fact.id], note: 'Signed.', turnId: 'turn-0', model: 'example-provider:example-model' });
    rt.brief(id).append('successCriteria', 'Title search is clean', { provenance: 'model' });
    await rt.systemAction(id, 'abandon an approach', () => {
      rt.abandoned(id).abandon({ approach: 'Cold-calling listing agents', why: 'All three declined the lot', factIds: [fact.id] }, { facts: rt.ledger(id).view().facts, decisions: [] });
    });
    const turn = await rt.beginTurn(id, { turnId: 'turn-1' });
    assert.deepStrictEqual(section(turn.orientation, HEADING), [
      HEADING,
      '- 1 of 1 confirmed criteria met · 1 proposed (not counted) · not ready to close (1 open)',
      `- sc-001 [met] Signed contract at or above the floor (evidence ${fact.id})`,
      '- sc-002 [proposed, not counted] Title search is clean',
      '- Ready to close: no. Owner: criteria-confirmed (sc-002).'
    ]);
    const abandoned = section(turn.orientation, ABANDONED);
    assert.strictEqual(abandoned.length, 2);
    assert.match(abandoned[1], new RegExp(`^- ab-0001 \\d{4}-\\d{2}-\\d{2} Cold-calling listing agents: All three declined the lot \\[${fact.id}\\]$`));
    assert.ok(turn.orientation.indexOf('## Load-bearing unknowns') < turn.orientation.indexOf(ABANDONED));
    await rt.endTurn(turn, { summary: 'read' });
    // What get_orientation and a wake-up read is the same text.
    assert.deepStrictEqual(section(rt.orientation(id), HEADING), section(turn.orientation, HEADING));
  });

  it('a case resumed by the owner\'s direction names its last failure report; Fail wrote no abandoned record', async () => {
    const { rt, id, dir } = await active();
    const turn = await rt.beginTurn(id, { turnId: 'turn-1' });
    rt.recordFailure(id, { failureClass: 'dead-end', what: 'County listing', tried: ['Listed on the county site'], why: 'No replies in 60 days', turnId: 'turn-1' });
    await rt.endTurn(turn, { summary: 'failed' });
    const report = rt.getCase(id).statusReason.ref;
    assert.match(report, /^journal\/.+-failure\.md$/);
    // Waiting for direction: the report is shown whole under Status, and the line is not there yet.
    assert.strictEqual(rt.orientation(id).includes('## Abandoned approaches'), false);
    const question = rt.questions(id).open().find((q) => q.payload?.type === 'direction');
    await rt.answerQuestion(id, question.id, { channel: 'in-app', text: 'Try the auction house instead' });
    assert.deepStrictEqual([rt.getCase(id).status, rt.getCase(id).statusReason.kind], ['active', 'direction']);
    assert.deepStrictEqual(section(rt.orientation(id), ABANDONED), [
      ABANDONED,
      `- The last failure report is ${report}. If the approach it describes is dropped, record it with Progress abandon.`
    ]);
    assert.deepStrictEqual(rt.abandoned(id).list().records, []);
    assert.strictEqual(fs.existsSync(path.join(dir, '.kl', 'abandoned.jsonl')), false);
  });

  it('a direction recorded from chat, whose fact names no failure report, gives no line', async () => {
    const { rt, id } = await active();
    const turn = await rt.beginTurn(id, { turnId: 'turn-1' });
    rt.recordFailure(id, { failureClass: 'dead-end', what: 'County listing', tried: ['Listed on the county site'], why: 'No replies in 60 days', turnId: 'turn-1' });
    const fact = rt.ledger(id).assert({
      stmt: 'Owner said to try the auction house', subject: 'direction', attr: '../brief', value: 'auction', provenance: 'user',
      source: { kind: 'user-message', ref: 'turn-1', quote: 'try the auction house', messageIndex: 0 }
    });
    assert.strictEqual(rt.applyOwnerFact(id, fact).applied, 'direction');
    assert.deepStrictEqual([rt.getCase(id).status, rt.getCase(id).statusReason.kind, rt.getCase(id).statusReason.ref], ['active', 'direction', fact.id]);
    assert.strictEqual(rt.orientation(id).includes('## Abandoned approaches'), false);
    await rt.endTurn(turn, { summary: 'resumed' });
  });

  it('a broken abandoned record or progress read costs one line, not the orientation', async () => {
    const { rt, id, dir } = await active();
    fs.appendFileSync(path.join(dir, '.kl', 'abandoned.jsonl'), 'not json\n');
    assert.deepStrictEqual(section(rt.orientation(id), ABANDONED), [ABANDONED, '- 1 line of the abandoned record could not be read and is not shown.']);
    rt.progress = () => { throw new Error('boom'); };
    rt.abandoned = () => { throw new Error('boom'); };
    const text = rt.orientation(id);
    assert.deepStrictEqual(section(text, HEADING), [HEADING, '- Progress could not be computed; the log says why.']);
    assert.deepStrictEqual(section(text, ABANDONED), [ABANDONED, '- The abandoned approaches could not be read; the log says why.']);
    assert.match(text, /## Facts \(active\)/);
  });

  it('a closed case shows the progress it closed with', async () => {
    const at = new Date('2026-10-21T09:00:00.000Z');
    const { rt, id } = await active({ now: () => at });
    rt.setStatus(id, 'done', { kind: 'owner', by: 'owner' });
    const lines = section(rt.orientation(id), HEADING);
    assert.strictEqual(lines[0], `${HEADING} — as of 2026-10-21`);
    assert.strictEqual(lines[2], '- sc-001 [unmet] Signed contract at or above the floor');
    assert.match(lines[lines.length - 1], /^- Ready to close: no\. Case: criteria-met \(sc-001\)\.$/);
  });
});
