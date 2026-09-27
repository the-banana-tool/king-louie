// src/cases/playbooks/changes.js
// Playbook changes for C2's re-orientation trigger (cases stage 6 spec §3.9)
// and the .kl/playbooks.json state file (§4.5). Pure apart from the state
// file helpers.
const path = require('path');
const { readJson, writeJsonIfChanged } = require('../jsonfile');
const { sha256, canonicalJson, NAME_RE, SLUG_RE, LIMITS } = require('./format');

const STATE_FILE = path.join('.kl', 'playbooks.json');
const LOST_STATES = Object.freeze(['unavailable', 'invalid', 'missing']);
const KNOWN_STATES = Object.freeze(['ok', ...LOST_STATES]);

const isMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// .kl/playbooks.json lives inside the case repo, so it is case data: it can
// arrive un-reviewed with `case import`, or be rewritten directly by a shell
// command (the write guard that protects facts.jsonl covers Write/Edit/
// MultiEdit, not Bash). readState therefore treats it exactly like a
// playbook package in format.js — untrusted third-party input — and never
// throws: a malformed file, a wrong type, or a `__proto__` key yields empty
// or partial state, never a crash or prototype pollution. Every map is
// built on a null-prototype object (so a "__proto__" key can never reach a
// normal object's setter even if a filter below were ever missed) and only
// copied onto a plain object at the end, through a spread, which copies own
// properties without ever invoking a setter (unlike Object.assign).
const MAX_PLAYBOOKS_TRACKED = LIMITS.files; // 64: far above any real case's playbook count
const MAX_GATING_IDS = LIMITS.gatingQuestions; // 30: the same cap a package itself is held to
const MAX_STEP_IDS = 128; // steps.md carries no count limit of its own; generous but bounded
const MAX_VENDORED_FILES = LIMITS.files; // 64: a package's own file-count cap (Deviation 10)
const MAX_APPLIED_ANSWERS = 4096; // one id per gating question answered over a case's life
const MAX_STRING = 2048; // generic string field: source, ref, commit, dates, hashes
const MAX_KEY_LENGTH = 128; // a map key: playbook name, gating id, step id, or file path

function emptyState() {
  return { vendored: {}, acknowledged: {}, appliedAnswers: [], lastUpdateCheck: null };
}

function boundedString(v, maxLen = MAX_STRING) {
  return typeof v === 'string' && v.length <= maxLen ? v : null;
}

function boundedStringArray(v, maxEntries, maxLen = MAX_STRING) {
  const out = [];
  if (!Array.isArray(v)) return out;
  for (const x of v) {
    if (out.length >= maxEntries) break;
    if (typeof x === 'string' && x.length <= maxLen) out.push(x);
  }
  return out;
}

// A string -> string map (gating/step id hashes, or a vendored playbook's
// per-file hashes), capped in entry count and key/value length. `keyRe`,
// when given, additionally requires the shape a legitimate id has (gating
// and step ids are lowercase slugs; a file's relative path is not, so it is
// only length-capped).
function boundedStringMap(v, { maxEntries, keyRe = null, maxKeyLength = MAX_KEY_LENGTH, maxValueLength = MAX_STRING }) {
  const out = Object.create(null);
  if (isMap(v)) {
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n >= maxEntries) break;
      if (typeof k !== 'string' || !k.length || k.length > maxKeyLength) continue;
      if (keyRe && !keyRe.test(k)) continue;
      const val = v[k];
      if (typeof val !== 'string' || val.length > maxValueLength) continue;
      out[k] = val;
      n += 1;
    }
  }
  return { ...out };
}

// One playbook's vendoring record. Every field is a bounded scalar except
// `files` (Deviation 10: per-file hashes, so an edited-copy refusal can
// name the files). Unknown keys are dropped; a value of the wrong shape
// reads as null/empty rather than being kept.
function sanitizeVendored(v) {
  if (!isMap(v)) return null;
  return {
    source: boundedString(v.source),
    ref: boundedString(v.ref),
    commit: boundedString(v.commit),
    vendoredAt: boundedString(v.vendoredAt),
    contentHash: boundedString(v.contentHash),
    onDiskVersion: boundedString(v.onDiskVersion),
    files: boundedStringMap(v.files, { maxEntries: MAX_VENDORED_FILES })
  };
}

// One playbook's last-oriented snapshot (see snapshotOf). A `state` outside
// KNOWN_STATES makes the whole entry unusable: it is dropped, not guessed
// at, so the playbook reports as never acknowledged (added, or its lost
// state) once — the same behaviour an unreadable file already gets.
function sanitizeAcknowledged(v) {
  if (!isMap(v) || typeof v.state !== 'string' || !KNOWN_STATES.includes(v.state)) return null;
  const out = { version: boundedString(v.version), state: v.state };
  if (v.state === 'ok') {
    out.gating = boundedStringMap(v.gating, { maxEntries: MAX_GATING_IDS, keyRe: SLUG_RE });
    out.steps = boundedStringMap(v.steps, { maxEntries: MAX_STEP_IDS, keyRe: SLUG_RE });
    out.briefRules = boundedString(v.briefRules);
    out.sources = boundedString(v.sources);
  }
  return out;
}

// A `vendored`/`acknowledged` top-level map: keyed by playbook name (the
// same NAME_RE a package's own directory name must match, which already
// excludes "__proto__" since it must start with [a-z0-9]), each entry
// sanitized by `sanitizeEntry`. An entry `sanitizeEntry` rejects (wrong
// type, unknown state, …) is dropped rather than kept partially.
function sanitizePlaybookMap(v, sanitizeEntry) {
  const out = Object.create(null);
  if (isMap(v)) {
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n >= MAX_PLAYBOOKS_TRACKED) break;
      if (typeof k !== 'string' || !NAME_RE.test(k)) continue;
      const entry = sanitizeEntry(v[k]);
      if (entry === null) continue;
      out[k] = entry;
      n += 1;
    }
  }
  return { ...out };
}

