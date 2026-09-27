// tests/cases-entities.test.js
// Entity keys and extraction (cases stage 7 spec §3.6).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { normalizeEntity, keyType } = require('../src/cases/entities/normalize');
const { extractEntities } = require('../src/cases/entities/extract');

describe('normalizeEntity', () => {
  it('lower-cases emails and rejects non-addresses', () => {
    assert.deepStrictEqual(normalizeEntity('email', 'Records@Example.COM'), ['email:records@example.com']);
    assert.deepStrictEqual(normalizeEntity('email', 'not an email'), []);
  });

  it('keys phones with and without the written country code', () => {
    assert.deepStrictEqual(normalizeEntity('phone', '+1 (555) 0100'), ['phone:15550100', 'phone:5550100']);
    assert.deepStrictEqual(normalizeEntity('phone', '555-0100'), ['phone:5550100']);
    assert.deepStrictEqual(normalizeEntity('phone', '+44 20 7946 0000'), ['phone:442079460000', 'phone:2079460000']);
    assert.deepStrictEqual(normalizeEntity('phone', '12345'), []);
  });

  it('keys ids by their token without separators, with or without the label', () => {
    assert.deepStrictEqual(normalizeEntity('id', 'Loan No. 0042-7781'), ['id:00427781']);
    assert.deepStrictEqual(normalizeEntity('id', '0042-7781'), ['id:00427781']);
    assert.deepStrictEqual(normalizeEntity('id', 'Parcel 12-345-678'), ['id:12345678']);
    assert.deepStrictEqual(normalizeEntity('id', 'Invoice #ab.12/3'), ['id:AB123']);
    assert.deepStrictEqual(normalizeEntity('id', 'order ab'), []);
  });

  it('expands street suffixes and collapses whitespace in addresses', () => {
    assert.deepStrictEqual(normalizeEntity('address', '12  Birch St.'), ['address:12 birch street']);
    assert.deepStrictEqual(normalizeEntity('address', '400 Harbor Road'), ['address:400 harbor road']);
    assert.deepStrictEqual(normalizeEntity('address', 'Birch Street'), []);
  });

  it('strips diacritics and punctuation from names, and company suffixes from orgs', () => {
    assert.deepStrictEqual(normalizeEntity('person', 'Zoë  O\'Neil'), ['person:zoe o neil']);
    assert.deepStrictEqual(normalizeEntity('org', 'Example Bank, Inc.'), ['org:example bank']);
    assert.deepStrictEqual(normalizeEntity('org', 'Lakeside Holdings LLC'), ['org:lakeside holdings']);
    assert.strictEqual(keyType('org:example bank'), 'org');
  });

  it('keys documents by sha256', () => {
    const hash = 'a'.repeat(64);
    assert.deepStrictEqual(normalizeEntity('document', hash), [`document:${hash}`]);
    assert.deepStrictEqual(normalizeEntity('document', 'abc'), []);
  });
});

