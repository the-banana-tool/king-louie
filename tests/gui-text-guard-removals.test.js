// tests/gui-text-guard-removals.test.js
// Third security review, findings 1 and 2 (2026-10-13): text the lease
// removes again, and what one check may cost. The keys go through the same
// parseKeys / printableChar / applyKey path as the Key tool.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  checkTypeText, TypedBuffer, keyEffect, applyKey, LOSSY_EDGE, LOSSY_RUN, VALUE_FOLLOW_MAX, STEP_BUDGET
} = require('../src/gui/text-guard');
const { parseKeys, printableChar } = require('../src/gui/keys');

const TOKEN = 'Zq7mK2pLx9Rt4wYb';

// A lease's typing: `type` as the Type tool, `key` as the Key tool. Both
// return the guard's answer; refused text is not typed.
function session({ vault = [], alwaysConfirm = [] } = {}) {
  const buf = new TypedBuffer();
  const s = {
    buf,
    refusals: [],
    type(text) {
      const r = checkTypeText(text, { vaultValues: vault, alwaysConfirm, ...buf.state });
      if (r.ok) buf.append(text); else s.refusals.push(r.code);
      return r;
    },
    key(keys, repeat = 1) {
      const combo = parseKeys(keys, 'linux');
      const char = printableChar(combo);
      if (char) return s.type(char.repeat(repeat));
      if (combo.key === 'enter' && combo.mods.every((m) => m === 'shift')) buf.append('\n'.repeat(repeat));
      else applyKey(buf, combo, { repeat });
      return { ok: true };
    }
  };
  return s;
}

// Types each piece, then runs `between(s)` (the keys that take the junk
// away); the code of the first refusal, or null.
function spell(pieces, between, options) {
  const s = session(options);
  for (let i = 0; i < pieces.length; i += 1) {
    const r = s.type(pieces[i]);
    if (!r.ok) return r.code;
    if (i < pieces.length - 1) between(s);
  }
  return null;
}

const endBackspace = (n = 1) => (s) => { s.key('end'); s.key('backspace', n); };

