// tests/examples.test.js
// Every file under examples/ is loaded here by the real loaders, so an
// example that drifts from the code fails `npm test` instead of an owner's
// install. Later fleet stages append their own keys to ROLE_RUNBOOKS and the
// expectations below (program §5).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseYaml } = require('../src/platform/yaml');
const { loadNodeConfig, NODE_YAML_KEYS } = require('../src/service/node-config');
const { loadServiceConfig, DEFAULT_FEATURES, DEFAULT_PORTS } = require('../src/service/config');
const { RunbookEngine } = require('../src/runbooks/runbook-engine');
const { isPathUnderRoots } = require('../src/platform/path-roots');
const { windowsPowerShellExe } = require('../src/platform/windows-paths');
const { ALLOWED_HOSTS, scanForPersonalValues } = require('./helpers/example-denylist');

const ROOT = path.join(__dirname, '..');
const EXAMPLES = path.join(ROOT, 'examples');
const RUNBOOKS = path.join(EXAMPLES, 'runbooks');
const GUIDE = path.join(ROOT, 'docs', 'install-guide.md');
const EUID = typeof process.geteuid === 'function' ? process.geteuid() : 0;
const POSIX = process.platform !== 'win32';

const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-examples-'));
  temps.push(d);
  return d;
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out.sort();
}

// Copies `files` into `dir` the way an admin installs them: the dir and its
// parent 0755, each file 0644, owned by the test's uid, which the loaders are
// told is the administrator (adminOpts).
function installInto(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  if (POSIX) {
    fs.chmodSync(path.dirname(dir), 0o755);
    fs.chmodSync(dir, 0o755);
  }
  for (const src of files) {
    const dest = path.join(dir, path.basename(src));
    fs.copyFileSync(src, dest);
    if (POSIX) fs.chmodSync(dest, 0o644);
  }
}

const runbookFiles = () => (fs.existsSync(RUNBOOKS)
  ? fs.readdirSync(RUNBOOKS).filter((f) => f.endsWith('.yaml')).sort()
  : []);
const adminOpts = { geteuid: () => EUID, adminUid: EUID };

describe('personal-value denylist', () => {
  const mustFail = [
    'evil-example.com',
    'example.com.evil.net',
    'someone@mail.test',
    '10.1.2.3',
    '/home/alice/',
    'C:\\Users\\bob\\',
    '+442071234567',
    'C:\\Users\\bob for details',
    '/home/alice for',
    '/Users/alice.',
    '212-555-0250',
    '(212) 555-0250',
    '+1-212-555-0250'
  ];
  const mustPass = [
    'example.com',
    'kl.example.com',
    'mcp.kl.example.com',
    '192.0.2.10',
    '+15550100',
    '/home/<user>/',
    'git@github.com',
    '212.555.0199',
    'released 2024-05-01, version 1.12.0, port 8080'
  ];
  for (const text of mustFail) {
    it(`flags ${text}`, () => {
      assert.notDeepEqual(scanForPersonalValues(text), [], text);
    });
  }
  for (const text of mustPass) {
    it(`accepts ${text}`, () => {
      assert.deepEqual(scanForPersonalValues(text), []);
    });
  }

  it('also flags a URL to an unlisted host and an off-range phone number', () => {
    assert.deepEqual(scanForPersonalValues('see https://files.example.net/x').map((f) => f.kind).sort(), ['host', 'url-host']);
    assert.deepEqual(scanForPersonalValues('call +15550200').map((f) => f.kind), ['phone']);
  });

  it('does not mistake file names for hosts', () => {
    assert.deepEqual(scanForPersonalValues('node.yaml service.json train.py hf.exe README.md examples.test.js site.service'), []);
  });

  it('allows exactly the hosts the spec lists', () => {
    assert.deepEqual([...ALLOWED_HOSTS], [
      'example.com', 'localhost', '127.0.0.1', 'huggingface.co', 'nodejs.org', 'git-scm.com',
      'www.python.org', 'python.org', 'claude.ai', 'code.claude.com', 'docs.anthropic.com',
      'www.sudo.ws', 'learn.microsoft.com', 'github.com'
    ]);
    assert.ok(Object.isFrozen(ALLOWED_HOSTS));
  });

  it('finds nothing personal in examples/ or the install guide', () => {
    const files = [...listFiles(EXAMPLES), GUIDE].filter((f) => fs.existsSync(f));
    const problems = [];
    for (const file of files) {
      for (const finding of scanForPersonalValues(fs.readFileSync(file, 'utf8'))) {
        problems.push(`${path.relative(ROOT, file)}: ${finding.kind} ${finding.value}`);
      }
    }
    assert.deepEqual(problems, []);
  });
});

const REF_PATTERN = String.raw`^(main|release/[A-Za-z0-9][A-Za-z0-9._-]{0,39}|v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})$`;
const FOLDER_NAME = String.raw`^(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][0-9]|[Ll][Pp][Tt][0-9])$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`;
const STRING_PATTERNS = {
  'site.status': {},
  'site.pull_and_restart': { ref: REF_PATTERN },
  'server.reboot': {},
  'models.hf_download': {
    repo: String.raw`^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$`,
    revision: String.raw`^(main|[0-9a-f]{40}|v[0-9]{1,4}(\.[0-9]{1,4}){0,2})$`,
    dest: FOLDER_NAME
  },
  'train.run': { config: FOLDER_NAME },
  'laptop.build_then_deploy': { ref: REF_PATTERN }
};
const VALID_PARAMS = {
  'site.status': {},
  'site.pull_and_restart': { ref: 'release/2.1' },
  'server.reboot': {},
  'models.hf_download': { repo: 'example-org/example-model', revision: 'v1.2', dest: 'example' },
  'train.run': { config: 'base' },
  'laptop.build_then_deploy': { ref: 'v1.2.3' }
};
const HOSTILE_VALUES = [
  'x;id', '$(id)', '`id`', '../x', 'a\u2215b', 'a\uFF0Fb', 'a\u0000b', '-oProxyCommand=x',
  'main\n', 'a b', '', 'a'.repeat(200), '\uFF4D\uFF41\uFF49\uFF4E', 'CON', 'nul'
];

