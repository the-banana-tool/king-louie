'use strict';

// A task's phone cards, from the manager's side (spec docs/superpowers/specs/2026-11-03-tasks-stage1-design.md
// §4.6): opening one, what came of one, and the refusal of a send that needs one. TaskGrants asks
// the phone; this writes what that means to the record, through the manager.

const { createLogger } = require('../logging');
const { ToolError, approvalOrigin } = require('../fleet/fleet-tools');
const { raisedUsd } = require('./grants');
const { sendOutcome } = require('./send-rules');
const { DEFAULT_MINUTES, FINAL_STATES, overCap } = require('./values');

const log = createLogger('tasks/cards');

const REFUSALS = { spend_cap: 'has reached its spend cap', duration: 'has reached the end of its time' };

// A press answered these; `stuck` is a question the press did not answer.
const PRESS_ANSWERS = new Set(['grant_pending', 'spend_cap', 'duration']);
// A card that asks past a cut and is refused one of these will not go next time either. Anything
// else (a take holding the node's lease) can change, so the task stays waiting and a send asks again.
const LASTING_REFUSALS = new Set(['approval_unavailable', 'capability_unavailable']);
// Known to pass: another job's lease, a card already out, a chat the next send will read as gone, a
// node stopping. A code in neither list also leaves the task waiting, and is logged as an error.
const PASSING_REFUSALS = new Set(['lease_busy', 'lease_pending', 'job_closed', 'service_stopped']);

// Long enough for a request refused outright to have said so.
const settled = () => new Promise((resolve) => { setImmediate(resolve); });

class TaskCards {
  constructor(manager) {
    this.manager = manager;
  }

  open(turn, proposal) {
    const { manager } = this;
    if (!manager.grants) return;
    const handle = this._newHandle(manager.store.get(turn.taskId), proposal, turn.origin, true);
    if (handle.state().awaiting) manager._update(turn.taskId, { state: 'awaiting_grant' });
  }

  // What a card asks. Until a press the cap is not what the task proposed to ask, so an acting
  // proposal's card still says that; a look-only one goes up by raises alone. Once pressed, `usd`.
  usdFor(record, proposal, usd) {
    const unasked = !record.grant && proposal && proposal.allows.length > 0;
    return unasked ? Math.max(usd, proposal.usd) : usd;
  }

  _newHandle(record, proposal, origin, card) {
    const taskId = record.task_id;
    const handle = this.manager.grants.open({
      task: record,
      proposal,
      origin: approvalOrigin(origin, `chat:${record.chat_id}`),
      onChange: (change) => this._onChange(taskId, change),
      card,
    });
    this.manager.handles.set(taskId, handle);
    return handle;
  }

  // ---- what came of a card ----

  // An interrupted task can still be pressed: its raise card goes before its next turn.
  _onChange(taskId, change) {
    const { manager } = this;
    const record = manager.store.get(taskId);
    if (!record || FINAL_STATES.includes(record.state)) return;
    const turn = manager.turn && manager.turn.taskId === taskId ? manager.turn : null;
    // `raise` on a card that asks for more says what it asks past: spend_cap or duration.
    const { kind, raise } = change;
    if (kind === 'card') {
      manager._update(taskId, { card_sends: (record.card_sends || 0) + 1 });
    } else if (kind === 'granted') {
      // A press starts no turn, but a chat the owner has taken has nothing left to grant. A chat that
      // will not read now ends nothing: the press stands, and the next send reads it again.
      let taken = null;
      if (!turn) {
        try {
          taken = manager._takenReason(record);
        } catch {
          taken = null;
        }
      }
      if (taken) manager._endTaken(record, taken);
      else this._granted(record, turn, change);
    } else if (kind === 'denied') {
      this._endByOwner(taskId, turn, raise || 'grant_denied');
    } else if (kind === 'stopped') {
      this._endByOwner(taskId, turn, 'stopped');
    } else if (kind === 'expired') {
      // The deadline is the lease's end and cuts at the same moment, or a send has run past it.
      if (turn) manager._cut(turn, 'duration');
    } else if (kind === 'pending_exhausted') {
      // A raise nobody answered stays as it is: a send asks once more.
      if (raise) return;
      if (turn) manager._cut(turn, 'grant_pending');
      else manager._update(taskId, { state: 'waiting', reason: 'grant_pending' });
    } else if (kind === 'unavailable') {
      this._noCard(record, raise, change.code);
    }
  }

