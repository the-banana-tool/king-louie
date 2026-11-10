'use strict';
// `longhaul convert --source <id> --input <file.parquet|dir|file.jsonl> [--repo R] [--max-sessions 12]
//   [--target-tokens 500000] [--min-tokens 250000] [--seed 1] [--config C --split S] [--dry-run] [--force]`
const path = require('path');
const { convertDataset } = require('../converting');
const { UsageError } = require('../errors');

const USAGE = 'Usage: longhaul convert --source <nebius-swe-rebench|open-swe-traces> --input <file.parquet|dir|file.jsonl> '
  + '[--repo R] [--max-sessions 12] [--target-tokens 500000] [--min-tokens 250000] [--seed 1] [--config C --split S] [--dry-run] [--force]';

function intOption(values, name, fallback, min) {
  const raw = values[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || !Number.isSafeInteger(Number(raw))) {
    throw new UsageError(`--${name} must be a whole number of at least ${min}.`);
  }
  return Number(raw);
}

function list(items, show, max = 10) {
  const shown = items.slice(0, max).map(show).join(', ');
  return items.length > max ? `${shown}, …` : shown;
}

function writeSummary(out, result, minTokens) {
  const lines = [];
  if (result.tooShort.length) {
    lines.push(`${result.tooShort.length} parts too short (under --min-tokens ${minTokens}): ${list(result.tooShort, (t) => `${t.repo} ~${t.estTokens}`)}`);
  }
  if (result.duplicatesDropped) lines.push(`${result.duplicatesDropped} duplicate trajectories dropped (one per instance)`);
  if (result.badRows.length) lines.push(`${result.badRows.length} bad rows (${list(result.badRows, (b) => `line ${b.rowNo}`)})`);
  if (result.noTaskPrompt.length) {
    lines.push(`${result.noTaskPrompt.length} rows with no task prompt (no messages, or the first is not from the user): `
      + `${list(result.noTaskPrompt, (b) => `line ${b.rowNo}`)}`);
  }
  for (const line of lines) out.write(`${line}\n`);
}

module.exports = {
  options: {
    source: { type: 'string' },
    input: { type: 'string' },
    repo: { type: 'string' },
    'max-sessions': { type: 'string' },
    'target-tokens': { type: 'string' },
    'min-tokens': { type: 'string' },
    seed: { type: 'string' },
    config: { type: 'string' },
    split: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false }
  },
  async run(ctx, values, positionals) {
    if (positionals.length || !values.source || !values.input) throw new UsageError(USAGE);
    const minTokens = intOption(values, 'min-tokens', 250000, 0);
    const result = await convertDataset(ctx.home, {
      source: values.source,
      input: path.resolve(ctx.cwd, values.input),
      repo: values.repo ?? null,
      maxSessions: intOption(values, 'max-sessions', 12, 1),
      targetTokens: intOption(values, 'target-tokens', 500000, 1),
      minTokens,
      seed: intOption(values, 'seed', 1, 0),
      config: values.config ?? null,
      split: values.split ?? null,
      dryRun: values['dry-run'],
      force: values.force
    });
    const out = ctx.stdout;
    if (values['dry-run']) {
      for (const r of result.repos) {
        out.write(`${r.repo}: ${r.kept} trajectories kept, ${r.duplicatesDropped} duplicates dropped, ${r.sessions} sessions, `
          + `${r.tooShort} parts too short, ~${r.estTokens} estimated tokens in sessions\n`);
      }
      for (const p of result.planned) {
        const verb = { new: 'would write', replace: 'would replace', unchanged: 'unchanged', exists: 'exists (needs --force)' }[p.status];
        out.write(`${verb} ${p.sessionId}: ${p.repo} part ${p.part}, ${p.trajectories} trajectories, ~${p.estTokens} estimated tokens\n`);
      }
    } else {
      for (const w of result.written) {
        if (w.status === 'unchanged') {
          out.write(`unchanged ${w.sessionId}: already converted from this input with these options\n`);
          continue;
        }
        const m = w.manifest;
        out.write(`converted ${m.sessionId}: ${m.repo} part ${m.part}, ${w.trajectories} trajectories, ${m.messages} messages, `
          + `${m.toolCalls} tool calls, ~${m.estTokens} estimated tokens (${m.license}, upstream ${m.upstreamLicense})\n`);
      }
    }
    if (values.repo && result.repos.length === 0) out.write(`no rows for --repo ${values.repo}\n`);
    writeSummary(out, result, minTokens);
    return 0;
  }
};
