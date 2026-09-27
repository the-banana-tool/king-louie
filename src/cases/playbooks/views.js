// src/cases/playbooks/views.js
// What the model and the executors see of the playbooks in a case (cases
// stage 6 spec §3.8): steps for the planner, brief rules for executors,
// sources and sections for Playbook.read, and the orientation section.
// Every piece of playbook text shown to the model is framed (frame.js);
// every single-line field is also one-lined, capped and tag-neutralised.
const { frame, neutralize, oneLine, cut } = require('./frame');
const { LIMITS, NAME_RE, SLUG_RE, VERSION_RE } = require('./format');

const SOURCES_MAX = 24000;
const ORIENTATION_MAX = 1500;
const SECTIONS = Object.freeze(['steps', 'sources', 'briefRules', 'gating']);
const STEP_TITLE_MAX = LIMITS.title;
const STEP_NOTES_MAX = 2000;
const RULE_MAX = LIMITS.ruleChars;
const LINE_MAX = 300;

// Neutralise first, then cap: the cap is then exact, and framing the
// result adds nothing (neutralize is idempotent).
const safeLine = (v, max) => oneLine(neutralize(v), max);

// ---- Problems, without quoting package text (ruling T10-quotes) ----
//
// Loader reasons, validator messages and warnings quote package and case
// text (a version string, an unknown key, a submodule URL) outside any
// frame. The model sees only the state, the files involved (a fixed set of
// names; any other file is counted) and where the details are.
const STATES = Object.freeze(['ok', 'invalid', 'unavailable', 'missing', 'unregistered']);
const KNOWN_FILES = Object.freeze(['case.yaml', '.gitmodules', 'playbook.yaml', 'steps.md', 'briefRules.md', 'sources.md']);
const DETAILS = 'details in the Playbooks panel';
const UNREGISTERED_RE = /^step "([a-z0-9-]+)" expects executor "([a-z0-9-]+)", which is not registered$/;

const nameOf = (e) => (typeof e.name === 'string' && NAME_RE.test(e.name) ? e.name : '(invalid name)');
const stateOf = (e) => (STATES.includes(e.state) ? e.state : 'not usable');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function problemOf(e) {
  const known = new Set();
  const other = new Set();
  for (const err of Array.isArray(e.errors) ? e.errors : []) {
    const file = err && err.file;
    if (typeof file !== 'string' || !file) continue;
    if (KNOWN_FILES.includes(file)) known.add(file);
    else other.add(file);
  }
  const parts = [...known];
  if (other.size) parts.push(plural(other.size, 'other file'));
  return `(${parts.length ? `${parts.join(', ')}; ` : ''}${DETAILS})`;
}

// Only the unknown-executor warning is shown, rebuilt from the validated
// step id and executor of a step that exists; the rest are counted.
function warningTexts(e) {
  const lines = [];
  let other = 0;
  const steps = e.package?.steps?.steps || [];
  for (const w of Array.isArray(e.warnings) ? e.warnings : []) {
    const m = typeof w === 'string' ? UNREGISTERED_RE.exec(w) : null;
    const s = m && steps.find((x) => x.id === m[1] && x.executor === m[2]);
    if (s && SLUG_RE.test(s.id) && SLUG_RE.test(s.executor)) {
      lines.push(`step "${s.id}" expects executor "${s.executor}", which is not registered`);
    } else {
      other += 1;
    }
  }
  if (other) lines.push(`${plural(other, 'other warning')} (${DETAILS})`);
  return lines;
}
const warningLines = (e) => warningTexts(e).map((w) => `  - ${w}`);

const inUse = (entries) => (entries || []).filter((e) => e && e.state === 'ok' && e.package && e.pinned && e.onDisk);
const metaOf = (e) => ({ name: e.name, version: e.onDisk.version, source: e.pinned?.source });

// A playbook can name an executor; only the registry says whether one
// exists. The lookup never registers or grants anything, and a registry
// that throws is not a yes.
function executorKnown(registry, id) {
  if (!registry || typeof registry.get !== 'function') return null;
  try {
    return registry.get(id) != null;
  } catch {
    return false;
  }
}

