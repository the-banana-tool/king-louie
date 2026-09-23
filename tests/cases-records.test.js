// tests/cases-records.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRecords } = require('../src/cases/records');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const newCaseDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-records-'));
  dirs.push(d);
  for (const sub of ['journal', '.kl']) fs.mkdirSync(path.join(d, sub));
  fs.writeFileSync(path.join(d, 'decisions.md'), '# Decisions\n');
  return d;
};

describe('CaseRecords', () => {
  it('records decisions to jsonl and markdown with sequential ids', () => {
    const dir = newCaseDir();
    const r = new CaseRecords(dir);
    const d1 = r.recordDecision({ decision: 'Drop the mailer channel', factIds: ['f-0003'], alternatives: ['Mail 68 letters'] });
    const d2 = r.recordDecision({ decision: 'Floor at 65k', factIds: ['f-0001', 'f-0004'] });
    assert.strictEqual(d1.id, 'D-001');
    assert.strictEqual(d2.id, 'D-002');
    assert.deepStrictEqual(r.decisions().map((d) => d.id), ['D-001', 'D-002']);
    const md = fs.readFileSync(path.join(dir, 'decisions.md'), 'utf8');
    assert.match(md, /## D-001 — Drop the mailer channel/);
    assert.match(md, /Facts: f-0001, f-0004/);
  });

  it('requires decision text', () => {
    const r = new CaseRecords(newCaseDir());
    assert.throws(() => r.recordDecision({ decision: '  ' }), /decision/);
  });

  it('writes journal entries with a safe, unique, sortable name', () => {
    const dir = newCaseDir();
    const r = new CaseRecords(dir);
    const when = new Date('2026-09-22T14:05:00Z');
    const a = r.writeJournal('turn', 'first', when);
    const b = r.writeJournal('../Re Orient!', 'second', when);
    const c = r.writeJournal('turn', 'third', when);
    assert.strictEqual(a, 'journal/2026-09-22-1405-turn.md');
    assert.strictEqual(b, 'journal/2026-09-22-1405-re-orient.md');
    assert.strictEqual(c, 'journal/2026-09-22-1405-turn-2.md');
    assert.strictEqual(r.lastJournal().text.trim(), 'third');
  });

  it('returns null when there is no journal entry', () => {
    fs.writeFileSync(path.join(newCaseDir(), 'journal', '.gitkeep'), '');
    assert.strictEqual(new CaseRecords(newCaseDir()).lastJournal(), null);
  });

  it('renders open-items.md from active unknowns, load-bearing first', () => {
    const dir = newCaseDir();
    const facts = new Map([
      ['f-0001', { id: 'f-0001', provenance: 'unknown', status: 'active', loadBearing: true, subject: 'lot', attr: 'listing-history', stmt: 'Listed before?', changes: 'Which channels are untried', answerable: 'owner', how: 'Ask' }],
      ['f-0002', { id: 'f-0002', provenance: 'unknown', status: 'active', loadBearing: false, subject: 'lot', attr: 'tap', stmt: 'Water tap installed?', changes: 'Buyer cost', answerable: 'utility', how: 'Call' }],
      ['f-0003', { id: 'f-0003', provenance: 'unknown', status: 'superseded', loadBearing: true, subject: 'lot', attr: 'acreage', stmt: 'Acreage?', changes: 'Price', answerable: 'clerk', how: 'Call' }]
    ]);
    const text = new CaseRecords(dir).renderOpenItems(facts);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'open-items.md'), 'utf8'), text);
    assert.ok(text.indexOf('f-0001') < text.indexOf('f-0002'));
    assert.ok(!text.includes('f-0003'));
    assert.match(text, /Ledger tool/);
  });
});
