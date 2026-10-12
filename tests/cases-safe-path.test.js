// tests/cases-safe-path.test.js
// A guarded directory has many names on Windows: the loopback admin share
// under any host name or address, the NT object namespace, a volume GUID, a
// device path. segmentsWithin must place every one of them, and the guards
// built on it must refuse a write through any of them.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { segmentsWithin, locateWithin, stripLongPathPrefix } = require('../src/cases/safe-path');
const { isProtectedCasePath, caseWriteRefusal } = require('../src/cases/chat-integration');
const { caseToolGuard, configureCaseGuard } = require('../src/cases/executors/case-guard');
const ToolExecutor = require('../src/execution/tool-executor');
const { initializeTools } = require('../src/tools');

const WIN = process.platform === 'win32';
const dirs = [];
after(() => {
  configureCaseGuard({});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// A guarded dir with one file, and a sibling dir that is outside it. Built
// under the native real path of TEMP: a CI runner's TEMP is an 8.3 name.
function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'kl-safe-'));
  dirs.push(root);
  const dir = path.join(root, 'guarded');
  const outside = path.join(root, 'elsewhere');
  fs.mkdirSync(dir);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(dir, 'facts.jsonl'), '{"kind":"fact"}\n');
  fs.writeFileSync(path.join(outside, 'facts.jsonl'), 'x\n');
  return { root, dir, outside };
}

// Every spelling of a drive-letter path this machine might accept:
// name → (absolute drive path) → alias. A form the machine does not have
// (no admin share, another volume number) is skipped where it is used.
function aliasForms(sample) {
  const drive = sample[0];
  const unc = (hostName) => (p) => `\\\\${hostName}\\${drive}$${p.slice(2)}`;
  const forms = {
    '\\\\localhost\\C$': unc('localhost'),
    '\\\\LOCALHOST\\c$ (other case)': (p) => `\\\\LOCALHOST\\${drive.toLowerCase()}$${p.slice(2)}`,
    '\\\\127.0.0.1\\C$': unc('127.0.0.1'),
    '\\\\[::1]\\C$': unc('[::1]'),
    '\\\\<hostname>\\C$': unc(os.hostname()),
    '\\\\?\\UNC\\localhost\\C$': (p) => `\\\\?\\UNC\\localhost\\${drive}$${p.slice(2)}`,
    '\\\\.\\UNC\\localhost\\C$': (p) => `\\\\.\\UNC\\localhost\\${drive}$${p.slice(2)}`,
    '\\\\?\\GLOBALROOT\\??\\C:': (p) => `\\\\?\\GLOBALROOT\\??\\${p}`,
    '\\\\?\\GLOBALROOT\\GLOBAL??\\C:': (p) => `\\\\?\\GLOBALROOT\\GLOBAL??\\${p}`,
    '\\\\.\\GLOBALROOT\\DosDevices\\C:': (p) => `\\\\.\\GLOBALROOT\\DosDevices\\${p}`,
    '\\\\?\\GLOBALROOT\\??\\UNC\\localhost\\C$': (p) => `\\\\?\\GLOBALROOT\\??\\UNC\\localhost\\${drive}$${p.slice(2)}`,
    '\\\\?\\GLOBALROOT\\Device\\Mup\\localhost\\C$': (p) => `\\\\?\\GLOBALROOT\\Device\\Mup\\localhost\\${drive}$${p.slice(2)}`,
    '\\\\?\\C:': (p) => `\\\\?\\${p}`,
    '\\\\.\\C:': (p) => `\\\\.\\${p}`
  };
  let volume = '';
  try {
    volume = execFileSync('mountvol', [`${drive}:\\`, '/L'], { encoding: 'utf8' }).trim().replace(/\\$/, '');
  } catch {}
  if (/^\\\\\?\\Volume\{[0-9a-f-]+\}$/i.test(volume)) {
    forms['\\\\?\\Volume{guid}'] = (p) => `${volume}${p.slice(2)}`;
    forms['\\\\.\\Volume{guid}'] = (p) => `\\\\.\\${volume.slice(4)}${p.slice(2)}`;
  }
  for (let n = 1; n <= 32; n += 1) {
    const device = (p) => `\\\\?\\GLOBALROOT\\Device\\HarddiskVolume${n}${p.slice(2)}`;
    if (fs.existsSync(device(sample))) {
      forms['\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeN'] = device;
      break;
    }
  }
  return forms;
}

