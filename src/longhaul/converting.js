'use strict';
// `longhaul convert` (benchmark spec §10.2): a downloaded public trajectory
// dataset into public constructed sessions. Pass 1 reads each row's repo, ids,
// license and size and plans; pass 2 reads again, keeps only the planned rows
// and writes each session. No absolute input path is recorded.
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { CONVERTERS } = require('./converters');
const { readRows, inputSha256, inputKind } = require('./converters/rows');
const { planSessions, assembleSession, sessionIdFor } = require('./converters/construct');
const { writeSession, sessionDir, estimateTokens, messageText } = require('./session-format');
const { isInside, byCodeUnit } = require('./files');
const { UsageError } = require('./errors');

function realOrSelf(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function checkOptions(converter, { source, config, split }) {
  if (!converter) throw new UsageError(`Unknown --source ${JSON.stringify(source)}; expected one of ${Object.keys(CONVERTERS).sort().join(', ')}.`);
  if (converter.needsConfig) {
    if (!config || !split) throw new UsageError(`--source ${converter.id} needs --config and --split (the dataset's config and split, e.g. --config v2.0 --split claudecode).`);
  } else if (config || split) {
    throw new UsageError(`--source ${converter.id} has no configs or splits; --config and --split are refused.`);
  }
}

function describeColumns(converter) {
  return [...new Set(Object.values(converter.columns).filter(Boolean))];
}

async function planPass(converter, input) {
  const entries = [];
  const badRows = [];
  for await (const item of readRows(input, { columns: describeColumns(converter) })) {
    if (item.error) {
      badRows.push({ rowNo: item.rowNo, reason: 'not JSON' });
      continue;
    }
    try {
      const described = converter.describe(item.row);
      let estTokens = 0;
      for (const m of converter.toMessages(item.row).messages) estTokens += estimateTokens(messageText(m));
      entries.push({ lineNo: item.rowNo, ...described, estTokens });
    } catch (err) {
      if (err?.code !== 'CONVERT_ROW') throw err;
      badRows.push({ rowNo: item.rowNo, reason: err.message });
    }
  }
  return { entries, badRows };
}

function repoSummaries(entries, plan, repo) {
  const byRepo = new Map();
  for (const e of entries) {
    if (repo && e.repo !== repo) continue;
    if (!byRepo.has(e.repo)) byRepo.set(e.repo, { repo: e.repo, rows: 0, instances: new Set(), sessions: 0, tooShort: 0, estTokens: 0 });
    const s = byRepo.get(e.repo);
    s.rows += 1;
    s.instances.add(e.instanceId ?? `line:${e.lineNo}`);
  }
  for (const p of plan.sessions) {
    byRepo.get(p.repo).sessions += 1;
    byRepo.get(p.repo).estTokens += p.estTokens;
  }
  for (const t of plan.tooShort) byRepo.get(t.repo).tooShort += 1;
  return [...byRepo.values()].sort((a, b) => byCodeUnit(a.repo, b.repo)).map((s) => ({
    repo: s.repo,
    kept: s.instances.size,
    duplicatesDropped: s.rows - s.instances.size,
    sessions: s.sessions,
    tooShort: s.tooShort,
    estTokens: s.estTokens
  }));
}

function existingStatus(dir, sourceSha256, convertOptions) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return 'new';
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  return existing.sourceSha256 === sourceSha256 && isDeepStrictEqual(existing.convertOptions, convertOptions) ? 'unchanged' : 'exists';
}

async function selectedRows(input, lineNos) {
  const rows = new Map();
  for await (const item of readRows(input)) {
    if (!item.error && lineNos.has(item.rowNo)) rows.set(item.rowNo, item.row);
  }
  return rows;
}

async function convertDataset(home, {
  source, input, repo = null, maxSessions = 12, targetTokens = 500000, minTokens = 250000, seed = 1,
  config = null, split = null, dryRun = false, force = false
}) {
  const converter = CONVERTERS[source];
  checkOptions(converter, { source, config, split });
  const resolved = path.resolve(input);
  inputKind(resolved);
  if (isInside(realOrSelf(resolved), realOrSelf(home.private))) {
    throw new UsageError('An input under LONGHAUL_HOME/private is refused: converted sessions are public.');
  }

  const sourceSha256 = await inputSha256(resolved);
  const { entries, badRows } = await planPass(converter, resolved);
  if (entries.length === 0) {
    throw new Error(`${path.basename(resolved)} has no usable row (${badRows.length} bad rows).`);
  }
  const plan = planSessions(entries, { targetTokens, minTokens, maxSessions, repo, seed });
  const convertOptions = { config, split, targetTokens, minTokens };
  const sourceRef = `${converter.datasetId}${converter.needsConfig ? `:${config}/${split}` : ''} ${path.basename(resolved)}`;

  const planned = plan.sessions.map((p) => {
    const sessionId = sessionIdFor(converter, { repo: p.repo, part: p.part, config, split, targetTokens, minTokens });
    const status = existingStatus(sessionDir(home.root, sessionId), sourceSha256, convertOptions);
    return { ...p, sessionId, trajectories: p.lineNos.length, status: status === 'exists' && force ? 'replace' : status };
  });
  const result = {
    planned,
    written: [],
    repos: repoSummaries(entries, plan, repo),
    tooShort: plan.tooShort,
    duplicatesDropped: plan.duplicatesDropped,
    badRows,
    usableRows: entries.length
  };
  if (dryRun) return result;

  const conflicts = planned.filter((p) => p.status === 'exists');
  if (conflicts.length) {
    throw new UsageError(`Session ${conflicts.map((p) => p.sessionId).join(', ')} already exists from a different input or with other options; `
      + 'pass --force to replace it (its questions are validated again at the next run).', 'SESSION_EXISTS');
  }

  const toWrite = planned.filter((p) => p.status !== 'unchanged');
  const rows = toWrite.length ? await selectedRows(resolved, new Set(toWrite.flatMap((p) => p.lineNos))) : new Map();
  for (const p of planned) {
    if (p.status === 'unchanged') {
      result.written.push({ sessionId: p.sessionId, status: 'unchanged' });
      continue;
    }
    const missing = p.lineNos.filter((n) => !rows.has(n));
    if (missing.length) throw new Error(`${path.basename(resolved)} changed while it was read (row ${missing[0]} is gone).`);
    const { manifest, messages } = assembleSession({
      converter,
      rows: p.lineNos.map((n) => rows.get(n)),
      repo: p.repo,
      part: p.part,
      sessionId: p.sessionId,
      sourceRef,
      sourceSha256,
      options: convertOptions
    });
    writeSession(sessionDir(home.root, p.sessionId), { manifest, messages });
    result.written.push({ sessionId: p.sessionId, status: 'imported', manifest, trajectories: p.trajectories });
  }
  return result;
}

module.exports = { convertDataset };
