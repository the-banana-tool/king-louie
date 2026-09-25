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