describe('stripLongPathPrefix', { skip: !WIN }, () => {
  it('strips the prefix of a drive path, turns the UNC form into a UNC path, and leaves the rest alone', () => {
    assert.strictEqual(stripLongPathPrefix('\\\\?\\C:\\a\\b'), 'C:\\a\\b');
    assert.strictEqual(stripLongPathPrefix('\\\\.\\C:\\a\\b'), 'C:\\a\\b');
    assert.strictEqual(stripLongPathPrefix('\\\\?\\UNC\\host\\share\\a'), '\\\\host\\share\\a');
    assert.strictEqual(stripLongPathPrefix('\\\\.\\unc\\host\\share\\a'), '\\\\host\\share\\a');
    // Never a relative path: that would be resolved under the working directory.
    assert.strictEqual(stripLongPathPrefix('\\\\?\\GLOBALROOT\\??\\C:\\a'), '\\\\?\\GLOBALROOT\\??\\C:\\a');
    assert.strictEqual(stripLongPathPrefix('\\\\?\\Volume{x}\\a'), '\\\\?\\Volume{x}\\a');
    assert.strictEqual(stripLongPathPrefix('C:\\a\\b'), 'C:\\a\\b');
  });
});

describe('segmentsWithin: ordinary paths', () => {
  it('places paths below a base that exists and one that does not exist yet', () => {
    const { root, dir, outside } = fixture();
    assert.deepStrictEqual(segmentsWithin(dir, dir), []);
    assert.deepStrictEqual(segmentsWithin(dir, path.join(dir, 'facts.jsonl')), ['facts.jsonl']);
    assert.deepStrictEqual(segmentsWithin(dir, path.join(dir, 'new', 'x.md')), ['new', 'x.md']);
    assert.strictEqual(segmentsWithin(dir, path.join(outside, 'facts.jsonl')), null);
    assert.strictEqual(segmentsWithin(dir, root), null);
    const later = path.join(root, 'later', 'case');
    assert.deepStrictEqual(segmentsWithin(later, later), []);
    assert.deepStrictEqual(segmentsWithin(later, path.join(later, '.kl', 'x.json')), ['.kl', 'x.json']);
    assert.strictEqual(segmentsWithin(later, path.join(root, 'later', 'other', 'x.json')), null);
    assert.deepStrictEqual(locateWithin(dir, path.join(outside, 'x')), { segments: null, unverifiable: false });
  });
});

