'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { CONVERTERS } = require('../src/longhaul/converters');

const FIXTURES = path.join(__dirname, 'fixtures', 'longhaul-converters');

function readRows(file) {
  return fs.readFileSync(path.join(FIXTURES, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('converter registry', () => {
  it('holds both datasets with their fixed fields', () => {
    assert.deepEqual(Object.keys(CONVERTERS).sort(), ['nebius-swe-rebench', 'open-swe-traces']);
    const nr = CONVERTERS['nebius-swe-rebench'];
    assert.equal(nr.id, 'nebius-swe-rebench');
    assert.equal(nr.source, 'openhands');
    assert.equal(nr.prefix, 'nr-');
    assert.equal(nr.datasetId, 'nebius/SWE-rebench-openhands-trajectories');
    assert.equal(nr.license, 'CC-BY-4.0');
    assert.equal(nr.needsConfig, false);
    const os = CONVERTERS['open-swe-traces'];
    assert.equal(os.id, 'open-swe-traces');
    assert.equal(os.source, 'open-swe-traces');
    assert.equal(os.prefix, 'os-');
    assert.equal(os.datasetId, 'nvidia/Open-SWE-Traces');
    assert.equal(os.license, 'CC-BY-4.0');
    assert.equal(os.needsConfig, true);
  });
});

describe('nebius-swe-rebench', () => {
  const conv = CONVERTERS['nebius-swe-rebench'];
  const rows = readRows('nebius-swe-rebench.jsonl');

  it('describes each fixture row by repo, instance and trajectory, with no upstream license', () => {
    const described = rows.map((row) => conv.describe(row));
    assert.deepEqual([...new Set(described.map((d) => d.repo))].sort(), ['example-org/parse-lane', 'example-org/widget-kit']);
    for (const [i, d] of described.entries()) {
      assert.equal(d.instanceId, rows[i].instance_id);
      assert.equal(d.trajectoryId, rows[i].trajectory_id);
      assert.equal(d.upstreamLicense, null);
    }
    const perInstance = new Map();
    for (const d of described) perInstance.set(d.instanceId, (perInstance.get(d.instanceId) || 0) + 1);
    assert.ok([...perInstance.values()].includes(2), 'one instance has two trajectories');
    for (const repo of ['example-org/parse-lane', 'example-org/widget-kit']) {
      const n = new Set(described.filter((d) => d.repo === repo).map((d) => d.instanceId)).size;
      assert.ok(n >= 3 && n <= 5, `${repo} has ${n} instances`);
    }
  });

  it('maps the first row with a user task prompt first and no system message', () => {
    const { messages, stats } = conv.toMessages(rows[0]);
    assert.equal(messages[0].sender, 'user');
    assert.equal(messages.filter((m) => m.sender === 'user').length, 1);
    assert.ok(!messages.some((m) => m.sender === 'system'));
    assert.equal(stats.skipped.system, 1);
    const results = messages.filter((m) => m.sender === 'toolResult');
    assert.ok(results.length > 0);
    assert.ok(results.every((m) => m.toolName !== 'unknown'));
    assert.equal(stats.unpaired, 0);
  });

  it('refuses a row with no repo or no trajectory', () => {
    const { repo, ...noRepo } = rows[0];
    assert.throws(() => conv.describe(noRepo), { code: 'CONVERT_ROW', message: /no repo/ });
    const { trajectory, ...noTrajectory } = rows[0];
    assert.throws(() => conv.describe(noTrajectory), { code: 'CONVERT_ROW', message: /no trajectory/ });
  });
});

describe('open-swe-traces', () => {
  const conv = CONVERTERS['open-swe-traces'];
  const rows = readRows('open-swe-traces.jsonl');

  it('describes each fixture row and carries the row license as upstreamLicense', () => {
    const described = rows.map((row) => conv.describe(row));
    assert.deepEqual([...new Set(described.map((d) => d.repo))].sort(), ['example-org/ledger-tool', 'example-org/widget-kit']);
    for (const [i, d] of described.entries()) {
      assert.equal(d.instanceId, rows[i].instance_id);
      assert.equal(d.trajectoryId, rows[i].trajectory_id);
      assert.equal(d.upstreamLicense, 'MIT');
    }
    const ids = described.map((d) => d.instanceId);
    assert.ok(ids.some((id, i) => ids.indexOf(id) !== i), 'one instance has two trajectories');
  });

  it('maps the first row: user first, no system, the two calls paired by order', () => {
    const { messages, stats } = conv.toMessages(rows[0]);
    assert.equal(messages[0].sender, 'user');
    assert.ok(!messages.some((m) => m.sender === 'system'));
    assert.equal(stats.unpaired, 0);
    assert.ok(stats.reasoningChars > 0);
    const seq = messages.map((m) => (m.toolName ? `${m.sender}:${m.toolName}` : m.sender));
    const start = seq.indexOf('toolUse:Read');
    assert.deepEqual(seq.slice(start, start + 4), ['toolUse:Read', 'toolUse:Bash', 'toolResult:Read', 'toolResult:Bash']);
  });

  it('refuses a row with no repo or no messages', () => {
    const { repo, ...noRepo } = rows[0];
    assert.throws(() => conv.describe(noRepo), { code: 'CONVERT_ROW', message: /no repo/ });
    const { messages, ...noMessages } = rows[0];
    assert.throws(() => conv.describe(noMessages), { code: 'CONVERT_ROW', message: /no messages/ });
  });

  it('a row with no license says null', () => {
    const { license, ...rest } = rows[0];
    assert.equal(conv.describe(rest).upstreamLicense, null);
  });
});
