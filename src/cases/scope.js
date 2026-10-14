// src/cases/scope.js
// Cases stage 8 (spec §6.1, §7.1): who wrote each success criterion and the
// objective. brief.md holds the words; <case>/.kl/scope.json holds one entry
// per criterion (id `sc-NNN`, a hash of the text) and one for the objective,
// each `proposed` or `confirmed`.
//
// This module knows nothing of Brief or CaseRuntime: brief data comes in as
// an argument. `view` joins the two in memory and never writes; `reconcile`
// and `confirm` write, and are called only with the case lock held.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeForQuote } = require('./chat-integration');
const { plainLineProblem } = require('./hidden-chars');
const { writeJsonIfChanged } = require('./jsonfile');
const { createLogger } = require('../logging');

const log = createLogger('cases/scope');

const MAX_CRITERIA = 12;
const MAX_PROPOSED = 6;
const MIN_CRITERION_CHARS = 3;
const MAX_CRITERION_CHARS = 300;
const ORIGINS = Object.freeze(['model', 'owner-quote', 'gating-answer', 'detour', 'owner-create', 'owner-action', 'legacy', 'file']);
// The origins an entry may be born `confirmed` with. Every other origin is
// born `proposed`, whatever the caller passes beside it.
const CONFIRMING_ORIGINS = Object.freeze(['owner-quote', 'gating-answer', 'owner-create', 'owner-action']);
const STATES = Object.freeze(['proposed', 'confirmed']);
const ID_RE = /^sc-(\d{3,})$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const OBJECTIVE = 'objective';

class ScopeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScopeError';
    this.code = code;
  }
}

// The hash of a criterion or objective: case, white space, curly quotes and
// dashes are folded first, so a re-saved file with the same words keeps its
// entry.
function textHash(text) {
  return `sha256:${crypto.createHash('sha256').update(normalizeForQuote(text), 'utf8').digest('hex')}`;
}

