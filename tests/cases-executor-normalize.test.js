// tests/cases-executor-normalize.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  normalizeRecipient, recipientChannel, valueMatchers, matchSpans, isRecipient, valueKey, foldText
} = require('../src/cases/executors/normalize');

const spans = (value, unit, text) => matchSpans(text, valueMatchers(value, unit)).map((s) => s.text);

describe('normalizeRecipient', () => {
  it('normalizes phone numbers to E.164', () => {
    assert.deepStrictEqual(normalizeRecipient('+1 (555) 0100', { channel: 'call' }), { ok: true, value: '+15550100' });
    assert.deepStrictEqual(normalizeRecipient('0015550100', { channel: 'sms' }), { ok: true, value: '+15550100' });
    assert.deepStrictEqual(normalizeRecipient('555.0100', { channel: 'call', defaultCountryCode: '1' }), { ok: true, value: '+15550100' });
    assert.deepStrictEqual(normalizeRecipient('555-0100', { channel: 'call' }), {
      ok: false,
      error: 'cannot normalize "555-0100" to E.164; give the country code'
    });
    assert.strictEqual(normalizeRecipient('+12', { channel: 'call' }).ok, false);
  });

  it('refuses as ambiguous rather than guessing when bare digits already start with the country code', () => {
    assert.deepStrictEqual(normalizeRecipient('15550100', { channel: 'call', defaultCountryCode: '1' }), {
      ok: false,
      error: 'ambiguous "15550100": write it in +E.164 form, e.g. "+15550100"'
    });
    // Doesn't start with the country code: still gets prefixed.
    assert.deepStrictEqual(normalizeRecipient('5550100', { channel: 'call', defaultCountryCode: '1' }), { ok: true, value: '+15550100' });
  });

  it('lowercases the email domain and refuses non-addresses', () => {
    assert.deepStrictEqual(normalizeRecipient(' Clerk@Records.Example.org ', { channel: 'email' }), { ok: true, value: 'Clerk@records.example.org' });
    assert.deepStrictEqual(normalizeRecipient('nobody', { channel: 'email' }), { ok: false, error: '"nobody" is not an email address' });
  });

  it('reduces a URL to its origin', () => {
    assert.deepStrictEqual(normalizeRecipient('HTTPS://Permits.Example.com:443/apply?x=1', { channel: 'web-form' }), { ok: true, value: 'https://permits.example.com' });
    assert.deepStrictEqual(normalizeRecipient('http://permits.example.com:8080/a', { channel: 'url' }), { ok: true, value: 'http://permits.example.com:8080' });
    assert.deepStrictEqual(normalizeRecipient('ftp://permits.example.com', { channel: 'url' }), { ok: false, error: '"ftp://permits.example.com" is not an http(s) URL' });
    assert.deepStrictEqual(normalizeRecipient('https://permits.example.com./apply', { channel: 'url' }), { ok: true, value: 'https://permits.example.com' });
  });

  it('picks the channel from an executor\'s capabilities', () => {
    assert.strictEqual(recipientChannel(['call', 'voicemail']), 'call');
    assert.strictEqual(recipientChannel(['email']), 'email');
    assert.strictEqual(recipientChannel(['web-browse', 'web-form']), 'url');
    assert.strictEqual(recipientChannel(['postal-mail']), 'text');
  });
});

