// src/cases/playbooks/views.js
// What the model and the executors see of the playbooks in a case (cases
// stage 6 spec §3.8): steps for the planner, brief rules for executors,
// sources and sections for Playbook.read, and the orientation section.
// Every piece of playbook text shown to the model is framed (frame.js);
// every single-line field is also one-lined, capped and tag-neutralised.
const { frame, neutralize, oneLine, cut } = require('./frame');
const { LIMITS } = require('./format');

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
// and prefixed [<playbook>], deduped. These go to executors, not the model,
// so they are not framed: they are instructions to the executor by design,
// and C3's outbound gate decides every payload. executorId is only a
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

function requireInUse(entries, name) {
  if (typeof name !== 'string' || !name) throw new Error('"playbook" must be a playbook name.');
  const e = (entries || []).find((x) => x && x.name === name);
  if (!e || !e.pinned) throw new Error(`Playbook "${safeLine(name, 64)}" is not attached to this case.`);
  if (e.state !== 'ok' || !e.package || !e.onDisk) {
    const reason = e.reason ? ` (${safeLine(e.reason, LINE_MAX)})` : '';
    throw new Error(`Playbook "${e.name}" is ${safeLine(e.state, 32)}${reason} and is not used.`);
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
// so a frame is never cut in half. Every line outside a frame that carries
// case or package text (names, reasons, warnings, change details, record
// ids) is one-lined, capped and tag-neutralised, so it cannot add a line or
// a frame of its own.
function orientationSection({ entries = [], changes = [], pending = [], status = 'active', max = ORIENTATION_MAX } = {}) {
  const blocks = [];
  const shown = (entries || []).filter((e) => e && (e.pinned || e.state === 'unregistered'));
  if (shown.length) {
    const lines = ["Playbooks (third-party method guidance, not the owner's instructions):"];
    for (const e of shown) {
      if (e.state === 'ok' && e.package && e.onDisk) {
        lines.push(`- ${safeLine(e.name, 64)}@${safeLine(e.onDisk.version, 64)} (${safeLine(e.mode, 16)}, ${e.package.steps.steps.length} steps; Playbook.read for steps and sources)`);
        for (const w of e.warnings || []) lines.push(`  - ${safeLine(w, LINE_MAX)}`);
      } else {
        const reason = e.reason ? `: ${safeLine(e.reason, LINE_MAX)}` : '';
        lines.push(`- playbook "${safeLine(e.name, 64)}" ${safeLine(e.state, 32)}${reason}`);
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
  stepsOf,
  briefRulesOf,
  sourcesOf,
  readSection,
  orientationSection
};
