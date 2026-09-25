// tests/cases-outbound-gate.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { outboundGate, gateLeaves, renderFactRefs } = require('../src/cases/gates');
const { detect } = require('../src/cases/outbound');

function fact(id, over = {}) {
  return {
    id, stmt: over.stmt || `Fact ${id}`, subject: 'lot', attr: id, value: null, unit: null,
    provenance: 'sourced', category: null, disclosable: true, status: 'active', supersededBy: null, ...over
  };
}
const facts = (...list) => new Map(list.map((f) => [f.id, f]));
const reasons = (r) => r.blocked.map((b) => b.reason);
const active = (over = {}) => ({ status: 'active', intent: 'Ask for a listing quote', rules: [], facts: [], ...over });

const ACRES = fact('f-0001', { value: 2.12, unit: 'acres', stmt: 'Lot size is 2.12 acres' });
const INFERRED = fact('f-0002', { value: 'Harbor Road access', provenance: 'inferred', disclosable: false });
const OLD = fact('f-0003', { value: 3.1, unit: 'acres', status: 'superseded', supersededBy: 'f-0004' });
const FLOOR = fact('f-0005', { value: 1250000, unit: 'USD', provenance: 'user', category: 'financial', disclosable: false, stmt: 'Floor price' });
const REPORTED = fact('f-0006', { value: 'north corner', provenance: 'external-agent' });
const OFFICE = fact('f-0007', { value: '+15550100', stmt: 'County office phone' });
const DUE = fact('f-0009', { value: '2026-11-14', stmt: 'Offers are due 2026-11-14' });

describe('fact references', () => {
  it('renders an active disclosable fact with its unit', () => {
    const r = outboundGate({ payloadText: 'The lot is {{f-0001}}.', facts: facts(ACRES) });
    assert.deepStrictEqual([r.ok, r.rendered], [true, 'The lot is 2.12 acres.']);
  });

  it('refuses bad, superseded, inferred, private and out-of-envelope references', () => {
    const all = facts(ACRES, INFERRED, OLD, FLOOR, REPORTED);
    const r = outboundGate({ payloadText: '{{f-0099}} {{f-0002}} {{f-0003}} {{f-0005}}', facts: all, mode: 'query' });
    assert.deepStrictEqual(reasons(r), ['bad-reference', 'inferred', 'superseded', 'non-disclosable']);
    assert.deepStrictEqual(r.blocked.map((b) => b.factId), ['f-0099', 'f-0002', 'f-0003', 'f-0005']);
    const env = outboundGate({ payloadText: 'Seen at {{f-0006}}', facts: all, mode: 'query', envelope: active({ facts: ['f-0001'] }) });
    assert.deepStrictEqual(reasons(env), ['not-in-envelope']);
    const ok = outboundGate({ payloadText: 'Seen at {{f-0006}}', facts: all, mode: 'query' });
    assert.deepStrictEqual([ok.ok, ok.rendered], [true, 'Seen at north corner']);
  });

  it('renderFactRefs reports each reference', () => {
    const r = renderFactRefs('{{ f-0001 }} and {{f-0002}}', facts(ACRES, INFERRED));
    assert.strictEqual(r.rendered, '2.12 acres and {{f-0002}}');
    assert.deepStrictEqual(r.blocked.map((b) => [b.reason, b.span.text]), [['inferred', '{{f-0002}}']]);
  });
});

describe('rule 1: value match', () => {
  it('blocks a pasted private, inferred or superseded value', () => {
    const all = facts(INFERRED, OLD, FLOOR);
    const r = outboundGate({ payloadText: 'Floor 1,250,000; access via Harbor Road access; 3.1 acres', facts: all, mode: 'query' });
    assert.deepStrictEqual(reasons(r).sort(), ['inferred', 'non-disclosable', 'superseded']);
    assert.ok(r.blocked.every((b) => b.factId));
  });

  it('lets a superseded value through when an active fact has the same value', () => {
    const r = outboundGate({ payloadText: 'About 3.1 acres', facts: facts(OLD, fact('f-0004', { value: 3.1, unit: 'acres' })), mode: 'query' });
    assert.strictEqual(r.ok, true);
  });

  it('turns a disclosable value outside the envelope into not-in-envelope', () => {
    const r = outboundGate({ payloadText: 'It is 2.12 acres', facts: facts(ACRES), mode: 'query', envelope: active() });
    assert.deepStrictEqual(r.blocked.map((b) => [b.reason, b.factId, b.span.text]), [['not-in-envelope', 'f-0001', '2.12']]);
  });

  it('never counts the recipient address as a disclosure', () => {
    const r = outboundGate({ payloadText: 'Calling 555-0100 now', facts: facts(OFFICE), recipients: ['+15550100'], envelope: active() });
    assert.strictEqual(r.ok, true);
  });
});

