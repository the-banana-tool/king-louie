// What a send comes to: the table in src/tasks/send-rules.js, row by row.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { sendOutcome } = require('../src/tasks/send-rules');

const BASE = {
  state: 'waiting', reason: null, atCap: false, pastDeadline: false, hasGrants: true, hasHandle: true, cardOut: false, cardCoversSpend: false,
};

const ROWS = [
  // the cap
  ['done at the cap', { state: 'done', atCap: true }, 'refuse', 'spend_cap'],
  ['done at the cap, no grants', { state: 'done', atCap: true, hasGrants: false, hasHandle: false }, 'refuse', 'spend_cap'],
  ['at the cap, no grants', { atCap: true, hasGrants: false, hasHandle: false }, 'end', 'spend_cap'],
  ['interrupted at the cap, no grants', { state: 'interrupted', atCap: true, hasGrants: false, hasHandle: false }, 'end', 'spend_cap'],
  ['at the cap, a card out that covers it', { atCap: true, cardOut: true, cardCoversSpend: true }, 'awaited', 'spend_cap'],
  ['at the cap, a card out that does not', { atCap: true, cardOut: true }, 'raise', 'spend_cap'],
  ['at the cap, no card out', { atCap: true }, 'raise', 'spend_cap'],
  ['at the cap, an hour unanswered', { atCap: true, reason: 'grant_pending' }, 'raise', 'spend_cap'],
  ['at the cap, no handle', { atCap: true, hasHandle: false, state: 'interrupted' }, 'raise', 'spend_cap'],
  ['at the cap and past the deadline', { atCap: true, pastDeadline: true }, 'raise', 'spend_cap'],
  // the deadline
  ['done past the deadline', { state: 'done', pastDeadline: true }, 'refuse', 'duration'],
  ['past the deadline, no grants', { pastDeadline: true, hasGrants: false, hasHandle: false }, 'end', 'duration'],
  ['past the deadline, a card out', { pastDeadline: true, cardOut: true }, 'awaited', 'duration'],
  ['past the deadline, an hour unanswered', { pastDeadline: true, reason: 'grant_pending' }, 'one_more', 'duration'],
  ['past the deadline, waiting duration', { pastDeadline: true, reason: 'duration' }, 'raise', 'duration'],
  ['past the deadline, stuck', { pastDeadline: true, reason: 'stuck' }, 'raise', 'duration'],
  ['past the deadline, interrupted, no handle', { pastDeadline: true, state: 'interrupted', hasHandle: false }, 'raise', 'duration'],
  ['past the deadline, grant_pending from the last run', { pastDeadline: true, reason: 'grant_pending', hasHandle: false }, 'raise', 'duration'],
  // neither
  ['inside both, an hour unanswered', { reason: 'grant_pending' }, 'run_one_more', undefined],
  ['inside both, grant_pending with a card out', { reason: 'grant_pending', cardOut: true }, 'run', undefined],
  ['inside both, a last run\'s waiting task', { hasHandle: false }, 'run_recard', undefined],
  ['inside both, interrupted', { state: 'interrupted', hasHandle: false }, 'run_recard', undefined],
  ['inside both, stuck', { reason: 'stuck' }, 'run', undefined],
  ['inside both, a card out', { cardOut: true }, 'run', undefined],
  ['inside both, done, closed handle', { state: 'done', hasHandle: false }, 'run', undefined],
  ['inside both, no grants', { hasGrants: false, hasHandle: false }, 'run', undefined],
];

describe('sendOutcome', () => {
  for (const [name, facts, act, why] of ROWS) {
    it(name, () => {
      const out = sendOutcome({ ...BASE, ...facts });
      assert.equal(out.act, act);
      assert.equal(out.why, why);
    });
  }
});
