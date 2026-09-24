// tests/cases-status.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  STATUSES, TRANSITIONS, ALLOWED, DENIED, READ_OPS, AUTONOMY_KEY, FAILURE_CLASSES,
  StatusError, canTransition, check
} = require('../src/cases/status');

const OPS = [
  'Ledger.assert', 'Ledger.infer', 'Ledger.unknown', 'Ledger.retract', 'Ledger.query',
  'Brief.read', 'Brief.update', 'Brief.append', 'Brief.completeGating',
  'Decide', 'Recommend', 'Reorient', 'Fail', 'Ask',
  'Plan', 'Executor.submit', 'Playbook.list', 'Playbook.read', 'Playbook.propose'
];

describe('status transitions', () => {
  it('names the six statuses and freezes the table', () => {
    assert.deepStrictEqual([...STATUSES], ['draft', 'active', 'needs-direction', 'paused', 'done', 'abandoned']);
    assert.ok(Object.isFrozen(TRANSITIONS));
    assert.ok(TRANSITIONS.every((t) => Object.isFrozen(t)));
  });

  it('allows every row of the spec table, with its by and kind', () => {
    const allowed = [
      ['draft', 'active', 'runtime', 'gating'],
      ['draft', 'abandoned', 'owner', 'owner'],
      ['active', 'needs-direction', 'runtime', 'failure'],
      ['active', 'paused', 'runtime', 'budget'],
      ['needs-direction', 'paused', 'runtime', 'budget'],
      ['active', 'paused', 'runtime', 'commit'],
      ['active', 'paused', 'owner', 'owner'],
      ['needs-direction', 'active', 'runtime', 'direction'],
      ['needs-direction', 'active', 'owner', 'direction'],
      ['paused', 'active', 'runtime', 'budget-grant'],
      ['paused', 'active', 'owner', 'owner'],
      ...['active', 'needs-direction', 'paused'].flatMap((from) => [
        [from, 'done', 'owner', 'owner'],
        [from, 'abandoned', 'owner', 'owner']
      ])
    ];
    for (const [from, to, by, kind] of allowed) {
      assert.strictEqual(canTransition(from, to, by, kind), true, `${from} -> ${to} (${by}, ${kind})`);
    }
  });

  it('refuses every other transition', () => {
    const refused = [
      ['draft', 'active', 'owner', 'owner'],
      ['draft', 'paused', 'runtime', 'budget'],
      ['draft', 'done', 'owner', 'owner'],
      ['draft', 'needs-direction', 'runtime', 'failure'],
      ['active', 'draft', 'owner', 'owner'],
      ['active', 'done', 'runtime', 'owner'],
      ['active', 'abandoned', 'runtime', 'owner'],
      ['active', 'paused', 'owner', 'budget'],
      ['needs-direction', 'active', 'owner', 'owner'],
      ['needs-direction', 'paused', 'owner', 'owner'],
      ['paused', 'active', 'runtime', 'direction'],
      ['paused', 'active', 'runtime', 'owner'],
      ['paused', 'active', 'owner', 'budget-grant'],
      ['paused', 'needs-direction', 'runtime', 'failure'],
      ['done', 'active', 'owner', 'owner'],
      ['done', 'abandoned', 'owner', 'owner'],
      ['abandoned', 'active', 'owner', 'owner']
    ];
    for (const [from, to, by, kind] of refused) {
      assert.strictEqual(canTransition(from, to, by, kind), false, `${from} -> ${to} (${by}, ${kind})`);
    }
  });

  it('checks only from/to/by when no kind is given', () => {
    assert.strictEqual(canTransition('active', 'paused', 'owner'), true);
    assert.strictEqual(canTransition('active', 'paused', 'someone-else'), false);
    assert.strictEqual(canTransition('paused', 'active'), true);
  });
});