describe('segmentsWithin: Windows aliases of the guarded directory', { skip: !WIN }, () => {
  const { root, dir, outside } = WIN ? fixture() : {};
  const forms = WIN ? aliasForms(path.join(dir, 'facts.jsonl')) : {};
  const later = WIN ? path.join(root, 'later', 'case') : '';

  for (const [name, alias] of Object.entries(forms)) {
    it(`${name}`, (t) => {
      if (!fs.existsSync(alias(path.join(dir, 'facts.jsonl')))) return t.skip(`this machine has no ${name}`);
      // The guarded directory itself.
      assert.deepStrictEqual(segmentsWithin(dir, alias(dir)), []);
      // A file that exists, one that does not, and one in a folder that does not.
      assert.deepStrictEqual(segmentsWithin(dir, alias(path.join(dir, 'facts.jsonl'))), ['facts.jsonl']);
      assert.deepStrictEqual(segmentsWithin(dir, alias(path.join(dir, 'new.jsonl'))), ['new.jsonl']);
      assert.deepStrictEqual(segmentsWithin(dir, alias(path.join(dir, '.KL', 'Ingest', 'x.json'))), ['.kl', 'ingest', 'x.json']);
      // The cleaning still applies below an alias.
      assert.deepStrictEqual(segmentsWithin(dir, `${alias(path.join(dir, 'FACTS.JSONL'))}::$DATA`), ['facts.jsonl']);
      assert.deepStrictEqual(segmentsWithin(dir, alias(path.join(dir, 'new. ', 'x.md.'))), ['new', 'x.md']);
      // Really outside: a sibling folder, the parent, a file beside the base.
      assert.strictEqual(segmentsWithin(dir, alias(path.join(outside, 'facts.jsonl'))), null);
      assert.strictEqual(segmentsWithin(dir, alias(path.join(outside, 'no', 'x.md'))), null);
      assert.strictEqual(segmentsWithin(dir, alias(root)), null);
      assert.strictEqual(segmentsWithin(dir, alias(`${dir}-notes.md`)), null);
      assert.deepStrictEqual(locateWithin(dir, alias(path.join(outside, 'facts.jsonl'))), { segments: null, unverifiable: false });
      // The base under an alias, the target plain.
      assert.deepStrictEqual(segmentsWithin(alias(dir), path.join(dir, 'facts.jsonl')), ['facts.jsonl']);
      // A base that does not exist yet.
      assert.deepStrictEqual(segmentsWithin(later, alias(later)), []);
      assert.deepStrictEqual(segmentsWithin(later, alias(path.join(later, 'facts.jsonl'))), ['facts.jsonl']);
      assert.strictEqual(segmentsWithin(later, alias(path.join(root, 'later', 'other', 'facts.jsonl'))), null);
    });

    it(`${name}: the guards refuse a write through it`, (t) => {
      const facts = alias(path.join(dir, 'facts.jsonl'));
      if (!fs.existsSync(facts)) return t.skip(`this machine has no ${name}`);
      assert.strictEqual(isProtectedCasePath(dir, facts), true);
      assert.strictEqual(isProtectedCasePath(dir, alias(path.join(dir, '.kl', 'budget.json'))), true);
      assert.strictEqual(isProtectedCasePath(dir, alias(path.join(dir, 'artifacts', 'sheet.md'))), false);
      assert.strictEqual(isProtectedCasePath(dir, alias(path.join(outside, 'facts.jsonl'))), false);
      // The case-turn guard, with the same folder standing in for the data dir.
      configureCaseGuard({ dataDir: dir });
      const ctx = { caseContext: { dir: outside }, workingDirectory: outside };
      const write = (file_path) => caseToolGuard('Write', { file_path, content: 'x' }, ctx);
      assert.strictEqual(write(alias(path.join(dir, 'ops-memory.jsonl'))).success, false);
      assert.strictEqual(write(alias(path.join(dir, 'executors', 'pkg', 'adapter.js'))).success, false);
      assert.strictEqual(write(alias(path.join(dir, 'notes.md'))), null);
      assert.strictEqual(write(alias(path.join(outside, 'ops-memory.jsonl'))), null);
      const multi = caseToolGuard('MultiEdit', { edits: [{ file_path: alias(path.join(dir, 'history.sqlite')), old_string: 'a', new_string: 'b' }] }, ctx);
      assert.strictEqual(multi.success, false);
    });
  }

  it('the executor leaves facts.jsonl alone when Write, Edit and MultiEdit name it through an alias', async (t) => {
    initializeTools();
    const facts = path.join(dir, 'facts.jsonl');
    const usable = Object.entries(forms).filter(([, alias]) => fs.existsSync(alias(facts)));
    if (!usable.length) return t.skip('no alias form exists on this machine');
    configureCaseGuard({});
    const executor = new ToolExecutor({
      workingDirectory: dir,
      runtimeEnvironment: { platform: process.platform },
      requireApproval: false,
      useSandbox: false,
      extraToolOptions: { caseContext: { dir } }
    });
    const before = fs.readFileSync(facts, 'utf8');
    for (const [name, alias] of usable) {
      const w = await executor.execute('Write', { file_path: alias(facts), content: 'rewritten\n' });
      assert.strictEqual(w.success, false, name);
      assert.match(w.error, /Ledger tool/, name);
      const e = await executor.execute('Edit', { file_path: alias(facts), old_string: 'fact', new_string: 'fiction' });
      assert.match(e.error, /Ledger tool/, name);
      const m = await executor.execute('MultiEdit', { edits: [{ file_path: alias(facts), old_string: 'fact', new_string: 'fiction' }] });
      assert.match(m.error, /Ledger tool/, name);
      assert.strictEqual(fs.readFileSync(facts, 'utf8'), before, name);
    }
  });
});

describe('a network or device path whose place cannot be read', { skip: !WIN }, () => {
  // A share this machine does not have: every stat fails, and not with
  // "no such file". Nothing proves the path is outside the case.
  const lost = '\\\\localhost\\kl-no-such-share-0100\\facts.jsonl';

  it('is not placed, and is reported as unverifiable', () => {
    const { dir } = fixture();
    assert.deepStrictEqual(locateWithin(dir, lost), { segments: null, unverifiable: true });
    assert.strictEqual(segmentsWithin(dir, lost), null);
    // An ordinary path that does not exist is simply outside.
    assert.deepStrictEqual(locateWithin(dir, 'C:\\kl-no-such-dir-0100\\x\\facts.jsonl'), { segments: null, unverifiable: false });
  });

  it('is refused by both write guards', async () => {
    const { dir, outside } = fixture();
    assert.strictEqual(caseWriteRefusal(dir, lost), 'unverifiable');
    assert.strictEqual(isProtectedCasePath(dir, lost), true);
    configureCaseGuard({ dataDir: dir });
    const r = caseToolGuard('Write', { file_path: lost, content: 'x' }, { caseContext: { dir: outside }, workingDirectory: outside });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /could not be confirmed/);
    configureCaseGuard({});
    initializeTools();
    const executor = new ToolExecutor({
      workingDirectory: dir,
      runtimeEnvironment: { platform: process.platform },
      requireApproval: false,
      useSandbox: false,
      extraToolOptions: { caseContext: { dir } }
    });
    const w = await executor.execute('Write', { file_path: lost, content: 'x' });
    assert.strictEqual(w.success, false);
    assert.match(w.error, /could not be confirmed/);
  });
});
