'use strict';
// `longhaul import` (benchmark spec §4, §10.1): a Claude Code transcript into
// LONGHAUL_HOME/sessions/<id>/. Private unless the owner says --public with a
// license; a file under LONGHAUL_HOME/private/ is private whatever is passed.
// No absolute source path is recorded.
const fs = require('fs');
const path = require('path');
const claudeCode = require('../history/importers/claude-code-jsonl');
const { buildManifest, writeSession, validateSessionId, sessionDir } = require('./session-format');
const { sha256File, isInside } = require('./files');
const { UsageError } = require('./errors');

function realOrSelf(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

async function importSession(home, sourcePath, { id, license, publicSession = false, force = false } = {}) {
  if (id !== undefined) validateSessionId(id);
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new UsageError(`No such file: ${sourcePath}`);
  const real = realOrSelf(resolved);
  const rootReal = realOrSelf(home.root);
  const fromPrivate = isInside(real, realOrSelf(home.private));

  if (fromPrivate && publicSession) throw new UsageError('A session under LONGHAUL_HOME/private is always private; --public is refused.');
  if (publicSession && !(typeof license === 'string' && license.trim())) throw new UsageError('--public needs --license <spdx id>.');
  if (!publicSession && license !== undefined) throw new UsageError('--license applies only with --public; a private session is licensed "private".');
  if (!(await claudeCode.detect(real))) {
    throw new UsageError(`${path.basename(real)} is not a Claude Code session transcript (subagent transcripts are not imported).`);
  }

  const sha = await sha256File(real);
  const sessionId = id || `cc-${sha.slice(0, 12)}`;
  validateSessionId(sessionId);
  const dir = sessionDir(home.root, sessionId);
  const manifestPath = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (existing.sourceSha256 === sha && existing.private === !publicSession) return { status: 'unchanged', sessionId, manifest: existing };
    if (!force) {
      throw new UsageError(`Session ${sessionId} already exists from a different file or with a different privacy setting; `
        + 'pass --force to replace it (its questions are validated again at the next run).');
    }
  }

  const { chat, messages, compactions, stats } = await claudeCode.parse(real);
  if (messages.length === 0) throw new UsageError(`${path.basename(real)} has no conversation messages.`);
  const sourceRef = isInside(real, rootReal) ? path.relative(rootReal, real).split(path.sep).join('/') : path.basename(real);
  const manifest = buildManifest({
    sessionId,
    source: claudeCode.kind,
    sourceRef,
    license: publicSession ? license.trim() : 'private',
    private: !publicSession,
    messages,
    compactions,
    extra: {
      title: chat.title,
      sourceSha256: sha,
      importer: { kind: claudeCode.kind, version: claudeCode.version },
      unmapped: stats.unmapped,
      skipped: stats.skipped,
      badLines: stats.badLines,
      duplicates: stats.duplicates,
      constructed: false
    }
  });
  writeSession(dir, { manifest, messages });
  return { status: 'imported', sessionId, manifest };
}

module.exports = { importSession };
