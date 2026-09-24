// tests/cases-orientation.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { buildOrientation } = require('../src/cases/orientation');

const meta = { title: 'Lakeside lot', slug: 'lakeside-lot', status: 'active' };
const briefData = {
  objective: 'Convert the lot to cash', why: 'Fund the house repair',
  successCriteria: ['Closed within 90 days'], hardConstraints: ['Both owners sign'],
  alreadyTried: ['Three agents on the MLS'], deadline: '2026-11-30', gating: { complete: true }
};
const f = (id, over) => [id, { id, subject: 'lot', attr: id, stmt: `stmt ${id}`, value: null, provenance: 'sourced', status: 'active', loadBearing: false, disclosable: true, source: { kind: 'url' }, ...over }];

describe('buildOrientation', () => {
  const facts = new Map([
    f('f-0001', { provenance: 'user', stmt: 'Owner needs cash', source: { kind: 'user-message' } }),
    f('f-0002', { stmt: 'Plat says 2.12 acres', value: 2.12, unit: 'acre' }),
    f('f-0003', { provenance: 'inferred', stmt: 'Buyer pool is investors' }),
    f('f-0004', { provenance: 'unknown', loadBearing: true, stmt: 'Listed before?', changes: 'Which channels are untried', answerable: 'owner', how: 'Ask' }),
    f('f-0005', { provenance: 'unknown', stmt: 'Tap installed?', changes: 'Buyer cost', answerable: 'utility', how: 'Call' }),
    f('f-0006', { stmt: 'GIS says 1.85 acres', status: 'superseded', supersededBy: 'f-0002' })
  ]);
  const decisions = [
    { id: 'D-001', decision: 'Price per acre from the plat', factIds: ['f-0002'] },
    { id: 'D-002', decision: 'Price per acre from GIS', factIds: ['f-0006'] }
  ];

  it('puts sections in the spec order', () => {
    const text = buildOrientation({ meta, brief: { data: briefData }, facts, decisions, lastJournal: { file: 'journal/x.md', text: 'Last turn summary' } });
    const order = ['# Case: Lakeside lot', '## Brief', '## Load-bearing unknowns', '## Facts', '## Decisions', '## Other unknowns', '## Last journal entry'];
    let at = -1;
    for (const h of order) {
      const i = text.indexOf(h);
      assert.ok(i > at, `${h} out of order`);
      at = i;
    }
    assert.match(text, /status: active/);
    assert.match(text, /Already tried: Three agents on the MLS/);
  });

  it('labels provenance groups and shows corrections', () => {
    const text = buildOrientation({ meta, brief: { data: briefData }, facts, decisions: [] });
    assert.match(text, /### From the owner[\s\S]*f-0001/);
    assert.match(text, /### Sourced[\s\S]*f-0002 lot\.f-0002 = 2\.12 acre/);
    assert.match(text, /### Inferred[^\n]*not usable[\s\S]*f-0003/);
    assert.match(text, /Corrections[\s\S]*f-0006 → f-0002/);
    assert.ok(text.indexOf('f-0004') < text.indexOf('## Facts'), 'load-bearing unknown precedes facts');
  });

  it('flags decisions that cite a fact that is no longer active', () => {
    const text = buildOrientation({ meta, brief: { data: briefData }, facts, decisions });
    assert.match(text, /D-002[^\n]*f-0006 which is now superseded/);
    assert.doesNotMatch(text, /D-001[^\n]*now superseded/);
  });

  it('warns loudly when gating is incomplete', () => {
    const text = buildOrientation({ meta: { ...meta, status: 'draft' }, brief: { data: { ...briefData, gating: { complete: false } } }, facts: new Map() });
    assert.match(text, /Gating pass: INCOMPLETE/);
  });

  it('reports an unreadable brief and ledger warnings instead of failing', () => {
    const text = buildOrientation({ meta, brief: { error: 'not valid YAML' }, facts: new Map(), ledgerErrors: [{ line: 7, message: 'Unexpected token' }] });
    assert.match(text, /brief\.md could not be read: not valid YAML/);
    assert.match(text, /line 7/);
  });

  it('cuts only the facts section when over budget and says how much was omitted', () => {
    const many = new Map(Array.from({ length: 400 }, (_, i) => f(`f-${String(i + 1).padStart(4, '0')}`, { stmt: 'x'.repeat(80) })));
    many.set('f-9999', { id: 'f-9999', subject: 'lot', attr: 'q', stmt: 'Critical unknown', provenance: 'unknown', status: 'active', loadBearing: true, changes: 'c', answerable: 'owner', how: 'ask' });
    const text = buildOrientation({ meta, brief: { data: briefData }, facts: many, decisions, lastJournal: { file: 'journal/x.md', text: 'j'.repeat(5000) }, maxChars: 6000 });
    assert.ok(text.length <= 6000 + 200, `length ${text.length}`);
    assert.match(text, /Critical unknown/);
    assert.match(text, /more facts not shown/);
    assert.match(text, /D-001/);
    assert.match(text, /## Last journal entry/);
  });
});
