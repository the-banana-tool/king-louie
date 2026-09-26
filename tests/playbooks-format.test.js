// tests/playbooks-format.test.js
// The playbook package format (cases stage 6 spec §3.2, §4.1–§4.3).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const f = require('../src/cases/playbooks/format');
const { PLAYBOOK_YAML, STEPS_MD, writePackage, withYaml } = require('./helpers/playbook-fixture');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-pbfmt-')); dirs.push(d); return d; };
const messages = (r) => r.errors.map((e) => e.message);
const yamlErrors = (text, opts = {}) => messages(f.parsePlaybookYaml(text, { dirName: 'land-sale', ...opts }));

describe('parsePlaybookYaml', () => {
  it('accepts the fixture and fills defaults', () => {
    const r = f.parsePlaybookYaml(PLAYBOOK_YAML, { dirName: 'land-sale' });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.value.version, '1.2.0');
    assert.deepStrictEqual(r.value.executors, ['web', 'phone-agent', 'owner']);
    const [floor, financing, parcel] = r.value.gatingQuestions;
    assert.strictEqual(floor.required, true);
    assert.strictEqual(floor.category, 'financial');
    assert.deepStrictEqual(floor.fact, { subject: 'property', attr: 'floor-price' });
    assert.deepStrictEqual(financing.options, [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]);
    assert.strictEqual(financing.required, false);
    assert.strictEqual(parcel.answerable, 'web');
    assert.deepStrictEqual(r.value.budgetDefaults, { usd: 10, contactsPerDay: 5, questionsPerDay: 4 });
  });

  it('bare numeric version is an error', () => {
    assert.deepStrictEqual(yamlErrors(withYaml(/version: "1.2.0"/, 'version: 1.2')), ['version must be a quoted string like "1.2.0"']);
    assert.match(yamlErrors(withYaml(/version: "1.2.0"/, 'version: "1.2"'))[0], /must be MAJOR\.MINOR\.PATCH/);
  });

  it('name must be a slug equal to the directory name', () => {
    assert.deepStrictEqual(yamlErrors(PLAYBOOK_YAML, { dirName: 'other' }), ['name "land-sale" must equal the directory name "other"']);
    assert.match(yamlErrors(withYaml(/name: land-sale/, 'name: Land_Sale'))[0], /name must match/);
    assert.deepStrictEqual(yamlErrors(PLAYBOOK_YAML, { dirName: null }), []);
  });

  it('refuses a Windows reserved device name as the playbook name', () => {
    for (const bad of ['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9']) {
      assert.strictEqual(f.NAME_RE.test(bad), false, bad);
      assert.match(yamlErrors(withYaml(/name: land-sale/, `name: ${bad}`), { dirName: bad })[0], /name must match/);
    }
    // Not a prefix ban: "console" and "computer" are ordinary names.
    assert.strictEqual(f.NAME_RE.test('console'), true);
    assert.strictEqual(f.NAME_RE.test('computer'), true);
  });

  it('refuses unknown keys, duplicate keys and bad syntax with a position', () => {
    assert.deepStrictEqual(yamlErrors(`${PLAYBOOK_YAML}author: someone\n`), ['unknown key "author"']);
    assert.match(yamlErrors(`${PLAYBOOK_YAML}title: Again\n`)[0], /duplicated mapping key/);
    assert.match(yamlErrors('name: land-sale\n  version: [\n')[0], /\(\d+:\d+\)/);
  });

  it('checks executors and caseType', () => {
    assert.match(yamlErrors(withYaml(/executors: .*/, 'executors: []'))[0], /non-empty list/);
    assert.match(yamlErrors(withYaml(/executors: .*/, 'executors: [web, web, owner]')).join('\n'), /may appear once/);
    const unknown = withYaml(/caseType: general/, 'caseType: outreach');
    assert.match(yamlErrors(unknown, { knownCaseTypes: ['general', 'software-repo'] })[0], /caseType "outreach" is not a known case type \(general, software-repo\)/);
    const r = f.parsePlaybookYaml(unknown, { dirName: 'land-sale' });
    assert.deepStrictEqual(r.errors, []);
    assert.match(r.warnings[0].message, /caseType "outreach" cannot be checked/);
  });

  it('never stringifies a non-string executor entry into the error message', () => {
    // A nested object/array here must be named, not rendered: a naive
    // `${e}` template would call the value's own toString(), which for a
    // large or (pre alias-refusal) shared nested structure is itself the
    // "expand a bomb into a message" bug.
    const nested = withYaml(/executors: .*/, 'executors: [web, { a: { b: [1, 2, 3] } }]');
    const msgs = yamlErrors(nested);
    assert.match(msgs.join('\n'), /executors: "<a mapping>" is not a lowercase slug/);
    assert.ok(msgs.join('\n').length < 500, 'the message must stay small regardless of the nested value');
  });

  it('checks gating questions', () => {
    const q = (extra) => [
      'name: land-sale', 'version: "1.0.0"', 'caseType: general', 'executors: [web, owner]', 'gatingQuestions:',
      '  - id: floor', '    text: Lowest price?', '    fact: { subject: property, attr: floor-price }', ...extra
    ].join('\n');
    assert.match(yamlErrors(q(['    answerable: phone-agent']))[0], /answerable must be "owner" or one of executors \(web, owner\)/);
    assert.match(yamlErrors(q(['    answerable: web', '    briefField: hardConstraints']))[0], /briefField is only for owner-answerable/);
    assert.match(yamlErrors(q(['    answerable: owner', '    briefField: resources']))[0], /briefField must be one of why, hardConstraints, alreadyTried, successCriteria, deadline/);
    assert.match(yamlErrors(q(['    answerable: owner', '    category: medical']))[0], /category must be one of personal, financial, legal, health/);
    assert.match(yamlErrors(q(['    answerable: owner', '    options: [{ id: "a", label: A }]']))[0], /options must be a list of 2 to 6/);
    assert.match(yamlErrors(q(['    answerable: owner', '    options: [{ id: 1, label: One }, { id: 2, label: Two }]']))[0], /option ids must be quoted strings/);
    assert.match(yamlErrors(q(['    answerable: owner', '    required: maybe']))[0], /required must be true or false/);
    assert.match(yamlErrors(q(['    answerable: owner', '    hint: x']))[0], /unknown key "hint"/);
    const noFact = q(['    answerable: owner']).replace('    fact: { subject: property, attr: floor-price }\n', '');
    assert.match(yamlErrors(noFact)[0], /fact \{ subject, attr \} is required/);
    const twice = `${q(['    answerable: owner'])}\n  - id: floor2\n    text: Again?\n    fact: { subject: property, attr: floor-price }\n    answerable: owner`;
    assert.match(yamlErrors(twice)[0], /another question already asks for property\.floor-price/);
    const many = ['name: land-sale', 'version: "1.0.0"', 'caseType: general', 'executors: [owner]', 'gatingQuestions:'];
    for (let i = 0; i < 31; i += 1) many.push(`  - { id: q${i}, text: Q${i}?, fact: { subject: s, attr: a${i} }, answerable: owner }`);
    assert.match(yamlErrors(many.join('\n'))[0], /31 entries; at most 30/);
  });

  it('checks materiality and budget defaults', () => {
    assert.match(yamlErrors(withYaml(/materialityDefaults: .*/, 'materialityDefaults: { tell: [offers], ignore: [offers] }'))[0], /"offers" is in both tell and ignore/);
    assert.match(yamlErrors(withYaml(/budgetDefaults: .*/, 'budgetDefaults: { usd: 10, deadline: 2026-12-01 }'))[0], /unknown key "deadline"/);
    assert.match(yamlErrors(withYaml(/budgetDefaults: .*/, 'budgetDefaults: { usd: 0 }'))[0], /usd must be a number greater than 0/);
    assert.match(yamlErrors(withYaml(/budgetDefaults: .*/, 'budgetDefaults: { turnsPerDay: 1.5 }'))[0], /turnsPerDay must be a whole number/);
  });
});

