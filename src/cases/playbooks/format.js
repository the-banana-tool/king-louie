// src/cases/playbooks/format.js
// The playbook package format (cases stage 6 spec §3.2, §4.1–§4.3). Pure:
// parses text and walks a directory. Nothing in a package is ever passed to
// require; a playbook is data. A package comes from a third party, so every
// size and count limit in LIMITS is enforced from the cheapest signal
// available (a directory listing, an lstat) before any expensive work (a
// full file read, a parse) is done on its contents.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseYaml } = require('../../platform/yaml');

// A playbook's `name` is also its directory name and its vendored path
// under a case; a reserved Windows device name there is exactly as
// dangerous as one inside the package (see WINDOWS_RESERVED_RE below), so
// the same names are refused up front, whatever case they'd be typed in.
const NAME_RE = /^(?!(?:con|prn|aux|nul|com\d|lpt\d)$)[a-z0-9][a-z0-9-]{0,47}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Each dot-separated pre-release identifier is a purely numeric string with
// no leading zero (unless it is exactly "0"), or an alphanumeric one (which
// carries no such restriction) — semver 2.0's own rule, so "1.0.0-alpha.01"
// is invalid the same way a bare "01" MAJOR/MINOR/PATCH would be.
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION_RE = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?$`);
// C2's QuestionStore option id rule; a gating option becomes a question option.
const OPTION_ID_RE = /^[a-z0-9-]{1,16}$/;

const TOP_KEYS = Object.freeze([
  'name', 'version', 'title', 'description', 'caseType', 'executors',
  'gatingQuestions', 'materialityDefaults', 'budgetDefaults'
]);
const GATING_KEYS = Object.freeze(['id', 'text', 'fact', 'answerable', 'required', 'options', 'briefField', 'category', 'changes', 'how']);
// Owner-only brief fields a gating answer may fill. Never `resources` (R41).
const GATING_BRIEF_FIELDS = Object.freeze(['why', 'hardConstraints', 'alreadyTried', 'successCriteria', 'deadline']);
const CATEGORIES = Object.freeze(['personal', 'financial', 'legal', 'health']);
const BUDGET_KEYS = Object.freeze(['usd', 'turnsPerDay', 'contactsPerDay', 'questionsPerDay']);
const STEP_KEYS = Object.freeze(['executor', 'establishes', 'needs', 'optional']);
const LIMITS = Object.freeze({
  files: 64,
  fileBytes: 256 * 1024,
  totalBytes: 1024 * 1024,
  sourcesBytes: 64 * 1024,
  gatingQuestions: 30,
  minOptions: 2,
  maxOptions: 6,
  rules: 50,
  ruleChars: 300,
  title: 200,
  description: 2000,
  questionText: 500,
  note: 300
});
const ALLOWED_EXTENSIONS = new Set(['.yaml', '.md', '.txt']);
// walkPackage's own cost bounds, separate from LIMITS (the package-format
// limits a normal playbook must fit): a hostile package can be shaped to
// cost more to WALK than its final file count/byte total would suggest —
// many empty directories, or directories nested far deeper than any real
// playbook needs — so these stop the walk itself, not just what it reports.
const MAX_WALK_ENTRIES = 512;
const MAX_WALK_DEPTH = 8;
const MAX_WALK_ERRORS = 20;
// Windows reserves these base names (with or without an extension) for
// devices; opening "con.md" or "nul.txt" by path can reach the device
// instead of a file. A package that names one is refused rather than let a
// later reader (the loader, vendoring) hit it.
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const normalizeText = (text) => String(text ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const isMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

// A string already known to be a string, safe to show in full but not
// necessarily short (an attacker-chosen YAML key or steps.md token can be
// almost as long as the whole file). Truncated for message hygiene, never
// for the value actually used.
const truncateForMessage = (s) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);

// A value of unknown type read from parsed YAML (or elsewhere) that is
// about to be named in an error message. Never calls String()/toString() or
// otherwise stringifies it: a plain object or array's default stringify
// recurses through the whole structure, and a value that reached here
// having failed a `typeof === 'string'` check could — before parseYaml
// started refusing YAML aliases — be a large, deeply shared structure whose
// naive stringification is exactly the "expand a alias bomb into memory"
// bug this guards against. A string is shown, truncated; every other type
// is named only, never rendered.
function describeValue(v) {
  if (typeof v === 'string') return truncateForMessage(v);
  if (v === null) return 'null';
  if (Array.isArray(v)) return '<a list>';
  if (typeof v === 'object') return '<a mapping>';
  return `<${typeof v}>`;
}

function sha256(text) {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

// Sorted-key JSON, dropping undefined at every level. For the values hashed
// here (strings, integers, booleans, null, arrays and plain objects) this is
// the same text as RFC 8785 JCS (src/platform/jcs.js, on main as of F3), but
// stays separate from it: package text can carry `undefined` fields or a
// lone UTF-16 surrogate, both of which JCS's canonicalize() throws on, and
// these digests are local change detectors that are never signed.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isMap(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// ---- Versions: MAJOR.MINOR.PATCH[-pre], semver 2.0 precedence ----

const MAX_VERSION_LENGTH = 64;

function parseVersion(v) {
  if (typeof v !== 'string') throw new TypeError(`A version must be a string, got ${typeof v}.`);
  if (v.length > MAX_VERSION_LENGTH) {
    throw new TypeError(`Invalid version "${truncateForMessage(v)}". A version is at most ${MAX_VERSION_LENGTH} characters.`);
  }
  const m = VERSION_RE.exec(v);
  if (!m) throw new TypeError(`Invalid version "${truncateForMessage(v)}". Use MAJOR.MINOR.PATCH, optionally with -pre.`);
  // The matched digit strings are kept as strings, not converted with
  // Number(): MAJOR/MINOR/PATCH (and a numeric pre-release identifier) have
  // no length limit in semver beyond "no leading zero", so a hostile
  // version could carry far more digits than Number can represent exactly.
  // compareNumericStrings below compares them without ever going through
  // Number, so precision is never on the table.
  return { nums: [m[1], m[2], m[3]], pre: m[4] ? m[4].split('.') : [] };
}

// Two non-negative integer strings, neither with a leading zero (unless
// the whole string is "0") — exactly what VERSION_RE's numeric groups can
// capture. A longer string is always numerically larger; same length
// compares lexicographically, which agrees with numeric order once the
// leading-zero case is ruled out.
function compareNumericStrings(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    const c = compareNumericStrings(x.nums[i], y.nums[i]);
    if (c !== 0) return c;
  }
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  const n = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i += 1) {
    if (i >= x.pre.length) return -1;
    if (i >= y.pre.length) return 1;
    const p = x.pre[i];
    const q = y.pre[i];
    const pNum = /^\d+$/.test(p);
    const qNum = /^\d+$/.test(q);
    if (pNum && qNum) {
      const c = compareNumericStrings(p, q);
      if (c !== 0) return c;
    } else if (pNum) {
      return -1;
    } else if (qNum) {
      return 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

const majorOf = (v) => Number(parseVersion(v).nums[0]);

// ---- playbook.yaml ----

function checkFact(fact, where, err) {
  if (!isMap(fact)) {
    err(`${where}: fact { subject, attr } is required`);
    return null;
  }
  for (const k of Object.keys(fact)) if (k !== 'subject' && k !== 'attr') err(`${where}: fact has unknown key "${truncateForMessage(k)}"`);
  // typeof is checked before SLUG_RE.test ever sees the value: a non-string
  // subject/attr (an object or array, potentially huge) must never reach a
  // regex test or a template literal, both of which stringify their input.
  const subjectOk = typeof fact.subject === 'string' && SLUG_RE.test(fact.subject);
  const attrOk = typeof fact.attr === 'string' && SLUG_RE.test(fact.attr);
  if (!subjectOk || !attrOk) {
    err(`${where}: fact subject and attr must be lowercase slugs`);
    return null;
  }
  return { subject: fact.subject, attr: fact.attr };
}

function checkOptions(options, where, err) {
  if (!Array.isArray(options) || options.length < LIMITS.minOptions || options.length > LIMITS.maxOptions) {
    err(`${where}: options must be a list of ${LIMITS.minOptions} to ${LIMITS.maxOptions} { id, label }`);
    return null;
  }
  const seen = new Set();
  const out = [];
  for (const o of options) {
    if (!isMap(o) || typeof o.id !== 'string') {
      err(`${where}: option ids must be quoted strings, like id: "yes"`);
      return null;
    }
    if (!OPTION_ID_RE.test(o.id)) err(`${where}: option id "${truncateForMessage(o.id)}" must match ^[a-z0-9-]{1,16}$`);
    if (seen.has(o.id)) err(`${where}: option id "${truncateForMessage(o.id)}" is used twice`);
    seen.add(o.id);
    if (!isText(o.label, 200)) err(`${where}: option "${truncateForMessage(o.id)}" needs a label of 1 to 200 characters`);
    out.push({ id: o.id, label: typeof o.label === 'string' ? o.label.trim() : '' });
  }
  return out;
}

function checkGating(list, executors, err) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    err('gatingQuestions must be a list');
    return [];
  }
  if (list.length > LIMITS.gatingQuestions) err(`gatingQuestions has ${list.length} entries; at most ${LIMITS.gatingQuestions}`);
  const ids = new Set();
  const keys = new Set();
  const out = [];
  list.forEach((q, i) => {
    const where = `gatingQuestions[${i}]${isMap(q) && typeof q.id === 'string' ? ` ("${truncateForMessage(q.id)}")` : ''}`;
    if (!isMap(q)) {
      err(`${where}: must be a mapping`);
      return;
    }
    for (const k of Object.keys(q)) if (!GATING_KEYS.includes(k)) err(`${where}: unknown key "${truncateForMessage(k)}"`);
    if (typeof q.id !== 'string' || !SLUG_RE.test(q.id)) err(`${where}: id must be a lowercase slug`);
    else if (ids.has(q.id)) err(`${where}: id "${truncateForMessage(q.id)}" is used twice`);
    ids.add(q.id);
    if (!isText(q.text, LIMITS.questionText)) err(`${where}: text must be 1 to ${LIMITS.questionText} characters`);
    const fact = checkFact(q.fact, where, err);
    if (fact) {
      const key = `${fact.subject}.${fact.attr}`;
      if (keys.has(key)) err(`${where}: another question already asks for ${key}`);
      keys.add(key);
    }
    const answerable = q.answerable;
    if (answerable !== 'owner' && !(typeof answerable === 'string' && executors.includes(answerable))) {
      err(`${where}: answerable must be "owner" or one of executors (${executors.join(', ')})`);
    }
    if (q.required !== undefined && typeof q.required !== 'boolean') err(`${where}: required must be true or false`);
    let options = null;
    if (q.options !== undefined && q.options !== null) options = checkOptions(q.options, where, err);
    if (q.briefField !== undefined && q.briefField !== null) {
      if (!GATING_BRIEF_FIELDS.includes(q.briefField)) {
        err(`${where}: briefField must be one of ${GATING_BRIEF_FIELDS.join(', ')}`);
      } else if (answerable !== 'owner') {
        err(`${where}: briefField is only for owner-answerable questions`);
      }
    }
    if (q.category !== undefined && q.category !== null && !CATEGORIES.includes(q.category)) {
      err(`${where}: category must be one of ${CATEGORIES.join(', ')}`);
    }
    for (const k of ['changes', 'how']) {
      if (q[k] !== undefined && q[k] !== null && !isText(q[k], LIMITS.note)) err(`${where}: ${k} must be 1 to ${LIMITS.note} characters`);
    }
    out.push({
      id: q.id,
      text: typeof q.text === 'string' ? q.text.trim() : '',
      fact,
      answerable,
      required: q.required !== false,
      options,
      briefField: q.briefField || null,
      category: q.category || null,
      changes: q.changes || null,
      how: q.how || null
    });
  });
  return out;
}

function checkMateriality(m, err) {
  if (m === undefined || m === null) return { tell: [], ignore: [] };
  if (!isMap(m)) {
    err('materialityDefaults must be a mapping with tell and ignore lists');
    return { tell: [], ignore: [] };
  }
  const out = { tell: [], ignore: [] };
  for (const k of Object.keys(m)) {
    if (k !== 'tell' && k !== 'ignore') {
      err(`materialityDefaults: unknown key "${truncateForMessage(k)}"`);
      continue;
    }
    if (!Array.isArray(m[k]) || !m[k].every((v) => isText(v, 100))) {
      err(`materialityDefaults.${k} must be a list of short strings`);
      continue;
    }
    out[k] = m[k].map((v) => v.trim());
  }
  for (const item of out.tell) if (out.ignore.includes(item)) err(`materialityDefaults: "${item}" is in both tell and ignore`);
  return out;
}

// Upper bounds are a sanity check, not a real budget ceiling (R30: a
// playbook only ever *lowers* a budget default, never raises one without
// the owner's confirm) — they exist so a playbook can't hand the parser a
// number so large it is awkward to store, log or compare (e.g. Infinity
// minus one, or a value that stops being a safe integer).
const BUDGET_MAX = Object.freeze({ usd: 1e6, turnsPerDay: 10000, contactsPerDay: 10000, questionsPerDay: 10000 });

function checkBudget(b, err) {
  if (b === undefined || b === null) return {};
  if (!isMap(b)) {
    err('budgetDefaults must be a mapping');
    return {};
  }
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (!BUDGET_KEYS.includes(k)) {
      err(`budgetDefaults: unknown key "${truncateForMessage(k)}" (allowed: ${BUDGET_KEYS.join(', ')})`);
    } else if (k === 'usd') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) err('budgetDefaults.usd must be a number greater than 0');
      else if (v > BUDGET_MAX.usd) err(`budgetDefaults.usd must be at most ${BUDGET_MAX.usd}`);
      else out[k] = v;
    } else if (!Number.isInteger(v) || v <= 0) {
      err(`budgetDefaults.${k} must be a whole number greater than 0`);
    } else if (v > BUDGET_MAX[k]) {
      err(`budgetDefaults.${k} must be at most ${BUDGET_MAX[k]}`);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// knownCaseTypes: C5's list, or null when case types are not in this build.
function parsePlaybookYaml(text, { dirName = null, knownCaseTypes = null } = {}) {
  const errors = [];
  const warnings = [];
  const err = (message) => errors.push({ file: 'playbook.yaml', message });
  let doc;
  try {
    doc = parseYaml(normalizeText(text));
  } catch (e) {
    err(e.message);
    return { value: null, errors, warnings };
  }
  if (!isMap(doc)) {
    err('playbook.yaml must be a mapping of keys to values');
    return { value: null, errors, warnings };
  }
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k)) err(`unknown key "${truncateForMessage(k)}"`);

  if (typeof doc.name !== 'string' || !NAME_RE.test(doc.name)) {
    err('name must match ^[a-z0-9][a-z0-9-]{0,47}$');
  } else if (dirName && doc.name !== dirName) {
    err(`name "${doc.name}" must equal the directory name "${dirName}"`);
  }
  if (typeof doc.version !== 'string') {
    err('version must be a quoted string like "1.2.0"');
  } else if (!VERSION_RE.test(doc.version)) {
    err(`version "${doc.version}" must be MAJOR.MINOR.PATCH, optionally with -pre`);
  }
  if (doc.title !== undefined && !isText(doc.title, LIMITS.title)) err(`title must be 1 to ${LIMITS.title} characters`);
  if (doc.description !== undefined && !isText(doc.description, LIMITS.description)) {
    err(`description must be 1 to ${LIMITS.description} characters`);
  }
  if (typeof doc.caseType !== 'string' || !SLUG_RE.test(doc.caseType)) {
    err('caseType is required and must be a lowercase slug');
  } else if (Array.isArray(knownCaseTypes)) {
    if (!knownCaseTypes.includes(doc.caseType)) {
      err(`caseType "${doc.caseType}" is not a known case type (${knownCaseTypes.join(', ')})`);
    }
  } else if (doc.caseType !== 'general') {
    warnings.push({ file: 'playbook.yaml', message: `caseType "${doc.caseType}" cannot be checked: case types are not available in this build` });
  }
  let executors = [];
  if (!Array.isArray(doc.executors) || doc.executors.length === 0) {
    err('executors must be a non-empty list of executor ids');
  } else {
    for (const e of doc.executors) if (typeof e !== 'string' || !SLUG_RE.test(e)) err(`executors: "${describeValue(e)}" is not a lowercase slug`);
    if (new Set(doc.executors).size !== doc.executors.length) err('executors: each id may appear once');
    executors = doc.executors.filter((e) => typeof e === 'string');
  }
  const gatingQuestions = checkGating(doc.gatingQuestions, executors, err);
  const materialityDefaults = checkMateriality(doc.materialityDefaults, err);
  const budgetDefaults = checkBudget(doc.budgetDefaults, err);
  return {
    value: {
      name: doc.name,
      version: doc.version,
      title: doc.title || null,
      description: doc.description || null,
      caseType: doc.caseType,
      executors,
      gatingQuestions,
      materialityDefaults,
      budgetDefaults
    },
    errors,
    warnings
  };
}

// ---- steps.md ----

function slugify(title) {
  const s = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return s || 'step';
}

function parseKeyList(value, key, step, err, line) {
  const items = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const item of items) {
    const dot = item.indexOf('.');
    const subject = dot === -1 ? '' : item.slice(0, dot);
    const attr = dot === -1 ? '' : item.slice(dot + 1);
    if (!SLUG_RE.test(subject) || !SLUG_RE.test(attr)) {
      err(line, `steps.md step "${truncateForMessage(step.id)}": ${key} item "${truncateForMessage(item)}" is not subject.attr`);
    } else {
      out.push(`${subject}.${attr}`);
    }
  }
  return out;
}

function parseSteps(text, { executors = null } = {}) {
  const errors = [];
  const warnings = [];
  const err = (line, message) => errors.push({ file: 'steps.md', line, message });
  const lines = normalizeText(text).split('\n');
  let title = null;
  const intro = [];
  const steps = [];
  let current = null;
  let phase = 'intro';

  const finish = () => {
    if (!current) return;
    const s = current;
    if (!s.executor) err(s.line, `steps.md step "${truncateForMessage(s.id)}": executor is required`);
    else if (Array.isArray(executors) && !executors.includes(s.executor)) {
      err(s.line, `steps.md step "${truncateForMessage(s.id)}": executor "${truncateForMessage(s.executor)}" is not in playbook.yaml executors`);
    }
    if (!s.establishes.length) err(s.line, `steps.md step "${truncateForMessage(s.id)}": establishes is required`);
    if (s.title.length > LIMITS.title) err(s.line, `steps.md step "${truncateForMessage(s.id)}": the title is longer than ${LIMITS.title} characters`);
    const prev = steps[steps.length - 1];
    if (prev && s.n <= prev.n) err(s.line, `steps.md step "${truncateForMessage(s.id)}": step numbers must increase (${prev.n} then ${s.n})`);
    if (steps.some((o) => o.id === s.id)) err(s.line, `steps.md step "${truncateForMessage(s.id)}": the id is used twice`);
    steps.push({
      n: s.n,
      id: s.id,
      title: s.title,
      executor: s.executor,
      establishes: s.establishes,
      needs: s.needs,
      optional: s.optional,
      notes: s.notes.join('\n').trim()
    });
    current = null;
  };

  lines.forEach((line, i) => {
    const no = i + 1;
    if (!current && title === null && phase === 'intro' && /^# \S/.test(line)) {
      title = line.slice(2).trim();
      return;
    }
    if (/^## /.test(line)) {
      finish();
      // A simple, unambiguous match with no nested quantifiers: the old
      // `\s+(.+?)(?:\s+\{#([^}]*)\})?\s*$` had two greedy/lazy whitespace
      // groups competing over the same run of spaces, which is catastrophic
      // backtracking waiting for a heading with a lot of whitespace in it
      // (a third party writes steps.md). The rest of the line is captured
      // in one linear-time group, then trimmed and split by hand.
      const m = /^## (\d{1,6})\.[ \t]+(.*)$/.exec(line);
      if (!m) {
        err(no, 'a step heading is "## <n>. <title>" with an optional {#id}');
        phase = 'skip';
        return;
      }
      let rest = m[2].trimEnd();
      // Not a regex: `/\{#([^}]*)\}$/` is quadratic on a run of repeated
      // "{#" with no closing "}" anywhere (every starting position makes
      // [^}]* greedily consume to the end, fails to find "}", and
      // backtracks one character at a time before the engine tries the
      // next starting position — O(n) work at each of O(n) positions).
      // lastIndexOf/indexOf are each a single linear scan, so this is
      // O(n) however the text is shaped.
      let explicitId = null;
      const idOpen = rest.lastIndexOf('{#');
      if (idOpen !== -1) {
        const idClose = rest.indexOf('}', idOpen + 2);
        if (idClose === rest.length - 1) {
          explicitId = rest.slice(idOpen + 2, idClose);
          rest = rest.slice(0, idOpen).trimEnd();
        }
      }
      const id = explicitId !== null ? explicitId : slugify(rest);
      if (explicitId !== null && !SLUG_RE.test(id)) err(no, `step id "${truncateForMessage(id)}" must be a lowercase slug`);
      current = { n: Number(m[1]), title: rest, id, executor: null, establishes: [], needs: [], optional: false, notes: [], line: no, seen: new Set() };
      phase = 'await-bullets';
      return;
    }
    if (!current) {
      if (phase === 'intro') intro.push(line);
      return;
    }
    if (phase === 'await-bullets') {
      if (!line.trim()) return;
      phase = /^- /.test(line) ? 'bullets' : 'notes';
    }
    if (phase === 'bullets') {
      if (/^- /.test(line)) {
        const b = /^- ([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
        if (!b) {
          err(no, `steps.md step "${truncateForMessage(current.id)}": a bullet is "- <key>: <value>"`);
          return;
        }
        const [, key, value] = b;
        if (!STEP_KEYS.includes(key)) {
          err(no, `steps.md step "${truncateForMessage(current.id)}": unknown key "${truncateForMessage(key)}"`);
          return;
        }
        if (current.seen.has(key)) err(no, `steps.md step "${truncateForMessage(current.id)}": "${key}" is given twice`);
        current.seen.add(key);
        if (key === 'executor') {
          if (!SLUG_RE.test(value.trim())) err(no, `steps.md step "${truncateForMessage(current.id)}": executor "${truncateForMessage(value.trim())}" is not an executor id`);
          else current.executor = value.trim();
        } else if (key === 'optional') {
          if (value.trim() !== 'true' && value.trim() !== 'false') err(no, `steps.md step "${truncateForMessage(current.id)}": optional must be true or false`);
          current.optional = value.trim() === 'true';
        } else {
          current[key] = parseKeyList(value, key, current, err, no);
        }
        return;
      }
      phase = 'notes';
    }
    current.notes.push(line);
  });
  finish();
  if (!steps.length && !errors.length) err(null, 'steps.md has no steps ("## 1. <title>")');
  return { title, intro: intro.join('\n').trim(), steps, errors, warnings };
}

