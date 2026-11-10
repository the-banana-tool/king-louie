'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { CONVERTERS } = require('../src/longhaul/converters');
const { planSessions, assembleSession, sessionIdFor } = require('../src/longhaul/converters/construct');
const { validateMessages, validateManifest, SESSION_ID_RE } = require('../src/longhaul/session-format');

const FIXTURES = path.join(__dirname, 'fixtures', 'longhaul-converters');

function readRows(file) {
  return fs.readFileSync(path.join(FIXTURES, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function entry(lineNo, repo, instanceId, estTokens, extra = {}) {
  return { lineNo, repo, instanceId, trajectoryId: `t-${lineNo}`, upstreamLicense: null, estTokens, ...extra };
}

const BASE = { targetTokens: 100, minTokens: 50, maxSessions: 12, seed: 1 };

function sampleEntries() {
  return [
    entry(1, 'example-org/alpha', 'a-1', 60),
    entry(2, 'example-org/alpha', 'a-2', 45),
    entry(3, 'example-org/alpha', 'a-3', 70),
    entry(4, 'example-org/alpha', 'a-2', 40, { trajectoryId: 't-0' }),
    entry(5, 'example-org/beta', 'b-1', 30)
  ];
}

describe('planSessions', () => {
  it('fills one repository into parts and lists the too-short one', () => {
    const plan = planSessions(sampleEntries(), BASE);
    assert.equal(plan.duplicatesDropped, 1);
    const alpha = plan.sessions.filter((s) => s.repo === 'example-org/alpha');
    assert.equal(alpha.length, 2);
    assert.deepEqual(alpha.map((s) => s.part), [1, 2]);
    // a-2's first trajectory by trajectoryId is t-0 (line 4), so line 2 is dropped.
    assert.deepEqual(alpha[0].lineNos, [1, 4]);
    assert.equal(alpha[0].estTokens, 100);
    assert.deepEqual(alpha[1].lineNos, [3]);
    assert.equal(alpha[1].estTokens, 70);
    assert.ok(plan.sessions.every((s) => s.repo !== 'example-org/beta'));
    assert.deepEqual(plan.tooShort, [{ repo: 'example-org/beta', estTokens: 30 }]);
  });

  it('puts a trajectory larger than the target alone in one part', () => {
    const plan = planSessions([entry(1, 'example-org/alpha', 'a-1', 250), entry(2, 'example-org/alpha', 'a-2', 60)], BASE);
    assert.deepEqual(plan.sessions.map((s) => [s.lineNos, s.estTokens]), [[[1], 250], [[2], 60]]);
  });

  it('closes a part before it passes the target', () => {
    const plan = planSessions([
      entry(1, 'example-org/alpha', 'a-1', 60),
      entry(2, 'example-org/alpha', 'a-2', 40),
      entry(3, 'example-org/alpha', 'a-3', 70)
    ], BASE);
    assert.deepEqual(plan.sessions.map((s) => [s.lineNos, s.estTokens]), [[[1, 2], 100], [[3], 70]]);
  });

  it('orders repositories by the seed, the same seed the same order', () => {
    const many = [];
    for (let r = 0; r < 8; r++) many.push(entry(r + 1, `example-org/repo-${r}`, `i-${r}`, 80));
    const order = (seed) => planSessions(many, { ...BASE, seed }).sessions.map((s) => s.repo);
    assert.deepEqual(order(1), order(1));
    const seeds = [2, 3, 4, 5, 6];
    assert.ok(seeds.some((s) => JSON.stringify(order(s)) !== JSON.stringify(order(1))));
    assert.deepEqual([...order(1)].sort(), many.map((e) => e.repo).sort());
  });

  it('stops at maxSessions', () => {
    const plan = planSessions(sampleEntries(), { ...BASE, maxSessions: 1 });
    assert.equal(plan.sessions.length, 1);
  });

  it('keeps one repository when asked', () => {
    const plan = planSessions(sampleEntries(), { ...BASE, minTokens: 10, repo: 'example-org/beta' });
    assert.deepEqual(plan.sessions.map((s) => s.repo), ['example-org/beta']);
  });

  it('says what upstream license a part has', () => {
    const lic = (a, b) => planSessions([
      entry(1, 'example-org/alpha', 'a-1', 30, { upstreamLicense: a }),
      entry(2, 'example-org/alpha', 'a-2', 30, { upstreamLicense: b })
    ], BASE).sessions[0].upstreamLicense;
    assert.equal(lic('MIT', 'MIT'), 'MIT');
    assert.equal(lic('MIT', 'Apache-2.0'), 'NOASSERTION');
    assert.equal(lic('MIT', null), 'NOASSERTION');
    assert.equal(lic(null, null), 'unknown-upstream');
  });
});

describe('assembleSession', () => {
  for (const [id, file] of [['nebius-swe-rebench', 'nebius-swe-rebench.jsonl'], ['open-swe-traces', 'open-swe-traces.jsonl']]) {
    it(`joins two ${id} rows into a valid constructed session`, () => {
      const converter = CONVERTERS[id];
      const rows = readRows(file).slice(0, 2);
      const sessionId = sessionIdFor(converter, { repo: rows[0].repo, part: 1, config: null, split: null, targetTokens: 100, minTokens: 50 });
      const { manifest, messages } = assembleSession({
        converter, rows, repo: rows[0].repo, part: 1, sessionId,
        sourceRef: `${converter.datasetId} ${file}`, sourceSha256: 'abc', options: { targetTokens: 100 }
      });
      assert.deepEqual(validateMessages(messages), []);
      assert.deepEqual(validateManifest(manifest, messages), []);
      assert.equal(manifest.constructed, true);
      assert.equal(manifest.private, false);
      assert.equal(manifest.license, 'CC-BY-4.0');
      assert.equal(manifest.timestampsSynthetic, true);
      assert.deepEqual(manifest.converter, { id, version: 1 });
      assert.equal(manifest.repo, rows[0].repo);
      assert.equal(manifest.part, 1);
      assert.equal(manifest.upstreamLicense, id === 'open-swe-traces' ? 'MIT' : 'unknown-upstream');
      const k = converter.toMessages(rows[0]).messages.length;
      assert.equal(manifest.boundaries.length, 2);
      assert.deepEqual(manifest.boundaries.map((b) => [b.fromSeq, b.toSeq]), [[1, k], [k + 1, messages.length]]);
      assert.equal(manifest.boundaries[0].instanceId, converter.describe(rows[0]).instanceId);
      assert.equal(manifest.boundaries[1].trajectoryId, converter.describe(rows[1]).trajectoryId);
      for (const b of manifest.boundaries) assert.equal(messages[b.fromSeq - 1].sender, 'user');
      assert.equal(messages[0].id, 'm-1');
      assert.equal(messages[0].timestamp, '2000-01-01T00:00:00.000Z');
      assert.equal(messages[2].timestamp, '2000-01-01T00:00:02.000Z');
      assert.equal(messages.some((m) => m.sender === 'system'), false);
    });
  }
});

describe('sessionIdFor', () => {
  it('derives an id that matches SESSION_ID_RE and follows the sizes', () => {
    const converter = CONVERTERS['open-swe-traces'];
    const args = { repo: 'example-org/widget-kit', part: 2, config: 'v2.0', split: 'claudecode', targetTokens: 500000, minTokens: 250000 };
    const id = sessionIdFor(converter, args);
    assert.match(id, SESSION_ID_RE);
    assert.match(id, /^os-[0-9a-f]{12}-2$/);
    assert.equal(sessionIdFor(converter, args), id);
    assert.notEqual(sessionIdFor(converter, { ...args, targetTokens: 400000 }), id);
  });
});
