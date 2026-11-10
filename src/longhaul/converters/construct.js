'use strict';
// Constructed sessions (benchmark spec §10.2): one repository's consecutive
// trajectories joined into one session, with a boundary per trajectory.
const crypto = require('crypto');
const { byCodeUnit } = require('../files');
const { createRng } = require('../rng');
const { buildManifest } = require('../session-format');

const TIMESTAMP_BASE_MS = Date.UTC(2000, 0, 1);
const CONVERTER_VERSION = 1;

function sharedLicense(licenses) {
  const present = licenses.filter((l) => typeof l === 'string' && l !== '');
  if (present.length === 0) return 'unknown-upstream';
  if (present.length !== licenses.length) return 'NOASSERTION';
  return present.every((l) => l === present[0]) ? present[0] : 'NOASSERTION';
}

function compareEntries(a, b) {
  return byCodeUnit(a.instanceId ?? '', b.instanceId ?? '')
    || byCodeUnit(a.trajectoryId ?? '', b.trajectoryId ?? '')
    || a.lineNo - b.lineNo;
}

function partsOf(repo, entries, targetTokens) {
  const parts = [];
  let current = null;
  for (const e of entries) {
    if (current && current.estTokens + e.estTokens > targetTokens) {
      parts.push(current);
      current = null;
    }
    if (!current) current = { repo, part: parts.length + 1, lineNos: [], estTokens: 0, licenses: [] };
    current.lineNos.push(e.lineNo);
    current.estTokens += e.estTokens;
    current.licenses.push(e.upstreamLicense);
  }
  if (current) parts.push(current);
  return parts;
}

function planSessions(entries, { targetTokens, minTokens, maxSessions, repo = null, seed = 1 }) {
  const byRepo = new Map();
  for (const e of entries) {
    if (repo && e.repo !== repo) continue;
    if (!byRepo.has(e.repo)) byRepo.set(e.repo, []);
    byRepo.get(e.repo).push(e);
  }

  let duplicatesDropped = 0;
  const tooShort = [];
  const sessions = [];
  const repos = createRng(seed).shuffle([...byRepo.keys()].sort(byCodeUnit));
  for (const name of repos) {
    const seen = new Set();
    const kept = [];
    for (const e of byRepo.get(name).slice().sort(compareEntries)) {
      // An entry with no instance id is its own instance.
      const key = e.instanceId ?? `line:${e.lineNo}`;
      if (seen.has(key)) { duplicatesDropped += 1; continue; }
      seen.add(key);
      kept.push(e);
    }
    for (const p of partsOf(name, kept, targetTokens)) {
      if (p.estTokens < minTokens) {
        tooShort.push({ repo: name, estTokens: p.estTokens });
        continue;
      }
      if (sessions.length >= maxSessions) continue;
      sessions.push({ repo: p.repo, part: p.part, lineNos: p.lineNos, estTokens: p.estTokens, upstreamLicense: sharedLicense(p.licenses) });
    }
  }
  return { sessions, tooShort, duplicatesDropped };
}

function addStats(total, stats) {
  total.skipped.system += stats.skipped?.system ?? 0;
  for (const k of ['unmapped', 'unpaired', 'badArguments', 'reasoningChars']) total[k] += stats[k] ?? 0;
}

function assembleSession({ converter, rows, repo, part, sessionId, sourceRef, sourceSha256, options }) {
  const messages = [];
  const boundaries = [];
  const licenses = [];
  const stats = { skipped: { system: 0 }, unmapped: 0, unpaired: 0, badArguments: 0, reasoningChars: 0 };
  for (const row of rows) {
    const described = converter.describe(row);
    licenses.push(described.upstreamLicense);
    const mapped = converter.toMessages(row);
    addStats(stats, mapped.stats);
    if (mapped.messages.length === 0) continue;
    const fromSeq = messages.length + 1;
    for (const m of mapped.messages) {
      const seq = messages.length + 1;
      messages.push({ ...m, id: `m-${seq}`, seq, timestamp: new Date(TIMESTAMP_BASE_MS + (seq - 1) * 1000).toISOString() });
    }
    boundaries.push({ fromSeq, toSeq: messages.length, instanceId: described.instanceId, trajectoryId: described.trajectoryId });
  }
  const manifest = buildManifest({
    sessionId,
    source: converter.source,
    sourceRef,
    license: converter.license,
    private: false,
    messages,
    extra: {
      constructed: true,
      boundaries,
      upstreamLicense: sharedLicense(licenses),
      repo,
      part,
      sourceSha256,
      convertOptions: options,
      converter: { id: converter.id, version: CONVERTER_VERSION },
      timestampsSynthetic: true,
      ...stats
    }
  });
  return { manifest, messages };
}

function sessionIdFor(converter, { repo, part, config = null, split = null, targetTokens, minTokens }) {
  const key = JSON.stringify({ repo, part, config, split, targetTokens, minTokens });
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  return `${converter.prefix}${hash}-${part}`;
}

module.exports = { CONVERTER_VERSION, planSessions, assembleSession, sessionIdFor };