// ---- briefRules.md ----

function parseBriefRules(text, { executors = null } = {}) {
  const errors = [];
  const all = [];
  const byExecutor = {};
  const err = (line, message) => errors.push({ file: 'briefRules.md', line, message });
  let section = null;
  let count = 0;
  normalizeText(text).split('\n').forEach((line, i) => {
    const no = i + 1;
    if (!line.trim()) return;
    const h = /^## (.+)$/.exec(line);
    if (h) {
      const id = h[1].trim();
      if (!SLUG_RE.test(id) || (Array.isArray(executors) && !executors.includes(id))) {
        err(no, `"## ${truncateForMessage(id)}" is not one of playbook.yaml executors`);
        section = '__invalid__';
        return;
      }
      section = id;
      byExecutor[id] = byExecutor[id] || [];
      return;
    }
    const r = /^- (.+)$/.exec(line);
    if (!r) {
      err(no, 'only "- " rules and "## <executor>" headings are allowed');
      return;
    }
    const rule = r[1].trim();
    count += 1;
    if (rule.length > LIMITS.ruleChars) err(no, `a rule is longer than ${LIMITS.ruleChars} characters`);
    if (section === null) all.push(rule);
    else if (section !== '__invalid__') byExecutor[section].push(rule);
  });
  if (count > LIMITS.rules) err(null, `${count} rules; at most ${LIMITS.rules}`);
  return { all, byExecutor, errors };
}

