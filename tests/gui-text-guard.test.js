// tests/gui-text-guard.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { checkTypeText, TypedBuffer, looksSecret, isInvalidText } = require('../src/gui/text-guard');
const { parseKeys, printableChar } = require('../src/gui/keys');

const ALWAYS = ['Bash(ssh *)', 'Bash(git push*)', 'Vault(*)', 'Bash(*deploy*)'];

describe('checkTypeText', () => {
  it('accepts ordinary text', () => {
    assert.deepEqual(checkTypeText('12+30=', { alwaysConfirm: ALWAYS }), { ok: true });
    assert.deepEqual(checkTypeText('Dear team,\n\tthe totals are in.', { alwaysConfirm: ALWAYS }), { ok: true });
  });

  it('invalid_text: empty, too long, control characters other than newline and tab', () => {
    for (const t of ['', 'a'.repeat(2001), 'a\u0000b', 'a\rb', 'a\u001bb', 'a\u007fb', 42]) {
      assert.deepEqual(checkTypeText(t), { ok: false, code: 'invalid_text' }, JSON.stringify(t));
    }
  });

  it('matches always_confirm details on the whole text, a line or a shell segment', () => {
    assert.equal(checkTypeText('git push origin main', { alwaysConfirm: ALWAYS }).code, 'text_matches_always_confirm');
    assert.equal(checkTypeText('cd x && git push origin', { alwaysConfirm: ALWAYS }).code, 'text_matches_always_confirm');
    assert.equal(checkTypeText('ls\nssh root@example.com', { alwaysConfirm: ALWAYS }).code, 'text_matches_always_confirm');
    assert.equal(checkTypeText('please redeploy now', { alwaysConfirm: ALWAYS }).code, 'text_matches_always_confirm');
    // Bare names (no detail) are ignored, and a bare `*` detail (Vault(*)) is not a text rule.
    assert.deepEqual(checkTypeText('hello', { alwaysConfirm: ['Bash', 'Vault(*)'] }), { ok: true });
  });

  it('checks the text on its own too, so an earlier buffer cannot mask it', () => {
    assert.equal(checkTypeText('git push origin', { alwaysConfirm: ALWAYS, buffer: 'hello ' }).code, 'text_matches_always_confirm');
  });

  it('refuses secret-looking text with the pinned patterns', () => {
    const secrets = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'token sk-ant-abcdefgh12345678',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'AKIAABCDEFGHIJKLMNOP',
      'AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_ghi',
      'Zx8#qL2!vN7$wK4%tR9^mB1&pC6*'
    ];
    for (const s of secrets) assert.equal(checkTypeText(s).code, 'text_looks_secret', s);
  });

  it('exempts a plain web URL from the entropy rule, but not one with userinfo', () => {
    assert.deepEqual(checkTypeText('https://example.com/a/B9x_7Qz-Lm3?q=Zr8&t=Wk2P'), { ok: true });
    assert.equal(checkTypeText('https://user:Zx8qL2vN7wK4tR9@example.com/a').code, 'text_looks_secret');
  });

  it('refuses any vault value of 8 characters or more as a substring', () => {
    assert.equal(checkTypeText('the code is hunter2hunter2 ok', { vaultValues: ['hunter2hunter2'] }).code, 'text_looks_secret');
    assert.deepEqual(checkTypeText('short abc', { vaultValues: ['abc'] }), { ok: true });
  });

  it('Review Focus 4: CJK prose and emoji are not secrets; length counts code points', () => {
    assert.deepEqual(checkTypeText('東京の会議は2026年9月25日にZoomで行います担当者は田中さんです'), { ok: true });
    assert.deepEqual(checkTypeText('这个季度的销售额增长了15个百分点主要来自华东地区的新客户'), { ok: true });
    assert.deepEqual(checkTypeText('😀'.repeat(2000)), { ok: true });
    assert.equal(checkTypeText('😀'.repeat(2001)).code, 'invalid_text');
    assert.equal(isInvalidText('😀'.repeat(2000)), false);
  });
});

describe('TypedBuffer', () => {
  it('a secret spelled by single Key presses is refused', () => {
    const buf = new TypedBuffer();
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    let refused = null;
    for (const ch of secret) {
      const keys = ch === '_' ? 'shift+-' : ch;
      const char = printableChar(parseKeys(keys, 'linux'));
      const r = checkTypeText(char, { buffer: buf.value });
      if (!r.ok) { refused = r.code; break; }
      buf.append(char);
    }
    assert.equal(refused, 'text_looks_secret');
  });

  it('keeps the last 2000 code points and resets', () => {
    const buf = new TypedBuffer();
    buf.append('a'.repeat(1990));
    buf.append('😀'.repeat(20));
    assert.equal(Array.from(buf.value).length, 2000);
    assert.ok(buf.value.endsWith('😀'));
    buf.reset();
    assert.equal(buf.value, '');
  });

  it('looksSecret is exported for the Key path', () => {
    assert.equal(looksSecret('AKIAABCDEFGHIJKLMNOP', []), true);
  });
});
