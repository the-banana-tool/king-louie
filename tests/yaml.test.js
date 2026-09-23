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
});