// ---- The package on disk ----

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a.rel, 'utf8'), Buffer.from(b.rel, 'utf8'));

// The reserved-device-name problem with a bare file or directory name, or
// null. Matches the base name before the first dot, case-insensitively:
// Windows reserves "nul.txt" exactly as it reserves "nul".
function reservedNameProblem(name) {
  const dot = name.indexOf('.');
  const base = dot === -1 ? name : name.slice(0, dot);
  return WINDOWS_RESERVED_RE.test(base) ? `"${name}" is a reserved Windows device name` : null;
}

// A directory-entry name is checked against a positive whitelist rather
// than a blacklist of what to reject: `.` and `..` (impossible from a real
// directory listing anyway, since readdir never returns them and no entry
// name can contain a path separator), spaces, and anything outside ASCII
// are all refused by simply not being in the allowed set, rather than by
// enumerating every way a name could be unsafe. A trailing "." is refused
// separately because it is allowed by the character class but Windows
// silently strips it from the name it actually creates, which could make
// two different-looking package entries collide on disk.
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
function segmentProblem(name) {
  if (!SEGMENT_RE.test(name)) {
    return 'names must be 1 to 100 characters of A-Z, a-z, 0-9, "_", ".", "-", starting with a letter, digit or "_"';
  }
  if (name.endsWith('.')) return 'must not end with "."';
  return null;
}