// All six runbooks in one admin-owned dir, loaded by the real engine.
function loadAllRunbooks() {
  const dir = path.join(tmp(), 'config', 'runbooks');
  installInto(dir, runbookFiles().map((f) => path.join(RUNBOOKS, f)));
  const engine = new RunbookEngine({ runbooksDir: dir, allowedRoots: [], ...adminOpts });
  engine.loadRunbooks();
  return engine;
}

describe('example runbooks: shape', () => {
  it('ships exactly the six runbooks of spec §3.3, and the engine loads them all', () => {
    assert.deepEqual(runbookFiles(), Object.keys(STRING_PATTERNS).map((n) => `${n}.yaml`).sort());
    assert.equal(loadAllRunbooks().runbooks.size, 6);
  });

  for (const name of Object.keys(STRING_PATTERNS)) {
    it(`${name}: absolute programs, anchored patterns, no path params, rate limited`, () => {
      const rb = parseYaml(fs.readFileSync(path.join(RUNBOOKS, `${name}.yaml`), 'utf8'));
      assert.equal(rb.name, name);
      assert.ok(rb.rate_limit && Number.isInteger(rb.rate_limit.max) && rb.rate_limit.max > 0, 'rate_limit');
      rb.steps.forEach((step, i) => {
        assert.equal(('run' in step) + ('check' in step), 1, `step ${i + 1} must be exactly one of run or check`);
        if (!step.run) return;
        const argv0 = step.run[0];
        assert.ok(path.win32.isAbsolute(argv0) || path.posix.isAbsolute(argv0), `step ${i + 1}: ${argv0} is not absolute`);
        assert.ok(!argv0.includes('{{'), `step ${i + 1}: the program is a parameter`);
      });
      const patterns = {};
      for (const [pName, p] of Object.entries(rb.params || {})) {
        assert.notEqual(p.type, 'path', `${pName}: examples use no path params (spec D3)`);
        if (p.type !== 'string') continue;
        assert.ok(p.pattern.startsWith('^') && p.pattern.endsWith('$'), `${pName} pattern is not anchored`);
        assert.equal(new RegExp(p.pattern).test('-x'), false, `${pName} accepts a leading "-"`);
        patterns[pName] = p.pattern;
      }
      assert.deepEqual(patterns, STRING_PATTERNS[name]);
    });
  }

  it('train.run passes nothing under a runner-writable root to the training script', () => {
    const rb = parseYaml(fs.readFileSync(path.join(RUNBOOKS, 'train.run.yaml'), 'utf8'));
    for (const step of rb.steps.filter((s) => s.run)) {
      for (const arg of step.run) {
        for (const root of ['D:\\models', 'D:\\datasets', 'D:\\ML Data']) {
          assert.ok(!arg.startsWith(root), `${arg} starts with ${root}`);
        }
      }
    }
  });

  it('laptop.build_then_deploy keeps the stage-4 hook commented out under its marker', () => {
    const lines = fs.readFileSync(path.join(RUNBOOKS, 'laptop.build_then_deploy.yaml'), 'utf8').split(/\r?\n/);
    const marker = lines.indexOf('  # ---- stage-4 hook (fleet stage 4 adds a cross-node step kind) ----');
    assert.notEqual(marker, -1, 'marker line missing');
    assert.ok(
      lines.slice(marker + 1).some((l) => l === "  # - call: { machine: web-01, runbook: site.pull_and_restart, params: { ref: '{{ref}}' } }"),
      'commented call step missing'
    );
    assert.ok(!lines.some((l) => /^\s*-\s*call:/.test(l)), 'no live call: step until fleet stage 4');
  });

  it('train.py is a stdlib-only stand-in that writes only under D:\\train\\runs', () => {
    const text = fs.readFileSync(path.join(EXAMPLES, 'scripts', 'train.py'), 'utf8');
    const imports = [...text.matchAll(/^(?:import|from) (\w+)/gm)].map((m) => m[1]).sort();
    assert.deepEqual(imports, ['argparse', 'json', 'pathlib', 're', 'sys', 'time']);
    assert.ok(text.includes('RUNS_ROOT = pathlib.Path(r"D:\\train\\runs")'));
    assert.ok(!/getcwd|chdir|import pickle|torch/.test(text));
  });
});

describe('example runbooks: parameter injection', () => {
  const engine = fs.existsSync(RUNBOOKS) ? loadAllRunbooks() : null;
  for (const [name, patterns] of Object.entries(STRING_PATTERNS)) {
    for (const [pName, pattern] of Object.entries(patterns)) {
      const hostile = pattern === FOLDER_NAME ? [...HOSTILE_VALUES, 'a.b'] : HOSTILE_VALUES;
      it(`${name}.${pName} rejects every hostile value`, () => {
        for (const bad of hostile) {
          assert.throws(
            () => engine.validateParameters(name, { ...VALID_PARAMS[name], [pName]: bad }),
            (err) => err.code === 'invalid_params' && err.message.startsWith(`Parameter "${pName}"`),
            `${JSON.stringify(bad)} was accepted`
          );
        }
      });
      it(`${name}.${pName} accepts a valid sample and its default`, () => {
        assert.equal(engine.validateParameters(name, VALID_PARAMS[name])[pName], VALID_PARAMS[name][pName]);
        const def = engine.getRunbook(name).params[pName].default;
        if (def !== undefined) {
          const { [pName]: _omitted, ...rest } = VALID_PARAMS[name];
          assert.equal(engine.validateParameters(name, rest)[pName], def);
        }
      });
    }
  }
});

// Spec §3.1.1: which runbooks each role installs, and their tiers.
const ROLE_RUNBOOKS = {
  'gpu-box': { profile: 'agent', runbooks: { 'models.hf_download': 'routine', 'train.run': 'routine' } },
  laptop: { profile: 'agent', runbooks: { 'laptop.build_then_deploy': 'routine' } },
  mac: { profile: 'agent', runbooks: {} },
  'web-01': { profile: 'runbook', runbooks: { 'site.status': 'read', 'site.pull_and_restart': 'unsafe', 'server.reboot': 'unsafe' } }
};