describe('extractEntities', () => {
  it('finds emails, phones, ids and addresses with exact offsets', () => {
    const text = 'Call +1 555 0100 or write records@example.com about Loan No. 0042-7781 at 12 Birch St.';
    const found = extractEntities(text);
    assert.deepStrictEqual(found.map((e) => [e.type, e.text, e.keys]), [
      ['phone', '+1 555 0100', ['phone:15550100', 'phone:5550100']],
      ['email', 'records@example.com', ['email:records@example.com']],
      ['id', '0042-7781', ['id:00427781']],
      ['address', '12 Birch St', ['address:12 birch street']]
    ]);
    for (const e of found) assert.strictEqual(text.slice(e.start, e.end), e.text);
  });

  it('does not read dates or money as phone numbers, and prefers an id over a phone for a labelled number', () => {
    const found = extractEntities('Payoff amount for loan 0042-7781 is $182,340.17 good through 2026-10-15');
    assert.deepStrictEqual(found.map((e) => e.keys[0]), ['id:00427781']);
  });

  it('does not read a spaced currency amount as a phone number (fix-T6-r1 I1)', () => {
    assert.deepStrictEqual(extractEntities('Total: $ 5551234567 due', { kinds: ['phone'] }), []);
    assert.deepStrictEqual(extractEntities('€ 5551234567', { kinds: ['phone'] }), []);
    assert.deepStrictEqual(extractEntities('£ 5551234567', { kinds: ['phone'] }), []);
    assert.deepStrictEqual(extractEntities('¥ 5551234567', { kinds: ['phone'] }), []);
    // a few spaces still count, but a run of ordinary text before the
    // digits is a real phone number, not a currency amount
    const found = extractEntities('call me at 5551234567 today', { kinds: ['phone'] });
    assert.strictEqual(found.length, 1);
  });

  it('never guesses people or organisations from text', () => {
    assert.deepStrictEqual(extractEntities('Pat Doe of Example Bank called.'), []);
  });
});

describe('normalizeEntity — hardening: hidden characters and lookalike digits', () => {
  // Built from code points (not literal invisible characters in this
  // source file): ZWSP, RLO, RLM, LRI, PDI.
  const ZWSP = String.fromCodePoint(0x200b);
  const RLO = String.fromCodePoint(0x202e);
  const RLM = String.fromCodePoint(0x200f);
  const LRI = String.fromCodePoint(0x2066);
  const PDI = String.fromCodePoint(0x2069);
  const HIDDEN_OR_BIDI_RE = new RegExp(
    `[${String.fromCodePoint(0x0000)}-${String.fromCodePoint(0x0008)}${String.fromCodePoint(0x000b)}${String.fromCodePoint(0x000c)}${String.fromCodePoint(0x000e)}-${String.fromCodePoint(0x001f)}${String.fromCodePoint(0x007f)}-${String.fromCodePoint(0x009f)}${String.fromCodePoint(0x200b)}-${String.fromCodePoint(0x200f)}${String.fromCodePoint(0x202a)}-${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2060)}-${String.fromCodePoint(0x2069)}${String.fromCodePoint(0xfeff)}]`
  );

  it('strips control, zero-width and bidi-format characters before building a key', () => {
    assert.deepStrictEqual(normalizeEntity('email', `a${ZWSP}b@example.com`), ['email:ab@example.com']);
    assert.deepStrictEqual(normalizeEntity('address', `12 Bi${ZWSP}rch St.`), ['address:12 birch street']);
    const [key] = normalizeEntity('person', `Zoe${RLO}${RLM} reverse${LRI}${PDI}`);
    assert.doesNotMatch(key, HIDDEN_OR_BIDI_RE);
  });

  it('ignores Arabic-Indic and fullwidth lookalike digits consistently rather than partially normalising them', () => {
    // Arabic-Indic 555-0100
    assert.deepStrictEqual(normalizeEntity('phone', '٥٥٥-٠١٠٠'), []);
    // fullwidth 0042-7781 after a real id label: the label strips, but the
    // fullwidth digits are not ASCII `\d` so the id is rejected, not folded.
    assert.deepStrictEqual(normalizeEntity('id', 'Loan No. ００４２-７７８１'), []);
    // extraction is consistent with normalizeEntity: a fullwidth digit run
    // after a real label is not recognised as an id at all.
    assert.deepStrictEqual(extractEntities('Loan No. ００４２-７７８１ today'), []);
  });

  it('strips the Arabic letter mark and soft hyphen from a key instead of rejecting it (fix-T6-r1 M2)', () => {
    const ALM = String.fromCodePoint(0x061c);
    const SOFT_HYPHEN = String.fromCodePoint(0x00ad);
    assert.deepStrictEqual(normalizeEntity('id', `Loan No. 0042${ALM}7781`), ['id:00427781']);
    assert.deepStrictEqual(normalizeEntity('id', `Loan No. 0042${SOFT_HYPHEN}7781`), ['id:00427781']);
  });
});