// Files of a package, excluding every dot-prefixed entry (a top-level .git
// file or directory included). Symlinks and junctions are reported, never
// followed (fs.lstat reports a Windows junction as a symbolic link, same as
// a POSIX symlink, so the same check refuses both). Every LIMITS size and
// count check runs off the cheap signal (a directory listing, an lstat)
// available at that point, and stops the walk as soon as a count or total
// crosses its limit rather than continuing to stat or list a package built
// to be huge. `truncated` is true whenever the walk stopped early for any
// of these reasons: the file list and error list are then a prefix, not the
// whole story, which matters to a caller (readEntries) deciding whether it
// is safe to read what's there.
function walkPackage(dir) {
  const files = [];
  const errors = [];
  let truncated = false;
  const err = (message) => {
    if (errors.length >= MAX_WALK_ERRORS) {
      truncated = true;
      return;
    }
    errors.push({ file: null, message });
  };
  let root;
  try {
    root = fs.lstatSync(dir);
  } catch {
    err(`${dir} does not exist`);
    return { files, errors, truncated };
  }
  if (root.isSymbolicLink()) {
    err('the package folder is a symbolic link');
    return { files, errors, truncated };
  }
  if (!root.isDirectory()) {
    err(`${dir} is not a folder`);
    return { files, errors, truncated };
  }
  let total = 0;
  let entryCount = 0;
  let stop = false;
  // Two paths that differ only by case or Unicode normalization form can
  // name the same file on the filesystems a case actually runs on (case
  // insensitive on Windows and, commonly, macOS), so two package entries
  // that look distinct here could silently collide once materialized.
  // Keyed by the full path, not just a sibling name, so "Notes/x.md" vs.
  // "notes/X.MD" is caught too.
  const seenNormalized = new Map();
  const walk = (abs, rel, depth) => {
    if (stop) return;
    if (depth > MAX_WALK_DEPTH) {
      err(`${rel || '.'}: nested more than ${MAX_WALK_DEPTH} levels deep`);
      stop = true;
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(abs).sort();
    } catch (e) {
      err(`${rel || '.'}: cannot be read (${e.code || e.message})`);
      return;
    }
    for (const name of entries) {
      if (stop) return;
      // Every entry readdir returns counts, including the dot-prefixed and
      // rejected ones below: a package built to hold many thousands of
      // entries costs a stat and a name check each, whether or not it
      // would otherwise be refused for some other reason.
      entryCount += 1;
      if (entryCount > MAX_WALK_ENTRIES) {
        err(`more than ${MAX_WALK_ENTRIES} entries in the package`);
        stop = true;
        truncated = true;
        return;
      }
      if (errors.length >= MAX_WALK_ERRORS) {
        stop = true;
        truncated = true;
        return;
      }
      if (name.startsWith('.')) continue;
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const badSegment = segmentProblem(name);
      if (badSegment) {
        err(`${childRel}: ${badSegment}`);
        continue;
      }
      const reserved = reservedNameProblem(name);
      if (reserved) {
        err(`${childRel}: ${reserved}`);
        continue;
      }
      const normalized = childRel.toLowerCase().normalize('NFC');
      const collidesWith = seenNormalized.get(normalized);
      if (collidesWith !== undefined) {
        err(`${childRel}: collides with "${collidesWith}" (the same name once case and accents are folded)`);
        continue;
      }
      seenNormalized.set(normalized, childRel);
      let st;
      try {
        st = fs.lstatSync(childAbs);
      } catch (e) {
        err(`${childRel}: cannot be read (${e.code || e.message})`);
        continue;
      }
      if (st.isSymbolicLink()) {
        err(`${childRel}: symbolic links are not allowed`);
      } else if (st.isDirectory()) {
        walk(childAbs, childRel, depth + 1);
      } else if (st.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext) && name !== 'LICENSE') {
          err(`${childRel}: only .yaml, .md, .txt and LICENSE files are allowed`);
        }
        if (st.size > LIMITS.fileBytes) err(`${childRel}: larger than 256 KiB`);
        files.push({ rel: childRel, abs: childAbs, size: st.size });
        total += st.size;
        if (files.length > LIMITS.files) {
          err(`${files.length} files; at most ${LIMITS.files}`);
          stop = true;
          truncated = true;
          return;
        }
        if (total > LIMITS.totalBytes) {
          err('the package is larger than 1 MiB');
          stop = true;
          truncated = true;
          return;
        }
      } else {
        err(`${childRel}: not a regular file`);
      }
    }
  };
  walk(dir, '', 0);
  files.sort(byteOrder);
  return { files, errors, truncated };
}