// An unreadable or malformed file reads as empty: every ok playbook then
// reports `added` once and the next re-orientation acknowledges it (spec
// §9). Never throws: readJson already turns bad JSON into `fallback`, and
// any other read error (EISDIR, EACCES, …) is caught here too.
function readState(caseDir) {
  let raw = null;
  try {
    raw = readJson(path.join(caseDir, STATE_FILE), null);
  } catch {
    raw = null;
  }
  const s = isMap(raw) ? raw : {};
  return {
    vendored: sanitizePlaybookMap(s.vendored, sanitizeVendored),
    acknowledged: sanitizePlaybookMap(s.acknowledged, sanitizeAcknowledged),
    appliedAnswers: boundedStringArray(s.appliedAnswers, MAX_APPLIED_ANSWERS),
    lastUpdateCheck: boundedString(s.lastUpdateCheck)
  };
}

function writeState(caseDir, state) {
  return writeJsonIfChanged(path.join(caseDir, STATE_FILE), {
    vendored: state.vendored || {},
    acknowledged: state.acknowledged || {},
    appliedAnswers: state.appliedAnswers || [],
    lastUpdateCheck: state.lastUpdateCheck || null
  });
}

// What the model last oriented against: per-item hashes of gating questions
// and steps (canonical JSON), and of the raw rules and sources text.
function snapshotOf(entry) {
  if (!entry || entry.state !== 'ok' || !entry.package) {
    return { version: entry?.onDisk?.version ?? entry?.pinned?.version ?? null, state: entry ? entry.state : 'missing' };
  }
  const pkg = entry.package;
  const gating = {};
  for (const q of pkg.playbook.gatingQuestions) gating[q.id] = sha256(canonicalJson(q));
  const steps = {};
  for (const s of pkg.steps.steps) steps[s.id] = sha256(canonicalJson(s));
  return {
    version: pkg.playbook.version,
    state: 'ok',
    gating,
    steps,
    briefRules: sha256(pkg.raw.briefRules),
    sources: sha256(pkg.sources)
  };
}

function diffIds(before, after) {
  const b = isMap(before) ? before : {};
  const a = isMap(after) ? after : {};
  return {
    added: Object.keys(a).filter((id) => !(id in b)),
    removed: Object.keys(b).filter((id) => !(id in a)),
    changed: Object.keys(a).filter((id) => id in b && a[id] !== b[id])
  };
}

const list = (label, ids) => (ids.length ? [`${label}[${ids.join(', ')}]`] : []);

function describe(c) {
  switch (c.kind) {
    case 'version-changed': return `moved from ${c.from} to ${c.to}`;
    case 'edited': return `the vendored copy of ${c.from} was edited`;
    case 'added': return `is now in use at ${c.to}`;
    default: return `is ${c.kind} and no longer used (was ${c.from || 'unknown'})`;
  }
}

function formatPlaybookChanges(changes) {
  return (changes || []).map((c) => {
    const parts = [];
    const gating = [...list('+', c.gating.added), ...list('-', c.gating.removed), ...list('~', c.gating.changed)];
    const steps = [...list('+', c.steps.added), ...list('-', c.steps.removed), ...list('~', c.steps.changed)];
    if (gating.length) parts.push(`gating ${gating.join(' ')}`);
    if (steps.length) parts.push(`steps ${steps.join(' ')}`);
    if (c.briefRulesChanged) parts.push('brief rules changed');
    if (c.sourcesChanged) parts.push('sources changed');
    return `Playbook ${c.name} ${describe(c)}${parts.length ? `: ${parts.join('; ')}` : ''}.`;
  }).join('\n');
}

// Change[] for the case.yaml entries whose disk state moved away from what
// was last acknowledged. `entries` are PlaybookLoader entries.
function computeChanges(entries, acknowledged = {}) {
  const out = [];
  for (const e of entries || []) {
    if (!e.pinned) continue;
    const ack = isMap(acknowledged[e.name]) ? acknowledged[e.name] : null;
    const wasOk = Boolean(ack && ack.state === 'ok');
    let kind = null;
    if (e.state === 'ok') {
      if (!wasOk) kind = 'added';
      else if (e.onDisk.version !== e.pinned.version) kind = 'version-changed';
      else if (e.onDisk.contentHash !== e.pinned.contentHash) kind = 'edited';
    } else if (LOST_STATES.includes(e.state) && wasOk) {
      kind = e.state;
    }
    if (!kind) continue;
    const now = snapshotOf(e);
    const base = wasOk ? ack : {};
    const change = {
      name: e.name,
      kind,
      from: e.pinned.version ?? null,
      to: e.state === 'ok' ? e.onDisk.version : null,
      key: `playbook:${e.name}:${e.state === 'ok' ? e.onDisk.contentHash : e.state}`,
      gating: diffIds(base.gating, now.gating),
      steps: diffIds(base.steps, now.steps),
      briefRulesChanged: (now.briefRules ?? null) !== (base.briefRules ?? null),
      sourcesChanged: (now.sources ?? null) !== (base.sources ?? null)
    };
    change.detail = formatPlaybookChanges([change]);
    out.push(change);
  }
  return out;
}

module.exports = {
  STATE_FILE,
  emptyState,
  readState,
  writeState,
  snapshotOf,
  diffIds,
  computeChanges,
  formatPlaybookChanges
};
