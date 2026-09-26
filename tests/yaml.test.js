const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseYaml } = require('../src/platform/yaml');

describe('YAML Parser', () => {
  it('parses node.yaml structure correctly', () => {
    const yaml = `
name: gpu-box
profile: agent
front_door: https://kl.example.com
capabilities: [gpu, cuda, large-disk]
policy:
  allowed_roots: ['D:\\models', 'D:\\datasets', 'C:\\Users\\me\\src']
  remote_sessions:
    always_confirm:
      - 'Bash(ssh *)'
      - 'Bash(scp *)'
      - 'Vault(*)'
    deny:
      - 'Bash(rm -rf /*)'
  max_concurrent_jobs: 2
runbooks_dir: runbooks/
`;
    const parsed = parseYaml(yaml);
    assert.equal(parsed.name, 'gpu-box');
    assert.equal(parsed.profile, 'agent');
    assert.equal(parsed.front_door, 'https://kl.example.com');
    assert.deepEqual(parsed.capabilities, ['gpu', 'cuda', 'large-disk']);
    assert.equal(parsed.policy.max_concurrent_jobs, 2);
    assert.deepEqual(parsed.policy.remote_sessions.always_confirm, [
      'Bash(ssh *)', 'Bash(scp *)', 'Vault(*)'
    ]);
    assert.deepEqual(parsed.policy.remote_sessions.deny, ['Bash(rm -rf /*)']);
    assert.equal(parsed.runbooks_dir, 'runbooks/');
  });

  it('parses runbook YAML structure correctly', () => {
    const yaml = `
name: site.pull_and_restart
description: Fetch ref and restart site
tier: unsafe
params:
  ref:
    type: string
    pattern: '^[A-Za-z0-9._/-]{1,64}$'
    default: main
steps:
  - run: [git, -C, /srv/site, fetch, --prune, origin]
  - run: [git, -C, /srv/site, checkout, --detach, 'origin/{{ref}}']
  - check: { http_get: 'https://www.example.com/healthz', expect_status: 200, retries: 5 }
timeout_s: 600
rate_limit: { max: 6, per: 1h }
`;
    const parsed = parseYaml(yaml);
    assert.equal(parsed.name, 'site.pull_and_restart');
    assert.equal(parsed.tier, 'unsafe');
    assert.equal(parsed.params.ref.type, 'string');
    assert.equal(parsed.params.ref.pattern, '^[A-Za-z0-9._/-]{1,64}$');
    assert.equal(parsed.steps.length, 3);
    assert.deepEqual(parsed.steps[0].run, ['git', '-C', '/srv/site', 'fetch', '--prune', 'origin']);
    assert.equal(parsed.steps[2].check.expect_status, 200);
    assert.equal(parsed.timeout_s, 600);
    assert.equal(parsed.rate_limit.max, 6);
  });

  // The cases below are ones the old hand-rolled parser got silently wrong.
  // String.raw keeps the backslashes exactly as they would appear in the file.

  it('keeps Windows paths in a block list as strings', () => {
    const parsed = parseYaml(String.raw`
allowed_roots:
  - 'D:\models'
  - C:\src
`);
    assert.deepEqual(parsed.allowed_roots, [String.raw`D:\models`, String.raw`C:\src`]);
  });

  it('keeps a single-quoted UNC path intact', () => {
    const parsed = parseYaml(String.raw`root: '\\server\share'`);
    assert.equal(parsed.root, String.raw`\\server\share`);
  });

  it('throws on a line it cannot parse instead of dropping it', () => {
    const yaml = `
policy:
  deny
    - x
  max_concurrent_jobs: 1
`;
    assert.throws(() => parseYaml(yaml), { name: 'YAMLException' });
  });

  it('rejects duplicate keys', () => {
    assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicated mapping key/);
  });

  it('supports folded scalars', () => {
    const parsed = parseYaml(`
description: >
  Fetch the ref
  and restart the site
tier: routine
`);
    assert.equal(parsed.description, 'Fetch the ref and restart the site\n');
    assert.equal(parsed.tier, 'routine');
  });

  it('keeps # inside an unquoted URL and strips a real comment', () => {
    const parsed = parseYaml(`
front_door: https://kl.example.com/app#main
tier: routine # trailing comment
`);
    assert.equal(parsed.front_door, 'https://kl.example.com/app#main');
    assert.equal(parsed.tier, 'routine');
  });

  it('does not construct JS types or custom tags', () => {
    assert.throws(() => parseYaml('f: !!js/function "function () {}"\n'), { name: 'YAMLException' });
    // The core schema leaves timestamps as strings rather than Date objects.
    assert.equal(parseYaml('when: 2026-09-21\n').when, '2026-09-21');
  });

  it('refuses a block-style anchor or alias, but not "&"/"*" inside a plain or quoted scalar', () => {
    assert.throws(() => parseYaml('a: &x [1, 2]\n'), { code: 'YAML_ALIAS_NOT_ALLOWED' });
    assert.throws(() => parseYaml('a: &x [1, 2]\nb: *x\n'), { code: 'YAML_ALIAS_NOT_ALLOWED' });
    // A merge key is just an alias by another name (<<: *anchor): the
    // anchor it references is refused at its own definition, well before
    // the merge would ever resolve it.
    assert.throws(() => parseYaml('base: &base { x: 1 }\n<<: *base\n'), { code: 'YAML_ALIAS_NOT_ALLOWED' });
    assert.throws(() => parseYaml('a: &x 1\nitems: [*x, *x]\n'), { code: 'YAML_ALIAS_NOT_ALLOWED' });
    // Ordinary content, not structure: left alone.
    assert.equal(parseYaml('description: Fish & Chips\n').description, 'Fish & Chips');
    assert.equal(parseYaml('note: 5 * 3 = 15\n').note, '5 * 3 = 15');
    assert.equal(parseYaml("allow: ['Bash(*deploy*)']\n").allow[0], 'Bash(*deploy*)');
  });

  it('refuses a flow-style anchor/alias and a document-level anchor (the old text scanner missed both)', () => {
    assert.throws(() => parseYaml('{"a": &x [1, 2], "b": *x}\n'), { code: 'YAML_ALIAS_NOT_ALLOWED' });
    assert.throws(() => parseYaml('--- &x [1, 2]\n'), { code: 'YAML_ALIAS_NOT_ALLOWED' });
  });

  it('parses a block scalar containing lines that start with "*" or "&" (the old text scanner refused these)', () => {
    // A runbook script line and a markdown bullet/ampersand line, inside
    // `|`/`>` block scalars: none of this is YAML structure, so none of it
    // should ever be checked for an anchor or alias.
    const cron = parseYaml('run: |\n  0 * * * * root /usr/bin/foo\n  echo &background &\n');
    assert.equal(cron.run, '0 * * * * root /usr/bin/foo\necho &background &\n');
    const bullets = parseYaml('description: |\n  * bullet one\n  * bullet two\n  & co\n');
    assert.equal(bullets.description, '* bullet one\n* bullet two\n& co\n');
  });

  it('refuses a nested-alias bomb quickly instead of building it', () => {
    // A classic "billion laughs" shape: each anchor aliases the previous
    // one 8 times, so resolving (or later stringifying) it would build an
    // enormous structure. This must be refused before any of that work,
    // so the whole check has to finish well under a second.
    const lines = ['a0: &a0 [x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 12; i += 1) {
      lines.push(`a${i}: &a${i} [*a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}]`);
    }
    const bomb = lines.join('\n');
    assert.ok(bomb.length < 2048, 'the source itself stays small');
    const start = Date.now();
    assert.throws(() => parseYaml(bomb), { code: 'YAML_ALIAS_NOT_ALLOWED' });
    assert.ok(Date.now() - start < 1000, 'refusal must be fast, not proportional to the expanded size');
  });

  it('refuses a flow-style (map-alias) bomb quickly, an ~850-byte source that would otherwise expand hugely', () => {
    const lines = ['a0: &a0 {x: 1, y: 2}'];
    for (let i = 1; i < 8; i += 1) {
      lines.push(`a${i}: &a${i} {p: *a${i - 1}, q: *a${i - 1}}`);
    }
    const bomb = lines.join('\n');
    assert.ok(bomb.length < 1024, 'the source itself stays small');
    const start = Date.now();
    assert.throws(() => parseYaml(bomb), { code: 'YAML_ALIAS_NOT_ALLOWED' });
    assert.ok(Date.now() - start < 1000, 'refusal must be fast, not proportional to the expanded size');
  });
});