// contentHash (R31): files sorted by the UTF-8 bytes of their relative
// paths, each contributing path NUL text NUL with CRLF read as LF.
function hashEntries(entries) {
  const h = crypto.createHash('sha256');
  for (const e of [...entries].sort(byteOrder)) {
    h.update(e.rel, 'utf8');
    h.update('\0');
    h.update(normalizeText(e.text), 'utf8');
    h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}

// hashPackage/fileHashes are used to detect whether a vendored copy still
// matches the pristine one, including a copy that no longer *validates*
// (an owner's edit can add a disallowed file, rename something, break a
// slug) — the caller (Task 11) hashes first and only then decides what to
// do about a mismatch, force included, so an ordinary validation problem
// must not stop the hash. This only refuses to read when the walk itself
// stopped early (truncated: there could be more package than `files`
// shows, so hashing it would be hashing a random prefix) or a listed file
// is over the per-file size limit — reading that much text just to throw
// its hash away is exactly the expensive work LIMITS exists to avoid.
function readEntries(dir) {
  const { files, errors, truncated } = walkPackage(dir);
  const oversized = files.find((f) => f.size > LIMITS.fileBytes);
  if (truncated || oversized) {
    const reason = truncated
      ? `the walk stopped early (${formatErrors(errors)})`
      : `${oversized.rel} is larger than 256 KiB`;
    const err = new Error(`cannot hash this package: ${reason}`);
    err.code = 'PACKAGE_TOO_LARGE';
    throw err;
  }
  return files.map((f) => ({ rel: f.rel, text: fs.readFileSync(f.abs, 'utf8') }));
}

function hashPackage(dir) {
  return hashEntries(readEntries(dir));
}

// Per-file hashes, used to name the files an owner edited.
function fileHashes(dir) {
  const out = {};
  for (const e of readEntries(dir)) out[e.rel] = sha256(normalizeText(e.text));
  return out;
}

// Node's default 'utf8' decoding is lenient: an invalid byte sequence is
// silently replaced with U+FFFD rather than reported, so a package with
// mojibake or a truncated multi-byte character would read as some other,
// wrong text instead of failing. A NUL byte is separately refused: it is
// valid UTF-8, but no legitimate playbook.yaml/steps.md/briefRules.md/
// sources.md content needs one, and letting it through risks confusing
// something downstream that treats the text as a C string.
function readTextStrict(abs) {
  const buf = fs.readFileSync(abs);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return { text: null, error: 'is not valid UTF-8' };
  }
  if (text.includes('\0')) return { text: null, error: 'contains a NUL byte' };
  return { text, error: null };
}