describe('parseSteps', () => {
  const executors = ['web', 'phone-agent', 'owner'];

  it('reads the fixture: title, intro, ids, lists, notes', () => {
    const r = f.parseSteps(STEPS_MD, { executors });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.title, 'Land sale');
    assert.strictEqual(r.intro, 'Work through these in order unless a step says otherwise.');
    assert.deepStrictEqual(r.steps.map((s) => s.id), ['confirm-parcel', 'call-buyers']);
    assert.deepStrictEqual(r.steps[0].establishes, ['property.parcel-id', 'property.acreage']);
    assert.deepStrictEqual(r.steps[0].needs, ['property.county']);
    assert.strictEqual(r.steps[0].optional, false);
    assert.strictEqual(r.steps[1].optional, true);
    assert.strictEqual(r.steps[0].notes, 'Search the assessor by address; cite the parcel page in sources/.');
  });

  it('CRLF input reads the same', () => {
    assert.deepStrictEqual(f.parseSteps(STEPS_MD.replace(/\n/g, '\r\n'), { executors }), f.parseSteps(STEPS_MD, { executors }));
  });

  it('names an unknown key with the step id', () => {
    const r = f.parseSteps('## 1. Confirm {#confirm}\n- executor: web\n- establishes: a.b\n- owner: me\n', { executors });
    assert.deepStrictEqual(messages(r), ['steps.md step "confirm": unknown key "owner"']);
  });

  it('refuses missing or unlisted executors, bad lists, order and duplicates', () => {
    assert.match(messages(f.parseSteps('## 1. A\n- establishes: a.b\n', { executors }))[0], /step "a": executor is required/);
    assert.match(messages(f.parseSteps('## 1. A\n- executor: bash\n- establishes: a.b\n', { executors }))[0], /executor "bash" is not in playbook.yaml executors/);
    assert.match(messages(f.parseSteps('## 1. A\n- executor: web\n- establishes: acreage\n', { executors }))[0], /"acreage" is not subject\.attr/);
    assert.match(messages(f.parseSteps('## 2. A\n- executor: web\n- establishes: a.b\n## 1. B\n- executor: web\n- establishes: a.c\n', { executors }))[0], /step numbers must increase \(2 then 1\)/);
    assert.match(messages(f.parseSteps('## 1. A\n- executor: web\n- establishes: a.b\n## 2. A\n- executor: web\n- establishes: a.c\n', { executors }))[0], /step "a": the id is used twice/);
    assert.match(messages(f.parseSteps('## Confirm\n', { executors }))[0], /a step heading is "## <n>\. <title>"/);
    assert.match(messages(f.parseSteps('# Only a title\n', { executors }))[0], /has no steps/);
  });

  it('a heading with a lot of whitespace parses in linear time (no catastrophic backtracking)', () => {
    // The old `\s+(.+?)(?:\s+\{#([^}]*)\})?\s*$` had two whitespace-hungry
    // groups competing over the same run of spaces; a third party writing
    // steps.md controls this text, so this must stay fast for any amount
    // of whitespace, not just the small cases above.
    const heading = `## 1. a${' '.repeat(60000)}b\n`;
    const start = Date.now();
    const r = f.parseSteps(heading, { executors });
    assert.ok(Date.now() - start < 1000, 'parsing must not be exponential in the whitespace run');
    assert.strictEqual(r.steps.length, 1);
    assert.strictEqual(r.steps[0].title, `a${' '.repeat(60000)}b`);
  });
});

