// tests/cases-ledger.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FactLedger, LedgerError } = require('../src/cases/ledger');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const newLedger = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-ledger-'));
  dirs.push(d);
  fs.writeFileSync(path.join(d, 'facts.jsonl'), '');
  return new FactLedger(d);
};
const src = { kind: 'url', ref: 'https://records.example.org/parcel/1' };

describe('FactLedger', () => {
  it('asserts sourced facts with sequential ids and disclosable by default', () => {
    const l = newLedger();
    const a = l.assert({ stmt: 'Lot is 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, unit: 'acre', source: src });
    const b = l.assert({ stmt: 'Flood zone X', subject: 'lot', attr: 'flood-zone', value: 'X', source: src });
    assert.strictEqual(a.id, 'f-0001');
    assert.strictEqual(b.id, 'f-0002');
    assert.strictEqual(a.provenance, 'sourced');
    assert.strictEqual(a.status, 'active');
    assert.strictEqual(a.disclosable, true);
    assert.strictEqual(a.loadBearing, false);
  });

  it('requires a source on assert and a basis on infer', () => {
    const l = newLedger();
    assert.throws(() => l.assert({ stmt: 's', subject: 'x', attr: 'y', value: 1 }), LedgerError);
    assert.throws(() => l.infer({ stmt: 's', subject: 'x', attr: 'y', value: 1 }), /basis/);
    assert.throws(() => l.infer({ stmt: 's', subject: 'x', attr: 'y', value: 1, basis: ['f-0099'] }), /f-0099/);
  });

  it('accepts a user-message source only on provenance user', () => {
    const l = newLedger();
    const owner = { kind: 'user-message', ref: 't1' };
    assert.throws(() => l.assert({ stmt: 's', subject: 'x', attr: 'y', value: 1, provenance: 'sourced', source: owner }), LedgerError);
    assert.throws(() => l.assert({ stmt: 's', subject: 'x', attr: 'y', value: 1, source: owner }), LedgerError);
    assert.strictEqual(l.assert({ stmt: 's', subject: 'x', attr: 'y', value: 1, provenance: 'user', source: owner }).provenance, 'user');
  });

  it('refuses unknown provenance values on assert', () => {
    const l = newLedger();
    assert.throws(() => l.assert({ stmt: 's', subject: 'x', attr: 'y', value: 1, source: src, provenance: 'inferred' }), /provenance/);
  });

  it('makes inferred, unknown and sensitive-category facts non-disclosable', () => {
    const l = newLedger();
    const base = l.assert({ stmt: 'Owner said sale is urgent', subject: 'owner', attr: 'urgency', value: 'high', provenance: 'user', source: { kind: 'user-message', ref: 't1' } });
    const inf = l.infer({ stmt: 'Owner is motivated', subject: 'owner', attr: 'motivation', value: 'high', basis: [base.id] });
    const unk = l.unknown({ stmt: 'Has the lot been listed before?', subject: 'lot', attr: 'listing-history', changes: 'Which channels are untried', answerable: 'owner', how: 'Ask the owner' });
    const fin = l.assert({ stmt: 'Mortgage payoff 41,200', subject: 'loan', attr: 'payoff', value: 41200, category: 'financial', source: src });
    assert.strictEqual(inf.disclosable, false);
    assert.strictEqual(unk.disclosable, false);
    assert.strictEqual(unk.provenance, 'unknown');
    assert.strictEqual(unk.value, null);
    assert.strictEqual(fin.disclosable, false);
  });

  it('ignores a disclosable flag passed by the caller', () => {
    const l = newLedger();
    const f = l.assert({ stmt: 'Payoff', subject: 'loan', attr: 'payoff', value: 1, category: 'financial', source: src, disclosable: true });
    assert.strictEqual(f.disclosable, false);
  });

  it('supersedes without rewriting the file', () => {
    const l = newLedger();
    const old = l.assert({ stmt: 'Lot is 1.85 acres (GIS)', subject: 'lot', attr: 'acreage', value: 1.85, source: src });
    const before = fs.readFileSync(l.path, 'utf8');
    const fresh = l.assert({ stmt: 'Lot is 2.12 acres (plat)', subject: 'lot', attr: 'acreage', value: 2.12, source: src, supersedes: old.id });
    const after = fs.readFileSync(l.path, 'utf8');
    assert.ok(after.startsWith(before), 'append-only');
    const { facts } = l.view();
    assert.strictEqual(facts.get(old.id).status, 'superseded');
    assert.strictEqual(facts.get(old.id).supersededBy, fresh.id);
    assert.strictEqual(facts.get(fresh.id).status, 'active');
  });

  it('resolves an unknown by superseding it', () => {
    const l = newLedger();
    const u = l.unknown({ stmt: 'Listed before?', subject: 'lot', attr: 'listing-history', changes: 'c', answerable: 'owner', how: 'ask' });
    const a = l.assert({ stmt: 'Three agents listed it on the MLS', subject: 'lot', attr: 'listing-history', value: 'mls-3x', provenance: 'user', source: { kind: 'user-message', ref: 't2' }, supersedes: u.id });
    assert.strictEqual(l.view().facts.get(u.id).status, 'superseded');
    assert.strictEqual(l.view().facts.get(a.id).status, 'active');
  });

  it('refuses to supersede a missing or inactive fact', () => {
    const l = newLedger();
    const a = l.assert({ stmt: 'a', subject: 'x', attr: 'y', value: 1, source: src });
    l.retract(a.id, 'wrong');
    assert.throws(() => l.assert({ stmt: 'b', subject: 'x', attr: 'y', value: 2, source: src, supersedes: a.id }), /not active/);
    assert.throws(() => l.assert({ stmt: 'b', subject: 'x', attr: 'y', value: 2, source: src, supersedes: 'f-0404' }), /f-0404/);
  });

  it('retracts, flips disclosability and marks load-bearing through appended entries', () => {
    const l = newLedger();
    const a = l.assert({ stmt: 'Payoff', subject: 'loan', attr: 'payoff', value: 1, category: 'financial', source: src });
    l.setDisclosable(a.id, true);
    l.markLoadBearing([a.id]);
    let f = l.view().facts.get(a.id);
    assert.strictEqual(f.disclosable, true);
    assert.strictEqual(f.loadBearing, true);
    l.retract(a.id, 'bad source');
    f = l.view().facts.get(a.id);
    assert.strictEqual(f.status, 'retracted');
    assert.strictEqual(fs.readFileSync(l.path, 'utf8').trim().split('\n').length, 4);
  });

  it('skips malformed and CRLF lines without losing the rest', () => {
    const l = newLedger();
    l.assert({ stmt: 'a', subject: 'x', attr: 'y', value: 1, source: src });
    fs.appendFileSync(l.path, '{not json\r\n');
    fs.appendFileSync(l.path, JSON.stringify({ kind: 'fact', id: 'f-0002', stmt: 'b', subject: 'x', attr: 'z', value: 2, provenance: 'sourced', source: src, at: 'now' }) + '\r\n');
    const { facts, errors } = l.view();
    assert.strictEqual(facts.size, 2);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].line, 2);
    assert.strictEqual(l.assert({ stmt: 'c', subject: 'x', attr: 'w', value: 3, source: src }).id, 'f-0003');
  });

  it('queries by subject, attr, provenance and status', () => {
    const l = newLedger();
    l.assert({ stmt: 'a', subject: 'lot', attr: 'acreage', value: 2, source: src });
    l.assert({ stmt: 'b', subject: 'lot', attr: 'zone', value: 'X', source: src });
    l.unknown({ stmt: 'c?', subject: 'lot', attr: 'tap', changes: 'c', answerable: 'owner', how: 'ask' });
    assert.strictEqual(l.query({ subject: 'lot' }).length, 3);
    assert.strictEqual(l.query({ subject: 'LOT', attr: 'Zone' }).length, 1);
    assert.strictEqual(l.query({ provenance: 'unknown' }).length, 1);
    assert.strictEqual(l.query({ text: 'b' }).length, 1);
  });

  it('keeps both facts when the file lost its final newline', () => {
    const l = newLedger();
    l.assert({ stmt: 'Lot is 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src });
    fs.writeFileSync(l.path, fs.readFileSync(l.path, 'utf8').replace(/\n$/, ''));
    l.assert({ stmt: 'Flood zone X', subject: 'lot', attr: 'flood-zone', value: 'X', source: src });
    const { facts, errors } = l.view();
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual([...facts.keys()], ['f-0001', 'f-0002']);
  });
});
