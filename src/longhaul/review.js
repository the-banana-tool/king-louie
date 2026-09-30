'use strict';
// The review core behind `longhaul verify` (benchmark spec §6), shared by the
// terminal loop and the web reviewer. Only a valid question can be accepted;
// an edit is saved only when valid and is never accepted by itself; progress
// is saved through onSave(current, rejected) after every accept, reject and
// saved edit. A question with no verifiedBy key is unverified.
const { validateQuestion, normalizeQuestion } = require('./questions');
const { UsageError } = require('./errors');

const REVIEWER_RE = /^[A-Za-z0-9._-]{1,32}$/;
// The fields a reviewer may edit, as in the terminal loop.
const EDIT_FIELDS = Object.freeze(['question', 'answer', 'acceptableAnswers', 'evidenceSeqs', 'askAtSeq', 'kind', 'supersededBy']);

function checkReviewer(reviewer) {
  if (!REVIEWER_RE.test(reviewer || '')) throw new UsageError('--reviewer <initials> is required (letters, digits, . _ -)');
  return reviewer;
}

function createReview({ session, questions, reviewer, onSave, now = () => new Date() }) {
  checkReviewer(reviewer);
  const { index } = session;
  const sessionId = session.manifest.sessionId;
  let current = questions.map((q) => (q.verifiedBy === undefined ? { ...q, verifiedBy: null } : q));
  // The review queue: the questions unverified at the start, in ask order.
  // Rejected ones stay in the queue (with their last version) so a reviewer
  // sees what they decided.
  const queue = current
    .filter((q) => q.verifiedBy == null)
    .sort((a, b) => a.askAtSeq - b.askAtSeq || String(a.id).localeCompare(String(b.id)))
    .map((q) => ({ id: q.id, status: 'pending', rejected: null }));
  const byId = new Map(queue.map((e) => [e.id, e]));
  let edited = 0;

  const find = (id) => current.find((q) => q.id === id) || null;
  const replace = (q) => { current = current.map((x) => (x.id === q.id ? q : x)); };
  const errorsOf = (q) => validateQuestion(q, { index, sessionId });
  const lookup = (id) => {
    const entry = byId.get(id);
    if (!entry) return { error: { ok: false, code: 'not-found', errors: [`no question ${JSON.stringify(id)} in this review`] } };
    if (entry.status === 'rejected') return { error: { ok: false, code: 'decided', errors: [`${id} was rejected`] } };
    return { entry, q: find(id) };
  };

  return {
    reviewer,
    pending() {
      return queue.map((e) => {
        const q = find(e.id) || e.rejected;
        return { id: e.id, kind: q.kind, askAtSeq: q.askAtSeq, status: e.status };
      });
    },
    current() { return current; },
    get(id) {
      const entry = byId.get(id);
      if (entry && entry.rejected) return entry.rejected;
      return find(id);
    },
    status(id) { return byId.get(id)?.status ?? null; },
    validate(id) {
      const q = find(id);
      return q ? errorsOf(q) : [];
    },
    accept(id) {
      const { error, entry, q } = lookup(id);
      if (error) return error;
      const errors = errorsOf(q);
      if (errors.length) return { ok: false, code: 'invalid', errors };
      const accepted = { ...normalizeQuestion(q, index), verifiedBy: `human:${reviewer}` };
      replace(accepted);
      onSave(current, null);
      entry.status = 'accepted';
      return { ok: true, question: accepted };
    },
    reject(id, reason) {
      const { error, entry, q } = lookup(id);
      if (error) return error;
      const rejected = { ...q, rejectedBy: `human:${reviewer}`, rejectReason: typeof reason === 'string' ? reason : '', rejectedAt: now().toISOString() };
      current = current.filter((x) => x.id !== id);
      onSave(current, rejected);
      entry.status = 'rejected';
      entry.rejected = rejected;
      return { ok: true, rejected };
    },
    skip(id) {
      const { error, entry } = lookup(id);
      if (error) return error;
      if (entry.status === 'pending') entry.status = 'skipped';
      return { ok: true };
    },
    // fields: any of EDIT_FIELDS, already typed (arrays, integers, null).
    edit(id, fields) {
      const { error, entry, q } = lookup(id);
      if (error) return error;
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { ok: false, code: 'invalid', errors: ['fields: expected an object'] };
      const unknown = Object.keys(fields).filter((k) => !EDIT_FIELDS.includes(k));
      if (unknown.length) return { ok: false, code: 'invalid', errors: unknown.map((k) => `field: ${k} cannot be edited`) };
      // distance is computed, never typed: drop the stored one so a moved
      // askAtSeq or evidence list is not refused as a mismatch.
      const { distance, ...rest } = q;
      const next = { ...rest, ...fields, verifiedBy: null };
      const errors = errorsOf(next);
      if (errors.length) return { ok: false, code: 'invalid', errors };
      const saved = normalizeQuestion(next, index);
      replace(saved);
      onSave(current, null);
      entry.status = 'edited';
      edited += 1;
      return { ok: true, question: saved };
    },
    counts() {
      const n = (s) => queue.filter((e) => e.status === s).length;
      return { accepted: n('accepted'), edited, rejected: n('rejected'), skipped: n('skipped') };
    }
  };
}

module.exports = { createReview, checkReviewer, EDIT_FIELDS, REVIEWER_RE };