describe('parseBriefRules', () => {
  it('splits rules for all executors and per executor', () => {
    const r = f.parseBriefRules('- Be brief.\n\n## phone-agent\n- No address.\n- No other bids.\n', { executors: ['phone-agent'] });
    assert.deepStrictEqual(r, { all: ['Be brief.'], byExecutor: { 'phone-agent': ['No address.', 'No other bids.'] }, errors: [] });
  });

  it('refuses unlisted headings, prose, long rules and too many rules', () => {
    assert.match(messages(f.parseBriefRules('## web\n- x\n', { executors: ['owner'] }))[0], /"## web" is not one of playbook.yaml executors/);
    assert.match(messages(f.parseBriefRules('Some prose.\n', { executors: [] }))[0], /only "- " rules and "## <executor>" headings/);
    assert.match(messages(f.parseBriefRules(`- ${'x'.repeat(301)}\n`, { executors: [] }))[0], /longer than 300/);
    const many = Array.from({ length: 51 }, (_, i) => `- rule ${i}`).join('\n');
    assert.match(messages(f.parseBriefRules(many, { executors: [] }))[0], /51 rules; at most 50/);
  });
});

describe('validatePackage', () => {
  it('accepts the fixture and treats briefRules.md and sources.md as optional', () => {
    const dir = writePackage(path.join(tmp(), 'land-sale'));
    const r = f.validatePackage(dir);
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.briefRules.all, ['Cite the recorded plat for acreage.']);
    const bare = writePackage(path.join(tmp(), 'land-sale'), { 'briefRules.md': null, 'sources.md': null });
    const b = f.validatePackage(bare);
    assert.strictEqual(b.ok, true);
    assert.deepStrictEqual(b.briefRules, { all: [], byExecutor: {} });
    assert.strictEqual(b.sources, '');
  });

  it('requires playbook.yaml and steps.md', () => {
    const dir = writePackage(path.join(tmp(), 'land-sale'), { 'steps.md': null });
    assert.deepStrictEqual(messages(f.validatePackage(dir)), ['steps.md is missing']);
  });

  it('refuses other extensions, big files, too many files and big packages; allows LICENSE', () => {
    const dir = writePackage(path.join(tmp(), 'land-sale'), { 'run.js': 'module.exports = 1;\n', LICENSE: 'MIT\n' });
    assert.deepStrictEqual(messages(f.validatePackage(dir)), ['run.js: only .yaml, .md, .txt and LICENSE files are allowed']);
    const big = writePackage(path.join(tmp(), 'land-sale'), { 'notes.md': 'x'.repeat(256 * 1024 + 1) });
    assert.deepStrictEqual(messages(f.validatePackage(big)), ['notes.md: larger than 256 KiB']);
    const extra = {};
    for (let i = 0; i < 61; i += 1) extra[`notes/n${i}.md`] = 'n\n';
    assert.match(messages(f.validatePackage(writePackage(path.join(tmp(), 'land-sale'), extra))).join('\n'), /65 files; at most 64/);
    const heavy = {};
    for (let i = 0; i < 5; i += 1) heavy[`h${i}.md`] = 'x'.repeat(250 * 1024);
    assert.match(messages(f.validatePackage(writePackage(path.join(tmp(), 'land-sale'), heavy))).join('\n'), /larger than 1 MiB/);
    const sources = writePackage(path.join(tmp(), 'land-sale'), { 'sources.md': 'x'.repeat(64 * 1024 + 1) });
    assert.deepStrictEqual(messages(f.validatePackage(sources)), ['sources.md is larger than 64 KiB']);
  });

  it('refuses a symlink, or a Windows junction where a file symlink needs privilege', (t) => {
    const dir = writePackage(path.join(tmp(), 'land-sale'));
    try {
      fs.symlinkSync(path.join(dir, 'steps.md'), path.join(dir, 'link.md'));
      assert.deepStrictEqual(messages(f.validatePackage(dir)), ['link.md: symbolic links are not allowed']);
      return;
    } catch {
      // Fall through: a file symlink needs dev mode or admin on Windows,
      // but a directory junction does not, and lstat reports a junction as
      // a symbolic link the same way, so it exercises the same check.
    }
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-pbfmt-junction-'));
    dirs.push(target);
    fs.writeFileSync(path.join(target, 'x.md'), 'x\n');
    try {
      fs.symlinkSync(target, path.join(dir, 'linked'), 'junction');
    } catch {
      return t.skip('neither a file symlink nor a junction can be created here');
    }
    assert.deepStrictEqual(messages(f.validatePackage(dir)), ['linked: symbolic links are not allowed']);
  });

  it('refuses each segment against a character whitelist, and a trailing "."', () => {
    const dir = writePackage(path.join(tmp(), 'land-sale'));
    fs.writeFileSync(path.join(dir, 'bad name.md'), 'x\n');
    assert.match(messages(f.validatePackage(dir)).join('\n'), /names must be 1 to 100 characters of A-Z, a-z, 0-9, "_", "\.", "-"/);

    const dotted = writePackage(path.join(tmp(), 'land-sale'));
    fs.writeFileSync(path.join(dotted, 'trailing.md.'), 'x\n');
    assert.match(messages(f.validatePackage(dotted)).join('\n'), /must not end with "\."/);
  });

  it('refuses two entries that collide once case and accents are folded', (t) => {
    const dir = writePackage(path.join(tmp(), 'land-sale'));
    fs.writeFileSync(path.join(dir, 'Notes.md'), 'a\n');
    fs.writeFileSync(path.join(dir, 'notes.md'), 'b\n');
    // On the case-insensitive filesystem this dev machine actually has, the
    // second write above overwrote the first (there is no way to make two
    // real directory entries collide here) — the check still matters for a
    // package checked out on a case-sensitive filesystem (Linux git) and
    // then validated or vendored onto a case-insensitive one (Windows,
    // commonly macOS), so this only runs where it can actually be exercised.
    if (fs.readdirSync(dir).filter((n) => n.toLowerCase() === 'notes.md').length < 2) {
      return t.skip('this filesystem is case-insensitive; the two names collided before the walk ever ran');
    }
    assert.match(messages(f.validatePackage(dir)).join('\n'), /collides with/);
  });

  it('detects a case-fold collision deterministically (a simulated directory listing)', () => {
    // This exercises the same check without depending on the host
    // filesystem's own case sensitivity: the collision is caught by
    // comparing the two spellings before either is ever lstat-ed, so it
    // does not matter that they resolve to the same real file underneath.
    const dir = writePackage(path.join(tmp(), 'land-sale'));
    fs.writeFileSync(path.join(dir, 'Notes.md'), 'a\n');
    const targetDir = path.resolve(dir);
    const original = fs.readdirSync;
    fs.readdirSync = function patched(p, ...rest) {
      const result = original.call(fs, p, ...rest);
      return path.resolve(String(p)) === targetDir ? [...result, 'notes.MD'] : result;
    };
    try {
      assert.match(messages(f.validatePackage(dir)).join('\n'), /collides with/);
    } finally {
      fs.readdirSync = original;
    }
  });

  it('refuses a Windows reserved device name even when it can only be created via an extended-length path', (t) => {
    const dir = writePackage(path.join(tmp(), 'land-sale'));
    const target = path.join(dir, 'con.md');
    try {
      fs.writeFileSync(`\\\\?\\${target}`, 'x\n');
    } catch {
      return t.skip('cannot create a reserved-name file in this environment');
    }
    assert.deepStrictEqual(messages(f.validatePackage(dir)), ['con.md: "con.md" is a reserved Windows device name']);
  });

  it('refuses a NUL byte or invalid UTF-8 in playbook.yaml/steps.md/briefRules.md/sources.md', () => {
    const nul = writePackage(path.join(tmp(), 'land-sale'));
    fs.writeFileSync(path.join(nul, 'sources.md'), Buffer.from('one\0two\n'));
    assert.deepStrictEqual(messages(f.validatePackage(nul)), ['sources.md contains a NUL byte']);

    const badUtf8 = writePackage(path.join(tmp(), 'land-sale'));
    // 0xC3 alone is the first byte of a 2-byte sequence with no second byte:
    // invalid UTF-8. Node's lenient default decoding would silently turn
    // this into a U+FFFD replacement character instead of failing.
    fs.writeFileSync(path.join(badUtf8, 'briefRules.md'), Buffer.from([0x2d, 0x20, 0xc3, 0x0a]));
    assert.deepStrictEqual(messages(f.validatePackage(badUtf8)), ['briefRules.md is not valid UTF-8']);
  });

  it('excludes .git and dot-prefixed entries from validation and hashing', () => {
    const dir = writePackage(path.join(tmp(), 'land-sale'));
    const before = f.hashPackage(dir);
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n');
    fs.writeFileSync(path.join(dir, '.hidden.js'), 'x');
    assert.strictEqual(f.validatePackage(dir).ok, true);
    assert.strictEqual(f.hashPackage(dir), before);
  });

  it('hashes CRLF and LF copies equally, and a changed byte differently', () => {
    const lf = writePackage(path.join(tmp(), 'land-sale'));
    const crlf = writePackage(path.join(tmp(), 'land-sale'), {
      'steps.md': STEPS_MD.replace(/\n/g, '\r\n'),
      'playbook.yaml': PLAYBOOK_YAML.replace(/\n/g, '\r\n')
    });
    assert.strictEqual(f.hashPackage(crlf), f.hashPackage(lf));
    assert.match(f.hashPackage(lf), /^sha256:[0-9a-f]{64}$/);
    fs.appendFileSync(path.join(lf, 'sources.md'), '- one more\n');
    assert.notStrictEqual(f.hashPackage(lf), f.hashPackage(crlf));
  });

  it('hashes a package that no longer validates, as long as the walk was not truncated', () => {
    // hashPackage/fileHashes detect drift from a pristine vendored copy,
    // including a copy an owner has edited into something that no longer
    // validates (an extra file, say). Task 11 hashes before checking
    // force, so an ordinary validation problem here must not block it.
    const dir = writePackage(path.join(tmp(), 'land-sale'), { 'run.js': 'module.exports = 1;\n' });
    assert.strictEqual(f.validatePackage(dir).ok, false);
    assert.match(f.hashPackage(dir), /^sha256:[0-9a-f]{64}$/);
  });

  it('never reads a file already flagged oversized', () => {
    const dir = writePackage(path.join(tmp(), 'land-sale'), { 'sources.md': 'x'.repeat(2 * 1024 * 1024) });
    const bigAbs = path.resolve(path.join(dir, 'sources.md'));
    const original = fs.readFileSync;
    let readBig = false;
    fs.readFileSync = function patched(p, ...rest) {
      if (path.resolve(String(p)) === bigAbs) readBig = true;
      return original.call(fs, p, ...rest);
    };
    try {
      const r = f.validatePackage(dir);
      assert.match(messages(r).join('\n'), /larger than 256 KiB/);
      assert.strictEqual(readBig, false, 'validatePackage must not read the oversized file into memory');
      assert.throws(() => f.hashPackage(dir), { code: 'PACKAGE_TOO_LARGE' });
      assert.strictEqual(readBig, false, 'hashPackage must not read the oversized file into memory either');
    } finally {
      fs.readFileSync = original;
    }
  });

  it('stops the walk after 512 entries even when nowhere near the file-count limit', () => {
    const dir = writePackage(path.join(tmp(), 'land-sale'));
    for (let i = 0; i < 520; i += 1) fs.mkdirSync(path.join(dir, `empty-${i}`));
    const start = Date.now();
    const r = f.validatePackage(dir);
    assert.ok(Date.now() - start < 2000, 'the walk must stop, not enumerate every empty directory');
    assert.match(messages(r).join('\n'), /512 entries/);
    assert.throws(() => f.hashPackage(dir), { code: 'PACKAGE_TOO_LARGE' });
  });

  it('refuses nesting deeper than 8 levels', () => {
    const deep = Array.from({ length: 10 }, (_, i) => `d${i}`).join('/');
    const dir = writePackage(path.join(tmp(), 'land-sale'), { [`${deep}/deep.md`]: 'x\n' });
    assert.match(messages(f.validatePackage(dir)).join('\n'), /nested more than 8 levels deep/);
    assert.throws(() => f.hashPackage(dir), { code: 'PACKAGE_TOO_LARGE' });
  });
});

