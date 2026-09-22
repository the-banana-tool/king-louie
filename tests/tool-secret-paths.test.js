// A1 — the host's own secret files are out of bounds for every path-gated tool,
// whatever the working directory and allowed directories say.
//
// Group B moved the service agent's working directory out of the data dir
// (<dataDir>/workspace). These tests deliberately point the working directory
// straight back at the data dir: this deny-list is the floor that has to hold
// when the workspace is misconfigured, when an operator adds the data dir to
// `allowedDirectories`, or when the Electron host's userData dir is in reach.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isPathAllowed,
  isProtectedSecretPath,
  describePathDenial,
  registerSecretDataDir,
  clearSecretDataDirs,
  SECRET_PATH_DENIAL_MESSAGE
} = require('../src/tools/utils');

const readTool = require('../src/tools/builtin/read-tool');
const writeTool = require('../src/tools/builtin/write-tool');
const editTool = require('../src/tools/builtin/edit-tool');
const multiEditTool = require('../src/tools/builtin/multi-edit-tool');
const grepTool = require('../src/tools/builtin/grep-tool');
const globTool = require('../src/tools/builtin/glob-tool');

const isWindows = process.platform === 'win32';

let dataDir;
let workspace;

const SECRETS = {
  'master.key': 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
  'master.key.dpapi': 'DPAPI-WRAPPED-MASTER-KEY-BLOB',
  'key-check': 'v1:AAAA:BBBB',
  'gateway-token': 'kl_gateway_SUPERSECRETBEARER',
  'chat-data.json': '{"apiTokens":{"anthropic":"v10:CIPHERTEXT"}}',
  'config.json': '{"__vault_deploy_key":"v10:CIPHERTEXT"}'
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-secrets-'));
  workspace = path.join(dataDir, 'workspace');
  fs.mkdirSync(workspace);
  for (const [name, body] of Object.entries(SECRETS)) {
    fs.writeFileSync(path.join(dataDir, name), body);
  }
  fs.writeFileSync(path.join(workspace, 'notes.md'), 'ordinary workspace file\n');
  clearSecretDataDirs();
  registerSecretDataDir(dataDir);
});

