// src/cases/executors/duplicates.js
// The duplicate-job gate (R36) is C5's (gates.js). Until C5 merges, this is
// a copy of C5 spec §3.2's algorithm; once gates.js exports the functions,
// those are used.
//
// When C5 lands, this file becomes C5's thin delegation (C5 merge rule 2):
// jobSignature and findDuplicateJob call gates.js, and the local* copies go.
// Callers keep importing from this path.
const gates = require('../gates');
const { sha256hex } = require('./util');
const { OPEN_STATES } = require('./job-store');

function normIntent(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// SHA-256 hex of the JSON of { e, k, r (sorted), i } in that key order.
function localJobSignature(executorId, job = {}) {
  const recipients = [...(job.recipients || [])].map(String).sort();
  return sha256hex(JSON.stringify({ e: executorId, k: job.kind || null, r: recipients, i: normIntent(job.intent) }));
}

function localFindDuplicateJob({ executorId, job, liveJobs = [] }) {
  return liveJobs.find((r) => r.executorId === executorId && r.signature === job.signature && OPEN_STATES.includes(r.state)) || null;
}

function jobSignature(executorId, job) {
  return typeof gates.jobSignature === 'function' ? gates.jobSignature(executorId, job) : localJobSignature(executorId, job);
}

function findDuplicateJob(args) {
  return typeof gates.findDuplicateJob === 'function' ? gates.findDuplicateJob(args) : localFindDuplicateJob(args);
}

module.exports = { normIntent, jobSignature, findDuplicateJob, localJobSignature, localFindDuplicateJob };
