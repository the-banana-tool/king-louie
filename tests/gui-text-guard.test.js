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

  it('keeps the last 4096 code points and resets', () => {
    const buf = new TypedBuffer();
    buf.append('a'.repeat(4086));
    buf.append('😀'.repeat(20));
    assert.equal(Array.from(buf.value).length, 4096);
    assert.ok(buf.value.endsWith('😀'));
    buf.reset();
    assert.equal(buf.value, '');
  });

  // Security review finding 9: the buffer models what the keys did.
  const VAULT = ['correct-horse-battery'];
  const check = (text, buf) => checkTypeText(text, { vaultValues: VAULT, buffer: buf.value, segments: buf.segments });

  it('backspace removes what it removed: half, a throwaway character, backspace, the other half is the whole value', () => {
    const buf = new TypedBuffer();
    assert.equal(check('correct-ho', buf).ok, true);
    buf.append('correct-ho');
    buf.append('x');
    buf.backspace(1);
    assert.equal(buf.value, 'correct-ho');
    assert.equal(check('rse-battery', buf).code, 'text_looks_secret');
    // Several at once, and more than was typed (then the field is unknown).
    const b2 = new TypedBuffer();
    b2.append('correct-hoxyz');
    b2.backspace(3);
    assert.equal(check('rse-battery', b2).code, 'text_looks_secret');
    const b3 = new TypedBuffer();
    b3.append('ab');
    b3.backspace(5);
    assert.equal(b3.value, '');
    assert.equal(b3.navigated, true, 'a backspace into text the buffer never saw');
  });

  it('after a navigation key the earlier text is kept as a piece: the second half, Home, the first half is refused', () => {
    const buf = new TypedBuffer();
    buf.append('rse-battery');
    buf.navigate(); // home, or ten presses of left
    assert.equal(buf.value, '', 'the caret is somewhere else: nothing follows on contiguously');
    assert.deepEqual(buf.segments, ['rse-battery']);
    assert.equal(check('correct-ho', buf).code, 'text_looks_secret');
    // The other order, and a piece dropped into the middle.
    const b2 = new TypedBuffer();
    b2.append('correct-ho');
    b2.navigate();
    assert.equal(check('rse-battery', b2).code, 'text_looks_secret');
    const b3 = new TypedBuffer();
    b3.append('correct-battery');
    b3.navigate();
    assert.equal(check('horse-', b3).code, 'text_looks_secret');
    // Three and four pieces, typed last to first.
    const b4 = new TypedBuffer();
    for (const piece of ['attery', 'rse-b', 'ct-ho']) { assert.equal(check(piece, b4).ok, true, piece); b4.append(piece); b4.navigate(); }
    assert.equal(check('corre', b4).code, 'text_looks_secret');
  });

  it('single key presses after a navigation are caught when they complete the value', () => {
    const buf = new TypedBuffer();
    buf.append('orrect-horse-battery');
    buf.navigate();
    assert.equal(check('c', buf).code, 'text_looks_secret');
  });

  it('ordinary typing around navigation is not refused', () => {
    const buf = new TypedBuffer();
    buf.append('Dear Sam, the horse is in the stable.');
    buf.navigate();
    assert.equal(check('The battery is flat, correct?', buf).ok, true);
    buf.append('The battery is flat, correct?');
    buf.navigate();
    assert.equal(check(' Thanks', buf).ok, true);
    // Without a navigation the pieces are where they were typed: no join is assumed.
    const b2 = new TypedBuffer();
    b2.append('correct-ho and then, much later, ');
    assert.equal(check('rse-battery', b2).ok, true);
  });

  it('an always_confirm command split around a navigation is refused in either order', () => {
    const ALWAYS_CONFIRM = ['Bash(git push*)'];
    const buf = new TypedBuffer();
    buf.append('push origin main');
    buf.navigate();
    assert.equal(checkTypeText('git ', { alwaysConfirm: ALWAYS_CONFIRM, buffer: buf.value, segments: buf.segments }).code, 'text_matches_always_confirm');
    const b2 = new TypedBuffer();
    b2.append('ghp_abc');
    b2.navigate();
    assert.equal(checkTypeText('defghijklmnop', { buffer: b2.value, segments: b2.segments }).code, 'text_looks_secret');
  });

  it('enter is a line break in the buffer, not a clean slate: half, enter, backspace, half is the whole value', () => {
    const buf = new TypedBuffer();
    buf.append('correct-ho');
    buf.append('\n');
    assert.equal(check('rse-battery', buf).ok, true, 'two lines');
    buf.backspace(1);
    assert.equal(check('rse-battery', buf).code, 'text_looks_secret');
  });

  it('keeps 4096 code points across its pieces, dropping the oldest', () => {
    const buf = new TypedBuffer();
    buf.append('a'.repeat(3500));
    buf.navigate();
    buf.append('b'.repeat(1000));
    assert.equal(Array.from(buf.segments.join('') + buf.value).length, 4096);
    assert.equal(buf.value, 'b'.repeat(1000));
    buf.reset();
    assert.deepEqual([buf.value, buf.segments, buf.navigated], ['', [], false]);
  });

  it('keeps the last 64 pieces, dropping the oldest', () => {
    const { RUNS_MAX } = require('../src/gui/text-guard');
    assert.equal(RUNS_MAX, 64);
    const buf = new TypedBuffer();
    for (let i = 0; i < 70; i += 1) { buf.append(`p${i}`); buf.navigate(); }
    assert.equal(buf.segments.length, 64);
    assert.equal(buf.segments[0], 'p6');
    assert.equal(buf.segments.at(-1), 'p69');
    // An empty navigation adds no piece.
    buf.navigate();
    assert.equal(buf.segments.length, 64);
  });

  // Second security review, finding 8. The guard followed at most four runs
  // of typed pieces, so a value typed as five pieces with a key between them
  // that moves nothing went through. Pieces typed one after another are now
  // followed whatever their number: a value that the typed pieces spell in
  // the order they were typed is refused.
  describe('second review finding 8: a value spelled by any number of pieces, in the order they were typed', () => {
    // Types the pieces with a key the guard cannot follow after each; the index of the first refusal, or null.
    function typeAll(buf, pieces, { vault = VAULT, alwaysConfirm = [] } = {}) {
      for (let i = 0; i < pieces.length; i += 1) {
        const r = checkTypeText(pieces[i], { vaultValues: vault, alwaysConfirm, buffer: buf.value, segments: buf.segments });
        if (!r.ok) return { at: i, code: r.code };
        buf.append(pieces[i]);
        buf.navigate();
      }
      return null;
    }

    it('five pieces with a no-op key between them (four passed before; five went through)', () => {
      assert.deepEqual(typeAll(new TypedBuffer(), ['corr', 'ect-', 'hors', 'e-ba', 'ttery']), { at: 4, code: 'text_looks_secret' });
      assert.deepEqual(typeAll(new TypedBuffer(), ['co', 'rr', 'ec', 't-', 'ho', 'rs', 'e-', 'ba', 'tt', 'ery']), { at: 9, code: 'text_looks_secret' });
    });

    it('one key at a time, a no-op key after each: refused at the press that completes it', () => {
      const value = VAULT[0];
      assert.deepEqual(typeAll(new TypedBuffer(), Array.from(value)), { at: value.length - 1, code: 'text_looks_secret' });
    });

    it('other text typed in between (a decoy in another field) does not hide it', () => {
      const pieces = ['correct-', 'Lakeside lot', 'hor', 'see you at ten', 'se-', 'bat', 'x', 'tery'];
      assert.deepEqual(typeAll(new TypedBuffer(), pieces), { at: 7, code: 'text_looks_secret' });
    });

    it('the value may begin inside the first piece and end inside the text being typed', () => {
      const buf = new TypedBuffer();
      assert.equal(typeAll(buf, ['my code is corr', 'ect-', 'hors', 'e-ba']), null);
      assert.equal(check('ttery, as agreed', buf).code, 'text_looks_secret');
      // And the text being typed may continue what is at the caret already.
      const b2 = new TypedBuffer();
      assert.equal(typeAll(b2, ['corr', 'ect-', 'hors', 'e-ba']), null);
      b2.append('tt');
      assert.equal(check('ery', b2).code, 'text_looks_secret');
      assert.equal(check('e', b2).ok, true, 'not yet complete');
    });

    it('an always_confirm command and a secret pattern in three or more pieces, in order', () => {
      assert.deepEqual(typeAll(new TypedBuffer(), ['gi', 't pu', 'sh or', 'igin'], { vault: [], alwaysConfirm: ['Bash(git push*)'] }), { at: 2, code: 'text_matches_always_confirm' });
      assert.deepEqual(typeAll(new TypedBuffer(), ['gh', 'p_ab', 'cdef', 'ghij', 'klmn'], { vault: [] }), { at: 3, code: 'text_looks_secret' });
    });

    it('ordinary typing in many fields is not refused, and the entropy rule is not applied across pieces', () => {
      const cells = ['Q3Revenue', '12,400.50', 'Total:', 'Zx8', 'North-East', '2026-10-13', 'correct', 'horse', 'battery', 'ok?', 'Lakeside lot', '+15550100'];
      assert.equal(typeAll(new TypedBuffer(), cells), null);
      // A refusal is not sticky: the next ordinary text goes through.
      const buf = new TypedBuffer();
      assert.equal(typeAll(buf, ['corr', 'ect-', 'hors', 'e-ba']), null);
      assert.equal(check('ttery', buf).code, 'text_looks_secret');
      assert.equal(check('Dear Sam,', buf).ok, true);
    });

    it('what it still does not follow, pinned so the residuals in the header stay true', () => {
      // More than four pieces typed out of order.
      assert.equal(typeAll(new TypedBuffer(), ['ttery', 'e-ba', 'hors', 'ect-', 'corr']), null);
      // More than four pieces, one of them with text around it that was not typed away with backspace.
      assert.equal(typeAll(new TypedBuffer(), ['corr', 'ect-', 'horsX', 'e-ba', 'ttery']), null);
      // A first piece that has left the 64-piece window.
      const far = ['corr', ...Array.from({ length: 64 }, (_, i) => `cell ${i}`), 'ect-', 'hors', 'e-ba', 'ttery'];
      assert.equal(typeAll(new TypedBuffer(), far), null);
    });

    it('a low-entropy vault value can refuse ordinary typing: eight cells of "a" spell "aaaaaaaa" (documented)', () => {
      assert.deepEqual(typeAll(new TypedBuffer(), Array.from({ length: 8 }, () => 'a'), { vault: ['aaaaaaaa'] }), { at: 7, code: 'text_looks_secret' });
    });

    // A full history (64 pieces, some 4000 code points) against fifty vault
    // values costs a few milliseconds a check here; the bound only catches
    // a check that has become quadratic in the history.
    it('a full history and fifty vault values: a check stays cheap', () => {
      const buf = new TypedBuffer();
      for (let i = 0; i < 64; i += 1) { buf.append(`cell ${i} ${'ab'.repeat(27)}`); buf.navigate(); }
      assert.equal(buf.segments.length, 64);
      const values = Array.from({ length: 50 }, (_, i) => `Zx8qL2vN7wK4tR9mB1pC6-${i}-correct-horse-b`);
      const start = process.hrtime.bigint();
      for (let i = 0; i < 10; i += 1) assert.equal(checkTypeText('ab'.repeat(40), { vaultValues: values, buffer: buf.value, segments: buf.segments }).ok, true);
      assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 10000, 'ten checks');
    });
  });

  it('looksSecret is exported for the Key path', () => {
    assert.equal(looksSecret('AKIAABCDEFGHIJKLMNOP', []), true);
  });
});