describe('per-status rules', () => {
  it('active allows every op', () => {
    for (const op of OPS) assert.strictEqual(check('active', op), null, op);
  });

  it('draft refuses Recommend, Plan, Executor.submit and Fail only', () => {
    const refused = ['Recommend', 'Plan', 'Executor.submit', 'Fail'];
    for (const op of OPS) {
      const r = check('draft', op);
      if (refused.includes(op)) {
        assert.deepStrictEqual(r, { ok: false, error: 'Case is a draft: finish the gating pass (Brief completeGating) first.' }, op);
      } else {
        assert.strictEqual(r, null, op);
      }
    }
  });

  it('needs-direction refuses Plan, Recommend, Fail and Executor.submit, and names the failure report', () => {
    const reason = { kind: 'failure', ref: 'journal/2026-09-23-1405-failure.md' };
    for (const op of ['Plan', 'Recommend', 'Fail', 'Executor.submit']) {
      assert.deepStrictEqual(check('needs-direction', op, { reason }), {
        ok: false,
        error: "Case is waiting for the owner's direction on journal/2026-09-23-1405-failure.md. Report status or ask; do not plan or recommend."
      }, op);
    }
    for (const op of ['Ledger.assert', 'Ledger.query', 'Brief.update', 'Decide', 'Reorient', 'Ask']) {
      assert.strictEqual(check('needs-direction', op, { reason }), null, op);
    }
  });

  it('needs-direction allows Executor.submit only when the case autonomy grants it', () => {
    assert.strictEqual(check('needs-direction', 'Executor.submit', { autonomyAllows: true }), null);
    assert.strictEqual(check('needs-direction', 'Plan', { autonomyAllows: true }).ok, false);
  });

  it('paused allows only the read ops, including the C6 playbook reads', () => {
    for (const op of OPS) {
      const r = check('paused', op, { reason: { kind: 'budget', ref: 'usd' } });
      if (['Ledger.query', 'Brief.read', 'Playbook.list', 'Playbook.read'].includes(op)) {
        assert.strictEqual(r, null, op);
      } else {
        assert.deepStrictEqual(r, { ok: false, error: 'Case is paused (budget). Only reading is available.' }, op);
      }
    }
  });

  it('done allows the reads and Playbook.propose', () => {
    for (const op of OPS) {
      const r = check('done', op);
      if (['Ledger.query', 'Brief.read', 'Playbook.list', 'Playbook.read', 'Playbook.propose'].includes(op)) {
        assert.strictEqual(r, null, op);
      } else {
        assert.deepStrictEqual(r, { ok: false, error: 'Case is done. It is read-only.' }, op);
      }
    }
  });

  it('abandoned allows only the reads', () => {
    assert.strictEqual(check('abandoned', 'Playbook.read'), null);
    assert.deepStrictEqual(check('abandoned', 'Playbook.propose'), { ok: false, error: 'Case is abandoned. It is read-only.' });
    assert.deepStrictEqual(check('abandoned', 'Ledger.assert'), { ok: false, error: 'Case is abandoned. It is read-only.' });
  });

  it('refuses everything for an unknown status', () => {
    const r = check('archived', 'Ledger.query');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /archived/);
  });

  it('exposes the allowlists and denylists the spec names', () => {
    assert.deepStrictEqual([...READ_OPS], ['Ledger.query', 'Brief.read', 'Playbook.list', 'Playbook.read']);
    assert.deepStrictEqual([...ALLOWED.done], [...READ_OPS, 'Playbook.propose']);
    assert.deepStrictEqual([...ALLOWED.abandoned], [...READ_OPS]);
    assert.deepStrictEqual([...DENIED.draft], ['Recommend', 'Plan', 'Executor.submit', 'Fail']);
  });
});

describe('autonomy keys and errors', () => {
  it('maps each failure class to its case.yaml autonomy key', () => {
    assert.deepStrictEqual({ ...AUTONOMY_KEY }, {
      'executor-no-answer': 'onExecutorNoAnswer',
      'dead-end': 'onDeadEnd',
      blocked: 'onBlocked',
      other: 'onOther'
    });
    assert.deepStrictEqual([...FAILURE_CLASSES], ['executor-no-answer', 'dead-end', 'blocked', 'other']);
  });

  it('StatusError carries its code', () => {
    const err = new StatusError('BUDGET_EXHAUSTED', 'Raise the usd budget first.');
    assert.ok(err instanceof Error);
    assert.strictEqual(err.name, 'StatusError');
    assert.strictEqual(err.code, 'BUDGET_EXHAUSTED');
  });
});