// Reads a named package file only when walkPackage already found it within
// the per-file size limit: a file already flagged oversized (or missing) is
// never read into memory, however large it actually is.
function readSmallFile(files, rel) {
  const f = files.find((x) => x.rel === rel);
  if (!f) return { present: false, text: null, error: null };
  if (f.size > LIMITS.fileBytes) return { present: true, text: null, error: null };
  const { text, error } = readTextStrict(f.abs);
  return { present: true, text, error };
}

function validatePackage(dir, { dirName = path.basename(dir), knownCaseTypes = null } = {}) {
  const { files, errors } = walkPackage(dir);
  const warnings = [];

  const yamlFile = readSmallFile(files, 'playbook.yaml');
  const stepsFile = readSmallFile(files, 'steps.md');
  const rulesFile = readSmallFile(files, 'briefRules.md');
  const sourcesFile = readSmallFile(files, 'sources.md');

  let playbook = null;
  let steps = null;
  let briefRules = { all: [], byExecutor: {}, errors: [] };

  if (!yamlFile.present) {
    errors.push({ file: 'playbook.yaml', message: 'playbook.yaml is missing' });
  } else if (yamlFile.error) {
    errors.push({ file: 'playbook.yaml', message: `playbook.yaml ${yamlFile.error}` });
  } else if (yamlFile.text !== null) {
    const parsed = parsePlaybookYaml(yamlFile.text, { dirName, knownCaseTypes });
    playbook = parsed.value;
    errors.push(...parsed.errors);
    warnings.push(...parsed.warnings);
  }

  const executors = playbook && playbook.executors.length ? playbook.executors : null;
  if (!stepsFile.present) {
    errors.push({ file: 'steps.md', message: 'steps.md is missing' });
  } else if (stepsFile.error) {
    errors.push({ file: 'steps.md', message: `steps.md ${stepsFile.error}` });
  } else if (stepsFile.text !== null) {
    steps = parseSteps(stepsFile.text, { executors });
    errors.push(...steps.errors);
    warnings.push(...(steps.warnings || []));
  }

  if (rulesFile.error) {
    errors.push({ file: 'briefRules.md', message: `briefRules.md ${rulesFile.error}` });
  } else if (rulesFile.present && rulesFile.text !== null) {
    briefRules = parseBriefRules(rulesFile.text, { executors });
    errors.push(...briefRules.errors);
  }

  if (sourcesFile.error) errors.push({ file: 'sources.md', message: `sources.md ${sourcesFile.error}` });
  const sources = sourcesFile.present && sourcesFile.text !== null ? normalizeText(sourcesFile.text) : '';
  if (sourcesFile.present && sourcesFile.text !== null && Buffer.byteLength(sources, 'utf8') > LIMITS.sourcesBytes) {
    errors.push({ file: 'sources.md', message: 'sources.md is larger than 64 KiB' });
  }

  // A NUL byte or invalid UTF-8 is refused in every walked file, not just
  // the four named ones above: any .yaml/.md/.txt/LICENSE file a package
  // carries (steps.md's own sources/ notes, say) gets the same check. The
  // four named files were already read (and so already checked) above;
  // this only reads the rest, and only within the per-file size limit —
  // an oversized file is never read here either.
  const NAMED_FILES = new Set(['playbook.yaml', 'steps.md', 'briefRules.md', 'sources.md']);
  for (const f of files) {
    if (NAMED_FILES.has(f.rel) || f.size > LIMITS.fileBytes) continue;
    const { error } = readTextStrict(f.abs);
    if (error) errors.push({ file: f.rel, message: `${f.rel} ${error}` });
  }

  return {
    ok: errors.length === 0,
    playbook,
    steps,
    briefRules: { all: briefRules.all, byExecutor: briefRules.byExecutor },
    sources,
    raw: {
      steps: stepsFile.present && stepsFile.text !== null ? normalizeText(stepsFile.text) : '',
      briefRules: rulesFile.present && rulesFile.text !== null ? normalizeText(rulesFile.text) : ''
    },
    errors,
    warnings,
    files: files.map((f) => ({ rel: f.rel, size: f.size }))
  };
}

function formatErrors(errors) {
  return (errors || []).map((e) => {
    const where = e.file ? `${e.file}${e.line ? `:${e.line}` : ''}: ` : '';
    return `${where}${e.message}`;
  }).join('\n');
}

module.exports = {
  NAME_RE,
  SLUG_RE,
  VERSION_RE,
  GATING_BRIEF_FIELDS,
  CATEGORIES,
  BUDGET_KEYS,
  LIMITS,
  normalizeText,
  sha256,
  canonicalJson,
  parseVersion,
  compareVersions,
  majorOf,
  parsePlaybookYaml,
  parseSteps,
  parseBriefRules,
  walkPackage,
  hashEntries,
  hashPackage,
  fileHashes,
  validatePackage,
  formatErrors
};
