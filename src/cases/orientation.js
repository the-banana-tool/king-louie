// src/cases/orientation.js
// Builds the orientation block every case turn starts from (spec §5.2).
// Pure: callers read the case from disk and pass the pieces in.
const { neutralize, oneLine: frameOneLine } = require('./playbooks/frame');
const { abandonedLines } = require('./abandoned');
const { plainLineProblem } = require('./hidden-chars');

const DEFAULT_MAX_CHARS = 28000;
const JOURNAL_MAX = 2000;

const GROUPS = [
  ['From the owner', 'user'],
  ['Sourced', 'sourced'],
  ['From external agents', 'external-agent'],
  ['Inferred — not usable for recommendations or outbound', 'inferred']
];

function valueText(f) {
  if (f.value === null || f.value === undefined) return '';
  const v = typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value);
  return ` = ${v}${f.unit ? ` ${f.unit}` : ''}`;
}

function factLine(f) {
  const tags = [
    f.source?.kind ? `[${f.source.kind}]` : '',
    f.loadBearing ? '(load-bearing)' : '',
    f.disclosable === false ? '(private)' : ''
  ].filter(Boolean).join(' ');
  return `- ${f.id} ${f.subject}.${f.attr}${valueText(f)} — ${f.stmt}${tags ? ` ${tags}` : ''}`;
}