afterEach(() => {
  clearSecretDataDirs();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('secret-path deny-list (A1)', () => {
  it('refuses every secret file even when the data dir IS the working directory', () => {
    for (const name of Object.keys(SECRETS)) {
      const target = path.join(dataDir, name);
      assert.strictEqual(isProtectedSecretPath(target), true, `${name} should be protected`);
      assert.strictEqual(isPathAllowed(target, dataDir, []), false, `${name} must not be allowed`);
    }
  });

  it('refuses secret files listed in allowedDirectories too', () => {
    const target = path.join(dataDir, 'master.key');
    assert.strictEqual(isPathAllowed(target, path.join(os.tmpdir(), 'elsewhere'), [dataDir]), false);
  });

  it('still allows ordinary files inside the data dir', () => {
    assert.strictEqual(isPathAllowed(path.join(workspace, 'notes.md'), dataDir, []), true);
    assert.strictEqual(isProtectedSecretPath(path.join(workspace, 'notes.md')), false);
  });

  it('does not protect same-named files in an unregistered directory', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-project-'));
    try {
      const target = path.join(other, 'config.json');
      fs.writeFileSync(target, '{}');
      assert.strictEqual(isProtectedSecretPath(target), false);
      assert.strictEqual(isPathAllowed(target, other, []), true);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('gives a denial message that names the reason', () => {
    const denial = describePathDenial(path.join(dataDir, 'master.key'), dataDir, []);
    assert.strictEqual(denial, SECRET_PATH_DENIAL_MESSAGE);
    assert.match(denial, /secret/i);
    // An ordinary out-of-bounds path keeps the old message.
    const outside = describePathDenial(path.join(os.tmpdir(), 'nowhere.txt'), workspace, []);
    assert.ok(outside && outside !== SECRET_PATH_DENIAL_MESSAGE);
    assert.strictEqual(describePathDenial(path.join(workspace, 'notes.md'), workspace, []), null);
  });

  describe('path-normalisation bypasses', () => {
    it('refuses a traversal spelling', () => {
      const target = path.join(workspace, '..', 'master.key');
      assert.strictEqual(isPathAllowed(target, dataDir, []), false);
    });

    it('refuses the temp files the atomic writers leave behind', () => {
      for (const name of ['chat-data.json.deadbeefcafe1234.tmp', 'config.json.0123456789abcdef.tmp', 'master.key.dpapi']) {
        assert.strictEqual(isProtectedSecretPath(path.join(dataDir, name)), true, name);
      }
    });

    it('refuses a not-yet-existing secret file (so it cannot be pre-planted or clobbered)', () => {
      const ghost = path.join(dataDir, 'master.key.new');
      assert.strictEqual(fs.existsSync(ghost), false);
      assert.strictEqual(isProtectedSecretPath(ghost), true);
    });

    it('refuses a symlink that points at a secret', { skip: isWindows ? 'symlink creation needs privileges on Windows' : false }, () => {
      const link = path.join(workspace, 'innocent.txt');
      fs.symlinkSync(path.join(dataDir, 'master.key'), link);
      assert.strictEqual(isPathAllowed(link, workspace, []), false);
    });

    it('refuses a path through a symlinked directory', { skip: isWindows ? 'symlink creation needs privileges on Windows' : false }, () => {
      const linkDir = path.join(workspace, 'peek');
      fs.symlinkSync(dataDir, linkDir, 'dir');
      assert.strictEqual(isPathAllowed(path.join(linkDir, 'gateway-token'), workspace, []), false);
    });

    it('refuses a hard link to a secret', () => {
      const link = path.join(workspace, 'harmless.bin');
      try {
        fs.linkSync(path.join(dataDir, 'master.key'), link);
      } catch (err) {
        return; // same-volume hard links unavailable here
      }
      assert.strictEqual(isPathAllowed(link, workspace, []), false);
    });

    it('refuses case-variant spellings', { skip: isWindows ? false : 'case-insensitive lookup is a Windows/macOS behaviour' }, () => {
      assert.strictEqual(isPathAllowed(path.join(dataDir, 'MASTER.KEY'), dataDir, []), false);
      assert.strictEqual(isPathAllowed(path.join(dataDir, 'Gateway-Token'), dataDir, []), false);
    });

    it('refuses an NTFS alternate-data-stream spelling', { skip: isWindows ? false : 'NTFS streams are Windows-only' }, () => {
      const ads = `${path.join(dataDir, 'master.key')}::$DATA`;
      assert.strictEqual(fs.readFileSync(ads, 'utf8'), SECRETS['master.key'], 'precondition: ::$DATA reads the file');
      assert.strictEqual(isPathAllowed(ads, dataDir, []), false);
    });

    it('refuses trailing dot/space spellings', { skip: isWindows ? false : 'Win32 name munging is Windows-only' }, () => {
      assert.strictEqual(isPathAllowed(`${path.join(dataDir, 'master.key')}.`, dataDir, []), false);
      assert.strictEqual(isPathAllowed(`${path.join(dataDir, 'master.key')} `, dataDir, []), false);
    });

    it('refuses an 8.3 short-name spelling when the volume has one', { skip: isWindows ? false : 'short names are Windows-only' }, () => {
      // MASTER~1.KEY only resolves on volumes with 8.3 generation enabled; when
      // it does not resolve there is nothing to bypass.
      const short = path.join(dataDir, 'MASTER~1.KEY');
      if (!fs.existsSync(short)) return;
      assert.strictEqual(isPathAllowed(short, dataDir, []), false);
    });
  });

  describe('the tools that route through isPathAllowed', () => {
    it('Read refuses a secret', async () => {
      await assert.rejects(
        () => readTool.execute({ file_path: path.join(dataDir, 'master.key') }, { workingDirectory: dataDir }),
        /secret/i
      );
    });

    it('Write refuses to clobber a secret', async () => {
      await assert.rejects(
        () => writeTool.execute({ file_path: path.join(dataDir, 'gateway-token'), content: 'attacker-token' }, { workingDirectory: dataDir }),
        /secret/i
      );
      assert.strictEqual(fs.readFileSync(path.join(dataDir, 'gateway-token'), 'utf8'), SECRETS['gateway-token']);
    });

    it('Edit refuses a secret', async () => {
      await assert.rejects(
        () => editTool.execute(
          { file_path: path.join(dataDir, 'config.json'), old_string: 'v10:CIPHERTEXT', new_string: 'x' },
          { workingDirectory: dataDir }
        ),
        /secret/i
      );
    });

    it('MultiEdit refuses a secret', async () => {
      const result = await multiEditTool.execute(
        { edits: [{ file_path: path.join(dataDir, 'config.json'), old_string: 'v10:CIPHERTEXT', new_string: 'x' }] },
        { workingDirectory: dataDir }
      );
      const errors = JSON.stringify(result);
      assert.match(errors, /secret/i);
      assert.match(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), /v10:CIPHERTEXT/);
    });

    it('Grep refuses the data dir as a search root', async () => {
      const result = await grepTool.execute({ pattern: '.', path: dataDir }, { workingDirectory: dataDir });
      assert.strictEqual(result.ok, true);
      const body = JSON.stringify(result.matches);
      assert.ok(!body.includes('SUPERSECRETBEARER'), 'gateway token leaked through Grep');
      assert.ok(!body.includes('aabbccddeeff'), 'master key leaked through Grep');
      assert.ok(!body.includes('v10:CIPHERTEXT'), 'vault ciphertext leaked through Grep');
    });

    it('Grep refuses a secret named directly as the search path', async () => {
      const result = await grepTool.execute(
        { pattern: '.', path: path.join(dataDir, 'master.key') },
        { workingDirectory: dataDir }
      );
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /secret/i);
    });

    it('Grep still finds ordinary files in the workspace', async () => {
      const result = await grepTool.execute({ pattern: 'ordinary', path: workspace }, { workingDirectory: workspace });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.matches.length, 1);
    });

    it('Glob does not enumerate the secret files', async () => {
      const result = await globTool.execute({ pattern: '*', cwd: dataDir }, { workingDirectory: dataDir });
      assert.strictEqual(result.ok, true);
      const names = result.files.map((f) => path.basename(f.path).toLowerCase());
      for (const secret of Object.keys(SECRETS)) {
        assert.ok(!names.includes(secret), `Glob listed ${secret}`);
      }
      assert.ok(names.includes('workspace'), 'Glob should still list ordinary entries');
    });

    it('Glob refuses a secret named directly as cwd', async () => {
      const result = await globTool.execute(
        { pattern: '*', cwd: path.join(dataDir, 'master.key') },
        { workingDirectory: dataDir }
      );
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /secret/i);
    });
  });
});
