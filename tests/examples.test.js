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
    '+442071234567'
  ];
  const mustPass = [
    'example.com',
    'kl.example.com',
    'mcp.kl.example.com',
    '192.0.2.10',
    '+15550100',
    '/home/<user>/',
    'git@github.com'
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