describe('rule 2: category keywords', () => {
  it('blocks a category keyword while the case holds a private fact of that category', () => {
    const r = outboundGate({ payloadText: 'What is your floor price?', facts: facts(FLOOR) });
    assert.deepStrictEqual(r.blocked.map((b) => [b.reason, b.span.text]), [['category-keyword', 'floor price']]);
    assert.strictEqual(outboundGate({ payloadText: 'What is your floor price?', facts: facts(ACRES) }).ok, true);
    assert.strictEqual(outboundGate({ payloadText: 'What is your floor price?', facts: facts(FLOOR), mode: 'query' }).ok, true);
  });

  it('passes a keyword that is verbatim in the approved intent', () => {
    const env = active({ intent: 'Ask each broker for their floor price estimate' });
    assert.strictEqual(outboundGate({ payloadText: 'What is your floor price?', facts: facts(FLOOR), envelope: env }).ok, true);
  });

  it('uses the configured keyword lists', () => {
    const r = outboundGate({ payloadText: 'Ask about the clinic', facts: facts(fact('f-0020', { value: 'x', category: 'health', disclosable: false })), categoryKeywords: { health: ['clinic'] } });
    assert.deepStrictEqual(reasons(r), ['category-keyword']);
  });
});

describe('rule 3: detectors', () => {
  it('date: finds written, ISO and numeric dates with a year, not fractions', () => {
    assert.deepStrictEqual(detect('Offers are due by Friday November 14.').map((d) => [d.kind, d.text, d.value]), [
      ['deadline', 'due by', null], ['date', 'Friday November 14', '--11-14']
    ]);
    assert.deepStrictEqual(detect('Closing 11/14/2026 or 2026-11-15').map((d) => d.value), ['2026-11-14', '2026-11-15']);
    assert.deepStrictEqual(detect('A 1/2 acre lot on two roads'), []);
  });

  it('price: finds dollar amounts, not bare counts', () => {
    assert.deepStrictEqual(detect('We ask $1,250 or 2k dollars').map((d) => [d.kind, d.value]), [['price', 1250], ['price', 2000]]);
    assert.deepStrictEqual(detect('Lot 12 of 40'), []);
  });

  it('deadline: finds deadline phrases, not ordinary verbs', () => {
    assert.deepStrictEqual(detect('Submit no later than 2026-11-14.').map((d) => d.kind), ['deadline', 'date']);
    assert.deepStrictEqual(detect('Submit it when you can'), []);
  });

  it('commitment: finds promises, not requests', () => {
    assert.deepStrictEqual(detect('We will accept 1,200 dollars').map((d) => d.kind), ['commitment', 'price']);
    assert.deepStrictEqual(detect('We would like a quote'), []);
  });

  it('keeps sentence numbers so a deadline sees its own sentence only', () => {
    const spans = detect('Call on Monday. Offers are due soon. The date is 2026-11-14.');
    assert.deepStrictEqual(spans.map((s) => [s.kind, s.sentence]), [['deadline', 1], ['date', 2]]);
  });
});