  // The press sets the card's spend and starts its minutes, so the turn runs to the moment the
  // lease comes down. With no turn running the task stays waiting: the client's send starts the
  // next, and `reason` goes, since the press answered it: state waiting, no reason, a client may send.
  _granted(record, turn, { grant, usd }) {
    const { manager } = this;
    const patch = { grant, deadline_at: grant.expires_at, spend: { ...record.spend, cap_usd: usd } };
    if (record.state === 'awaiting_grant') patch.state = 'running';
    if (PRESS_ANSWERS.has(record.reason)) patch.reason = null;
    const { spend } = manager._update(record.task_id, patch);
    if (!turn || turn.cut) return;
    if (overCap(spend)) manager._cut(turn, 'spend_cap');
    else manager._armDeadline(turn);
  }

  _endByOwner(taskId, turn, reason) {
    this.manager._end(taskId, 'cancelled', reason);
    if (turn) this.manager._cut(turn, reason);
  }

  // No card could go: no phone to ask, or the node's lease is taken. A card that asks past a cut
  // ends the task when that will not change, since nothing else can move it, and otherwise leaves
  // it waiting for the send that asks again. Any other leaves a task like one with no grants: each
  // act asks for itself, on the lowest spend and time.
  _noCard(record, raise, code) {
    if (raise) {
      if (LASTING_REFUSALS.has(code)) this.manager._end(record.task_id, 'failed', raise);
      else if (!PASSING_REFUSALS.has(code)) log.error('a raise card was refused for a reason not known to pass; the task stays waiting', { taskId: record.task_id, code: code || null });
    } else if (record.state === 'awaiting_grant') this.manager._update(record.task_id, { state: 'running' });
  }

  // A card asking past the cap or the deadline; its press is the only thing that moves either.
  // → whether it went: at the most a raise can ask, nothing can, and the task is over.
  askMore(record, origin, why) {
    const taskId = record.task_id;
    const asked = why === 'spend_cap' ? raisedUsd(record.spend) : record.spend.cap_usd;
    if (asked === null) {
      this.manager._end(taskId, 'failed', why);
      return false;
    }
    const usd = this.usdFor(record, record.proposal, asked);
    const handle = this.manager.handles.get(taskId) || this._newHandle(record, record.proposal, origin, false);
    handle.raise({ usd, minutes: record.proposal ? record.proposal.minutes : DEFAULT_MINUTES, why });
    return true;
  }

  // ---- a send ----

  outcome(record) {
    const { manager } = this;
    const handle = manager.handles.get(record.task_id);
    const { awaiting = false } = handle ? handle.state() : {};
    const out = awaiting ? handle.askingUsd() : null;
    return sendOutcome({
      state: record.state,
      reason: record.reason,
      atCap: overCap(record.spend),
      pastDeadline: Date.parse(record.deadline_at) <= manager.clock(),
      hasGrants: Boolean(manager.grants),
      hasHandle: Boolean(handle),
      cardOut: awaiting,
      cardCoversSpend: awaiting && record.spend && out > record.spend.usd,
    });
  }

  // → the error for a send that does not run. "Awaited" is said only of a card that is out once
  // the phone's side has answered: a request refused outright has ended the task by then, or has
  // left it waiting for the next send.
  async refuse(record, origin, { act, why }) {
    const { manager } = this;
    const plain = new ToolError('invalid_params', `invalid_params: this task ${REFUSALS[why]}`);
    const awaited = new ToolError('invalid_params', `invalid_params: this task ${REFUSALS[why]}; a press on the phone is awaited`);
    if (act === 'refuse') return plain;
    if (act === 'awaited') return awaited;
    if (act === 'end') {
      manager._end(record.task_id, 'failed', why);
      return plain;
    }
    const handle = manager.handles.get(record.task_id);
    const asked = act === 'one_more' && handle.resend({ why }) ? true : this.askMore(record, origin, why);
    if (!asked) return plain;
    await settled();
    const after = manager.store.get(record.task_id);
    if (after && FINAL_STATES.includes(after.state)) return plain;
    const out = manager.handles.get(record.task_id);
    return out && out.state().awaiting ? awaited : new ToolError('invalid_params', `invalid_params: this task ${REFUSALS[why]}; no card could go just now, so send again`);
  }
}

module.exports = { TaskCards };