describe('compareVersions', () => {
  it('orders by semver 2.0 precedence, pre-releases included', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '10.0.0'];
    for (let i = 0; i < ordered.length - 1; i += 1) {
      assert.strictEqual(f.compareVersions(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
      assert.strictEqual(f.compareVersions(ordered[i + 1], ordered[i]), 1);
    }
    assert.strictEqual(f.compareVersions('1.2.0', '1.2.0'), 0);
    assert.strictEqual(f.majorOf('3.4.5'), 3);
  });

  it('takes strings only', () => {
    assert.throws(() => f.compareVersions(1.2, '1.2.0'), /must be a string/);
    assert.throws(() => f.compareVersions('1.2', '1.2.0'), /Invalid version "1\.2"/);
  });

  it('compares huge numeric parts by length then lexicographically, never through Number', () => {
    // 20 nines vs. a 21-digit number one bigger: Number(smaller) and
    // Number(bigger) both round to values well past MAX_SAFE_INTEGER and
    // could easily compare equal or backwards if compareVersions ever ran
    // them through Number().
    const almost = '99999999999999999999.0.0';
    const oneMore = '100000000000000000000.0.0';
    assert.strictEqual(f.compareVersions(almost, oneMore), -1);
    assert.strictEqual(f.compareVersions(oneMore, almost), 1);
    // Same digit count, so it's a lexicographic (not length) comparison.
    assert.strictEqual(f.compareVersions('123.0.0', '124.0.0'), -1);
    // The same precision guard applies to a numeric pre-release identifier.
    assert.strictEqual(f.compareVersions('1.0.0-99999999999999999999', '1.0.0-100000000000000000000'), -1);
  });

  it('forbids a leading zero in a numeric pre-release identifier', () => {
    assert.throws(() => f.parseVersion('1.0.0-01'), /Invalid version/);
    assert.throws(() => f.parseVersion('1.0.0-alpha.01'), /Invalid version/);
    // A purely-numeric "0" alone, and an alphanumeric identifier that merely
    // starts with a digit, are both still fine.
    assert.doesNotThrow(() => f.parseVersion('1.0.0-0'));
    assert.doesNotThrow(() => f.parseVersion('1.0.0-0a'));
  });

  it('caps a version at 64 characters', () => {
    const long = `1.0.0-${'a'.repeat(70)}`;
    assert.ok(long.length > 64);
    assert.throws(() => f.parseVersion(long), /Invalid version/);
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level and drops undefined', () => {
    assert.strictEqual(f.canonicalJson({ b: 1, a: { d: [2, { z: 1, y: null }], c: 'x' }, u: undefined }), '{"a":{"c":"x","d":[2,{"y":null,"z":1}]},"b":1}');
  });
});