describe('rule 3: unsourced constraints', () => {
  it('blocks an invented deadline and passes one backed by a sourced fact', () => {
    const bad = outboundGate({ payloadText: 'Offers are due by Friday November 14', facts: facts() });
    assert.deepStrictEqual(reasons(bad), ['unsourced-constraint', 'unsourced-constraint']);
    const good = outboundGate({ payloadText: 'Offers are due by {{f-0009}}.', facts: facts(DUE), envelope: active({ facts: ['f-0009'] }) });
    assert.deepStrictEqual([good.ok, good.rendered], [true, 'Offers are due by 2026-11-14.']);
    const matched = outboundGate({ payloadText: 'Offers are due by November 14, 2026', facts: facts(fact('f-0010', { value: '2026-11-14', provenance: 'user' })) });
    assert.strictEqual(matched.ok, true);
  });

  it('never lets an external-agent fact back a constraint', () => {
    const reported = fact('f-0011', { value: '2026-11-14', provenance: 'external-agent' });
    const r = outboundGate({ payloadText: 'Offers are due by {{f-0011}}.', facts: facts(reported) });
    assert.deepStrictEqual(r.blocked.map((b) => [b.reason, b.span.text]), [['unsourced-constraint', 'due by']]);
  });

  it('passes wording that is verbatim in the approved envelope', () => {
    const env = active({ intent: 'Tell brokers offers are due by Friday November 14' });
    assert.strictEqual(outboundGate({ payloadText: 'Offers are due by Friday November 14', facts: facts(), envelope: env }).ok, true);
    const requested = { ...env, status: 'requested' };
    assert.strictEqual(outboundGate({ payloadText: 'Offers are due by Friday November 14', facts: facts(), envelope: requested }).ok, false, 'only an approved envelope counts');
  });

  it('a promise needs a backed value in its sentence', () => {
    assert.deepStrictEqual(reasons(outboundGate({ payloadText: 'We will accept $1,200.', facts: facts() })), ['unsourced-constraint', 'unsourced-constraint']);
    assert.strictEqual(outboundGate({ payloadText: 'We will accept $1,200.', facts: facts(fact('f-0012', { value: 1200, unit: 'USD' })) }).ok, true);
  });
});

describe('rule 4 and modes', () => {
  it('blocks an entity span unless it is this send\'s recipient', () => {
    const text = 'Call back on 555-0199';
    const start = text.indexOf('555-0199');
    const entitySpans = [{ span: { start, end: start + 8, text: '555-0199' }, entity: 'phone', reason: 'private phone' }];
    assert.deepStrictEqual(reasons(outboundGate({ payloadText: text, facts: facts(), entitySpans })), ['non-disclosable-entity']);
    assert.strictEqual(outboundGate({ payloadText: text, facts: facts(), entitySpans, recipients: ['+15550199'] }).ok, true);
  });

  it('query mode runs the value rules only', () => {
    assert.strictEqual(outboundGate({ payloadText: 'Offers are due by Friday November 14', facts: facts(), mode: 'query' }).ok, true);
    assert.strictEqual(outboundGate({ payloadText: 'lakeside 1,250,000', facts: facts(FLOOR), mode: 'query' }).ok, false);
  });
});

describe('gateLeaves', () => {
  it('payload name leaf is gated', () => {
    const payload = {
      recipients: [{ address: '+15550100', name: 'Harbor Road access' }],
      text: 'Hello about {{f-0001}}',
      expect: [{ subject: 'lot', attr: 'price', question: 'Is 1,250,000 fair?' }],
      attemptsPerContact: 2
    };
    const r = gateLeaves(payload, { recipients: ['+15550100'], facts: facts(ACRES, INFERRED, FLOOR), mode: 'query' });
    assert.deepStrictEqual(r.blocked.map((b) => [b.path, b.reason]), [
      ['recipients[0].name', 'inferred'],
      ['expect[0].question', 'non-disclosable']
    ]);
    assert.strictEqual(r.rendered.text, 'Hello about 2.12 acres');
    assert.strictEqual(r.rendered.attemptsPerContact, 2);
  });

  it('gates keys with rule 1, and asks the entity index per value leaf only', () => {
    const calls = [];
    const entityIndex = {
      nonDisclosableSpans(text, { caseId }) {
        calls.push([text, caseId]);
        const i = text.indexOf('Pat Doe');
        return i === -1 ? [] : [{ span: { start: i, end: i + 7, text: 'Pat Doe' }, entity: 'person', reason: 'private name' }];
      }
    };
    const r = gateLeaves({ 'Harbor Road access': 'ok', note: 'Ask for Pat Doe' }, { facts: facts(INFERRED), mode: 'query', caseId: 'case-1', entityIndex });
    assert.deepStrictEqual(r.blocked.map((b) => [b.path, b.reason]), [['Harbor Road access', 'inferred'], ['note', 'non-disclosable-entity']]);
    assert.deepStrictEqual(calls, [['ok', 'case-1'], ['Ask for Pat Doe', 'case-1']]);
  });

  it('fails closed when the entity index throws', () => {
    const entityIndex = { nonDisclosableSpans() { throw new Error('index offline'); } };
    const r = gateLeaves({ text: 'hello' }, { facts: facts(), mode: 'query', entityIndex });
    assert.deepStrictEqual(r.blocked.map((b) => [b.path, b.reason]), [['text', 'non-disclosable-entity']]);
  });
});