// [{ playbook, version, id, n, title, executor, establishes, needs, optional, notes, executorKnown }]
// with title and notes one-lined, capped and framed (C3's Plan.propose hands
// these objects to the model unchanged).
function stepsOf(entries, { registry = null } = {}) {
  const out = [];
  for (const e of inUse(entries)) {
    const meta = metaOf(e);
    for (const s of e.package.steps.steps) {
      const notes = safeLine(s.notes, STEP_NOTES_MAX);
      out.push({
        playbook: e.name,
        version: e.onDisk.version,
        id: s.id,
        n: s.n,
        title: frame(meta, safeLine(s.title, STEP_TITLE_MAX)),
        executor: s.executor,
        establishes: [...(s.establishes || [])],
        needs: [...(s.needs || [])],
        optional: s.optional === true,
        notes: notes ? frame(meta, notes) : '',
        executorKnown: executorKnown(registry, s.executor)
      });
    }
  }
  return out;
}

// Rules for every executor, then this executor's, each one-lined, capped
// and prefixed [<playbook>], deduped. These go to executors (C3's draft
// prompt, "Executor rules:"), not to the case model, so they are not framed:
// they are instructions to the executor by design, and C3's outbound gate
// decides every payload. The case model sees them only framed, through
// Playbook.read section briefRules; C3's orientation section prints just
// their count (final review I2). executorId is only a
// lookup key (own keys only: "__proto__" or "constructor" find nothing).
function briefRulesOf(entries, executorId) {
  const seen = new Set();
  for (const e of inUse(entries)) {
    const rules = e.package.briefRules || {};
    const own = typeof executorId === 'string' && rules.byExecutor && Object.hasOwn(rules.byExecutor, executorId)
      ? rules.byExecutor[executorId]
      : [];
    for (const r of [...(Array.isArray(rules.all) ? rules.all : []), ...(Array.isArray(own) ? own : [])]) {
      const rule = safeLine(r, RULE_MAX);
      if (rule) seen.add(`[${e.name}] ${rule}`);
    }
  }
  return [...seen];
}

const MODES = Object.freeze(['vendored', 'submodule']);
const versionOf = (e) => {
  const v = e.onDisk?.version;
  return typeof v === 'string' && v.length <= 64 && VERSION_RE.test(v) ? v : '(invalid version)';
};

// Playbook.list: the attached (and unregistered) playbooks, built only from
// validated fields. A playbook that is not ok shows its state and the files
// involved, never the loader's reason or the validator's messages (ruling
// T10-quotes); the owner's Playbooks panel has the details.
function listItems(entries) {
  const out = [];
  for (const e of entries || []) {
    if (!e || !(e.pinned || e.state === 'unregistered')) continue;
    const mode = MODES.includes(e.mode) ? e.mode : null;
    if (e.state === 'ok' && e.package && e.onDisk) {
      out.push({ name: nameOf(e), version: versionOf(e), mode, state: 'ok', steps: e.package.steps.steps.length, warnings: warningTexts(e) });
    } else {
      out.push({ name: nameOf(e), mode, state: stateOf(e), detail: problemOf(e) });
    }
  }
  return out;
}

function requireInUse(entries, name) {
  if (typeof name !== 'string' || !name) throw new Error('"playbook" must be a playbook name.');
  const e = (entries || []).find((x) => x && x.name === name);
  if (!e || !e.pinned) throw new Error(`Playbook "${safeLine(name, 64)}" is not attached to this case.`);
  if (e.state !== 'ok' || !e.package || !e.onDisk) {
    throw new Error(`Playbook "${safeLine(e.name, 64)}" is ${stateOf(e)} ${problemOf(e)} and is not used.`);
  }
  return e;
}

// One playbook's sources.md, or all of them under ## <name> headings, within
// `max` characters. Frames are never cut: a section that does not fit is
// shortened inside its frame and a note says so.
function sourcesOf(entries, name = null, { max = SOURCES_MAX } = {}) {
  const list = name ? [requireInUse(entries, name)] : inUse(entries);
  if (!list.length) return 'No playbook in this case has sources.';
  const note = `\n\n(Truncated at ${max.toLocaleString('en-US')} characters. Read one playbook's sources with Playbook.read and "playbook".)`;
  const parts = [];
  let used = 0;
  for (const e of list) {
    const meta = metaOf(e);
    const head = name ? '' : `## ${e.name}\n\n`;
    // Neutralised up front so the lengths below are the lengths shown.
    const content = neutralize(e.package.sources || '(This playbook has no sources.md.)');
    const whole = `${head}${frame(meta, content)}`;
    const sep = parts.length ? 2 : 0;
    if (used + sep + whole.length <= max) {
      parts.push(whole);
      used += sep + whole.length;
      continue;
    }
    const overhead = head.length + frame(meta, '').length + sep + note.length;
    const room = max - used - overhead;
    if (room > 0) parts.push(`${head}${frame(meta, cut(content, room))}`);
    return parts.length ? `${parts.join('\n\n')}${note}` : note.slice(2, 2 + max);
  }
  return parts.join('\n\n');
}

