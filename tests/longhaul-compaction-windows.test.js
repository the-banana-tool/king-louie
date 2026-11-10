'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadSession, SessionIndex, estimateTokens } = require('../src/longhaul/session-format');
const { compactionWindows, summaryText } = require('../src/longhaul/compaction/windows');

const FIXTURE = path.join(__dirname, 'fixtures', 'longhaul', 'sessions', 'synth-compacted');

function msg(seq, sender, text, extra = {}) {
  return { id: `m${seq}`, seq, sender, text, timestamp: new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString(), ...extra };
}

function handBuilt(compactions, { boundaryMeta } = {}) {
  const messages = [];
  for (let seq = 1; seq <= 12; seq++) {
    if (seq === 6) messages.push(msg(seq, 'status', 'summary of the first part', { meta: { compaction: true } }));
    else if (seq === 5 && boundaryMeta) messages.push(msg(seq, 'status', 'boundary', { meta: boundaryMeta }));
    else messages.push(msg(seq, seq % 2 ? 'user' : 'assistant', `message number ${seq} with some words in it`));
  }
  const manifest = { sessionId: 'hand', private: false, license: 'test', messages: messages.length };
  if (compactions) manifest.compactions = compactions;
  return { manifest, messages, index: new SessionIndex(messages) };
}

describe('compactionWindows', () => {
  it('returns the fixture windows in order, inside bounds, not overlapping, with ratio > 1', async () => {
    const session = await loadSession(FIXTURE);
    const { windows, skipped } = compactionWindows(session);
    assert.equal(windows.length, 2);
    assert.deepEqual(skipped, []);
    windows.forEach((w, i) => {
      assert.equal(w.index, i);
      assert.ok(w.windowFromSeq >= 1);
      assert.ok(w.windowToSeq < w.summarySeq);
      assert.ok(w.ratio > 1);
      assert.equal(w.windowTokens, session.index.tokensBetween(w.windowFromSeq - 1, w.windowToSeq + 1));
      assert.equal(w.summaryTokens, estimateTokens(summaryText(session, w)));
      assert.equal(w.preTokens, null);
      assert.equal(w.postTokens, null);
    });
    assert.ok(windows[1].windowFromSeq > windows[0].windowToSeq);
    assert.ok(windows[0].summarySeq < windows[1].summarySeq);
  });

  it('skips an empty window', () => {
    const session = handBuilt([{ atSeq: 6, summarySeq: 6, windowFromSeq: 4, windowToSeq: 3 }]);
    assert.deepEqual(compactionWindows(session), { windows: [], skipped: [{ summarySeq: 6, reason: 'empty-window' }] });
  });

  it('returns nothing for a manifest with no compactions', () => {
    assert.deepEqual(compactionWindows(handBuilt(undefined)), { windows: [], skipped: [] });
  });

  it('carries preTokens and postTokens from the boundary at atSeq', () => {
    const session = handBuilt(
      [{ atSeq: 5, summarySeq: 6, windowFromSeq: 1, windowToSeq: 4 }],
      { boundaryMeta: { compactBoundary: { preTokens: 160000, postTokens: 9000 } } }
    );
    const { windows } = compactionWindows(session);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].preTokens, 160000);
    assert.equal(windows[0].postTokens, 9000);
    assert.equal(summaryText(session, windows[0]), 'summary of the first part');
  });

  it('gives a null ratio for an empty summary', () => {
    const session = handBuilt([{ atSeq: 6, summarySeq: 6, windowFromSeq: 1, windowToSeq: 5 }]);
    session.messages[5].text = '';
    session.index = new SessionIndex(session.messages);
    const { windows } = compactionWindows(session);
    assert.equal(windows[0].summaryTokens, 0);
    assert.equal(windows[0].ratio, null);
  });
});
