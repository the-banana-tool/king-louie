// tests/preload-listeners.test.js
// preload.js's registerOnce keeps one callback per channel: a second
// registration silently drops the first (Task 12 fix round 1,
// stream-investigation.md). chat:messageStart/messageComplete/toolUse were
// registered twice in renderer.js — the real send-path handlers, and
// initAgentProgress's own progress-bar handlers — so the real handlers were
// silently replaced: no streaming placeholder, no live text, Stop never
// shown. Fixed by making those three channels registerAdditive; this test
// guards every other registerOnce channel against the same mistake, now and
// for any future addition.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

// Walk preload.js's exposed object literal: a 4-space-indented `name: {`
// opens a namespace (chat, tool, task, ...), and within it a 6-space-indented
// `onX: (callback) => registerOnce('channel', callback)` is one registerOnce
// consumer, exposed to the renderer as window.electron.<namespace>.<onX>.
function findRegisterOnceEntries(src) {
  const nsRe = /^ {4}(\w+): \{\s*$/;
  const propRe = /^ {6}(\w+): \(callback\) => registerOnce\('([^']+)'/;
  const entries = [];
  let currentNs = null;
  for (const line of src.split('\n')) {
    const nsMatch = line.match(nsRe);
    if (nsMatch) {
      currentNs = nsMatch[1];
      continue;
    }
    const propMatch = line.match(propRe);
    if (propMatch && currentNs) {
      entries.push({ ns: currentNs, prop: propMatch[1], channel: propMatch[2] });
    }
  }
  return entries;
}

describe('preload registerOnce channels are registered at most once in renderer.js', () => {
  const entries = findRegisterOnceEntries(preload);

  it('finds the known registerOnce channels (sanity: the parser actually works)', () => {
    assert.ok(entries.length >= 20, `only found ${entries.length} registerOnce channels in preload.js`);
    assert.ok(entries.some((e) => e.ns === 'chat' && e.prop === 'onMessageChunk'));
    assert.ok(entries.some((e) => e.ns === 'mesh' && e.prop === 'onReady'));
  });

  it('the three channels renderer.js registers twice are additive, not registerOnce', () => {
    const src = preload;
    assert.match(src, /onMessageStart: \(callback\) => registerAdditive\('chat:messageStart', callback\)/);
    assert.match(src, /onMessageComplete: \(callback\) => registerAdditive\('chat:messageComplete', callback\)/);
    assert.match(src, /onToolUse: \(callback\) => registerAdditive\('chat:toolUse', callback\)/);
  });

  for (const { ns, prop, channel } of entries) {
    it(`window.electron.${ns}.${prop} (${channel}) is registered at most once in renderer.js`, () => {
      const matches = renderer.match(new RegExp(`electron\\.${ns}\\.${prop}\\(`, 'g')) || [];
      assert.ok(
        matches.length <= 1,
        `${ns}.${prop} is a registerOnce channel in preload.js, but renderer.js registers it `
        + `${matches.length} times — every registration but the last is silently dropped`
      );
    });
  }
});
