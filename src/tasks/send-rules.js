'use strict';

// What a client's send comes to (spec docs/superpowers/specs/2026-11-03-tasks-stage1-design.md
// §4.6), asked once with what is true now and nothing else, so that each send does one of four
// things: starts a turn inside a cap and a deadline it may use, sends a real card and says so,
// refuses with a true message, or ends the task. Only a press moves a cap or a deadline.
//
//   past what            grants  state  card                       → act
//   ------------------   ------  -----  -------------------------  -----------------------------
//   the cap              any     done   any                        refuse (no card, no write)
//   the cap              none    other  -                          end failed, spend_cap
//   the cap              some    other  out, asks past the spend   awaited
//   the cap              some    other  anything else              raise (spend_cap)
//   the deadline         any     done   any                        refuse (no card, no write)
//   the deadline         none    other  -                          end failed, duration
//   the deadline         some    other  out                        awaited
//   the deadline         some    other  an hour unanswered         one more card (duration)
//   the deadline         some    other  anything else              raise (duration)
//   neither              any     any    an hour unanswered         run, with one more card out
//   neither              some    other  no handle (a last run's)   run, re-proposing and carding
//   neither              any     any    anything else              run
//
// "An hour unanswered" is the reason grant_pending on a handle with no card out; a press clears
// that reason. The cap comes first: a raise's press moves the deadline too.

function sendOutcome({ state, reason, atCap, pastDeadline, hasGrants, hasHandle, cardOut, cardCoversSpend }) {
  const done = state === 'done';
  const unanswered = hasHandle && !cardOut && reason === 'grant_pending';
  if (atCap) {
    if (done) return { act: 'refuse', why: 'spend_cap' };
    if (!hasGrants) return { act: 'end', why: 'spend_cap' };
    if (cardOut && cardCoversSpend) return { act: 'awaited', why: 'spend_cap' };
    return { act: 'raise', why: 'spend_cap' };
  }
  if (pastDeadline) {
    if (done) return { act: 'refuse', why: 'duration' };
    if (!hasGrants) return { act: 'end', why: 'duration' };
    if (cardOut) return { act: 'awaited', why: 'duration' };
    return { act: unanswered ? 'one_more' : 'raise', why: 'duration' };
  }
  if (unanswered) return { act: 'run_one_more' };
  if (hasGrants && !hasHandle && !done) return { act: 'run_recard' };
  return { act: 'run' };
}

module.exports = { sendOutcome };
