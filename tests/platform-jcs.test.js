// tests/platform-jcs.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalize, sha256b64url, JcsError } = require('../src/platform/jcs');

// Characters are built from code points so no editor or tool can silently
// turn an escape into the character (or the other way round).
const cp = (...points) => String.fromCodePoint(...points);
const BS = cp(0x5c); // backslash
const DQ = cp(0x22); // double quote

describe('canonicalize (RFC 8785)', () => {
  it('matches the RFC 8785 §3.2.2 example', () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 0.000000000000000000000000001],
      string: `${cp(0x20ac)}$${cp(0x0f)}${cp(0x0a)}A'B${DQ}${BS}${BS}${DQ}/`,
      literals: [null, true, false]
    };
    const expected = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
      + `"string":"${cp(0x20ac)}$${BS}u000f${BS}nA'B${BS}${DQ}${BS}${BS}${BS}${BS}${BS}${DQ}/"}`;
    assert.equal(canonicalize(input), expected);
  });

  it('sorts keys by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const keys = [cp(0x20ac), cp(0x0d), cp(0xfb33), '1', cp(0x1f600), cp(0x80), cp(0xf6)];
    const input = {};
    for (const k of keys) input[k] = k.codePointAt(0);
    // Object.keys would list the integer-like key "1" first, so the expected
    // text is built by hand in RFC order.
    const order = [cp(0x0d), '1', cp(0x80), cp(0xf6), cp(0x20ac), cp(0x1f600), cp(0xfb33)];
    const expected = `{${order.map((k) => `${JSON.stringify(k)}:${k.codePointAt(0)}`).join(',')}}`;
    assert.equal(canonicalize(input), expected);
  });

  it('sorts nested objects and keeps array order', () => {
    assert.equal(canonicalize({ b: [3, { z: 1, a: 2 }], a: 'x' }), '{"a":"x","b":[3,{"a":2,"z":1}]}');
  });

  it('writes numbers the ECMAScript way', () => {
    const cases = [[1e21, '1e+21'], [1e-7, '1e-7'], [0.1 + 0.2, '0.30000000000000004'], [-0, '0'], [100, '100'], [-1.5, '-1.5'], [5e-324, '5e-324']];
    for (const [n, text] of cases) assert.equal(canonicalize(n), text, String(n));
  });

  it('emits no whitespace and escapes control characters in lowercase hex', () => {
    assert.equal(canonicalize({ a: cp(0x01, 0x09), b: [1, 2] }), `{"a":"${BS}u0001${BS}t","b":[1,2]}`);
  });

  it('refuses values JCS cannot represent', () => {
    const bad = [NaN, Infinity, -Infinity, undefined, () => 1, Symbol('s'), 10n, { a: undefined }, [1, undefined],
      new Date(0), String.fromCharCode(0xd800), { [String.fromCharCode(0xdc00)]: 1 }, `a${String.fromCharCode(0xd83d)}`];
    for (const value of bad) {
      assert.throws(() => canonicalize(value), (err) => err instanceof JcsError && err.code === 'non_canonical_value');
    }
    // A hole in an array is undefined, not a skipped element.
    const holey = [1];
    holey[2] = 3;
    assert.throws(() => canonicalize(holey), JcsError);
  });

  it('accepts a well-formed surrogate pair and a null-prototype object', () => {
    const obj = Object.create(null);
    obj.k = cp(0x1f600);
    assert.equal(canonicalize(obj), `{"k":"${cp(0x1f600)}"}`);
  });

  it('refuses a self-referencing object as a circular reference', () => {
    const o = {};
    o.self = o;
    assert.throws(() => canonicalize(o), (err) => err instanceof JcsError && err.code === 'non_canonical_value');
  });

  it('refuses a self-referencing array as a circular reference', () => {
    const a = [1];
    a.push(a);
    assert.throws(() => canonicalize(a), (err) => err instanceof JcsError && err.code === 'non_canonical_value');
  });

  it('still serializes a shared reference used twice without a cycle', () => {
    const shared = { x: 1 };
    assert.equal(canonicalize({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
  });
});

describe('sha256b64url', () => {
  it('hashes the UTF-8 bytes and encodes base64url without padding', () => {
    assert.equal(sha256b64url(''), '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
    assert.equal(sha256b64url(Buffer.from('abc')), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
    assert.equal(sha256b64url('abc'), sha256b64url(Buffer.from('abc')));
  });
});
