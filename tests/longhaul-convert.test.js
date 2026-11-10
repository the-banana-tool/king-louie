'use strict';
// `longhaul convert` (benchmark spec §10.2): a downloaded public trajectory
// dataset into public constructed sessions.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { main } = require('../src/longhaul/cli');
const { loadSession, listSessions } = require('../src/longhaul/session-format');
const { tmpHome, tmpDir, sink } = require('./helpers/longhaul-helpers');

const FIXTURES = path.join(__dirname, 'fixtures', 'longhaul-converters');
const NEBIUS = path.join(FIXTURES, 'nebius-swe-rebench.jsonl');
const OPEN_JSONL = path.join(FIXTURES, 'open-swe-traces.jsonl');
const OPEN_PARQUET = path.join(FIXTURES, 'open-swe-traces.parquet');
const SMALL = ['--target-tokens', '400', '--min-tokens', '100'];
const OPEN = ['--source', 'open-swe-traces', '--config', 'v2.0', '--split', 'claudecode', ...SMALL];

async function run(argv, env) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, { stdout, stderr, env });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

async function sessions(root) {
  const out = [];
  for (const id of listSessions(root)) out.push(await loadSession(path.join(root, 'sessions', id)));
  return out;
}

describe('longhaul convert', () => {
  it('writes public constructed sessions from the rebench fixture', async () => {
    const { env, root } = tmpHome();
    const r = await run(['convert', '--source', 'nebius-swe-rebench', '--input', NEBIUS, ...SMALL], env);
    assert.equal(r.code, 0, r.stderr);
    const all = await sessions(root);
    assert.ok(all.length > 0);
    for (const s of all) {
      assert.equal(s.manifest.private, false);
      assert.equal(s.manifest.license, 'CC-BY-4.0');
      assert.equal(s.manifest.upstreamLicense, 'unknown-upstream');
      assert.equal(s.manifest.constructed, true);
      assert.equal(s.manifest.source, 'openhands');
      assert.match(s.manifest.sessionId, /^nr-/);
      assert.equal(s.manifest.sourceRef, 'nebius/SWE-rebench-openhands-trajectories nebius-swe-rebench.jsonl');
      assert.match(r.stdout, new RegExp(`converted ${s.manifest.sessionId}: ${s.manifest.repo} part ${s.manifest.part}, `));
    }
    assert.match(r.stdout, /CC-BY-4\.0, upstream unknown-upstream/);
    assert.match(r.stdout, /1 duplicate trajectories dropped/);
  });

  it('writes MIT upstream sessions from the Open-SWE fixture, naming the config and split', async () => {
    const { env, root } = tmpHome();
    const r = await run(['convert', ...OPEN, '--input', OPEN_JSONL], env);
    assert.equal(r.code, 0, r.stderr);
    const all = await sessions(root);
    assert.ok(all.length > 0);
    for (const s of all) {
      assert.equal(s.manifest.upstreamLicense, 'MIT');
      assert.equal(s.manifest.sourceRef, 'nvidia/Open-SWE-Traces:v2.0/claudecode open-swe-traces.jsonl');
      assert.match(s.manifest.sessionId, /^os-/);
    }
  });

  it('writes the same sessions from the parquet fixture as from its JSONL', async () => {
    const a = tmpHome();
    const b = tmpHome();
    assert.equal((await run(['convert', ...OPEN, '--input', OPEN_JSONL], a.env)).code, 0);
    const r = await run(['convert', ...OPEN, '--input', OPEN_PARQUET], b.env);
    assert.equal(r.code, 0, r.stderr);
    const fromJsonl = await sessions(a.root);
    const fromParquet = await sessions(b.root);
    assert.deepEqual(fromParquet.map((s) => s.manifest.sessionId), fromJsonl.map((s) => s.manifest.sessionId));
    for (let i = 0; i < fromJsonl.length; i++) {
      assert.deepEqual(fromParquet[i].messages, fromJsonl[i].messages);
      const strip = ({ sourceRef, sourceSha256, ...rest }) => rest;
      assert.deepEqual(strip(fromParquet[i].manifest), strip(fromJsonl[i].manifest));
      assert.match(fromParquet[i].manifest.sourceRef, /open-swe-traces\.parquet$/);
    }
  });

  it('needs --config and --split for open-swe-traces and refuses them for nebius-swe-rebench', async () => {
    const { env } = tmpHome();
    const missing = await run(['convert', '--source', 'open-swe-traces', '--input', OPEN_JSONL, '--split', 'claudecode'], env);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--config/);
    const extra = await run(['convert', '--source', 'nebius-swe-rebench', '--input', NEBIUS, '--config', 'v2.0'], env);
    assert.equal(extra.code, 2);
    const unknown = await run(['convert', '--source', 'nope', '--input', NEBIUS], env);
    assert.equal(unknown.code, 2);
  });

  it('reports every session unchanged on a second identical run', async () => {
    const { env, root } = tmpHome();
    const argv = ['convert', '--source', 'nebius-swe-rebench', '--input', NEBIUS, ...SMALL];
    assert.equal((await run(argv, env)).code, 0);
    const count = listSessions(root).length;
    const r = await run(argv, env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal((r.stdout.match(/^unchanged /gm) || []).length, count);
    assert.doesNotMatch(r.stdout, /^converted /m);
  });

  it('writes new ids for other flags, and refuses a changed input over an id until --force', async () => {
    const { env, root } = tmpHome();
    assert.equal((await run(['convert', '--source', 'nebius-swe-rebench', '--input', NEBIUS, ...SMALL], env)).code, 0);
    const first = listSessions(root);
    assert.equal((await run(['convert', '--source', 'nebius-swe-rebench', '--input', NEBIUS, '--target-tokens', '5000', '--min-tokens', '100'], env)).code, 0);
    const added = listSessions(root).filter((id) => !first.includes(id));
    assert.ok(added.length > 0);

    const dir = tmpDir();
    const changed = path.join(dir, 'nebius-swe-rebench.jsonl');
    fs.writeFileSync(changed, `${fs.readFileSync(NEBIUS, 'utf8')}\n`);
    const refused = await run(['convert', '--source', 'nebius-swe-rebench', '--input', changed, ...SMALL], env);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /--force/);
    const forced = await run(['convert', '--source', 'nebius-swe-rebench', '--input', changed, ...SMALL, '--force'], env);
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(forced.stdout, /^converted /m);
  });

  it('writes nothing on --dry-run and prints the plan', async () => {
    const { env, root } = tmpHome();
    const r = await run(['convert', '--source', 'nebius-swe-rebench', '--input', NEBIUS, ...SMALL, '--dry-run'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(listSessions(root), []);
    assert.equal(fs.readdirSync(path.join(root, 'sessions')).length, 0);
    assert.match(r.stdout, /example-org\/widget-kit/);
    assert.match(r.stdout, /would write nr-/);
  });

  it('lists a repository too short for --min-tokens', async () => {
    const { env } = tmpHome();
    const r = await run(['convert', '--source', 'nebius-swe-rebench', '--input', NEBIUS, '--target-tokens', '400', '--min-tokens', '500', '--dry-run'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /too short/);
  });

  it('refuses an input under LONGHAUL_HOME/private', async () => {
    const { env, root } = tmpHome();
    fs.mkdirSync(path.join(root, 'private'), { recursive: true });
    const inside = path.join(root, 'private', 'rows.jsonl');
    fs.copyFileSync(NEBIUS, inside);
    const r = await run(['convert', '--source', 'nebius-swe-rebench', '--input', inside, ...SMALL], env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /private/);
  });

  it('converts the other rows when one line is broken and counts it', async () => {
    const { env, root } = tmpHome();
    const dir = tmpDir();
    const file = path.join(dir, 'broken.jsonl');
    const lines = fs.readFileSync(NEBIUS, 'utf8').split('\n').filter(Boolean);
    lines.splice(2, 0, '{"repo": "example-org/widget-kit", "trajec');
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const r = await run(['convert', '--source', 'nebius-swe-rebench', '--input', file, ...SMALL], env);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(listSessions(root).length > 0);
    assert.match(r.stdout, /1 bad rows \(line 3\)/);

    const { convertDataset } = require('../src/longhaul/converting');
    const { resolveHome, ensureDirs } = require('../src/longhaul/home');
    const out = await convertDataset(ensureDirs(resolveHome(tmpHome().env)), {
      source: 'nebius-swe-rebench', input: file, targetTokens: 400, minTokens: 100, dryRun: true
    });
    assert.equal(out.badRows.length, 1);
    assert.equal(out.badRows[0].rowNo, 3);
  });

  it('does not plan a row with no task prompt, counts it and writes the rest', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'no-prompt.jsonl');
    const lines = fs.readFileSync(NEBIUS, 'utf8').split('\n').filter(Boolean);
    const first = JSON.parse(lines[0]);
    const assistantFirst = { ...first, instance_id: `${first.instance_id}-np`, trajectory: first.trajectory.filter((m) => m.role !== 'user') };
    assert.equal(assistantFirst.trajectory.find((m) => m.role !== 'system').role, 'assistant');
    const empty = { ...first, instance_id: `${first.instance_id}-empty`, trajectory: first.trajectory.filter((m) => m.role === 'system') };
    fs.writeFileSync(file, `${[...lines, JSON.stringify(assistantFirst), JSON.stringify(empty)].join('\n')}\n`);
    const n = lines.length;

    const dry = await run(['convert', '--source', 'nebius-swe-rebench', '--input', file, ...SMALL, '--dry-run'], tmpHome().env);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, new RegExp(`2 rows with no task prompt .*line ${n + 1}, line ${n + 2}`));

    const { env, root } = tmpHome();
    const r = await run(['convert', '--source', 'nebius-swe-rebench', '--input', file, ...SMALL], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /2 rows with no task prompt/);
    const all = await sessions(root);
    assert.ok(all.length > 0);
    for (const s of all) assert.ok(s.manifest.boundaries.every((b) => b.instanceId !== assistantFirst.instance_id));
  });

  it('refuses a session written by another converter version until --force, saying the converter changed', async () => {
    const { env, root } = tmpHome();
    const argv = ['convert', '--source', 'nebius-swe-rebench', '--input', NEBIUS, ...SMALL];
    assert.equal((await run(argv, env)).code, 0);
    const id = listSessions(root)[0];
    const file = path.join(root, 'sessions', id, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, `${JSON.stringify({ ...manifest, converter: { ...manifest.converter, version: 0 } }, null, 2)}\n`);
    const refused = await run(argv, env);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, new RegExp(`${id} was written by another converter version`));
    assert.match(refused.stderr, /converter changed/);
    const forced = await run([...argv, '--force'], env);
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(forced.stdout, new RegExp(`^converted ${id}:`, 'm'));
  });

  it('exits 1 when no row is usable', async () => {
    const { env } = tmpHome();
    const file = path.join(tmpDir(), 'bad.jsonl');
    fs.writeFileSync(file, '{"nope": 1}\nnot json\n');
    const r = await run(['convert', '--source', 'nebius-swe-rebench', '--input', file, ...SMALL], env);
    assert.equal(r.code, 1);
  });

  it('writes only the repository --repo names', async () => {
    const { env, root } = tmpHome();
    const r = await run(['convert', '--source', 'nebius-swe-rebench', '--input', NEBIUS, ...SMALL, '--repo', 'example-org/widget-kit'], env);
    assert.equal(r.code, 0, r.stderr);
    const all = await sessions(root);
    assert.ok(all.length > 0);
    for (const s of all) assert.equal(s.manifest.repo, 'example-org/widget-kit');
  });

  it('records no absolute path in any manifest', async () => {
    const { env, root } = tmpHome();
    assert.equal((await run(['convert', '--source', 'nebius-swe-rebench', '--input', NEBIUS, ...SMALL], env)).code, 0);
    assert.equal((await run(['convert', ...OPEN, '--input', OPEN_PARQUET], env)).code, 0);
    for (const id of listSessions(root)) {
      const text = fs.readFileSync(path.join(root, 'sessions', id, 'manifest.json'), 'utf8');
      assert.equal(text.includes(FIXTURES), false);
      assert.equal(text.includes(JSON.stringify(FIXTURES).slice(1, -1)), false);
      assert.equal(text.includes(root), false);
    }
  });
});
