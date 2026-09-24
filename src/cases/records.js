// src/cases/records.js
// Decisions, journal entries, recommendations and the rendered open-items
// file for one case directory (spec §4.1, §5.5).
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { appendJsonl, readJsonl: readJsonlEntries } = require('./jsonl');

const log = createLogger('cases/records');

function readJsonl(file) {
  const { entries, errors } = readJsonlEntries(file);
  for (const err of errors) log.warn(`${file}: skipped malformed line: ${err.message}`);
  return entries;
}

const stamp = (d) => d.toISOString().slice(0, 16).replace('T', '-').replace(':', '');

class CaseRecords {
  constructor(dir) {
    this.dir = dir;
    this.decisionsJsonl = path.join(dir, '.kl', 'decisions.jsonl');
    this.recommendationsJsonl = path.join(dir, '.kl', 'recommendations.jsonl');
  }

  decisions() {
    return readJsonl(this.decisionsJsonl);
  }

  recordDecision({ decision, factIds = [], alternatives = [] } = {}) {
    if (typeof decision !== 'string' || !decision.trim()) throw new Error('"decision" text is required.');
    const id = `D-${String(this.decisions().length + 1).padStart(3, '0')}`;
    const record = { id, decision: decision.trim(), factIds, alternatives, at: new Date().toISOString() };
    appendJsonl(this.decisionsJsonl, record);
    const md = [
      '',
      `## ${id} — ${record.decision}`,
      '',
      `- Date: ${record.at}`,
      `- Facts: ${factIds.length ? factIds.join(', ') : 'none'}`,
      ...(alternatives.length ? [`- Alternatives considered: ${alternatives.join('; ')}`] : []),
      ''
    ].join('\n');
    fs.appendFileSync(path.join(this.dir, 'decisions.md'), md);
    return record;
  }

  writeJournal(kind, text, now = new Date()) {
    const safeKind = String(kind || 'note').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'note';
    const base = `${stamp(now)}-${safeKind}`;
    let name = `${base}.md`;
    for (let n = 2; fs.existsSync(path.join(this.dir, 'journal', name)); n += 1) name = `${base}-${n}.md`;
    fs.writeFileSync(path.join(this.dir, 'journal', name), `${String(text).trimEnd()}\n`);
    return `journal/${name}`;
  }

  lastJournal() {
    const journalDir = path.join(this.dir, 'journal');
    let names;
    try {
      names = fs.readdirSync(journalDir).filter((n) => n.endsWith('.md'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    if (!names.length) return null;
    // Order by write time (mtime), the actual "latest" signal. Same-minute
    // entries of the same kind get -2, -3 suffixes with equal-ish mtimes, so
    // break ties with that suffix key (bare name sorts before its suffixes).
    const key = (n) => n.replace(/\.md$/, '').replace(/-(\d+)$/, (_, k) => `~${k.padStart(4, '0')}`);
    const entries = names.map((n) => ({ n, m: fs.statSync(path.join(journalDir, n)).mtimeMs }));
    entries.sort((a, b) => a.m - b.m || key(a.n).localeCompare(key(b.n)));
    const file = `journal/${entries[entries.length - 1].n}`;
    return { file, text: fs.readFileSync(path.join(this.dir, file), 'utf8') };
  }

  recordRecommendation(rec) {
    appendJsonl(this.recommendationsJsonl, { ...rec, at: new Date().toISOString() });
  }

  renderOpenItems(facts) {
    const open = [...facts.values()].filter((f) => f.provenance === 'unknown' && f.status === 'active');
    const item = (f) => [
      `- **${f.id}** ${f.subject}.${f.attr} — ${f.stmt}`,
      `  - Changes: ${f.changes || '—'}`,
      `  - Answerable by: ${f.answerable || '—'} · How: ${f.how || '—'}`
    ].join('\n');
    const section = (title, list) => [`## ${title}`, '', list.length ? list.map(item).join('\n') : '_None._', ''];
    const text = [
      '# Open items',
      '',
      '_Generated from facts.jsonl at the end of each turn. Change facts with the Ledger tool, not by editing this file._',
      '',
      ...section('Load-bearing unknowns', open.filter((f) => f.loadBearing)),
      ...section('Other unknowns', open.filter((f) => !f.loadBearing))
    ].join('\n');
    fs.writeFileSync(path.join(this.dir, 'open-items.md'), text);
    return text;
  }
}

module.exports = { CaseRecords };