describe('detection survives full-width and zero-width characters', () => {
  it('detect folds the text but reports original spans', () => {
    const text = 'Offers are d​ue by ２０２６-11-14.';
    const spans = detect(text);
    assert.deepStrictEqual(spans.map((s) => [s.kind, s.value, s.text]), [
      ['deadline', null, 'd​ue by'], ['date', '2026-11-14', '２０２６-11-14']
    ]);
    for (const s of spans) assert.strictEqual(text.slice(s.start, s.end), s.text);
  });

  it('prices and commitments are found through full-width and zero-width forms', () => {
    assert.deepStrictEqual(detect('We w​ill accept ＄１,200').map((d) => [d.kind, d.value]), [['commitment', null], ['price', 1200]]);
  });

  it('a split or full-width category keyword is still blocked', () => {
    for (const text of ['What is your floor​price?', 'What is your ｆloor price?', 'What is your floor​ price?']) {
      const r = outboundGate({ payloadText: text, facts: facts(FLOOR) });
      assert.deepStrictEqual(reasons(r), ['category-keyword'], text);
      const b = r.blocked[0];
      assert.strictEqual(text.slice(b.span.start, b.span.end), b.span.text);
    }
  });

  it('an invented full-width deadline is still unsourced', () => {
    const r = outboundGate({ payloadText: 'Offers are due by ２０２６-11-14', facts: facts() });
    assert.deepStrictEqual(reasons(r), ['unsourced-constraint', 'unsourced-constraint']);
  });
});

