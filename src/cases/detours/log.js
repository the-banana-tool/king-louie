// src/cases/detours/log.js
// .kl/detours.jsonl (cases stage 5 spec §4.2): classification, proposal,
// released, resolution and incoming rows, append-only and committed with
// the case. A detour's status is its last resolution's, else held or
// proposed.
const path = require('path');
const { appendJsonl, readJsonl } = require('../jsonl');
const { createLogger } = require('../../logging');

const log = createLogger('cases/detours');

const ROW_TYPES = Object.freeze(['classification', 'proposal', 'released', 'resolution', 'incoming']);
// `superseded`: another detour of the same retry chain (proposal `retryOf`)
// was attached or created, so this one's work is already routed.
const RESOLUTION_STATUSES = Object.freeze(['attached', 'created', 'declined', 'superseded', 'failed', 'awaiting-mapping']);
// A detour with one of these is settled; resolve returns it as existing.
const FINAL_STATUSES = Object.freeze(['attached', 'created', 'declined', 'superseded']);

class DetourLog {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, '.kl', 'detours.jsonl');
  }

  rows() {
    const { entries, errors } = readJsonl(this.file, (row) => {
      if (!row || typeof row !== 'object' || !ROW_TYPES.includes(row.type)) throw new Error('unknown row type');
    });
    if (errors.length) log.warn(`${this.file}: skipped ${errors.length} malformed line(s)`);
    return entries;
  }

  append(row) {
    if (!ROW_TYPES.includes(row?.type)) throw new Error(`Unknown detour row type "${row?.type}".`);
    if (row.type === 'resolution' && !RESOLUTION_STATUSES.includes(row.status)) {
      throw new Error(`Unknown resolution status "${row.status}".`);
    }
    appendJsonl(this.file, row);
    return row;
  }

  // d- + 4 digits, one past the highest proposal id.
  nextId(rows = this.rows()) {
    let max = 0;
    for (const r of rows) {
      if (r.type !== 'proposal') continue;
      const n = Number(String(r.id).replace(/^d-/, ''));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `d-${String(max + 1).padStart(4, '0')}`;
  }

  // id → { id, proposal, questionId, resolutions, last, status } in proposal order.
  detours(rows = this.rows()) {
    const out = new Map();
    for (const r of rows) {
      if (r.type === 'proposal' && !out.has(r.id)) {
        out.set(r.id, { id: r.id, proposal: r, questionId: r.questionId || null, resolutions: [], last: null, status: r.held ? 'held' : 'proposed' });
      } else if (r.type === 'released' && out.has(r.id)) {
        const d = out.get(r.id);
        d.questionId = r.questionId;
        if (!d.last) d.status = 'proposed';
      } else if (r.type === 'resolution' && out.has(r.id)) {
        const d = out.get(r.id);
        d.resolutions.push(r);
        d.last = r;
        d.status = r.status;
      }
    }
    return out;
  }

  incoming(rows = this.rows()) {
    const seen = new Set();
    return rows.filter((r) => {
      if (r.type !== 'incoming') return false;
      const key = `${r.fromCaseId}\u0000${r.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

module.exports = { DetourLog, ROW_TYPES, RESOLUTION_STATUSES, FINAL_STATUSES };
