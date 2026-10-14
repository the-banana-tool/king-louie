// src/cases/verify/status.js
// Cases stage 8 (spec §6.3): the state of a confirmed criterion, computed on
// every read from the verification records and whatever the evidence
// resolvers say now. Pure: no I/O, no requires. Nothing stored is taken as
// a state: not `cache.states`, not a field on a scope row or a record.

const STATES = Object.freeze(['unmet', 'met', 'stale', 'failing']);
const FAILED_CHECK_RESULTS = Object.freeze(['fail', 'timeout']);
const NO_EVIDENCE = 'the record cites no evidence';

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const recordNumber = (r) => {
  const m = /^v-(\d+)$/.exec(String(r?.id || ''));
  return m ? Number(m[1]) : -1;
};

// One evidence id, resolved now. Anything short of `holds === true` from
// the resolver does not hold.
function resolveOne(id, resolve) {
  let result = null;
  if (typeof id === 'string' && typeof resolve === 'function') {
    try {
      result = resolve(id);
    } catch {
      result = null;
    }
  }
  const r = isObject(result) ? result : {};
  const holds = r.holds === true;
  return {
    id: typeof id === 'string' ? id : String(id),
    holds,
    reason: holds ? null : (typeof r.reason === 'string' && r.reason ? r.reason : 'evidence-missing'),
    provenance: typeof r.provenance === 'string' ? r.provenance : null,
    sourceKind: typeof r.sourceKind === 'string' ? r.sourceKind : null,
    label: typeof r.label === 'string' && r.label ? r.label : null
  };
}

const reasonText = (e) => e.label || (e.reason === 'evidence-missing' ? `${e.id} is not in the record` : `${e.id} does not hold (${e.reason})`);

// `entry`: a confirmed scope row ({ id, hash }). `records`: the file's
// records. `resolve(id)`: what the resolvers say of an evidence id now.
// `newestCheck`: the newest check run of the case, or null.
// → { state, record, evidence, reasons }. Precedence: failing, stale, met.
function computeCriterionState({ entry, records, resolve, newestCheck = null } = {}) {
  // 1. No record for this criterion at its current hash: a reworded
  //    criterion starts over.
  let record = null;
  for (const r of Array.isArray(records) ? records : []) {
    if (!isObject(r) || !entry || r.criterion !== entry.id || r.criterionHash !== entry.hash) continue;
    if (!record || recordNumber(r) >= recordNumber(record)) record = r;
  }
  if (!record) return { state: 'unmet', record: null, evidence: [], reasons: [] };

  const ids = Array.isArray(record.evidence) ? record.evidence : [];
  const evidence = ids.map((id) => resolveOne(id, resolve));

  // 2. It cites a check, and the newest check run failed or timed out.
  if (ids.some((id) => typeof id === 'string' && id.startsWith('chk-')) && isObject(newestCheck) && FAILED_CHECK_RESULTS.includes(newestCheck.result)) {
    const which = typeof newestCheck.id === 'string' && newestCheck.id ? ` (${newestCheck.id})` : '';
    const reason = `the newest check run${which} ${newestCheck.result === 'timeout' ? 'timed out' : 'failed'}`;
    return { state: 'failing', record, evidence, reasons: [reason] };
  }

  // 3. A later verify pass disagreed with this record.
  if (record.disagreed) {
    const turn = isObject(record.disagreed) && typeof record.disagreed.turnId === 'string' && record.disagreed.turnId ? record.disagreed.turnId : 'a later turn';
    return { state: 'stale', record, evidence, reasons: [`the verify pass of ${turn} no longer agrees`] };
  }

  // 4. Every cited id must hold now. A record that cites nothing is never met.
  if (!evidence.length) return { state: 'stale', record, evidence, reasons: [NO_EVIDENCE] };
  const failed = evidence.filter((e) => !e.holds);
  if (!failed.length) return { state: 'met', record, evidence, reasons: [] };
  return { state: 'stale', record, evidence, reasons: failed.map(reasonText) };
}

// `scopeView`: ScopeStore.view(). `file`: VerificationStore.read().
// → { objective, criteria, counts }. A proposed row has `state: null`, and
// no record or opinion is shown for it.
function progressView({ scopeView, file, resolve, newestCheck = null } = {}) {
  const records = Array.isArray(file?.records) ? file.records : [];
  const opinions = isObject(file?.opinions) ? file.opinions : {};
  const counts = { confirmed: 0, met: 0, stale: 0, failing: 0, unmet: 0, proposed: 0 };
  const criteria = [];
  for (const row of Array.isArray(scopeView?.criteria) ? scopeView.criteria : []) {
    if (!isObject(row)) continue;
    const base = { id: row.id, text: row.text, hash: row.hash, scope: row.state === 'confirmed' ? 'confirmed' : 'proposed', origin: row.origin ?? null, provisional: row.provisional === true };
    if (base.scope !== 'confirmed') {
      counts.proposed += 1;
      criteria.push({ ...base, state: null, recordId: null, note: null, evidence: [], reasons: [], opinion: null });
      continue;
    }
    const computed = computeCriterionState({ entry: { id: row.id, hash: row.hash }, records, resolve, newestCheck });
    counts.confirmed += 1;
    counts[computed.state] += 1;
    criteria.push({
      ...base,
      state: computed.state,
      recordId: computed.record ? computed.record.id : null,
      note: computed.record && typeof computed.record.note === 'string' ? computed.record.note : null,
      evidence: computed.evidence,
      reasons: computed.reasons,
      opinion: isObject(opinions[row.id]) ? opinions[row.id] : null
    });
  }
  return { objective: scopeView?.objective ?? null, criteria, counts };
}

// "1 of 3 confirmed criteria met · 1 stale · 1 unmet · 2 proposed (not
// counted) · not ready to close (4 open)". Without `readiness` it ends
// before the "ready" part. Numbers and fixed words only.
function summaryLine(view, readiness = null) {
  const n = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
  const c = isObject(view?.counts) ? view.counts : {};
  const parts = [`${n(c.met)} of ${n(c.confirmed)} confirmed criteria met`];
  for (const state of ['failing', 'stale', 'unmet']) if (n(c[state])) parts.push(`${n(c[state])} ${state}`);
  if (n(c.proposed)) parts.push(`${n(c.proposed)} proposed (not counted)`);
  if (isObject(readiness)) {
    const items = Array.isArray(readiness.items) ? readiness.items : [];
    const open = items.filter((i) => i?.state !== 'ok' && i?.state !== 'n/a').length;
    parts.push(readiness.ready === true && open === 0 ? 'ready to close' : `not ready to close (${open} open)`);
  }
  return parts.join(' · ');
}

module.exports = { computeCriterionState, progressView, summaryLine, STATES };