// Spec §4.1.
const NODE_EXPECT = {
  'gpu-box': { capabilities: ['gpu', 'cuda', 'large-disk'], roots: ['D:\\models', 'D:\\datasets', 'D:\\train', 'D:\\ML Data'], maxJobs: 2 },
  laptop: { capabilities: ['build'], roots: ['C:\\build', 'C:\\src'], maxJobs: 1 },
  mac: { capabilities: ['apple-silicon'], roots: ['/opt/work'], maxJobs: 2 },
  'web-01': { capabilities: ['site'], roots: ['/srv/site'], maxJobs: 1 }
};
const F2_ALWAYS_CONFIRM = ['Bash(ssh *)', 'Bash(scp *)', 'Bash(git push*)', 'Vault(*)', 'Bash(*deploy*)'];
const F2_DENY = ['Bash(rm -rf /*)'];

// A role's node.yaml, service.json and runbooks, installed into
// <tmp>/config the way the guide installs them into the MCP config dir.
function installRole(role) {
  const root = tmp();
  const config = path.join(root, 'config');
  const fleet = path.join(EXAMPLES, 'fleet', role);
  installInto(config, [path.join(fleet, 'node.yaml'), path.join(fleet, 'service.json')]);
  const names = Object.keys(ROLE_RUNBOOKS[role].runbooks);
  if (names.length) installInto(path.join(config, 'runbooks'), names.map((n) => path.join(RUNBOOKS, `${n}.yaml`)));
  return { root, config };
}

describe('example roles: files', () => {
  it('has every file the role table lists, and every runbook belongs to a role', () => {
    const claimed = new Set();
    for (const [role, { runbooks }] of Object.entries(ROLE_RUNBOOKS)) {
      for (const f of ['node.yaml', 'service.json']) {
        assert.ok(fs.existsSync(path.join(EXAMPLES, 'fleet', role, f)), `${role}/${f} missing`);
      }
      for (const name of Object.keys(runbooks)) {
        assert.ok(fs.existsSync(path.join(RUNBOOKS, `${name}.yaml`)), `${name}.yaml missing`);
        claimed.add(`${name}.yaml`);
      }
    }
    assert.deepEqual(runbookFiles().filter((f) => !claimed.has(f)), [], 'runbooks that belong to no role');
    assert.ok(fs.existsSync(path.join(EXAMPLES, 'README.md')));
    assert.ok(fs.existsSync(path.join(EXAMPLES, 'fleet', 'frontdoor', 'README.md')));
    assert.ok(!fs.existsSync(path.join(EXAMPLES, 'fleet', 'frontdoor', 'node.yaml')), 'frontdoor/node.yaml arrives with fleet stage 4');
  });
});

describe('example roles: load through the real loaders', () => {
  for (const [role, expect] of Object.entries(ROLE_RUNBOOKS)) {
    it(`${role} loads its node.yaml, service.json and runbooks`, () => {
      const { root, config } = installRole(role);

      const node = loadNodeConfig({ adminConfigDir: config, ...adminOpts });
      assert.equal(node.name, role);
      assert.equal(node.profile, expect.profile);
      assert.equal(node.frontDoor, null, 'front_door stays commented out until fleet stage 4');
      assert.deepEqual(node.capabilities, NODE_EXPECT[role].capabilities);
      assert.deepEqual(node.policy.allowed_roots, NODE_EXPECT[role].roots.map((r) => path.resolve(r)));
      assert.equal(node.policy.max_concurrent_jobs, NODE_EXPECT[role].maxJobs);
      assert.deepEqual(node.policy.remote_sessions, { always_confirm: F2_ALWAYS_CONFIRM, deny: F2_DENY });
      assert.equal(node.runbooksDir, path.join(config, 'runbooks'));

      const raw = parseYaml(fs.readFileSync(path.join(config, 'node.yaml'), 'utf8'));
      for (const key of Object.keys(raw)) assert.ok(NODE_YAML_KEYS.top.includes(key), `node.yaml key ${key}`);

      const service = loadServiceConfig(path.join(root, 'data'), {}, { adminConfigDir: config, geteuid: () => -1, adminUid: EUID });
      assert.equal(service.profile, expect.profile);
      const rawService = JSON.parse(fs.readFileSync(path.join(config, 'service.json'), 'utf8'));
      assert.deepEqual(Object.keys(rawService), ['profile', 'features', 'ports']);
      assert.deepEqual(Object.keys(rawService.features), Object.keys(DEFAULT_FEATURES));
      assert.deepEqual(Object.keys(rawService.ports), Object.keys(DEFAULT_PORTS));
      assert.ok(Object.values(rawService.features).every((v) => v === false), 'every listener off in the examples');

      const engine = new RunbookEngine({ runbooksDir: node.runbooksDir, allowedRoots: node.policy.allowed_roots, ...adminOpts });
      const loaded = engine.loadRunbooks();
      assert.deepEqual(
        Object.fromEntries([...loaded.values()].map((r) => [r.name, r.tier])),
        expect.runbooks
      );
    });
  }

  it('a Windows root with a space holds a file inside it', { skip: POSIX ? 'win32 path semantics' : false }, () => {
    const spaced = path.join(tmp(), 'ML Data');
    fs.mkdirSync(spaced);
    assert.equal(isPathUnderRoots(path.join(spaced, 'x.json'), [spaced]), true);
  });
});