describe('value forms', () => {
  it('finds a phone with and without the country code, across separators', () => {
    assert.deepStrictEqual(spans('+15550100', null, 'Call 555-0100 or +1 555 0100 today'), ['555-0100', '+1 555 0100']);
    assert.deepStrictEqual(spans('+15550100', null, 'Ref 155501009'), []);
  });

  it('finds money and grouped numbers but not inside longer numbers', () => {
    assert.deepStrictEqual(spans(1250000, 'USD', 'Floor is $1,250,000 or 1250000.00'), ['1,250,000', '1250000.00']);
    assert.deepStrictEqual(spans(1250000, null, 'Lot 12500001'), []);
    assert.deepStrictEqual(spans('$1,250', null, 'Offer 1,250 now'), ['1,250']);
  });

  it('skips unitless numbers under three digits, keeps them with a unit', () => {
    assert.deepStrictEqual(valueMatchers(42, null), []);
    assert.deepStrictEqual(spans(42, 'acres', 'About 42 acres'), ['42']);
    assert.deepStrictEqual(spans(2.12, 'acres', 'The lot is 2.12 acres'), ['2.12']);
  });

  it('finds ISO and written dates', () => {
    assert.deepStrictEqual(spans('2026-11-14', null, 'Due 2026-11-14.'), ['2026-11-14']);
    assert.deepStrictEqual(spans('2026-11-14', null, 'Due November 14, 2026 at noon'), ['November 14, 2026']);
    assert.deepStrictEqual(spans('2026-11-14', null, 'Due Friday November 14'), ['November 14']);
  });

  it('finds folded text of four or more characters, not stop words or fragments', () => {
    assert.deepStrictEqual(spans('Lakeside Lot', null, 'the lakeside   lot is for sale'), ['lakeside   lot']);
    assert.deepStrictEqual(valueMatchers('lot', null), []);
    assert.deepStrictEqual(valueMatchers('none', null), []);
    assert.deepStrictEqual(spans('Harbor', null, 'Harborview Road'), []);
  });

  it('finds an email case-insensitively and walks array values', () => {
    assert.deepStrictEqual(spans('clerk@records.example.org', null, 'Write to Clerk@Records.Example.org.'), ['Clerk@Records.Example.org']);
    assert.deepStrictEqual(spans(['Lakeside Lot', 1250000], 'USD', 'Lakeside lot at $1,250,000'), ['Lakeside lot', '1,250,000']);
  });

  it('finds grouped numbers written with alternate separators and comma-decimal cents', () => {
    const text = "Wire 1.250,50 then 1 250,50 then 1 250,50 then 1 250,50 then 1 250,50 then 1'250,50 done";
    assert.deepStrictEqual(spans(1250.5, 'USD', text), [
      '1.250,50', '1 250,50', '1 250,50', '1 250,50', '1 250,50', "1'250,50"
    ]);
    // A form built from an unrelated grouping separator must not match a plain decimal elsewhere.
    assert.deepStrictEqual(spans(1250.5, 'USD', 'The rate is 1.25 percent'), []);
  });

  it('folds full-width and invisible characters in the scanned text, mapping spans back to the original', () => {
    const fullWidthPhone = '５５５－０１００'; // "555-0100"
    assert.deepStrictEqual(spans('+15550100', null, `Call ${fullWidthPhone} today`), [fullWidthPhone]);

    const zwspLot = 'lakeside​lot'; // zero-width space hides the word break
    assert.deepStrictEqual(spans('Lakeside Lot', null, `The ${zwspLot} is for sale`), [zwspLot]);

    const fullWidthAmount = '１，２５０'; // "1,250"
    assert.deepStrictEqual(spans('$1,250', null, `Offer ${fullWidthAmount} now`), [fullWidthAmount]);

    const fullWidthDate = '２０２６－１１－１４'; // "2026-11-14"
    assert.deepStrictEqual(spans('2026-11-14', null, `Due ${fullWidthDate}.`), [fullWidthDate]);

    // The "fi" ligature expands to two characters under NFKC, so this also
    // checks that a span maps back correctly when folding changes length.
    const ligatureOffice = 'ofﬁce lot'; // NFKC-folds to "office lot"
    assert.deepStrictEqual(spans('Office Lot', null, `Visit the ${ligatureOffice} today`), [ligatureOffice]);
  });
});

describe('comparison helpers', () => {
  it('treats a recipient address as the recipient in any format', () => {
    assert.strictEqual(isRecipient('555-0100', ['+15550100']), true);
    assert.strictEqual(isRecipient('+1 555 0100', ['+15550100']), true);
    assert.strictEqual(isRecipient('555-0199', ['+15550100']), false);
    assert.strictEqual(isRecipient('Clerk@Records.example.org', ['clerk@records.example.org']), true);
  });

  it('valueKey compares values after normalization', () => {
    assert.strictEqual(valueKey('2.12'), valueKey(2.12));
    assert.strictEqual(valueKey('$1,250'), valueKey(1250));
    assert.notStrictEqual(valueKey(2.5), valueKey(2.12));
    assert.strictEqual(valueKey(['b', 'a']), valueKey(['a', 'b']));
    assert.strictEqual(foldText('  Lakeside  LOT '), 'lakeside lot');
  });
});