describe('third review finding 1: a junk character removed after a navigation', () => {
  it('the three reproductions: End, Backspace after each piece', () => {
    assert.equal(spell(['Zq7#', 'mK2#', 'pLx#', '9Rt#', '4wYb'], endBackspace(), { vault: [TOKEN] }), 'text_looks_secret');
    assert.equal(spell(['rm -#', 'rf /tmp/x'], endBackspace(), { alwaysConfirm: ['Bash(rm -rf *)'] }), 'text_matches_always_confirm');
    assert.equal(spell(['ghp_#', 'abcdefghijklmnop'], endBackspace(), {}), 'text_looks_secret');
  });

  it('a backspace past the piece being typed takes from the end of the piece before it, and keeps what it took', () => {
    const s = session();
    s.type('Zq7#');
    s.key('end');
    s.key('backspace');
    assert.deepEqual([s.buf.value, s.buf.segments, s.buf.cuts, s.buf.lossy], ['', ['Zq7'], ['#'], false]);
    // Text typed after End, removed with what is before it; then into the piece before that.
    s.type('ab');
    s.key('end');
    s.key('backspace', 4);
    assert.deepEqual([s.buf.segments, s.buf.cuts, s.buf.lossy], [['Z', ''], ['q7#', 'ab'], false]);
  });

  it('one character a piece, and more junk than the lossy edge: followed exactly after End', () => {
    const one = Array.from(TOKEN).map((c, i) => (i < TOKEN.length - 1 ? `${c}#` : c));
    assert.equal(spell(one, endBackspace(), { vault: [TOKEN] }), 'text_looks_secret');
    const junk = '#'.repeat(LOSSY_EDGE + 3);
    assert.equal(spell([`Zq${junk}`, `7m${junk}`, `K2${junk}`, `pL${junk}`, `x9${junk}`, `Rt${junk}`, '4wYb'], endBackspace(junk.length), { vault: [TOKEN] }), 'text_looks_secret');
  });

  it('End may have gone to the end of other text: the piece is checked with what the backspace took, too', () => {
    const s = session({ vault: [TOKEN] });
    s.type('Zq7m');
    s.key('end');
    s.key('backspace'); // took a character of text that was there before, not the "m"
    assert.equal(s.type('K2pLx9Rt4wYb').code, 'text_looks_secret');
    const c = session({ alwaysConfirm: ['Bash(rm -rf *)'] });
    c.type('rm -r');
    c.key('end');
    c.key('backspace');
    assert.equal(c.type('f /tmp/x').code, 'text_matches_always_confirm');
  });

  it('a key that moves nothing, then Backspace: the place is unknown, the field is lossy, the value is still refused', () => {
    const between = (s) => { s.key('escape'); s.key('backspace'); };
    assert.equal(spell(['Zq7#', 'mK2#', 'pLx#', '9Rt#', '4wYb'], between, { vault: [TOKEN] }), 'text_looks_secret');
    assert.equal(spell(['rm -#', 'rf /tmp/x'], between, { alwaysConfirm: ['Bash(rm -rf *)'] }), 'text_matches_always_confirm');
    assert.equal(spell(['ghp_#', 'abcdefghijklmnop'], between, {}), 'text_looks_secret');
    const s = session();
    s.type('abc');
    s.key('escape');
    s.key('backspace');
    assert.deepEqual([s.buf.segments, s.buf.cuts, s.buf.lossy], [['abc'], [''], true], 'nothing is taken from a piece whose place is unknown');
  });

  it('End after the caret was elsewhere: the end of the line may be the end of any piece', () => {
    // The junk of each piece goes, though the piece typed last is a decoy at the start of the line.
    const between = (s) => { s.key('home'); s.type('j'); s.key('end'); s.key('backspace'); };
    assert.equal(spell(['Zq7#', 'mK2#', 'pLx#', '9Rt#', '4wYb'], between, { vault: [TOKEN] }), 'text_looks_secret');
  });

  it('Delete: left, delete after each piece', () => {
    const between = (s) => { s.key('left'); s.key('delete'); s.key('end'); };
    assert.equal(spell(['Zq7#', 'mK2#', 'pLx#', '9Rt#', '4wYb'], between, { vault: [TOKEN] }), 'text_looks_secret');
    assert.equal(spell(['rm -#', 'rf /tmp/x'], between, { alwaysConfirm: ['Bash(rm -rf *)'] }), 'text_matches_always_confirm');
    assert.equal(spell(['ghp_#', 'abcdefghijklmnop'], between, {}), 'text_looks_secret');
    // Junk at the start of a piece, and in the middle of one.
    assert.equal(spell(['#Zq7', '#mK2', '#pLx', '#9Rt', '4wYb'], (s) => { s.key('left', 4); s.key('delete'); s.key('end'); }, { vault: [TOKEN] }), 'text_looks_secret');
    const mid = session({ vault: [TOKEN] });
    mid.type('Zq7mK2####pLx9');
    mid.key('left', 4);
    mid.key('backspace', 4);
    mid.key('end');
    assert.equal(mid.type('Rt4wYb').code, 'text_looks_secret');
  });

  it('ctrl+Backspace and ctrl+Delete: a word of junk after each piece', () => {
    const word = (s) => { s.key('ctrl+backspace'); };
    assert.equal(spell(['Zq7####', 'mK2####', 'pLx####', '9Rt####', '4wYb'], word, { vault: [TOKEN] }), 'text_looks_secret');
    assert.equal(spell(['rm -##', 'rf /tmp/x'], word, { alwaysConfirm: ['Bash(rm -rf *)'] }), 'text_matches_always_confirm');
    const fwd = (s) => { s.key('left', 4); s.key('ctrl+delete'); };
    assert.equal(spell(['Zq7####', 'mK2####', 'pLx####', '9Rt####', '4wYb'], fwd, { vault: [TOKEN] }), 'text_looks_secret');
    assert.equal(spell(['ghp_####', 'abcdefghijklmnop'], fwd, {}), 'text_looks_secret');
  });

  it('a selection, then typing over it', () => {
    const select = (s) => { s.key('shift+left', 2); };
    assert.equal(spell(['Zq7##', 'mK2##', 'pLx##', '9Rt##', '4wYb'], select, { vault: [TOKEN] }), 'text_looks_secret');
    // The check that follows the selection is the lossy one already.
    assert.equal(spell(['rm -##', 'rf /tmp/x'], select, { alwaysConfirm: ['Bash(rm -rf *)'] }), 'text_matches_always_confirm');
    assert.equal(spell(['ghp_##', 'abcdefghijklmnop'], select, {}), 'text_looks_secret');
    // A double click or a drag selects as well (what the Click and Drag tools call).
    assert.equal(spell(['rm -##', 'rf /tmp/x'], (s) => s.buf.select(), { alwaysConfirm: ['Bash(rm -rf *)'] }), 'text_matches_always_confirm');
    // A selection removed with backspace, and the mark stays.
    const s = session({ vault: [TOKEN] });
    s.type('Zq7mK2pL##');
    s.key('shift+left', 2);
    assert.equal(s.buf.lossy, false);
    s.key('backspace');
    assert.equal(s.buf.lossy, true);
    assert.equal(s.type('x9Rt4wYb').code, 'text_looks_secret');
  });

  it('keyEffect: which keys the buffer follows, and which mark the field lossy', () => {
    const effect = (keys) => keyEffect(parseKeys(keys, 'linux'));
    assert.equal(effect('backspace'), 'backspace');
    for (const k of ['delete', 'insert', 'shift+backspace', 'ctrl+backspace', 'alt+backspace', 'ctrl+delete', 'ctrl+h', 'ctrl+w', 'ctrl+k', 'ctrl+z', 'ctrl+enter', 'alt+d']) {
      assert.equal(effect(k), 'edit', k);
    }
    for (const k of ['shift+left', 'shift+end', 'shift+home', 'ctrl+shift+right', 'shift+up', 'shift+pagedown']) assert.equal(effect(k), 'select', k);
    assert.equal(effect('end'), 'end');
    for (const k of ['home', 'left', 'right', 'up', 'down', 'pageup', 'pagedown']) assert.equal(effect(k), 'move', k);
    for (const k of ['tab', 'shift+tab', 'escape', 'f5', 'ctrl+left', 'ctrl+end', 'alt+right']) assert.equal(effect(k), 'navigate', k);
  });

  it('a removal whose outcome is not known is never followed: the field is lossy', () => {
    const buf = new TypedBuffer();
    buf.append('Zq7#');
    applyKey(buf, parseKeys('backspace', 'linux'), { repeat: 1, certain: false });
    assert.deepEqual([buf.value, buf.segments, buf.lossy], ['', ['Zq7#'], true]);
    const b2 = new TypedBuffer();
    b2.append('abc');
    applyKey(b2, parseKeys('end', 'linux'), { certain: false });
    applyKey(b2, parseKeys('backspace', 'linux'), {});
    assert.deepEqual([b2.segments, b2.cuts, b2.lossy], [['abc'], [''], true], 'an End that may not have happened places nothing');
  });

  it('the mark lasts for the lease: reset clears it, a navigation does not', () => {
    const buf = new TypedBuffer();
    buf.append('abc');
    buf.edited();
    buf.navigate();
    buf.append('def');
    buf.navigate('end');
    assert.equal(buf.state.lossy, true);
    buf.reset();
    assert.deepEqual(buf.state, { buffer: '', segments: [], cuts: [], lossy: false });
  });

  describe('ordinary editing is not refused', () => {
    // A 16-character token, a 12-character password, an API key with a prefix.
    const vault = [TOKEN, 'Tr0ub4dor&3x', 'kl_live_9fK2mQ7xLp4Zt8Rw'];
    const alwaysConfirm = ['Bash(rm -rf *)', 'Bash(git push*)', 'Bash(ssh *)'];
    const ok = (s, r) => assert.deepEqual(r, { ok: true }, JSON.stringify(s.buf.state));

    it('a sentence, a typo fixed with Backspace, End, more text', () => {
      const s = session({ vault, alwaysConfirm });
      ok(s, s.type('Dear Sam, the meetign is at ten.'));
      s.key('backspace', 15);
      ok(s, s.type('ing is at ten.'));
      s.key('end');
      ok(s, s.type(' See you there.'));
      s.key('enter');
      ok(s, s.type('The trouble with the door is fixed, and the key is under the mat.'));
      // End, then a backspace into the piece before, and on.
      s.key('end');
      s.key('backspace', 4);
      ok(s, s.type('rug. Zoe has the live report; Kim moved lot 4 to row 8.'));
      assert.equal(s.buf.lossy, false);
      assert.deepEqual(s.refusals, []);
    });

    it('a lossy field: clicks, Delete, a word removed, a selection typed over, save, undo', () => {
      const s = session({ vault, alwaysConfirm });
      ok(s, s.type('Quarterly totals for the Lakeside lot'));
      s.key('left', 3);
      s.key('backspace', 2);
      assert.equal(s.buf.lossy, true);
      ok(s, s.type('de plot'));
      s.key('ctrl+s');
      for (const cell of ['Q3 Revenue', '12,400.50', 'Total:', 'Zx8', 'North-East', '2026-10-13', 'push the date back', 'remove the draft', 'ok?', '+15550100', 'live key rotation is due', 'Trouble with row 3']) {
        ok(s, s.type(cell));
        s.key('tab');
      }
      s.key('shift+home');
      ok(s, s.type('The trouble started in May.'));
      s.key('ctrl+backspace');
      ok(s, s.type('June.'));
      s.key('home');
      s.key('delete', 4);
      ok(s, s.type('That '));
      s.key('ctrl+z');
      ok(s, s.type('Zoe and Quinn met at 7; Kim took lot 2.'));
      s.buf.select();
      ok(s, s.type('Rt 4 was busy, by the way.'));
      assert.deepEqual(s.refusals, []);
    });

    it('a lossy field still refuses a value typed in runs of the lossy length, in order (the documented false positive)', () => {
      assert.equal(LOSSY_RUN, 3);
      assert.ok(LOSSY_EDGE >= 4);
      const cells = ['xabcx', 'xdefx', 'xghix', 'xjklx', 'xmnox'];
      const s = session({ vault: ['abcdefghijklmnopqr'] });
      s.key('delete');
      for (const cell of cells) { s.type(cell); s.key('tab'); }
      assert.equal(s.type('pqr').code, 'text_looks_secret');
      // Not lossy: the same typing goes through.
      const t = session({ vault: ['abcdefghijklmnopqr'] });
      for (const cell of cells) { t.type(cell); t.key('tab'); }
      assert.deepEqual(t.type('pqr'), { ok: true });
    });
  });

  it('what it still does not follow, pinned so the residuals in the header stay true', () => {
    // One or two characters a piece with more than LOSSY_EDGE characters of junk removed beside each, in a lossy field.
    const junk = '#'.repeat(LOSSY_EDGE + 1);
    const pieces = ['Zq', '7m', 'K2', 'pL', 'x9', 'Rt', '4w'].map((p) => `${p}${junk}`);
    assert.equal(spell([...pieces, 'Yb'], (s) => { s.key('left', junk.length); s.key('delete', junk.length); s.key('end'); }, { vault: [TOKEN] }), null);
    // A command whose pieces lost different numbers of characters at different joins.
    assert.equal(spell(['git#', ' pu##', 'sh origin'], (s) => { s.key('escape'); s.key('backspace', 2); }, { alwaysConfirm: ['Bash(git push*)'] }), null);
    // A removal that completes a value with nothing typed after it: no check runs.
    const s = session({ vault: [TOKEN] });
    assert.deepEqual(s.type('Zq7mK2pL#x9Rt4wYb'), { ok: true });
    s.key('left', 8);
    assert.deepEqual(s.key('backspace'), { ok: true });
  });
});

