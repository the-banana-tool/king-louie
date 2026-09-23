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
});