// → the trimmed text; throws unless it is one plain line of 3 to 300
// characters (it is shown on a card).
function validateCriterionText(text) {
  if (typeof text !== 'string') throw new ScopeError('CRITERION_INVALID', 'A success criterion is one line of text.');
  const trimmed = text.trim();
  const problem = plainLineProblem(trimmed);
  if (problem) throw new ScopeError('CRITERION_INVALID', `A success criterion is one plain line; ${problem}.`);
  if (trimmed.length < MIN_CRITERION_CHARS || trimmed.length > MAX_CRITERION_CHARS) {
    throw new ScopeError('CRITERION_INVALID', `A success criterion is ${MIN_CRITERION_CHARS} to ${MAX_CRITERION_CHARS} characters; this one is ${trimmed.length}.`);
  }
  return trimmed;
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const idOf = (n) => `sc-${String(n).padStart(3, '0')}`;
const numberOf = (id) => {
  const m = ID_RE.exec(String(id || ''));
  return m ? Number(m[1]) : 0;
};
const strOrNull = (v) => (typeof v === 'string' && v ? v : null);

// A stored confirmation, or null when it does not say who confirmed.
function storedConfirmation(c) {
  if (!isObject(c) || typeof c.by !== 'string' || !c.by) return null;
  return { by: c.by, channel: strOrNull(c.channel), at: strOrNull(c.at), quote: strOrNull(c.quote), factId: strOrNull(c.factId) };
}

// An entry is `confirmed` only when it also says who confirmed it; a bare
// `state: "confirmed"` is read as proposed.
function stateOf(raw) {
  const confirmed = raw.state === 'confirmed' ? storedConfirmation(raw.confirmed) : null;
  return { state: confirmed ? 'confirmed' : 'proposed', confirmed };
}

function cleanEntry(raw) {
  if (!isObject(raw) || !ID_RE.test(String(raw.id || '')) || !HASH_RE.test(String(raw.hash || ''))) return null;
  if (!STATES.includes(raw.state) || !ORIGINS.includes(raw.origin)) return null;
  return { id: raw.id, hash: raw.hash, ...stateOf(raw), origin: raw.origin, addedBy: strOrNull(raw.addedBy), at: strOrNull(raw.at) };
}

function cleanObjective(raw) {
  if (!isObject(raw) || !HASH_RE.test(String(raw.hash || ''))) return null;
  if (!STATES.includes(raw.state) || !ORIGINS.includes(raw.origin)) return null;
  return { hash: raw.hash, ...stateOf(raw), origin: raw.origin, at: strOrNull(raw.at) };
}

function cleanRemoved(raw) {
  if (!isObject(raw) || !ID_RE.test(String(raw.id || ''))) return null;
  return {
    id: raw.id,
    hash: typeof raw.hash === 'string' ? raw.hash : '',
    text: typeof raw.text === 'string' ? raw.text : '',
    state: STATES.includes(raw.state) ? raw.state : 'proposed',
    at: strOrNull(raw.at),
    by: strOrNull(raw.by)
  };
}

// The stored order of an entry's keys (§7.1).
const criterionRecord = (e) => ({ id: e.id, hash: e.hash, state: e.state, origin: e.origin, addedBy: e.addedBy, at: e.at, confirmed: e.confirmed });
const objectiveRecord = (e) => ({ hash: e.hash, state: e.state, origin: e.origin, at: e.at, confirmed: e.confirmed });

// What the caller says of a new string: { origin, confirmed }.
function birth(given, nowIso) {
  if (!isObject(given) || !ORIGINS.includes(given.origin)) {
    throw new ScopeError('SCOPE_INVALID', `A scope origin is one of ${ORIGINS.join(', ')}.`);
  }
  if (given.confirmed === null || given.confirmed === undefined) return { origin: given.origin, state: 'proposed', confirmed: null };
  if (!CONFIRMING_ORIGINS.includes(given.origin)) {
    throw new ScopeError('SCOPE_INVALID', `An entry of origin ${given.origin} is proposed until the owner confirms it.`);
  }
  const confirmed = storedConfirmation(given.confirmed);
  if (!confirmed) throw new ScopeError('SCOPE_INVALID', 'A confirmation names who confirmed ("by").');
  return { origin: given.origin, state: 'confirmed', confirmed: { ...confirmed, at: confirmed.at || nowIso } };
}

// `removedTexts`: the view read before the change, or a plain object of
// texts keyed by criterion id or by hash.
function removedTextLookup(removedTexts) {
  if (!isObject(removedTexts)) return () => '';
  if (Array.isArray(removedTexts.criteria)) {
    const byId = new Map(removedTexts.criteria.filter(isObject).map((r) => [r.id, r.text]));
    return (entry) => (typeof byId.get(entry.id) === 'string' ? byId.get(entry.id) : '');
  }
  return (entry) => {
    const text = removedTexts[entry.id] ?? removedTexts[entry.hash];
    return typeof text === 'string' ? text : '';
  };
}

class ScopeStore {
  constructor(dir, { now = () => new Date() } = {}) {
    this.dir = dir;
    this.file = path.join(dir, '.kl', 'scope.json');
    this.now = now;
    this._warned = false;
  }

  // → { status: 'absent' | 'corrupt' | 'ok', file }. A file that is there
  // and is not a scope record is `corrupt`: its strings read as origin
  // `file`, never `legacy`, since legacy is for a case that never had one.
  _load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { status: 'absent', file: null };
      this._warn(`cannot be read (${err.message})`);
      return { status: 'corrupt', file: null };
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      this._warn(`is not valid JSON (${err.message})`);
      return { status: 'corrupt', file: null };
    }
    if (!isObject(value)) {
      this._warn('is not a scope record');
      return { status: 'corrupt', file: null };
    }
    this._warned = false;
    return { status: 'ok', file: value };
  }

  _warn(what) {
    if (this._warned) return;
    this._warned = true;
    log.warn(`${this.file} ${what}; reading the case's scope as unconfirmed.`);
  }

  // The file object, or null when it is absent, unreadable or not an object.
  read() {
    return this._load().file;
  }

  // The file's entries with everything malformed left out. Never writes.
  _state() {
    const { status, file } = this._load();
    const criteria = [];
    const seenIds = new Set();
    const seenHashes = new Set();
    for (const raw of Array.isArray(file?.criteria) ? file.criteria : []) {
      const entry = cleanEntry(raw);
      if (!entry || seenIds.has(entry.id) || seenHashes.has(entry.hash)) continue;
      seenIds.add(entry.id);
      seenHashes.add(entry.hash);
      criteria.push(entry);
    }
    const removed = (Array.isArray(file?.removed) ? file.removed : []).map(cleanRemoved).filter(Boolean);
    // Ids only grow: past the stored counter and past every id in the file,
    // well formed or not.
    let next = Number.isInteger(file?.nextCriterion) && file.nextCriterion > 0 ? file.nextCriterion : 1;
    for (const list of [file?.criteria, file?.removed]) {
      for (const raw of Array.isArray(list) ? list : []) next = Math.max(next, numberOf(raw?.id) + 1);
    }
    const migratedAt = strOrNull(file?.migratedAt);
    return {
      status,
      migratedAt,
      // After the first write, and for a corrupt file, a string with no
      // entry was put there by something other than the case tools.
      migrated: status === 'corrupt' || Boolean(migratedAt),
      nextCriterion: next,
      objective: cleanObjective(file?.objective),
      criteria,
      removed
    };
  }

  _join(state, briefData) {
    const data = isObject(briefData) ? briefData : {};
    const unknownOrigin = state.migrated ? 'file' : 'legacy';
    const byHash = new Map(state.criteria.map((e) => [e.hash, e]));
    const criteria = [];
    const duplicates = [];
    const seen = new Set();
    let next = state.nextCriterion;
    for (const text of Array.isArray(data.successCriteria) ? data.successCriteria : []) {
      if (typeof text !== 'string' || !text.trim()) continue;
      const hash = textHash(text);
      if (seen.has(hash)) {
        duplicates.push({ text, hash });
        continue;
      }
      seen.add(hash);
      const entry = byHash.get(hash);
      if (entry) {
        criteria.push({ id: entry.id, text, hash, state: entry.state, origin: entry.origin, addedBy: entry.addedBy, at: entry.at, confirmed: entry.confirmed, provisional: false });
      } else {
        criteria.push({ id: idOf(next), text, hash, state: 'proposed', origin: unknownOrigin, addedBy: null, at: null, confirmed: null, provisional: true });
        next += 1;
      }
    }
    let objective = null;
    if (typeof data.objective === 'string' && data.objective.trim()) {
      const hash = textHash(data.objective);
      const entry = state.objective && state.objective.hash === hash ? state.objective : null;
      objective = entry
        ? { text: data.objective, hash, state: entry.state, origin: entry.origin, at: entry.at, confirmed: entry.confirmed, provisional: false }
        : { text: data.objective, hash, state: 'proposed', origin: unknownOrigin, at: null, confirmed: null, provisional: true };
    }
    return { migrated: state.migrated, objective, criteria, removed: state.removed, duplicates };
  }

  // brief data + the file, joined in memory. NEVER writes: a string with no
  // entry is `proposed` with a provisional id, origin `legacy` on first
  // contact and `file` after it.
  view(briefData) {
    return this._join(this._state(), briefData);
  }

  // Writes the view. New strings take `origins[hash]` ({ origin, confirmed })
  // when given, `origins.objective` for the objective; an entry that already
  // exists is never changed here. Entries whose string is gone move to
  // `removed`. Call with the case lock held.
  reconcile(briefData, { origins = {}, addedBy = null, removedTexts = null, removedBy = null } = {}) {
    const state = this._state();
    const joined = this._join(state, briefData);
    const nowIso = this.now().toISOString();
    const given = isObject(origins) ? origins : {};
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(given, key);

    const criteria = [];
    let next = state.nextCriterion;
    for (const row of joined.criteria) {
      if (!row.provisional) {
        criteria.push(criterionRecord(row));
        continue;
      }
      const born = hasOwn(row.hash) ? birth(given[row.hash], nowIso) : { origin: row.origin, state: 'proposed', confirmed: null };
      criteria.push(criterionRecord({ id: row.id, hash: row.hash, ...born, addedBy: strOrNull(addedBy), at: nowIso }));
      next = Math.max(next, numberOf(row.id) + 1);
    }

    let objective = null;
    if (joined.objective) {
      if (!joined.objective.provisional) {
        objective = objectiveRecord(joined.objective);
      } else {
        const born = hasOwn(OBJECTIVE) ? birth(given[OBJECTIVE], nowIso) : { origin: joined.objective.origin, state: 'proposed', confirmed: null };
        objective = objectiveRecord({ hash: joined.objective.hash, ...born, at: nowIso });
      }
    }

    const live = new Set(criteria.map((e) => e.id));
    const textOf = removedTextLookup(removedTexts);
    const removed = [...state.removed];
    for (const entry of state.criteria) {
      if (live.has(entry.id)) continue;
      removed.push({ id: entry.id, hash: entry.hash, text: textOf(entry), state: entry.state, at: nowIso, by: strOrNull(removedBy) || strOrNull(addedBy) });
    }

    writeJsonIfChanged(this.file, {
      version: 1,
      migratedAt: state.migratedAt || nowIso,
      nextCriterion: next,
      objective,
      criteria,
      removed
    });
    return this.view(briefData);
  }

  // `targets`: `sc-` ids and/or 'objective'. `hashes[target]` is the hash
  // the caller saw; the owner confirms the words that were shown, so a hash
  // that no longer matches is refused and nothing is written.
  confirm(targets, { hashes = {}, by, channel = null, quote = null, factId = null } = {}) {
    if (typeof by !== 'string' || !by) throw new ScopeError('SCOPE_INVALID', 'A confirmation names who confirmed ("by").');
    const list = Array.isArray(targets) ? targets : [targets];
    const seen = isObject(hashes) ? hashes : {};
    const state = this._state();
    const found = [];
    for (const target of list) {
      const entry = target === OBJECTIVE ? state.objective : state.criteria.find((e) => e.id === target);
      if (!entry) {
        throw new ScopeError('CRITERION_NOT_FOUND', target === OBJECTIVE ? 'This case has no recorded objective to confirm.' : `No success criterion ${String(target)} in this case.`);
      }
      if (typeof seen[target] !== 'string' || seen[target] !== entry.hash) {
        throw new ScopeError('SCOPE_STALE', `${target === OBJECTIVE ? 'The objective' : target} changed since it was shown; read it again.`);
      }
      found.push(entry);
    }
    const nowIso = this.now().toISOString();
    let changed = false;
    for (const entry of found) {
      if (entry.state === 'confirmed') continue;
      entry.state = 'confirmed';
      entry.confirmed = { by, channel: strOrNull(channel), at: nowIso, quote: strOrNull(quote), factId: strOrNull(factId) };
      changed = true;
    }
    if (changed) {
      writeJsonIfChanged(this.file, {
        version: 1,
        migratedAt: state.migratedAt || nowIso,
        nextCriterion: state.nextCriterion,
        objective: state.objective ? objectiveRecord(state.objective) : null,
        criteria: state.criteria.map(criterionRecord),
        removed: state.removed
      });
    }
    return this.read();
  }

  // `adding`: every criterion about to be added; `addingProposed`: how many
  // of those are born proposed. → null, or the ScopeError to refuse with.
  limitsProblem(view, { addingProposed = 0, adding = 0 } = {}) {
    const rows = Array.isArray(view?.criteria) ? view.criteria : [];
    const count = (n) => (Number.isInteger(n) && n > 0 ? n : 0);
    const newProposed = count(addingProposed);
    const total = rows.length + Math.max(count(adding), newProposed);
    if (total > MAX_CRITERIA) {
      return new ScopeError('CRITERION_LIMIT', `A case has at most ${MAX_CRITERIA} success criteria.`);
    }
    const proposed = rows.filter((r) => r?.state !== 'confirmed').length + newProposed;
    if (newProposed > 0 && proposed > MAX_PROPOSED) {
      return new ScopeError('CRITERION_LIMIT', `A case has at most ${MAX_PROPOSED} proposed success criteria; ask the owner to confirm or drop some first.`);
    }
    return null;
  }
}

module.exports = {
  ScopeStore, ScopeError, textHash, validateCriterionText,
  MAX_CRITERIA, MAX_PROPOSED, ORIGINS, CONFIRMING_ORIGINS
};