describe('third review finding 2: what one check may cost', () => {
  const timed = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return [r, Number(process.hrtime.bigint() - t) / 1e6]; };

  it('the reported input (a 7000-character value of one letter, 1900 characters typed, a 300-character Type) returns at once', () => {
    const buf = new TypedBuffer();
    buf.append('x');
    buf.navigate();
    buf.append('a'.repeat(1900));
    const [r, ms] = timed(() => checkTypeText('a'.repeat(300), { vaultValues: ['a'.repeat(7000)], ...buf.state }));
    assert.deepEqual(r, { ok: true }, 'the value is not in the text; a value this long is not followed across pieces');
    assert.ok(ms < 1000, `${ms} ms`);
    // The plain check still covers a long value.
    assert.equal(VALUE_FOLLOW_MAX, 512);
    assert.equal(checkTypeText('a'.repeat(300), { vaultValues: ['a'.repeat(513)], buffer: 'a'.repeat(213) }).code, 'text_looks_secret');
  });

  it('values at the length limit against a full repetitive history: refused or allowed within a second, in a lossy field too', () => {
    for (const lossy of [false, true]) {
      const buf = new TypedBuffer();
      for (let i = 0; i < 18; i += 1) { buf.append('ab'.repeat(50)); buf.navigate(); }
      buf.append('ab'.repeat(50));
      if (lossy) buf.edited();
      const values = Array.from({ length: 40 }, (_, i) => `${'ab'.repeat(250)}${String(i).padStart(11, 'c')}z`);
      assert.equal(values[0].length, VALUE_FOLLOW_MAX);
      const [r, ms] = timed(() => checkTypeText('ab'.repeat(150), { vaultValues: values, ...buf.state }));
      assert.ok(ms < 1000, `${ms} ms (lossy ${lossy})`);
      assert.ok(r.ok === true || r.code === 'text_guard_limit', JSON.stringify(r));
    }
  });

  it('out of steps, the check refuses with its own code: it never lets the text through', () => {
    const buf = new TypedBuffer();
    for (let i = 0; i < 18; i += 1) { buf.append('ab'.repeat(50)); buf.navigate(); }
    const value = `${'ab'.repeat(250)}cccccccccccz`;
    const r = checkTypeText('ab'.repeat(150), { vaultValues: [value], ...buf.state, stepBudget: 1000 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'text_guard_limit');
    assert.match(r.detail, /not typed/);
    assert.ok(!r.detail.includes('ab'), 'the reason holds no typed text');
    // An ordinary value against the same history is decided within the default budget.
    assert.ok(STEP_BUDGET >= 1_000_000);
    assert.deepEqual(checkTypeText('ab'.repeat(150), { vaultValues: [TOKEN], ...buf.state }), { ok: true });
  });

  it('ordinary use stays far from the budget: a full history, 200 vault values', () => {
    const buf = new TypedBuffer();
    for (let i = 0; i < 64; i += 1) { buf.append(`cell ${i} ${'the quick brown fox '.repeat(3)}`); buf.navigate(); }
    buf.edited();
    const values = Array.from({ length: 200 }, (_, i) => `Zx8qL2vN7wK4tR9mB1pC6-${i}-the-quick-brown`);
    const [r, ms] = timed(() => checkTypeText('the quick brown fox jumps over the lazy dog', { vaultValues: values, ...buf.state, stepBudget: STEP_BUDGET / 4 }));
    assert.deepEqual(r, { ok: true });
    assert.ok(ms < 1000, `${ms} ms`);
  });
});