describe('sudoers for web-01', () => {
  const SUDOERS = path.join(EXAMPLES, 'sudoers', 'king-louie-web-01');

  it('grants exactly the sudo -n commands of web-01 runbooks, once each', () => {
    const lines = fs.readFileSync(SUDOERS, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
    const granted = lines.map((l) => {
      const m = /^king-louie ALL=\(root\) NOPASSWD: (.+)$/.exec(l);
      assert.ok(m, `unexpected sudoers line: ${l}`);
      return m[1];
    });
    const needed = [];
    for (const name of Object.keys(ROLE_RUNBOOKS['web-01'].runbooks)) {
      const rb = parseYaml(fs.readFileSync(path.join(RUNBOOKS, `${name}.yaml`), 'utf8'));
      for (const step of rb.steps) {
        if (step.run && path.posix.basename(step.run[0]) === 'sudo' && step.run[1] === '-n') needed.push(step.run.slice(2).join(' '));
      }
    }
    assert.equal(granted.length, new Set(granted).size, 'duplicate grant');
    assert.deepEqual([...granted].sort(), [...new Set(needed)].sort());
  });

  // F5 ruling: the brief's original assertion checked path.basename(SUDOERS)
  // against a literal this test built itself, so it could never fail. This
  // reads the real examples/sudoers directory instead.
  it('has a name sudo will read from sudoers.d (no dot)', () => {
    const names = fs.readdirSync(path.join(EXAMPLES, 'sudoers'));
    assert.ok(names.length > 0, 'no files in examples/sudoers');
    for (const name of names) assert.ok(!name.includes('.'), `${name} has a dot; sudo skips it`);
  });

  it('passes visudo -cf', (t) => {
    for (const cmd of ['/usr/sbin/visudo', 'visudo']) {
      const r = spawnSync(cmd, ['-cf', SUDOERS], { encoding: 'utf8' });
      if (r.error && r.error.code === 'ENOENT') continue;
      assert.equal(r.status, 0, `${cmd} -cf: ${r.stdout}${r.stderr}`);
      return;
    }
    t.skip('visudo is not installed');
  });
});

describe('Windows ACL script', () => {
  const SCRIPT = path.join(EXAMPLES, 'windows', 'runbook-acls.ps1');
  const text = () => fs.readFileSync(SCRIPT, 'utf8');
  const fnBody = (t, name) => {
    const start = t.indexOf(`function ${name} {`);
    assert.ok(start > -1, `no function ${name}`);
    const next = t.indexOf('\nfunction ', start + 1);
    return t.slice(start, next === -1 ? undefined : next);
  };

  it('declares WhatIf support, a mandatory role and runner, and the default base', () => {
    const t = text();
    assert.match(t, /\[CmdletBinding\(SupportsShouldProcess\)\]/);
    assert.match(t, /\[Parameter\(Mandatory\)\]\[ValidateSet\('base', 'gpu-box', 'laptop'\)\]\[string\] \$Role/);
    assert.match(t, /\[Parameter\(Mandatory\)\]\[string\] \$Runner/);
    assert.ok(t.includes("[string] $Base = 'C:\\KingLouie'"));
    assert.match(t, /^Set-StrictMode -Version Latest$/m);
    assert.match(t, /^\$ErrorActionPreference = 'Stop'$/m);
  });

  it('calls icacls only by its full path, never recursively, refuses to run unelevated, and resolves the runner to a SID', () => {
    const t = text();
    assert.ok(t.includes('$icacls = "$env:SystemRoot\\System32\\icacls.exe"'));
    const invoked = [...t.matchAll(/^\s*&\s+(\S+)/gm)].map((m) => m[1]);
    assert.deepEqual([...new Set(invoked)], ['$icacls']);
    assert.ok(!/^\s*icacls\b/im.test(t), 'a bare icacls call');
    // takeown /R and icacls /T follow junctions out of the tree (reproduced).
    assert.ok(!/takeown\.exe/i.test(t), 'takeown is back');
    assert.ok(!/['"]\/[TR]['"]/i.test(t), 'a recursive /T or /R argument');
    assert.ok(!/\s-Recurse\b/.test(t), 'Get-ChildItem -Recurse does not see through junctions and must not drive the walk or the check');
    assert.match(t, /WindowsBuiltInRole\]::Administrator/);
    assert.match(t, /NTAccount\(\$Runner\)\)\.Translate\(\[Security\.Principal\.SecurityIdentifier\]\)/);
  });

  it('validates -Base: rooted with a separator, not a drive root, outside $env:SystemRoot, and either empty or an existing King Louie install', () => {
    const t = text();
    assert.match(t, /\$Base -notmatch '\^\[A-Za-z\]:\[\\\\\/\]'/);
    assert.match(t, /drive root/);
    assert.match(t, /\$env:SystemRoot/);
    assert.match(t, /app\\package\.json/);
    assert.ok(t.includes('Get-ChildItem -LiteralPath $baseFull -Force -ErrorAction Stop'));
    assert.ok(!t.includes('SilentlyContinue'), 'an error is swallowed');
  });

  it('builds every path from the normalized $baseFull', () => {
    const t = text();
    assert.ok(!/"\$Base\\/.test(t), 'a path is built from the raw -Base');
    assert.ok(!/Join-Path \$Base\b/.test(t), 'a path is built from the raw -Base');
    assert.match(t, /\$baseFull = \[System\.IO\.Path\]::GetFullPath\(\$Base\)\.TrimEnd\('\\'\)/);
  });

  it('lets LOCAL SERVICE read the app folder', () => {
    const t = text();
    assert.ok(t.includes("$LocalService = '*S-1-5-19'"));
    assert.ok(t.includes('Set-KlAcl -Path "$baseFull\\app" -Grants @("${LocalService}:(OI)(CI)RX")'));
  });

  it('grants only to SYSTEM, Administrators, LOCAL SERVICE and the runner, by SID', () => {
    const t = text();
    const sids = new Set([...t.matchAll(/\*S-1-[0-9-]+/g)].map((m) => m[0]));
    assert.deepEqual([...sids].sort(), ['*S-1-5-18', '*S-1-5-19', '*S-1-5-32-544']);
    const principals = new Set([...t.matchAll(/"\$\{(\w+)\}:\(/g)].map((m) => m[1]));
    assert.deepEqual([...principals].sort(), ['Admins', 'LocalService', 'RunnerSid', 'System']);
    assert.equal(/["'][A-Za-z][^"'$\r\n]*:\((?:OI|CI)\)/.test(t), false, 'a grant names an account literally');
    const ruleSids = new Set([...t.matchAll(/New-KlAccessRule \$(\w+)/g)].map((m) => m[1]));
    assert.deepEqual([...ruleSids].sort(), ['AdminsSecurityId', 'RunnerSecurityId', 'SystemSecurityId']);
  });

  describe('locking an admin-owned tree (Ruling C1)', () => {
    it('locks each folder (owner verified by SID, DACL replaced) before listing its children, one level at a time', () => {
      const t = text();
      const fn = fnBody(t, 'Lock-KlAdminOwnedTree');
      const lockTop = fn.indexOf('[KlNative]::LockItem($top, $true, $OwnerSid.Value, $topDacl)');
      const list = fn.indexOf('Get-ChildItem -LiteralPath $dir -Force)');
      assert.ok(lockTop > -1 && lockTop < list, 'the top folder is not locked before it is listed');
      assert.ok(fn.includes("$topDacl = 'D:PAI' +"), 'the top DACL is not protected');
      // A child folder is locked before it is queued, and listed only when popped.
      const lockChild = fn.indexOf('[KlNative]::LockItem($full, $true, $OwnerSid.Value, $folderDacl)', list);
      const push = fn.indexOf('$pending.Push($full)');
      assert.ok(lockChild > -1 && lockChild < push, 'a child folder is queued before it is locked');
      // LockItem: owner written, read back and compared by SID, then the DACL.
      const setOwner = t.indexOf('SetKernelObjectSecurity(handle, OwnerSecurityInformation');
      const verify = t.indexOf('actual.Value != owner.Value');
      const setDacl = t.indexOf('SetKernelObjectSecurity(handle, DaclSecurityInformation');
      assert.ok(setOwner > -1 && setOwner < verify && verify < setDacl, 'owner, verify, DACL are not in order');
    });

    it('changes one item per write: a handle on the item itself, no SetNamedSecurityInfo (Set-Acl, icacls) inside the walk', () => {
      const t = text();
      assert.ok(!/Set-Acl\s+-/.test(t), 'Set-Acl propagates into the subtree before the walk has checked it');
      assert.ok(!/SetAccessControl\(/.test(t), 'SetAccessControl propagates into the subtree before the walk has checked it');
      const lockItem = t.slice(t.indexOf('public static void LockItem('), t.indexOf('// Returns { attributes, number of links }.'));
      const open = lockItem.indexOf('CreateFileW(path, access, 0x7, IntPtr.Zero, 3, 0x00200000 | 0x02000000');
      const reparse = lockItem.indexOf('FileAttributeReparsePoint) != 0');
      const links = lockItem.indexOf('info.NumberOfLinks > 1');
      const write = lockItem.indexOf('SetKernelObjectSecurity(');
      assert.ok(open > -1 && open < reparse && reparse < links && links < write, 'the checks do not come before the writes on the same handle');
      assert.ok(!fnBody(t, 'Lock-KlAdminOwnedTree').includes('& $icacls'), 'icacls inside the walk');
    });

    it('throws on a reparse point before touching it, and re-checks each item after locking it', () => {
      const t = text();
      const fn = fnBody(t, 'Lock-KlAdminOwnedTree');
      const reparse = fn.indexOf('$child.Attributes -band [IO.FileAttributes]::ReparsePoint');
      assert.ok(reparse > -1, 'no reparse check on listed children');
      assert.match(fnBody(t, 'Assert-KlNotReparsePoint'), /throw "\$Path is a junction, symbolic link or other reparse point/);
      assert.ok(reparse < fn.indexOf('[KlNative]::LockItem($full'), 'the reparse check does not come first');
      assert.match(fn, /Assert-KlSingleLinkFile -Path \$full/);
    });

    it('refuses a file with a second hard link, read with GetFileInformationByHandle on a handle that does not follow reparse points', () => {
      const t = text();
      assert.match(t, /GetFileInformationByHandle/);
      assert.match(t, /NumberOfLinks/);
      assert.match(t, /0x00200000/, 'FILE_FLAG_OPEN_REPARSE_POINT');
      assert.match(t, /Add-Type -TypeDefinition/);
      assert.match(fnBody(t, 'Assert-KlSingleLinkFile'), /\$facts\[1\] -gt 1/);
    });

    it('resets files and inner folders to inherited-only: the top rules as inherited entries, nothing explicit', () => {
      const t = text();
      const fn = fnBody(t, 'Lock-KlAdminOwnedTree');
      assert.ok(fn.includes("$folderDacl = 'D:AI' + (ConvertTo-KlAceSddl -Rules $TopRules -Kind Folder)"));
      assert.ok(fn.includes("$fileDacl = 'D:AI' + (ConvertTo-KlAceSddl -Rules $TopRules -Kind File)"));
      assert.ok(fnBody(t, 'ConvertTo-KlAceSddl').includes("@{ Top = 'OICI'; Folder = 'OICIID'; File = 'ID' }"));
    });

    it('never walks into a data folder: locks the folder itself and moves on', () => {
      const fn = fnBody(text(), 'Lock-KlAdminOwnedTree');
      const dataBranch = fn.slice(fn.indexOf('if ($dataKey.Count -gt 0) {'), fn.indexOf('continue', fn.indexOf('if ($dataKey.Count -gt 0) {')));
      assert.ok(dataBranch.includes('[KlNative]::LockItem($full, $true, $OwnerSid.Value, $data[$dataKey[0]])'));
      assert.ok(!dataBranch.includes('$pending.Push'), 'a data folder is walked');
    });

    it('verifies by hand: throws on any reparse point, counts GENERIC_WRITE and GENERIC_ALL as write, and exempts no LOCAL SERVICE write', () => {
      const fn = fnBody(text(), 'Confirm-KlTreeLockedDown');
      assert.match(fn, /\$item\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint/);
      assert.match(fn, /0x40000000/);
      assert.match(fn, /0x10000000/);
      assert.ok(!fn.includes('S-1-5-19'), 'LOCAL SERVICE may not write anywhere in an admin-owned tree');
      assert.match(fn, /throw ".*is not owned by/);
      assert.match(fn, /throw ".*grants write access to/);
    });

    it('applies the walk to $baseFull, $baseFull\\tools, D:\\train and D:\\train\\configs only, with mcp\\data and train\\runs as data folders', () => {
      const t = text();
      const targets = [...t.matchAll(/^\s*Set-KlAdminOwnedTree -Path (\S+)/gm)].map((m) => m[1]);
      assert.deepEqual(targets.sort(), ['"$baseFull\\tools"', '$baseFull', "'D:\\train'", "'D:\\train\\configs'"].sort());
      assert.ok(t.includes('-DataFolders @{ "$baseFull\\mcp\\data" = $RunnerDataRules }'));
      assert.ok(t.includes("-DataFolders @{ 'D:\\train\\runs' = $RunnerDataRules }"));
      assert.ok(t.includes('$RunnerDataRules = @((New-KlAccessRule $RunnerSecurityId \'Modify\'))'));
      assert.match(fnBody(t, 'Set-KlAdminOwnedTree'), /-OwnerSid \$AdminsSecurityId/);
    });

    it('enables SeTakeOwnership and SeRestore only after the elevation check', () => {
      const t = text();
      const elevated = t.indexOf("throw 'Run this script from an elevated PowerShell");
      assert.ok(elevated > -1 && elevated < t.indexOf("[KlNative]::EnablePrivilege('SeTakeOwnershipPrivilege')"));
      assert.ok(t.includes("[KlNative]::EnablePrivilege('SeRestorePrivilege')"));
    });

    it('prints each change of the walk under -WhatIf', () => {
      const fn = fnBody(text(), 'Lock-KlAdminOwnedTree');
      assert.ok([...fn.matchAll(/\$PSCmdlet\.ShouldProcess\(/g)].length >= 5);
    });
  });

  it('refuses to icacls a path that is a reparse point', () => {
    const fn = fnBody(text(), 'Set-KlAcl');
    assert.ok(fn.indexOf('Assert-KlNotReparsePoint -Path $Path') < fn.indexOf('& $icacls'));
  });

  it('cuts inheritance on the two runner-writable data paths no walk reaches', () => {
    const t = text();
    for (const target of ["'C:\\build\\site'", "'D:\\models'"]) {
      assert.ok(t.includes(`Set-KlAcl -Path ${target} -CutInheritance -Grants`), `${target} keeps its inherited ACEs`);
    }
  });

  it('refuses a gpu-box Python venv whose interpreter is not installed for all users, comparing full paths against ProgramW6432 when set', () => {
    const t = text();
    assert.match(t, /tools\\py\\pyvenv\.cfg/);
    assert.match(t, /\[IO\.Path\]::GetFullPath\(\$Matches\[1\]\)/);
    assert.match(t, /\$env:ProgramW6432/);
    assert.match(t, /\$env:ProgramFiles/);
    assert.match(t, /for all users/);
  });

  it('refuses a gpu-box Python venv with include-system-site-packages = true', () => {
    assert.match(text(), /include-system-site-packages\s*=\s*true/);
  });

  it("documents that changing -Runner leaves the old runner's entries behind, in icacls's *SID form", () => {
    const t = text();
    assert.match(t, /old runner/i);
    assert.match(t, /\*<old runner's SID>/);
  });

  it('includes the underlying exception message when -Runner cannot be resolved', () => {
    assert.match(text(), /catch \{[^}]*\$_\.Exception\.Message[^}]*\}/s);
  });

  it('is ASCII only', () => {
    const t = text();
    for (let i = 0; i < t.length; i++) {
      const code = t.codePointAt(i);
      assert.ok(code <= 127, `non-ASCII character (U+${code.toString(16)}) at offset ${i}`);
    }
  });

  it('parses without errors in Windows PowerShell', { skip: POSIX ? 'Windows PowerShell only' : false }, () => {
    const ps = `$t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT.replace(/'/g, "''")}', [ref]$t, [ref]$e); $e.Count`;
    const r = spawnSync(windowsPowerShellExe(), ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '0');
  });

  // The walk run for real, unelevated, on a scratch tree. The script's own
  // functions are loaded from its AST (the script body refuses to run
  // unelevated), and the owner is the current user instead of
  // Administrators: an unelevated token cannot assign Administrators.
  describe('the walk on a scratch tree', { skip: POSIX ? 'Windows only' : false }, () => {
    const PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:KL_ACL_SCRIPT, [ref]$tokens, [ref]$parseErrors)
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  . ([ScriptBlock]::Create($fn.Extent.Text))
}
$root = $env:KL_ACL_ROOT
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$users = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
$everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$localService = New-Object Security.Principal.SecurityIdentifier('S-1-5-19')
$sy = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$topRules = @((New-KlAccessRule $sy 'FullControl'), (New-KlAccessRule $me 'FullControl'), (New-KlAccessRule $users 'ReadAndExecute'))
$dataRules = @((New-KlAccessRule $localService 'Modify'))
function Info($p) {
  $a = Get-Acl -LiteralPath $p
  @{
    owner = $a.GetOwner([Security.Principal.SecurityIdentifier]).Value
    isProtected = $a.AreAccessRulesProtected
    explicit = @($a.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value })
    all = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value + '=' + [int] $_.FileSystemRights })
    sddl = $a.Sddl
  }
}
function AddExplicit($p, $sid, $rights) {
  $a = Get-Acl -LiteralPath $p
  $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, $rights, 'Allow')))
  if ((Get-Item -LiteralPath $p -Force).PSIsContainer) { [IO.Directory]::SetAccessControl($p, $a) } else { [IO.File]::SetAccessControl($p, $a) }
}
# A file that keeps exactly these explicit entries and inherits nothing.
function ProtectFile($p, $rules) {
  $a = Get-Acl -LiteralPath $p
  $a.SetAccessRuleProtection($true, $false)
  foreach ($r in @($a.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) { [void] $a.RemoveAccessRuleSpecific($r) }
  foreach ($r in $rules) { $a.AddAccessRule($r) }
  [IO.File]::SetAccessControl($p, $a)
}
function Invoke-Try($block) { try { & $block; $null } catch { $_.Exception.Message } }
`;
    function runWalk(root, body) {
      const file = path.join(root, 'harness.ps1');
      fs.writeFileSync(file, `${PRELUDE}\n${body}\n`);
      const r = spawnSync(windowsPowerShellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
        encoding: 'utf8',
        env: { ...process.env, KL_ACL_SCRIPT: SCRIPT, KL_ACL_ROOT: root },
      });
      assert.equal(r.status, 0, `powershell failed:\n${r.stdout}\n${r.stderr}`);
      return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
    }
    // An outside folder with a file, each given an explicit Everyone entry,
    // so any change the walk made to them would show in their SDDL.
    function scratch() {
      const root = tmp();
      fs.mkdirSync(path.join(root, 'tree', 'a'), { recursive: true });
      fs.mkdirSync(path.join(root, 'outside'));
      fs.writeFileSync(path.join(root, 'outside', 'secret.txt'), 'x');
      fs.writeFileSync(path.join(root, 'tree', 'a', 'f.txt'), 'x');
      return root;
    }
    const OUTSIDE_SETUP = String.raw`
AddExplicit "$root\outside" $everyone 'ReadAndExecute'
AddExplicit "$root\outside\secret.txt" $everyone 'Read'
$before = @{ dir = Info "$root\outside"; file = Info "$root\outside\secret.txt" }
`;

    for (const where of [['tree', 'j'], ['tree', 'a', 'j']]) {
      it(`a junction at ${where.join('\\')} makes the walk throw before its target is touched`, () => {
        const root = scratch();
        fs.symlinkSync(path.join(root, 'outside'), path.join(root, ...where), 'junction');
        const out = runWalk(root, `${OUTSIDE_SETUP}
$err = Invoke-Try { Lock-KlAdminOwnedTree -Path "$root\\tree" -OwnerSid $me -TopRules $topRules }
@{ err = $err; before = $before; after = @{ dir = Info "$root\\outside"; file = Info "$root\\outside\\secret.txt" }; top = Info "$root\\tree" } | ConvertTo-Json -Compress -Depth 5`);
        assert.ok(out.err, 'the walk did not throw');
        assert.match(out.err, /junction, symbolic link or other reparse point/);
        assert.ok(out.err.includes(path.join(root, ...where)), out.err);
        // The walk got past the top folder: the throw is the junction check, not a failed lock.
        assert.equal(out.top.isProtected, true);
        assert.deepEqual(out.after, out.before, "the junction's target changed");
      });
    }

    it('a file with a second hard link makes the walk throw before the file is touched', () => {
      const root = scratch();
      fs.linkSync(path.join(root, 'outside', 'secret.txt'), path.join(root, 'tree', 'a', 'h.txt'));
      const out = runWalk(root, `${OUTSIDE_SETUP}
$err = Invoke-Try { Lock-KlAdminOwnedTree -Path "$root\\tree" -OwnerSid $me -TopRules $topRules }
@{ err = $err; before = $before; after = @{ dir = Info "$root\\outside"; file = Info "$root\\outside\\secret.txt" } } | ConvertTo-Json -Compress -Depth 5`);
      assert.ok(out.err, 'the walk did not throw');
      assert.match(out.err, /h\.txt has 2 hard links/);
      assert.deepEqual(out.after, out.before, 'the hard-linked file changed');
    });

    it('locks a clean tree: top protected with exactly its rules, everything below inherited-only, data folders locked but not walked', () => {
      const root = scratch();
      fs.mkdirSync(path.join(root, 'tree', 'a', 'b'));
      fs.writeFileSync(path.join(root, 'tree', 'a', 'b', 'g.txt'), 'x');
      fs.mkdirSync(path.join(root, 'tree', 'data'));
      fs.writeFileSync(path.join(root, 'tree', 'data', 'd.txt'), 'x');
      // Inside a data folder a junction is never followed by the walk; the check still refuses it.
      fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'tree', 'data', 'jj'), 'junction');
      const out = runWalk(root, `${OUTSIDE_SETUP}
AddExplicit "$root\\tree\\a\\f.txt" $everyone 'Modify'
AddExplicit "$root\\tree\\a\\b" $everyone 'Modify'
# The runner's own file in its data folder: the walk must leave it exactly as it is.
ProtectFile "$root\\tree\\data\\d.txt" @((New-Object Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')), (New-Object Security.AccessControl.FileSystemAccessRule($everyone, 'ReadAndExecute', 'Allow')))
$dataFileBefore = Info "$root\\tree\\data\\d.txt"
Lock-KlAdminOwnedTree -Path "$root\\tree" -OwnerSid $me -TopRules $topRules -DataFolders @{ "$root\\tree\\data" = $dataRules } -EnsureFolders @("$root\\tree\\mcp\\config")
$inner = @{}
foreach ($p in 'a', 'a\\f.txt', 'a\\b', 'a\\b\\g.txt', 'mcp', 'mcp\\config') { $inner[$p] = Info "$root\\tree\\$p" }
$checkWithJunction = Invoke-Try { Confirm-KlTreeLockedDown -Path "$root\\tree" -OwnerSid $me -DataFolders @("$root\\tree\\data") -DataWriterSid $localService }
cmd /c rmdir "$root\\tree\\data\\jj"
$checkClean = Invoke-Try { Confirm-KlTreeLockedDown -Path "$root\\tree" -OwnerSid $me -DataFolders @("$root\\tree\\data") -DataWriterSid $localService }
AddExplicit "$root\\tree\\a\\b\\g.txt" $everyone 'Write'
$checkWritable = Invoke-Try { Confirm-KlTreeLockedDown -Path "$root\\tree" -OwnerSid $me -DataFolders @("$root\\tree\\data") -DataWriterSid $localService }
@{
  me = $me.Value; top = Info "$root\\tree"; inner = $inner
  data = Info "$root\\tree\\data"; dataFile = Info "$root\\tree\\data\\d.txt"; dataFileBefore = $dataFileBefore
  before = $before; after = @{ dir = Info "$root\\outside"; file = Info "$root\\outside\\secret.txt" }
  checkWithJunction = $checkWithJunction; checkClean = $checkClean; checkWritable = $checkWritable
} | ConvertTo-Json -Compress -Depth 5`);
      assert.equal(out.top.owner, out.me);
      assert.equal(out.top.isProtected, true);
      assert.deepEqual([...out.top.explicit].sort(), [out.me, 'S-1-5-18', 'S-1-5-32-545'].sort());
      for (const [p, info] of Object.entries(out.inner)) {
        assert.equal(info.owner, out.me, `${p} owner`);
        assert.equal(info.isProtected, false, `${p} is protected`);
        assert.deepEqual(info.explicit, [], `${p} keeps an explicit entry`);
        assert.deepEqual([...info.all].sort(), [...out.top.all].sort(), `${p} does not inherit exactly the top folder's entries`);
      }
      assert.equal(out.data.owner, out.me);
      assert.equal(out.data.isProtected, false);
      assert.deepEqual(out.data.explicit, ['S-1-5-19']);
      assert.deepEqual(out.dataFile, out.dataFileBefore, 'the walk went inside the data folder');
      assert.deepEqual(out.after, out.before, 'the junction target inside the data folder changed');
      assert.match(out.checkWithJunction || '', /jj is a junction, symbolic link or other reparse point/);
      assert.equal(out.checkClean, null);
      assert.match(out.checkWritable || '', /g\.txt grants write access to S-1-1-0/);
    });

    it('changes nothing under -WhatIf', () => {
      const root = scratch();
      const out = runWalk(root, String.raw`
AddExplicit "$root\tree\a\f.txt" $everyone 'Modify'
$before = @{ top = Info "$root\tree"; a = Info "$root\tree\a"; f = Info "$root\tree\a\f.txt" }
Lock-KlAdminOwnedTree -Path "$root\tree" -OwnerSid $me -TopRules $topRules -EnsureFolders @("$root\tree\mcp\work") -WhatIf 6>$null | Out-Null
@{ before = $before; after = @{ top = Info "$root\tree"; a = Info "$root\tree\a"; f = Info "$root\tree\a\f.txt" }; created = (Test-Path "$root\tree\mcp") } | ConvertTo-Json -Compress -Depth 5`);
      assert.deepEqual(out.after, out.before);
      assert.equal(out.created, false);
    });

    it('enables a privilege the token holds and refuses one it does not', () => {
      const root = tmp();
      const out = runWalk(root, String.raw`
Initialize-KlNative
$elevated = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
@{ held = (Invoke-Try { [KlNative]::EnablePrivilege('SeChangeNotifyPrivilege') }); notHeld = (Invoke-Try { [KlNative]::EnablePrivilege('SeTakeOwnershipPrivilege') }); elevated = $elevated } | ConvertTo-Json -Compress`);
      assert.equal(out.held, null);
      if (!out.elevated) assert.match(out.notHeld || '', /does not hold SeTakeOwnershipPrivilege/);
    });
  });
});

describe('MCP client configs', () => {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'mcp', name), 'utf8'));
  const WINDOWS_ARGS = [
    '/d', '/c', 'cd', '/d', 'C:\\KingLouie\\mcp\\work', '&&',
    'C:\\Program Files\\nodejs\\node.exe', 'C:\\KingLouie\\app\\bin\\king-louie-service.js',
    'mcp', '--data-dir', 'C:\\KingLouie\\mcp\\data'
  ];

  it('Windows: starts the server in the admin-owned work dir, one argument per word', () => {
    const server = read('claude-desktop.windows.json').mcpServers['king-louie'];
    assert.equal(server.command, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(server.args, WINDOWS_ARGS);
    assert.ok(server.args.every((a) => !a.includes('"')), 'a quote inside an argument reaches cmd.exe as \\" and breaks the command');
  });

  it('macOS: starts the server in the admin-owned work dir through /bin/sh', () => {
    const server = read('claude-desktop.macos.json').mcpServers['king-louie'];
    assert.equal(server.command, '/bin/sh');
    assert.deepEqual(server.args, [
      '-c',
      'cd /opt/king-louie/mcp/work && exec /usr/local/bin/node /opt/king-louie/app/bin/king-louie-service.js mcp --data-dir /opt/king-louie/mcp/data'
    ]);
  });

  it('Windows: the same argument shape runs through cmd.exe with a spaced directory', { skip: POSIX ? 'cmd.exe only' : false }, () => {
    const server = read('claude-desktop.windows.json').mcpServers['king-louie'];
    const work = path.join(tmp(), 'mcp work');
    fs.mkdirSync(work);
    const args = [...server.args.slice(0, 4), work, '&&', process.execPath, '-p', 'process.cwd()'];
    const r = spawnSync(server.command, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.realpathSync.native(r.stdout.trim()), fs.realpathSync.native(work));
  });
});

describe('install guide', () => {
  const HEADINGS = [
    '# King Louie fleet install guide',
    '## 1. What you are setting up',
    '## 2. Before you start',
    '## 3. Get the code and lock the install directory',
    '## 4. Install the service',
    '## 5. Write the config directories',
    '## 6. Grant exact privileges',
    '## 7. Check with doctor',
    '## 8. Your first runbook over stdio MCP',
    '## 9. Troubleshooting',
    '## 10. Stage 3: Approving unsafe runbooks from your phone',
    '## 11. Stage 4: Reaching the fleet through the front door',
    '## 12. Stage 5: Desktop apps on agent nodes'
  ];
  const lines = () => fs.readFileSync(GUIDE, 'utf8').split(/\r?\n/);

  it('has the fixed headings, in order', () => {
    const found = lines().filter((l) => /^#{1,2} /.test(l));
    assert.deepEqual(found, HEADINGS);
  });

  it('reserves sections 10 to 12 for wave 4 with one marker line each', () => {
    const all = lines();
    for (const [heading, stage] of [[HEADINGS[10], 3], [HEADINGS[11], 4], [HEADINGS[12], 5]]) {
      const i = all.indexOf(heading);
      const body = [];
      for (let j = i + 1; j < all.length && !/^#{1,2} /.test(all[j]); j += 1) {
        if (all[j].trim()) body.push(all[j]);
      }
      assert.deepEqual(body, [`Not available yet. This section is written when fleet stage ${stage} merges.`], heading);
    }
  });

  it('gives the commands the examples depend on', () => {
    const text = lines().join('\n');
    for (const needle of [
      'runbook-acls.ps1 -Role base -Runner',
      'install --profile runbook --dry-run',
      'install --user _kinglouie --dry-run',
      'visudo -cf /opt/king-louie/app/examples/sudoers/king-louie-web-01',
      'install -o root -g root -m 0440',
      'doctor --data-dir C:\\KingLouie\\mcp\\data',
      'sudo -u king-louie /usr/bin/env --chdir=/opt/king-louie/mcp/work',
      'safe.directory=*',
      'fc.exe',
      'untrusted_output',
      'huggingface_hub[cli]'
    ]) {
      assert.ok(text.includes(needle), `guide does not mention ${needle}`);
    }
  });
});

describe('packaging and docs', () => {
  it('keeps examples/ out of the desktop app build', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.build.files.includes('!examples/**'), JSON.stringify(pkg.build.files));
  });

  it('points readers at the examples and the guide', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const service = readme.indexOf('## Running as a Service');
    const section = readme.indexOf('### Fleet setup and examples');
    const next = readme.indexOf('## Supported Providers');
    assert.ok(service !== -1 && section > service && section < next, 'the README section sits at the end of Running as a Service');
    assert.ok(readme.includes('(docs/install-guide.md)'));
    const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /^## Examples$/m);
    assert.ok(claude.includes('tests/helpers/example-denylist.js'));
  });
});