function unknownLine(u) {
  return `- ${u.id} ${u.subject}.${u.attr} — ${u.stmt}\n  Changes: ${u.changes || '—'} · Answerable by: ${u.answerable || '—'} · How: ${u.how || '—'}`;
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Cases stage 8 (spec §6.8): who wrote an objective the owner has not
// confirmed. Fixed words; a confirmed objective has no mark.
function objectiveMark(progress) {
  const objective = isObject(progress?.view?.objective) ? progress.view.objective : null;
  if (!objective || objective.state === 'confirmed') return '';
  if (objective.origin === 'file') return ' (changed outside the app; not confirmed)';
  if (objective.origin === 'legacy') return ' (from before progress was tracked; the owner has not confirmed it)';
  return ' (proposed by the model; the owner has not confirmed it)';
}

// The criteria the Progress section lists, or null when there is no view
// (no progress input, or one that could not be computed).
function progressRows(progress) {
  if (!isObject(progress)) return null;
  if (isObject(progress.closed)) return Array.isArray(progress.closed.criteria) ? progress.closed.criteria.filter(isObject) : [];
  return Array.isArray(progress.view?.criteria) ? progress.view.criteria.filter(isObject) : null;
}

function briefLines(brief, progress = null) {
  if (!brief || brief.error) return [`- brief.md could not be read: ${brief?.error || 'missing'}. Ask the owner to fix it or rewrite it with the Brief tool.`];
  const d = brief.data || {};
  const list = (v) => (Array.isArray(v) && v.length ? v.join('; ') : '—');
  // With the Progress section below, the brief gives the counts and the
  // section gives the texts, each with its state.
  const rows = progressRows(progress);
  let criteria = list(d.successCriteria);
  if (rows && rows.length) {
    const confirmed = rows.filter((r) => r.scope === 'confirmed').length;
    criteria = `${confirmed} confirmed, ${rows.length - confirmed} proposed; see Progress`;
  } else if (rows) {
    criteria = '—';
  }
  return [
    `- Objective: ${d.objective || '—'}${d.objective ? objectiveMark(progress) : ''}`,
    `- Why: ${d.why || '—'}`,
    `- Success criteria: ${criteria}`,
    `- Hard constraints: ${list(d.hardConstraints)}`,
    `- Already tried: ${list(d.alreadyTried)}`,
    `- Deadline: ${d.deadline || '—'}`,
    `- Materiality: tell ${list(d.materiality?.tell)}; ignore ${list(d.materiality?.ignore)}`,
    `- Safe defaults on silence: ${list(d.safeDefaults)}`,
    d.gating?.complete
      ? '- Gating pass: complete'
      : '- Gating pass: INCOMPLETE. Ask the owner only what they alone know (why, hard constraints, what has already been tried), record it with the Brief tool, then call Brief completeGating. Recommendations are refused until then.'
  ];
}

const clip = (text, max = JOURNAL_MAX) => (text.length > max ? `${text.slice(0, max)}…` : text);
const oneLine = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// ---- Progress and abandoned approaches (cases stage 8 spec §6.8) ----

const PROGRESS_HEADING = '## Progress (computed by King Louie; you cannot set these)';
const ABANDONED_HEADING = '## Abandoned approaches (do not retry one without a new fact; say what changed if you do)';
const PROGRESS_MAX = 2500;
const CRITERION_TEXT_MAX = 160;
const REASON_MAX = 160;
const ITEM_REFS_MAX = 5;
const HIDDEN_TEXT = '(text hidden: not one plain line)';
const CRITERION_ID = /^sc-\d{3,}$/;
const EVIDENCE_ID = /^[a-z]{1,4}-\d{1,8}$/;
const ITEM_ID = /^[a-z][a-z-]{1,39}$/;
// What the ready-to-close list gives as refs: the stores' ids and `#12`.
const REF = /^(?:[a-z]{1,6}-\d{1,8}|#\d{1,8})$/i;
const CRITERION_STATES = ['unmet', 'met', 'stale', 'failing'];
const FAILURE_FILE = /^journal\/\d{4}-\d{2}-\d{2}-\d{4}-failure(?:-\d+)?\.md$/;
const GROUP_LABEL = [['owner', 'Owner'], ['case', 'Case'], ['either', 'Either']];

// A criterion's text on one line, cut. The model can write a proposed one,
// so line breaks are folded and what is still not a plain line is hidden.
function criterionText(text) {
  const flat = oneLine(text, 2000);
  if (!flat || plainLineProblem(flat)) return HIDDEN_TEXT;
  return flat.length > CRITERION_TEXT_MAX ? `${flat.slice(0, CRITERION_TEXT_MAX - 1)}…` : flat;
}

function criterionLine(row) {
  const id = typeof row.id === 'string' && CRITERION_ID.test(row.id) ? row.id : 'sc-???';
  const text = criterionText(row.text);
  if (row.scope !== 'confirmed') return `- ${id} [proposed, not counted] ${text}`;
  const state = CRITERION_STATES.includes(row.state) ? row.state : 'unmet';
  let detail = '';
  if (state === 'met') {
    const ids = (Array.isArray(row.evidence) ? row.evidence : []).map((e) => e?.id).filter((e) => typeof e === 'string' && EVIDENCE_ID.test(e));
    if (ids.length) detail = ` (evidence ${ids.join(', ')})`;
  } else if (state !== 'unmet') {
    // Reasons are ids and fixed words (verify/status.js): the first one.
    const reason = Array.isArray(row.reasons) && typeof row.reasons[0] === 'string' ? oneLine(row.reasons[0], REASON_MAX) : '';
    if (reason && !plainLineProblem(reason)) detail = ` (${reason})`;
  }
  return `- ${id} [${state}] ${text}${detail}`;
}

// "Ready to close: no. Owner: criteria-confirmed (sc-004). Case: …": the
// open items by whose they are to fix, as item ids and refs only.
function readyLine(readiness) {
  if (!isObject(readiness)) return null;
  const open = (Array.isArray(readiness.items) ? readiness.items : [])
    .filter((i) => isObject(i) && i.state !== 'ok' && i.state !== 'n/a' && typeof i.id === 'string' && ITEM_ID.test(i.id));
  if (readiness.ready === true && !open.length) return '- Ready to close: yes.';
  const named = (item) => {
    const refs = (Array.isArray(item.refs) ? item.refs : []).filter((r) => typeof r === 'string' && REF.test(r));
    if (!refs.length) return item.state === 'unknown' ? `${item.id} (not known)` : item.id;
    const shown = refs.slice(0, ITEM_REFS_MAX);
    if (refs.length > shown.length) shown.push(`… ${refs.length - shown.length} more`);
    return `${item.id} (${shown.join(', ')})`;
  };
  const groups = GROUP_LABEL
    .map(([by, label]) => [label, open.filter((i) => (by === 'either' ? i.by !== 'owner' && i.by !== 'case' : i.by === by))])
    .filter(([, items]) => items.length)
    .map(([label, items]) => `${label}: ${items.map(named).join(', ')}.`);
  return `- Ready to close: no.${groups.length ? ` ${groups.join(' ')}` : ''}`;
}

// Directly after the brief. In the head, which is never trimmed, so it is
// capped: rows past the cap become one line saying how many.
function progressSection(progress) {
  if (!isObject(progress)) return [];
  const closed = isObject(progress.closed) ? progress.closed : null;
  const rows = progressRows(progress);
  const date = closed && /^\d{4}-\d{2}-\d{2}/.test(String(closed.at || '')) ? String(closed.at).slice(0, 10) : null;
  const heading = closed ? `${PROGRESS_HEADING} — as of ${date || 'its close'}` : PROGRESS_HEADING;
  if (!rows) return [heading, '- Progress could not be computed; the log says why.', ''];
  if (!rows.length) return [heading, '- No success criteria yet.', ''];
  const summary = typeof progress.summary === 'string' && progress.summary.trim() && !plainLineProblem(progress.summary.trim())
    ? `- ${oneLine(progress.summary, 300)}`
    : null;
  const ready = readyLine(closed ? closed.readiness : progress.readiness);
  const fixed = [heading, summary, ready].filter(Boolean);
  const moreLine = (n) => `- … ${n} more; Progress status lists them`;
  const room = PROGRESS_MAX - fixed.join('\n').length - 1;
  const lines = [];
  let used = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const line = criterionLine(rows[i]);
    const left = rows.length - i - 1;
    const reserve = left > 0 ? moreLine(left).length + 1 : 0;
    if (used + line.length + 1 + reserve > room) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length < rows.length) lines.push(moreLine(rows.length - lines.length));
  return [heading, ...(summary ? [summary] : []), ...lines, ...(ready ? [ready] : []), ''];
}

// After the load-bearing unknowns. `abandoned` is the store's records
// (oldest first), or { records, errors, unavailable }. `lastFailure` names
// the failure report a case was resumed from (R-C8-10: Fail writes no
// abandoned record, so the model is told where the report is).
function abandonedSection(abandoned, lastFailure) {
  const given = Array.isArray(abandoned) ? { records: abandoned } : (isObject(abandoned) ? abandoned : {});
  const lines = abandonedLines(Array.isArray(given.records) ? given.records : []);
  const skipped = Array.isArray(given.errors) ? given.errors.length : 0;
  if (skipped) lines.push(`- ${skipped} ${skipped === 1 ? 'line' : 'lines'} of the abandoned record could not be read and ${skipped === 1 ? 'is' : 'are'} not shown.`);
  if (given.unavailable === true) lines.push('- The abandoned approaches could not be read; the log says why.');
  const file = isObject(lastFailure) && typeof lastFailure.file === 'string' && FAILURE_FILE.test(lastFailure.file) ? lastFailure.file : null;
  if (file) lines.push(`- The last failure report is ${file}. If the approach it describes is dropped, record it with Progress abandon.`);
  return lines.length ? [ABANDONED_HEADING, ...lines, ''] : [];
}

function reorientationSection(triggers = []) {
  const blocking = triggers.filter((t) => t && t.blocking);
  if (!blocking.length) return [];
  return ['## Re-orientation required', ...blocking.map((t) => `- ${t.detail}`), 'Call Reorient before Recommend, Decide or Fail.', ''];
}

function sinceLastTurnSection(notes = []) {
  if (!notes.length) return [];
  return ['## Since last turn', ...notes.map((n) => `- ${n}`), ''];
}

function statusSection(meta, reason, failure) {
  if (!['needs-direction', 'paused', 'done', 'abandoned'].includes(meta.status)) return [];
  const detail = reason
    ? ` (${[reason.kind, reason.by ? `by ${reason.by}` : '', reason.at || ''].filter(Boolean).join(', ')})${reason.note ? `: ${reason.note}` : ''}`
    : '';
  const lines = ['## Status', `- ${meta.status}${detail}`];
  if (meta.status === 'needs-direction') {
    lines.push("- Waiting for the owner's direction. Report status or ask; do not plan or recommend.");
    if (failure?.text) lines.push(`### Failure report (${failure.file})`, clip(String(failure.text)).trimEnd());
  }
  if (meta.status === 'paused') lines.push('- Paused: only reading is available until the owner resumes the case.');
  return [...lines, ''];
}

// A playbook gating record's text is third-party wording, and this section
// sits outside every playbook frame (ruling T12-openq, T10-quotes): it shows
// only the neutralised, one-line, capped key. Pending required questions
// appear with their text, framed, in the playbooks section (views.js).
function questionText(q) {
  if (q.payload?.type === 'gating') {
    const key = typeof q.payload.gating?.key === 'string' ? q.payload.gating.key : '';
    return `gating ${frameOneLine(neutralize(key), 80) || '(no key)'} (playbook question; see Brief)`;
  }
  return oneLine(q.text, 200);
}

function questionsSection(questions = [], now = new Date()) {
  if (!questions.length) return [];
  const t = now.getTime();
  const line = (q) => {
    const overdue = q.expiresAt && Date.parse(q.expiresAt) <= t && q.defaultOnSilence === 'hold' ? ' — OVERDUE, still holding' : '';
    return `- ${q.id} [${q.kind}, ${q.urgency}] ${questionText(q)}${overdue}`;
  };
  return ['## Open questions to the owner', ...questions.map(line), 'Do not assume answers to open questions.', ''];
}

function budgetSection(budget) {
  if (!budget || typeof budget !== 'object') return [];
  const passed = (e) => (Array.isArray(e?.crossed) && e.crossed.length ? ` (passed ${e.crossed.join(', ')} %)` : '');
  const lines = [];
  for (const [category, e] of Object.entries(budget)) {
    if (!e) continue;
    if (category === 'deadline') {
      if (e.at) lines.push(`- deadline ${e.at}: ${Math.round(Math.min(Number(e.ratio) || 0, 9.99) * 100)} % of the time used${passed(e)}`);
      continue;
    }
    if (!e.limit) continue;
    lines.push(`- ${category}: ${e.spent} of ${e.limit}${e.day ? ` today (${e.day})` : ''}${passed(e)}`);
  }
  const unpriced = Number(budget.usd?.unpricedTokens) || 0;
  if (unpriced > 0) lines.push(`- ${unpriced} tokens on providers with no price table are not counted against the $ budget.`);
  return lines.length ? ['## Budget', ...lines, ''] : [];
}

const DETOURS_MAX = 1500;
const EXTRAS_MAX = 2500;
const cap = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Detour proposals and related-case lines (cases stage 5 spec §3.8).
function detoursSection(detours = []) {
  if (!detours.length) return [];
  return [cap(['## Detours and related cases', ...detours.map((d) => `- ${d}`)].join('\n'), DETOURS_MAX), ''];
}

// The case type's extras, rendered last (cases stage 5 spec §3.7).
function extrasBlock(extras) {
  if (!extras || !String(extras.text || '').trim()) return '';
  return cap(`## Case type: ${extras.type}\n${String(extras.text).trimEnd()}`, EXTRAS_MAX);
}

function nextWakeupSection(w) {
  if (!w) return [];
  return ['## Next wake-up', `- ${w.id} ${w.kind} at ${w.nextAt}`, ''];
}

function buildOrientation({
  meta, brief, facts = new Map(), decisions = [], lastJournal = null, ledgerErrors = [], maxChars = DEFAULT_MAX_CHARS,
  triggers = [], hookNotes = [], statusReason = null, failure = null, questions = [], budget: budgetStatus = null, nextWakeup = null,
  now = new Date(), detours = [], extras = null, progress = null, abandoned = [], lastFailure = null
}) {
  const all = [...facts.values()];
  const active = all.filter((f) => f.status === 'active');
  const unknowns = active.filter((f) => f.provenance === 'unknown');
  const lbUnknowns = unknowns.filter((u) => u.loadBearing).map(unknownLine);
  const otherUnknowns = unknowns.filter((u) => !u.loadBearing).map(unknownLine);

  const head = [
    `# Case: ${meta.title} (${meta.slug}) — status: ${meta.status}`,
    '',
    ...reorientationSection(triggers),
    ...sinceLastTurnSection(hookNotes),
    ...statusSection(meta, statusReason, failure),
    '## Brief',
    ...briefLines(brief, progress),
    '',
    ...progressSection(progress),
    '## Load-bearing unknowns (resolve or work around these before anything else)',
    ...(lbUnknowns.length ? lbUnknowns : ['- none recorded']),
    '',
    ...abandonedSection(abandoned, lastFailure),
    ...questionsSection(questions, now),
    ...detoursSection(detours),
    ...budgetSection(budgetStatus),
    ...nextWakeupSection(nextWakeup)
  ].join('\n');

  const decisionLines = decisions.map((d) => {
    const stale = (d.factIds || [])
      .map((id) => facts.get(id))
      .filter((f) => f && f.status !== 'active')
      .map((f) => ` ⚠ cites ${f.id} which is now ${f.status}; revisit this decision.`)
      .join('');
    return `- ${d.id} ${d.decision} (facts: ${(d.factIds || []).join(', ') || 'none'})${stale}`;
  });
  let journal = '';
  if (lastJournal) {
    const body = lastJournal.text.length > JOURNAL_MAX ? `${lastJournal.text.slice(0, JOURNAL_MAX)}…` : lastJournal.text;
    journal = [`## Last journal entry (${lastJournal.file})`, body.trimEnd(), ''].join('\n');
  }
  const tail = [
    '## Decisions',
    ...(decisionLines.length ? decisionLines : ['- none yet']),
    '',
    '## Other unknowns',
    ...(otherUnknowns.length ? otherUnknowns : ['- none']),
    '',
    ...(ledgerErrors.length
      ? ['## Ledger warnings', ...ledgerErrors.map((e) => `- facts.jsonl line ${e.line} skipped: ${e.message}`), '']
      : []),
    journal
  ].join('\n');

  const factLines = [];
  for (const [title, provenance] of GROUPS) {
    const group = active.filter((f) => f.provenance === provenance);
    if (group.length) factLines.push({ text: `### ${title}` }, ...group.map((f) => ({ text: factLine(f), fact: true })));
  }
  const corrections = all.filter((f) => f.status !== 'active' && f.provenance !== 'unknown');
  if (corrections.length) {
    factLines.push({ text: '### Corrections (superseded or retracted)' });
    factLines.push(...corrections.map((f) => ({
      text: f.supersededBy ? `- ${f.id} → ${f.supersededBy}: ${f.stmt}` : `- ${f.id} retracted: ${f.stmt}`,
      fact: true
    })));
  }

  const typeBlock = extrasBlock(extras);
  const budget = maxChars - head.length - tail.length - typeBlock.length - 200;
  const kept = ['## Facts (active)'];
  let used = kept[0].length + 1;
  let omitted = 0;
  for (const line of factLines) {
    if (omitted || used + line.text.length + 1 > budget) {
      if (line.fact) omitted += 1;
      continue;
    }
    kept.push(line.text);
    used += line.text.length + 1;
  }
  if (omitted) kept.push(`- … ${omitted} more facts not shown; use the Ledger tool's query action.`);
  if (kept.length === 1) kept.push('- none yet');

  return [head, kept.join('\n'), '', tail, ...(typeBlock ? [typeBlock, ''] : [])].join('\n');
}

module.exports = { buildOrientation, questionText, DEFAULT_MAX_CHARS };