describe('extractEntities — hardening: bounded output', () => {
  it('caps a single entity\'s recorded text and keeps the start/end offsets consistent', () => {
    // The email regex alone can match up to ~345 characters (a generous
    // but still bounded local/domain/tld length); MAX_ENTITY_CHARS (200)
    // is the backstop that caps the *recorded* text regardless. Chosen so
    // the '.' before the tld falls before the 200-character cut, so the
    // truncated text is still a syntactically valid (capped) email.
    const longEmail = `${'a'.repeat(50)}@${'b'.repeat(130)}.${'c'.repeat(24)}`;
    const text = `contact ${longEmail} today`;
    const [found] = extractEntities(text, { kinds: ['email'] });
    assert.ok(longEmail.length > 200, 'fixture must exceed the cap to exercise it');
    assert.ok(found, 'expected one (capped) email entity');
    assert.strictEqual(found.text.length, 200);
    assert.strictEqual(text.slice(found.start, found.end), found.text);
  });

  it('caps the number of entities returned per call', () => {
    const text = Array.from({ length: 600 }, (_, i) => `a${i}@example.com`).join(' ');
    const found = extractEntities(text, { kinds: ['email'] });
    assert.strictEqual(found.length, 500);
  });

  it('caps the whole key, prefix included, not just the part after the colon (fix-T6-r1 M1)', () => {
    // "email:" is 6 characters; the entity's recorded text is already
    // capped to 200 by extractEntities, so drive normalizeEntity directly
    // with a 199-character local part to prove the *key* (prefix + value)
    // is what MAX_KEY_CHARS bounds, not just the value.
    const longRaw = `${'a'.repeat(194)}@example.com`; // > MAX_KEY_CHARS once prefixed
    const [key] = normalizeEntity('email', longRaw);
    assert.ok(`email:${longRaw}`.length > 200, 'fixture must exceed the cap once prefixed');
    assert.strictEqual(key.length, 200);
    assert.ok(key.startsWith('email:'));
  });
});

describe('extractEntities — hardening: no catastrophic regex on adversarial input', () => {
  const MAX_MS = 1000;
  const timed = (label, text, kinds) => {
    const started = process.hrtime.bigint();
    const found = extractEntities(text, { kinds });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`[cases-entities] ${label}: ${text.length} chars, ${found.length} entities, ${ms.toFixed(1)} ms`);
    assert.ok(ms < MAX_MS, `${label} took ${ms.toFixed(1)} ms on a ${text.length}-character adversarial input`);
    return found;
  };

  it('stays fast on a 400,000-character run of digits, spaces and dashes (phone)', () => {
    timed('phone digit run', `${'5'.repeat(200000)}${'-'.repeat(100000)}${' '.repeat(99999)}5`, ['phone']);
  });

  it('stays fast on a 400,000-character run of @ and . characters (email)', () => {
    timed('email symbol run', `${'a@'.repeat(133333)}${'.'.repeat(133334)}`, ['email']);
  });

  it('stays fast on a 400,000-character run of address-like capitalised words (address)', () => {
    timed('address word run', '1 Aa Bb Cc Dd Ee Ff Gg Hh '.repeat(15385), ['address']);
  });

  it('stays fast on a 400,000-character run of labelled id-like tokens (id)', () => {
    timed('id label run', 'account 1234567890-abcdefghij.klmnop/qrstuv '.repeat(9091), ['id']);
  });

  it('stays fast across all kinds together on mixed adversarial input', () => {
    const chunk = `${'5'.repeat(30)} a@${'b'.repeat(30)}. account ${'1'.repeat(30)} 1 Aa Bb Cc Dd `;
    timed('mixed adversarial', chunk.repeat(Math.ceil(400000 / chunk.length)), undefined);
  });
});
