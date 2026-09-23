const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeConfig = require('../src/service/node-config');
const serviceConfig = require('../src/service/config');

const { loadNodeConfig } = nodeConfig;
const currentUid = process.getuid ? process.getuid() : 0;
const POSIX_ONLY = { skip: process.platform === 'win32' };

// A private admin dir holding node.yaml with the given contents, owned by
// the test's own uid — which the loader is told to treat as the admin.
function withNodeYaml(contents, fn, { fileMode = 0o600 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-config-test-'));
  try {
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
    const file = path.join(dir, 'node.yaml');
    fs.writeFileSync(file, contents, 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(file, fileMode);
    return fn(dir, file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function load(dir, opts = {}) {
  return loadNodeConfig({ adminConfigDir: dir, geteuid: () => currentUid, adminUid: currentUid, ...opts });
}

describe('node-config ownership check', () => {
  it('exports the check from both modules', () => {
    assert.equal(typeof serviceConfig.assertAdminOwned, 'function');
    // runbook-engine imports it from node-config, so it must stay exported there.
    assert.equal(typeof nodeConfig.assertAdminOwned, 'function');
  });

  it('refuses a group/world-writable node.yaml, worded for node policy', POSIX_ONLY, () => {
    withNodeYaml('name: n\n', (dir) => {
      assert.throws(() => load(dir), (err) => {
        assert.match(err.message, /group- or world-writable/);
        assert.match(err.message, /what this node may do/);
        assert.doesNotMatch(err.message, /network listeners/);
        return true;
      });
    }, { fileMode: 0o666 });
  });

  it('refuses a node.yaml owned by the service account', POSIX_ONLY, () => {
    withNodeYaml('name: n\n', (dir) => {
      // The file is ours; call ourselves the service account and someone else the admin.
      assert.throws(
        () => load(dir, { adminUid: currentUid + 1 }),
        /owned by the account running the service .*loosen its own node policy/
      );
    });
  });

  it('refuses a node.yaml owned by some other non-admin uid', POSIX_ONLY, () => {
    withNodeYaml('name: n\n', (dir) => {
      assert.throws(
        () => load(dir, { geteuid: () => currentUid + 2, adminUid: currentUid + 1 }),
        /not by root\/an administrator/
      );
    });
  });

  it('refuses when node.yaml is a symlink', POSIX_ONLY, () => {
    withNodeYaml('name: n\n', (dir, file) => {
      const real = path.join(dir, 'real.yaml');
      fs.renameSync(file, real);
      fs.symlinkSync(real, file);
      assert.throws(() => load(dir), /is a symlink/);
    });
  });

  it('checks a target that does not exist instead of skipping it', POSIX_ONLY, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-config-missing-'));
    try {
      fs.chmodSync(dir, 0o700);
      assert.throws(
        () => nodeConfig.assertAdminOwned(path.join(dir, 'absent.yaml'), () => currentUid, currentUid),
        /ENOENT/
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not exempt a world-writable /tmp-style parent', POSIX_ONLY, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-config-sticky-'));
    try {
      // Stands in for /tmp itself: world-writable with the sticky bit.
      fs.chmodSync(dir, 0o1777);
      const file = path.join(dir, 'node.yaml');
      fs.writeFileSync(file, 'name: n\n', 'utf8');
      fs.chmodSync(file, 0o600);
      assert.throws(() => load(dir), /group- or world-writable/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps service.json's listener wording by default", POSIX_ONLY, () => {
    withNodeYaml('{}', (dir, file) => {
      assert.throws(
        () => serviceConfig.assertAdminOwned(file, () => currentUid, currentUid),
        /which network listeners this service opens/
      );
    }, { fileMode: 0o666 });
  });
});

describe('node-config policy validation', () => {
  it('applies defaults for absent keys', () => {
    withNodeYaml('profile: agent\n', (dir) => {
      const cfg = load(dir);
      assert.equal(cfg.name, 'unnamed-node');
      assert.deepEqual(cfg.capabilities, []);
      assert.deepEqual(cfg.policy.allowed_roots, []);
      assert.equal(cfg.policy.max_concurrent_jobs, 2);
      assert.ok(cfg.policy.remote_sessions.always_confirm.includes('Bash(ssh *)'));
      assert.deepEqual(cfg.policy.remote_sessions.deny, ['Bash(rm -rf /*)']);
    });
  });

  it('accepts Windows paths in a block list of allowed_roots', () => {
    withNodeYaml(String.raw`
policy:
  allowed_roots:
    - 'D:\models'
    - C:\src
`, (dir) => {
      const cfg = load(dir);
      assert.deepEqual(cfg.policy.allowed_roots, [path.resolve(String.raw`D:\models`), path.resolve(String.raw`C:\src`)]);
    });
  });

  it('names the file when the YAML itself is malformed', () => {
    withNodeYaml('policy:\n  deny\n    - x\n  max_concurrent_jobs: 1\n', (dir, file) => {
      assert.throws(() => load(dir), (err) => err.message.startsWith(`Invalid ${file}:`));
    });
  });

  const rejected = [
    ['max_concurrent_jobs of zero', 'policy:\n  max_concurrent_jobs: 0\n', /policy\.max_concurrent_jobs must be a positive integer/],
    ['negative max_concurrent_jobs', 'policy:\n  max_concurrent_jobs: -3\n', /policy\.max_concurrent_jobs must be a positive integer/],
    ['fractional max_concurrent_jobs', 'policy:\n  max_concurrent_jobs: 1.5\n', /policy\.max_concurrent_jobs must be a positive integer/],
    ['string max_concurrent_jobs', "policy:\n  max_concurrent_jobs: 'four'\n", /policy\.max_concurrent_jobs must be a positive integer/],
    ['allowed_roots as a scalar', 'policy:\n  allowed_roots: /srv\n', /policy\.allowed_roots must be a list of non-empty strings/],
    ['allowed_roots with an empty entry', "policy:\n  allowed_roots: ['/srv', '']\n", /policy\.allowed_roots must be a list of non-empty strings/],
    ['allowed_roots with a mapping entry', 'policy:\n  allowed_roots:\n    - D: models\n', /policy\.allowed_roots must be a list of non-empty strings/],
    ['always_confirm as a scalar', "policy:\n  remote_sessions:\n    always_confirm: 'Bash(ssh *)'\n", /always_confirm must be a list of strings/],
    ['deny as a scalar', "policy:\n  remote_sessions:\n    deny: 'Bash(rm *)'\n", /deny must be a list of strings/],
    ['deny with a non-string entry', 'policy:\n  remote_sessions:\n    deny: [1, 2]\n', /deny must be a list of strings/],
    ['capabilities as a scalar', 'capabilities: gpu\n', /capabilities must be a list/],
    ['an empty name', "name: '  '\n", /name must be a non-empty string/],
    ['a numeric name', 'name: 42\n', /name must be a non-empty string/],
    ['policy as a list', 'policy: [a]\n', /policy must be a mapping/]
  ];
  for (const [label, yaml, pattern] of rejected) {
    it(`rejects ${label}`, () => {
      withNodeYaml(yaml, (dir, file) => {
        assert.throws(() => load(dir), (err) => {
          assert.ok(err.message.startsWith(`Invalid ${file}:`), err.message);
          assert.match(err.message, pattern);
          return true;
        });
      });
    });
  }
});
