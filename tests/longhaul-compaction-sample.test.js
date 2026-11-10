'use strict';
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadSession, messageText } = require('../src/longhaul/session-format');
const { compactionWindows } = require('../src/longhaul/compaction/windows');
const { planWindowFacts, FACT_KINDS } = require('../src/longhaul/compaction/sample');
const { ANCHOR_SENDERS, MIN_ANCHOR_CHARS } = require('../src/longhaul/sampling');

const FIXTURE = path.join(__dirname, 'fixtures', 'longhaul', 'sessions', 'synth-compacted');

describe('planWindowFacts', () => {
  let session;
  let window;
  before(async () => {
    session = await loadSession(FIXTURE);
    window = compactionWindows(session).windows[0];
  });

  function anchorsOf(kind) {
    return session.index.messages.filter((m) => m.seq >= window.windowFromSeq && m.seq <= window.windowToSeq
      && ANCHOR_SENDERS[kind].includes(m.sender) && messageText(m).trim().length >= MIN_ANCHOR_CHARS);
  }

  it('exports the three kinds of fact and the anchor length', () => {
    assert.deepEqual(FACT_KINDS, ['user-said', 'tool-observed', 'decision']);
    assert.equal(MIN_ANCHOR_CHARS, 40);
  });

  it('returns items inside the window, kinds in turn', () => {
    for (const kind of FACT_KINDS) assert.ok(anchorsOf(kind).length >= 2, `fixture window has ${kind} anchors`);
    const { items, shortfall } = planWindowFacts(session.index, window, { count: 6, seed: 7 });
    assert.equal(items.length, 6);
    assert.equal(shortfall, 0);
    assert.deepEqual(items.map((it) => it.kind), [...FACT_KINDS, ...FACT_KINDS]);
    for (const it of items) {
      for (const seq of [it.anchorSeq, it.spanFrom, it.spanTo]) {
        assert.ok(seq >= window.windowFromSeq && seq <= window.windowToSeq, `${seq} inside the window`);
      }
      assert.ok(it.spanFrom <= it.anchorSeq && it.anchorSeq <= it.spanTo);
      assert.ok(ANCHOR_SENDERS[it.kind].includes(session.index.get(it.anchorSeq).sender));
      assert.equal(it.tokensToSummary, session.index.tokensBetween(it.anchorSeq, window.summarySeq));
    }
  });

  it('gives the same items for the same seed', () => {
    const a = planWindowFacts(session.index, window, { count: 6, seed: 7 });
    const b = planWindowFacts(session.index, window, { count: 6, seed: 7 });
    assert.deepEqual(a, b);
  });

  it('reports a shortfall when the count passes the anchors, with no anchor twice', () => {
    const { items, shortfall } = planWindowFacts(session.index, window, { count: 100000, seed: 3 });
    assert.ok(shortfall > 0);
    assert.equal(items.length + shortfall, 100000);
    const seqs = items.map((it) => it.anchorSeq);
    assert.equal(new Set(seqs).size, seqs.length);
  });

  it('keeps to the kinds asked for', () => {
    const { items } = planWindowFacts(session.index, window, { count: 4, seed: 5, kinds: ['tool-observed'] });
    assert.ok(items.length > 0);
    for (const it of items) {
      assert.equal(it.kind, 'tool-observed');
      assert.equal(session.index.get(it.anchorSeq).sender, 'toolResult');
    }
  });
});
