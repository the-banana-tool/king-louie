// src/cases/orientation.js
// Builds the orientation block every case turn starts from (spec §5.2).
// Pure: callers read the case from disk and pass the pieces in.
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

function briefLines(brief) {
  if (!brief || brief.error) return [`- brief.md could not be read: ${brief?.error || 'missing'}. Ask the owner to fix it or rewrite it with the Brief tool.`];
  const d = brief.data || {};
  const list = (v) => (Array.isArray(v) && v.length ? v.join('; ') : '—');
  return [
    `- Objective: ${d.objective || '—'}`,
    `- Why: ${d.why || '—'}`,
    `- Success criteria: ${list(d.successCriteria)}`,
    `- Hard constraints: ${list(d.hardConstraints)}`,
    `- Already tried: ${list(d.alreadyTried)}`,
    `- Deadline: ${d.deadline || '—'}`,
    d.gating?.complete
      ? '- Gating pass: complete'
      : '- Gating pass: INCOMPLETE. Ask the owner only what they alone know (why, hard constraints, what has already been tried), record it with the Brief tool, then call Brief completeGating. Recommendations are refused until then.'
  ];
}

function buildOrientation({
  meta, brief, facts = new Map(), decisions = [], lastJournal = null, ledgerErrors = [], maxChars = DEFAULT_MAX_CHARS
}) {
  const all = [...facts.values()];
  const active = all.filter((f) => f.status === 'active');
  const unknowns = active.filter((f) => f.provenance === 'unknown');
  const lbUnknowns = unknowns.filter((u) => u.loadBearing).map(unknownLine);
  const otherUnknowns = unknowns.filter((u) => !u.loadBearing).map(unknownLine);

  const head = [
    `# Case: ${meta.title} (${meta.slug}) — status: ${meta.status}`,
    '',
    '## Brief',
    ...briefLines(brief),
    '',
    '## Load-bearing unknowns (resolve or work around these before anything else)',
    ...(lbUnknowns.length ? lbUnknowns : ['- none recorded']),
    ''
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

  const budget = maxChars - head.length - tail.length - 200;
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

  return [head, kept.join('\n'), '', tail].join('\n');
}

module.exports = { buildOrientation, DEFAULT_MAX_CHARS };