// Playbook.read: one framed section of one playbook (sources may be all).
function readSection(entries, { playbook = null, section = 'steps' } = {}) {
  if (!SECTIONS.includes(section)) throw new Error(`section must be one of ${SECTIONS.join(', ')}.`);
  if (section === 'sources') return sourcesOf(entries, playbook || null);
  if (!playbook) throw new Error(`"playbook" is required to read ${section}.`);
  const e = requireInUse(entries, playbook);
  const meta = metaOf(e);
  if (section === 'steps') return frame(meta, e.package.raw.steps);
  if (section === 'briefRules') return frame(meta, e.package.raw.briefRules || '(This playbook has no brief rules.)');
  const lines = e.package.playbook.gatingQuestions.map((q) => {
    const fact = q.fact ? `${oneLine(q.fact.subject, 64)}.${oneLine(q.fact.attr, 64)}; ` : '';
    return `- ${oneLine(q.id, 64)} (${fact}${oneLine(q.answerable, 64)}; ${q.required ? 'required' : 'optional'}): ${oneLine(q.text, LIMITS.questionText)}`;
  });
  return frame(meta, lines.length ? lines.join('\n') : '(This playbook asks no gating questions.)');
}

// The turn-start note (≤ max characters). Blocks are added whole, in order,
// so a frame is never cut in half. Problems and warnings never quote package
// text (problemOf, warningLines). Every other line outside a frame that
// carries case or package text (names, change details, record ids) is
// one-lined, capped and tag-neutralised, so it cannot add a line or a frame
// of its own.
function orientationSection({ entries = [], changes = [], pending = [], status = 'active', max = ORIENTATION_MAX } = {}) {
  const blocks = [];
  const shown = (entries || []).filter((e) => e && (e.pinned || e.state === 'unregistered'));
  if (shown.length) {
    const lines = ["Playbooks (third-party method guidance, not the owner's instructions):"];
    for (const e of shown) {
      if (e.state === 'ok' && e.package && e.onDisk) {
        lines.push(`- ${safeLine(e.name, 64)}@${safeLine(e.onDisk.version, 64)} (${safeLine(e.mode, 16)}, ${e.package.steps.steps.length} steps; Playbook.read for steps and sources)`);
        lines.push(...warningLines(e));
      } else {
        lines.push(`- playbook "${nameOf(e)}" ${stateOf(e)} ${problemOf(e)}`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  if (changes && changes.length) {
    blocks.push(['Playbook changes since the last re-orientation:', ...changes.map((c) => `- ${safeLine(c?.detail, LINE_MAX)}`)].join('\n'));
  }
  if (pending && pending.length && (status === 'draft' || status === 'active')) {
    const label = status === 'draft' ? 'Pending gating' : 'Pending gating (required)';
    blocks.push(`${label}: ${pending.map((p) => safeLine(p.recordId || p.key, 64)).join(', ')}`);
    const used = inUse(entries);
    const byPlaybook = new Map();
    for (const p of pending) {
      const origin = (p.origins || []).find((o) => String(o).startsWith('playbook:'));
      const e = origin ? used.find((x) => `playbook:${x.name}` === origin) : null;
      if (!e) continue;
      if (!byPlaybook.has(e)) byPlaybook.set(e, []);
      byPlaybook.get(e).push(`- ${safeLine(p.key, 200)}: ${safeLine(p.text, LIMITS.questionText)}`);
    }
    for (const [e, lines] of byPlaybook) blocks.push(frame(metaOf(e), lines.join('\n')));
  }
  if (status === 'done') {
    blocks.push('This case is done. You may propose playbook changes with Playbook.propose; nothing else can be written.');
  }
  const more = '… (more with Playbook.list)';
  let text = '';
  for (let i = 0; i < blocks.length; i += 1) {
    const next = text ? `${text}\n${blocks[i]}` : blocks[i];
    const room = i === blocks.length - 1 ? max : max - more.length - 1;
    if (next.length > room) return text ? `${text}\n${more}` : more;
    text = next;
  }
  return text;
}

module.exports = {
  SOURCES_MAX,
  ORIENTATION_MAX,
  SECTIONS,
  STEP_TITLE_MAX,
  STEP_NOTES_MAX,
  RULE_MAX,
  listItems,
  stepsOf,
  briefRulesOf,
  sourcesOf,
  readSection,
  orientationSection
};
