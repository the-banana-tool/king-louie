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

  it('declares WhatIf support, a mandatory role and runner, and the default base', () => {
    const t = text();
    assert.match(t, /\[CmdletBinding\(SupportsShouldProcess\)\]/);
    assert.match(t, /\[Parameter\(Mandatory\)\]\[ValidateSet\('base', 'gpu-box', 'laptop'\)\]\[string\] \$Role/);
    assert.match(t, /\[Parameter\(Mandatory\)\]\[string\] \$Runner/);
    assert.ok(t.includes("[string] $Base = 'C:\\KingLouie'"));
  });

  it('calls icacls only by its full path, refuses to run unelevated, and resolves the runner to a SID', () => {
    const t = text();
    assert.ok(t.includes('$icacls = "$env:SystemRoot\\System32\\icacls.exe"'));
    const invoked = [...t.matchAll(/^\s*&\s+(\S+)/gm)].map((m) => m[1]);
    assert.deepEqual([...new Set(invoked)], ['$icacls']);
    assert.ok(!/^\s*icacls/im.test(t), 'a bare icacls call');
    assert.match(t, /WindowsBuiltInRole\]::Administrator/);
    assert.match(t, /NTAccount\(\$Runner\)\)\.Translate\(\[Security\.Principal\.SecurityIdentifier\]\)/);
  });

  it('cuts inheritance on the base, tools, train and configs folders', () => {
    const t = text();
    for (const target of ['"$Base"', '"$Base\\tools"', "'D:\\train'", "'D:\\train\\configs'"]) {
      assert.ok(t.includes(`Set-KlAcl -Path ${target} -CutInheritance`), `${target} keeps its inherited ACEs`);
    }
    assert.ok(t.includes("'/inheritance:r'"));
  });

  it('lets LOCAL SERVICE read the app folder', () => {
    const t = text();
    assert.ok(t.includes("$LocalService = '*S-1-5-19'"));
    assert.ok(t.includes('Set-KlAcl -Path "$Base\\app" -Grants @("${LocalService}:(OI)(CI)RX")'));
  });

  it('grants only to SYSTEM, Administrators, LOCAL SERVICE and the runner, by SID', () => {
    const t = text();
    const sids = new Set([...t.matchAll(/\*S-1-[0-9-]+/g)].map((m) => m[0]));
    assert.deepEqual([...sids].sort(), ['*S-1-5-18', '*S-1-5-19', '*S-1-5-32-544']);
    const principals = new Set([...t.matchAll(/"\$\{(\w+)\}:\(/g)].map((m) => m[1]));
    assert.deepEqual([...principals].sort(), ['Admins', 'LocalService', 'RunnerSid', 'System']);
    assert.equal(/["'][A-Za-z][^"'$\r\n]*:\((?:OI|CI)\)/.test(t), false, 'a grant names an account literally');
  });

  it('resets ownership and clears explicit child ACEs on every admin-owned path before granting', () => {
    const t = text();
    assert.match(t, /\[switch\]\s*\$ResetOwnership/);
    assert.ok(t.includes("'/setowner'"));
    assert.ok(t.includes("'/reset'"));
    const resetCalls = [...t.matchAll(/Set-KlAcl -Path (\S+) -CutInheritance -ResetOwnership/g)].map((m) => m[1]);
    assert.deepEqual(resetCalls.sort(), ['"$Base"', '"$Base\\tools"', "'D:\\train'", "'D:\\train\\configs'"].sort());
    for (const target of ['"$Base\\mcp\\data"', "'D:\\train\\runs'", "'D:\\models'", "'C:\\build\\site'"]) {
      assert.ok(!t.includes(`-Path ${target} -CutInheritance -ResetOwnership`) && !t.includes(`-Path ${target} -ResetOwnership`), `${target} should not reset ownership`);
    }
  });

  it('verifies the owner after /setowner instead of trusting its exit code', () => {
    const t = text();
    assert.match(t, /\(Get-Acl -LiteralPath \$Path\)\.Owner/);
    assert.match(t, /\[Security\.Principal\.NTAccount\]\s*\$ownerAccount\)\.Translate\(\[Security\.Principal\.SecurityIdentifier\]\)/);
    assert.match(t, /\$ownerSid -ne 'S-1-5-32-544'/);
    // the verification must run between the /setowner and /reset calls
    const setownerIdx = t.indexOf("'/setowner'");
    const verifyIdx = t.indexOf('Get-Acl -LiteralPath $Path');
    const resetIdx = t.indexOf("'/reset'");
    assert.ok(setownerIdx < verifyIdx && verifyIdx < resetIdx, 'owner verification is not between /setowner and /reset');
  });

  it('cuts inheritance on the two runner-writable data paths without resetting ownership', () => {
    const t = text();
    for (const target of ["'C:\\build\\site'", "'D:\\models'"]) {
      assert.ok(t.includes(`Set-KlAcl -Path ${target} -CutInheritance -Grants`), `${target} keeps its inherited ACEs`);
      assert.ok(!t.includes(`-Path ${target} -CutInheritance -ResetOwnership`), `${target} should not reset ownership`);
    }
  });

  it("refuses a gpu-box Python venv whose interpreter is not installed for all users", () => {
    const t = text();
    assert.match(t, /tools\\py\\pyvenv\.cfg/);
    assert.match(t, /\$env:ProgramFiles/);
    assert.match(t, /for all users/);
  });

  it('validates -Base is rooted, not a drive root, and outside $env:SystemRoot', () => {
    const t = text();
    assert.match(t, /IsPathRooted\(\$Base\)/);
    assert.match(t, /drive root/);
    assert.match(t, /\$env:SystemRoot/);
  });

  it("documents that changing -Runner leaves the old runner's entries behind", () => {
    assert.match(text(), /old runner/i);
  });

  it('includes the underlying exception message when -Runner cannot be resolved', () => {
    assert.match(text(), /catch \{[^}]*\$_\.Exception\.Message[^}]*\}/s);
  });

  it('parses without errors in Windows PowerShell', { skip: POSIX ? 'Windows PowerShell only' : false }, () => {
    const ps = `$t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT.replace(/'/g, "''")}', [ref]$t, [ref]$e); $e.Count`;
    const r = spawnSync(windowsPowerShellExe(), ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '0');
  });
});
