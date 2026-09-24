// src/cases/status.js
// Case status machine and per-status tool rules (cases stage 2 spec §3.1).
// Pure: no I/O. CaseRuntime.setStatus and assertWritable apply it.

const STATUSES = Object.freeze(['draft', 'active', 'needs-direction', 'paused', 'done', 'abandoned']);
const REASON_KINDS = Object.freeze(['gating', 'failure', 'budget', 'budget-grant', 'commit', 'owner', 'direction']);

const row = (from, to, by, kinds) => Object.freeze({
  from: Object.freeze(from), to, by: Object.freeze(by), kinds: Object.freeze(kinds)
});

const TRANSITIONS = Object.freeze([
  row(['draft'], 'active', ['runtime'], ['gating']),
  row(['draft'], 'abandoned', ['owner'], ['owner']),
  row(['active'], 'needs-direction', ['runtime'], ['failure']),
  row(['active', 'needs-direction'], 'paused', ['runtime'], ['budget']),
  row(['active'], 'paused', ['runtime'], ['commit']),
  row(['active'], 'paused', ['owner'], ['owner']),
  row(['needs-direction'], 'active', ['runtime', 'owner'], ['direction']),
  row(['paused'], 'active', ['runtime'], ['budget-grant']),
  row(['paused'], 'active', ['owner'], ['owner']),
  row(['active', 'needs-direction', 'paused'], 'done', ['owner'], ['owner']),
  row(['active', 'needs-direction', 'paused'], 'abandoned', ['owner'], ['owner'])
]);

const READ_OPS = Object.freeze(['Ledger.query', 'Brief.read', 'Playbook.list', 'Playbook.read']);

// Narrow statuses use an allowlist; the others a denylist (spec §3.1).
const ALLOWED = Object.freeze({
  paused: READ_OPS,
  done: Object.freeze([...READ_OPS, 'Playbook.propose']),
  abandoned: READ_OPS
});

const DENIED = Object.freeze({
  draft: Object.freeze(['Recommend', 'Plan', 'Executor.submit', 'Fail']),
  active: Object.freeze([]),
  'needs-direction': Object.freeze(['Plan', 'Recommend', 'Fail', 'Executor.submit'])
});

const AUTONOMY_KEY = Object.freeze({
  'executor-no-answer': 'onExecutorNoAnswer',
  'dead-end': 'onDeadEnd',
  blocked: 'onBlocked',
  other: 'onOther'
});
const FAILURE_CLASSES = Object.freeze(Object.keys(AUTONOMY_KEY));

class StatusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatusError';
    this.code = code;
  }
}

function canTransition(from, to, by = 'runtime', kind = null) {
  return TRANSITIONS.some((t) => (
    t.from.includes(from)
    && t.to === to
    && t.by.includes(by)
    && (kind === null || kind === undefined || t.kinds.includes(kind))
  ));
}

function refusal(status, reason) {
  switch (status) {
    case 'draft':
      return 'Case is a draft: finish the gating pass (Brief completeGating) first.';
    case 'needs-direction':
      return `Case is waiting for the owner's direction on ${reason?.ref || 'its failure report'}. Report status or ask; do not plan or recommend.`;
    case 'paused':
      return `Case is paused (${reason?.kind || 'owner'}). Only reading is available.`;
    case 'done':
      return 'Case is done. It is read-only.';
    case 'abandoned':
      return 'Case is abandoned. It is read-only.';
    default:
      return `Case status "${status}" is not recognised, so nothing can run. Fix case.yaml.`;
  }
}

// null when `op` may proceed in `status`, else a refusal result.
function check(status, op, { autonomyAllows = false, reason = null } = {}) {
  const allowed = ALLOWED[status];
  if (allowed) return allowed.includes(op) ? null : { ok: false, error: refusal(status, reason) };
  const denied = DENIED[status];
  if (!denied) return { ok: false, error: refusal(status, reason) };
  if (!denied.includes(op)) return null;
  if (status === 'needs-direction' && op === 'Executor.submit' && autonomyAllows === true) return null;
  return { ok: false, error: refusal(status, reason) };
}

module.exports = {
  STATUSES,
  REASON_KINDS,
  TRANSITIONS,
  ALLOWED,
  DENIED,
  READ_OPS,
  AUTONOMY_KEY,
  FAILURE_CLASSES,
  StatusError,
  canTransition,
  check
};