describe('review round 1: splicing, leaves, keys, entity spans', () => {
  const PART = fact('f-0021', { value: 250 });
  const ROAD = fact('f-0023', { value: 'Road' });
  const EMPTY = fact('f-0024', { value: '' });

  for (const mode of ['message', 'query']) {
    it(`blocks a value spliced together around a reference (${mode})`, () => {
      const r1 = outboundGate({ payloadText: '1,{{f-0021}},000', facts: facts(FLOOR, PART), mode });
      assert.deepStrictEqual(r1.blocked.map((b) => [b.reason, b.factId, b.span.text]), [['non-disclosable', 'f-0005', '1,{{f-0021}},000']]);
      const r2 = outboundGate({ payloadText: 'Harbor {{f-0023}} access', facts: facts(INFERRED, ROAD), mode });
      assert.deepStrictEqual(r2.blocked.map((b) => [b.reason, b.factId, b.span.text]), [['inferred', 'f-0002', 'Harbor {{f-0023}} access']]);
      const r3 = outboundGate({ payloadText: '1,250{{f-0024}},000', facts: facts(FLOOR, EMPTY), mode });
      assert.deepStrictEqual(r3.blocked.map((b) => [b.reason, b.factId]), [['non-disclosable', 'f-0005']]);
    });
  }

  it('gates number leaves with rule 1 and keeps their type', () => {
    const r = gateLeaves({ amountUsd: 1250000, attemptsPerContact: 2 }, { facts: facts(FLOOR), mode: 'query' });
    assert.deepStrictEqual(r.blocked.map((b) => [b.path, b.reason]), [['amountUsd', 'non-disclosable']]);
    assert.strictEqual(r.rendered.amountUsd, 1250000);
    assert.strictEqual(r.rendered.attemptsPerContact, 2);
  });

  it('gates keys with rule 1 only', () => {
    const r = gateLeaves({ 'Harbor Road access': 'yes' }, { facts: facts(INFERRED), mode: 'message' });
    assert.deepStrictEqual(r.blocked.map((b) => [b.path, b.reason]), [['Harbor Road access', 'inferred']]);
    assert.strictEqual(gateLeaves({ 'floor price': 'x' }, { facts: facts(FLOOR) }).ok, true, 'rule 2 does not run on keys');
  });

  it('a malformed entity span blocks the whole leaf', () => {
    const text = 'Ask for Pat Doe';
    const i = text.indexOf('Pat Doe');
    const bad = [
      [{ span: { start: 1.5, end: 3, text: 'x' }, entity: 'person' }],
      [{ entity: 'person' }],
      [{ span: { start: i, end: 999, text: 'Pat Doe' } }],
      [{ span: { start: 5, end: 2, text: '' } }],
      'not a list'
    ];
    for (const entitySpans of bad) {
      const r = outboundGate({ payloadText: text, facts: facts(), mode: 'query', entitySpans });
      assert.deepStrictEqual(r.blocked.map((b) => [b.reason, b.span.start, b.span.end]), [['non-disclosable-entity', 0, text.length]], JSON.stringify(entitySpans));
    }
    const forged = [{ span: { start: i, end: i + 7, text: '+15550199' }, entity: 'person' }];
    const r = outboundGate({ payloadText: text, facts: facts(), mode: 'query', entitySpans: forged, recipients: ['+15550199'] });
    assert.deepStrictEqual(r.blocked.map((b) => [b.reason, b.span.text]), [['non-disclosable-entity', 'Pat Doe']]);
  });

  it('a non-array entity index result is a blocked result', () => {
    for (const out of [Promise.resolve([]), null, {}, 'x']) {
      const entityIndex = { nonDisclosableSpans: () => out };
      const r = gateLeaves({ text: 'hello' }, { facts: facts(), mode: 'query', entityIndex });
      assert.deepStrictEqual(r.blocked.map((b) => [b.path, b.reason]), [['text', 'non-disclosable-entity']]);
    }
  });

  it('query mode blocks other written forms of a private date or price', () => {
    const PDATE = fact('f-0030', { value: '2026-11-14', provenance: 'user', disclosable: false });
    for (const probe of ['Nov 14, 2026', '14 November 2026', '11/14/2026', '$1.25M', '1.25 million', '1250k']) {
      const r = outboundGate({ payloadText: `Note: ${probe} ok`, facts: facts(FLOOR, PDATE), mode: 'query' });
      assert.deepStrictEqual([...new Set(reasons(r))], ['non-disclosable'], probe);
    }
  });

  it('category keywords match joined, split and plural forms', () => {
    for (const probe of ['floor-price', 'floor_price', 'bank-account number', 'salaries', 'mortgages', 'debts']) {
      const r = outboundGate({ payloadText: `About the ${probe} today`, facts: facts(FLOOR) });
      assert.deepStrictEqual(reasons(r), ['category-keyword'], probe);
    }
  });

  it('approved wording matches whole words only', () => {
    const LEGAL = fact('f-0031', { value: 'x', category: 'legal', disclosable: false });
    const env = active({ intent: 'Ask about the courtyard' });
    assert.deepStrictEqual(reasons(outboundGate({ payloadText: 'Ask about the court date', facts: facts(LEGAL), envelope: env })), ['category-keyword']);
    const ok = active({ intent: 'Ask about the court' });
    assert.strictEqual(outboundGate({ payloadText: 'Ask about the court date', facts: facts(LEGAL), envelope: ok }).ok, true);
  });

  it('look-alike references are bad references', () => {
    for (const probe of ['{{F-0001}}', '{{f-001}}', '｛｛f-0001｝｝', '{{f-0001​}}', '{{ fact 1 }}']) {
      const r = outboundGate({ payloadText: `See ${probe}`, facts: facts(ACRES), mode: 'query' });
      assert.deepStrictEqual(r.blocked.map((b) => [b.reason, b.span.text]), [['bad-reference', probe]], probe);
    }
  });

  it('bad input comes back as a result, never a throw', () => {
    const map = new Map([['f-0001', null], ['f-0002', 'junk'], ['f-0005', FLOOR]]);
    const r = outboundGate({ payloadText: 'hi {{f-0001}} 1,250,000', facts: map, mode: 'query' });
    assert.deepStrictEqual(reasons(r), ['bad-reference', 'non-disclosable']);
    const p = { a: 'x' };
    p.self = p;
    const c = gateLeaves(p, { facts: facts(), mode: 'query' });
    assert.deepStrictEqual(c.blocked.map((b) => [b.path, b.reason]), [['self', 'bad-reference']]);
    const shared = { note: 'hi' };
    assert.strictEqual(gateLeaves({ a: shared, b: shared }, { facts: facts(), mode: 'query' }).ok, true, 'a shared object is not a cycle');
  });
});
