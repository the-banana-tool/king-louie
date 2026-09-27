// tests/playbooks-ipc.test.js
// Playbook IPC and case:create with playbooks (cases stage 6 spec §7).
// Every reply carries untrustedText: true — its strings are plain text for
// textContent (validator and loader messages quote package text).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/cases/git');
const IPC = require('../src/ipc/constants');
const { CaseRuntime } = require('../src/cases');
const { installPlaybooks } = require('../src/cases/playbooks');
const { readState, writeState } = require('../src/cases/playbooks/changes');
const { MAX_PATCH_BYTES } = require('../src/cases/playbooks/proposals');
const { registerCaseHandlers } = require('../src/ipc/case-handlers');
const { registerPlaybookHandlers } = require('../src/ipc/playbook-handlers');
const { createBridgeDispatcher } = require('../src/desktop-bridge/bridge-dispatcher');
const { createConnection } = require('../src/desktop-bridge/connection');
const { writePackage, makeGitPackage, PLAYBOOK_YAML, STEPS_MD, withYaml } = require('./helpers/playbook-fixture');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-pbipc-')); dirs.push(d); return d; };
const U = (o) => ({ ...o, untrustedText: true });

const CHANNELS = {
  CASE_PLAYBOOKS: 'case:playbooks',
  CASE_ADD_PLAYBOOK: 'case:addPlaybook',
  CASE_REMOVE_PLAYBOOK: 'case:removePlaybook',
  CASE_CHECK_PLAYBOOK_UPDATES: 'case:checkPlaybookUpdates',
  CASE_UPDATE_PLAYBOOK: 'case:updatePlaybook',
  CASE_LIST_EXAMPLE_PLAYBOOKS: 'case:listExamplePlaybooks',
  CASE_PLAYBOOK_PROPOSALS: 'case:playbookProposals',
  CASE_APPLY_PLAYBOOK_PROPOSAL: 'case:applyPlaybookProposal',
  CASE_REJECT_PLAYBOOK_PROPOSAL: 'case:rejectPlaybookProposal',
  CASE_ACCEPT_PLAYBOOK_BUDGET: 'case:acceptPlaybookBudget'
};

function makeContext({ examples = {}, settings = { playbooks: {} } } = {}) {
  const examplesDir = tmp();
  writePackage(path.join(examplesDir, 'land-sale'), examples);
  const runtime = new CaseRuntime({ root: tmp(), getSettings: () => ({}) });
  installPlaybooks(runtime, { getSettings: () => settings, examplesDir, tmpRoot: tmp() });
  let chats = [{ id: 'chat-1', title: 'Chat' }];
  const context = {
    getCaseRuntime: () => runtime,
    getPlaybookManager: () => runtime.playbooks,
    getChats: () => chats,
    setChats: (next) => { chats = next; }
  };
  return { runtime, context, examplesDir, settings };
}

async function world(opts = {}) {
  const { runtime, context, examplesDir, settings } = makeContext(opts);
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), on: () => {} };
  registerCaseHandlers(ipcMain, context);
  registerPlaybookHandlers(ipcMain, context);
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  return { runtime, call, handlers, examplesDir, settings };
}

describe('constants', () => {
  it('names every channel case:<camelName>', () => {
    for (const [key, value] of Object.entries(CHANNELS)) assert.strictEqual(IPC[key], value, key);
  });
});

describe('playbook channels', () => {
  it('add, list, check, update, remove', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { runtime, call } = await world();
    const { id } = await runtime.createCase({ title: 'Lakeside lot' });
    assert.deepStrictEqual(await call(IPC.CASE_ADD_PLAYBOOK, { caseId: id }), U({ ok: false, error: 'Give exactly one of source or adopt.' }));
    const added = await call(IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: 'example:land-sale' });
    assert.strictEqual(added.ok, true);
    assert.strictEqual(added.untrustedText, true);
    assert.deepStrictEqual(added.playbook, { name: 'land-sale', version: '1.2.0' });
    const listed = await call(IPC.CASE_PLAYBOOKS, { caseId: id });
    assert.strictEqual(listed.ok, true);
    assert.strictEqual(listed.untrustedText, true);
    assert.deepStrictEqual(listed.playbooks.map((p) => [p.name, p.state, p.mode, p.version]), [['land-sale', 'ok', 'vendored', '1.2.0']]);
    assert.ok(!('package' in listed.playbooks[0]), 'entries come without the parsed package');
    assert.deepStrictEqual(listed.pendingGating.map((p) => p.key), ['property.floor-price']);
    const checked = await call(IPC.CASE_CHECK_PLAYBOOK_UPDATES, { caseId: id });
    assert.deepStrictEqual(checked, U({ ok: true, updates: [{ name: 'land-sale', pinned: '1.2.0', upstream: '1.2.0', updateAvailable: false, sameMajor: true }] }));
    assert.deepStrictEqual(await call(IPC.CASE_UPDATE_PLAYBOOK, { caseId: id, name: 'land-sale', force: 'yes' }), U({ ok: false, error: 'force must be true or false.' }));
    assert.strictEqual((await call(IPC.CASE_UPDATE_PLAYBOOK, { caseId: id, name: 'land-sale' })).ok, true);
    assert.deepStrictEqual(await call(IPC.CASE_REMOVE_PLAYBOOK, { caseId: id, name: 'land-sale' }), U({ ok: true }));
    assert.deepStrictEqual((await call(IPC.CASE_PLAYBOOKS, { caseId: id })).playbooks, []);
  });

  it('refusals keep their code; a missing case is a result, not a throw', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { runtime, call } = await world();
    const { id } = await runtime.createCase({ title: 'Lakeside lot' });
    const r = await call(IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: 'https://example.com/playbooks/land-sale.git' });
    assert.deepStrictEqual(r, U({ ok: false, error: 'Playbook source https://example.com/playbooks/land-sale.git is not allowed. Add its host to Settings → Playbooks → Allowed sources.', code: 'SOURCE_NOT_ALLOWED' }));
    const missing = await call(IPC.CASE_PLAYBOOKS, { caseId: 'nope' });
    assert.strictEqual(missing.ok, false);
    assert.match(missing.error, /Case not found: nope/);
  });

  it('lists examples, accepts budget raises, and runs proposals', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { runtime, call } = await world({ examples: { 'playbook.yaml': withYaml(/budgetDefaults: .*/, 'budgetDefaults: { usd: 40 }') } });
    assert.deepStrictEqual(await call(IPC.CASE_LIST_EXAMPLE_PLAYBOOKS, {}), U({ ok: true, examples: [{ name: 'land-sale', version: '1.2.0', title: 'Sell a parcel of land', caseType: 'general' }] }));
    const { id } = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
    const added = await call(IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: 'example:land-sale' });
    assert.deepStrictEqual(added.budgetRaises, [{ key: 'usd', from: 20, to: 40 }]);
    assert.deepStrictEqual((await call(IPC.CASE_PLAYBOOKS, { caseId: id })).budgetRaises, [{ playbook: 'land-sale', key: 'usd', from: 20, to: 40 }]);
    assert.deepStrictEqual(await call(IPC.CASE_ACCEPT_PLAYBOOK_BUDGET, { caseId: id, name: 'land-sale' }), U({ ok: true, applied: [{ key: 'usd', from: 20, to: 40 }] }));
    assert.strictEqual(runtime.getCase(id).budget.usd, 40);

    runtime.brief(id).update('why', 'Need the cash', { provenance: 'user' });
    runtime.brief(id).append('successCriteria', 'Sold', { provenance: 'model' });
    for (const q of runtime.questions(id).open()) await runtime.answerQuestion(id, q.id, q.options?.length ? { optionId: q.options[0].id } : { text: '250000' });
    runtime.completeGating(id);
    runtime.setStatus(id, 'done', { kind: 'owner', by: 'owner' });
    const proposed = await runtime.playbooks.propose(id, { playbook: 'land-sale', files: [{ path: 'steps.md', content: STEPS_MD.replace('Call the buyers on the list;', 'Call the largest buyers first;') }], rationale: 'Faster answers.', factIds: [] });
    const listed = await call(IPC.CASE_PLAYBOOK_PROPOSALS, { caseId: id, proposalId: proposed.proposal.id });
    assert.strictEqual(listed.proposals[0].status, 'proposed');
    assert.match(listed.patch, /^\+Call the largest buyers first;/m);
    const repo = await makeGitPackage(path.join(tmp(), 'land-sale'), { 'playbook.yaml': withYaml(/budgetDefaults: .*/, 'budgetDefaults: { usd: 40 }') });
    assert.deepStrictEqual(await call(IPC.CASE_APPLY_PLAYBOOK_PROPOSAL, { caseId: id, proposalId: 'pp-001' }), U({ ok: false, error: 'repoPath is required.' }));
    assert.deepStrictEqual(await call(IPC.CASE_APPLY_PLAYBOOK_PROPOSAL, { caseId: id, proposalId: 'pp-001', repoPath: repo }), U({ ok: true, appliedTo: repo, appliedOver: '1.2.0' }));
    assert.deepStrictEqual(await call(IPC.CASE_REJECT_PLAYBOOK_PROPOSAL, { caseId: id, proposalId: 'pp-001' }), U({ ok: false, error: 'Proposal pp-001 is applied.' }));
  });
});

describe('patch text', () => {
  it('an oversize patch file is refused with a fixed error and never read', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { runtime, call } = await world();
    const { id, dir } = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
    assert.strictEqual((await call(IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: 'example:land-sale' })).ok, true);
    runtime.brief(id).update('why', 'Need the cash', { provenance: 'user' });
    runtime.brief(id).append('successCriteria', 'Sold', { provenance: 'model' });
    for (const q of runtime.questions(id).open()) await runtime.answerQuestion(id, q.id, q.options?.length ? { optionId: q.options[0].id } : { text: '250000' });
    runtime.completeGating(id);
    runtime.setStatus(id, 'done', { kind: 'owner', by: 'owner' });
    const proposed = await runtime.playbooks.propose(id, { playbook: 'land-sale', files: [{ path: 'steps.md', content: STEPS_MD.replace('Call the buyers on the list;', 'Call the largest buyers first;') }], rationale: 'Faster answers.', factIds: [] });
    const patchFile = path.join(dir, ...proposed.proposal.patch.split('/'));
    fs.writeFileSync(patchFile, 'x'.repeat(MAX_PATCH_BYTES + 1));
    const reads = [];
    const realRead = fs.readFileSync;
    fs.readFileSync = function (p, ...rest) {
      if (typeof p === 'string' && path.resolve(p) === path.resolve(patchFile)) reads.push(p);
      return realRead.call(this, p, ...rest);
    };
    t.after(() => { fs.readFileSync = realRead; });
    const r = await call(IPC.CASE_PLAYBOOK_PROPOSALS, { caseId: id, proposalId: proposed.proposal.id });
    fs.readFileSync = realRead;
    assert.deepStrictEqual(r, U({ ok: false, error: `The patch of proposal ${proposed.proposal.id} is too large to show here; review it in the case folder.`, code: 'PATCH_TOO_LARGE' }));
    assert.deepStrictEqual(reads, [], 'the oversize patch was never read');
  });
});

describe('argument validation', () => {
  it('every channel refuses a bad argument with a fixed error before using it', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { runtime, call } = await world();
    const { id } = await runtime.createCase({ title: 'Lakeside lot' });
    const long = 'x'.repeat(5000);
    const cases = [
      // caseId
      [IPC.CASE_PLAYBOOKS, {}, 'caseId is required.'],
      [IPC.CASE_PLAYBOOKS, { caseId: 7 }, 'caseId is required.'],
      [IPC.CASE_PLAYBOOKS, { caseId: '../x' }, 'caseId is not a valid case id.'],
      [IPC.CASE_PLAYBOOKS, { caseId: 'A\nB' }, 'caseId is not a valid case id.'],
      [IPC.CASE_PLAYBOOKS, { caseId: long }, 'caseId is not a valid case id.'],
      [IPC.CASE_PLAYBOOKS, null, 'caseId is required.'],
      [IPC.CASE_PLAYBOOKS, ['x'], 'caseId is required.'],
      // playbook names (NAME_RE)
      [IPC.CASE_REMOVE_PLAYBOOK, { caseId: id }, 'name is required.'],
      [IPC.CASE_REMOVE_PLAYBOOK, { caseId: id, name: '../../evil' }, 'name is not a valid playbook name.'],
      [IPC.CASE_UPDATE_PLAYBOOK, { caseId: id, name: 'Land-Sale' }, 'name is not a valid playbook name.'],
      [IPC.CASE_ACCEPT_PLAYBOOK_BUDGET, { caseId: id, name: 'a/b' }, 'name is not a valid playbook name.'],
      [IPC.CASE_CHECK_PLAYBOOK_UPDATES, { caseId: id, name: 'x y' }, 'name is not a valid playbook name.'],
      [IPC.CASE_ADD_PLAYBOOK, { caseId: id, adopt: '..' }, 'adopt is not a valid playbook name.'],
      // sources and refs
      [IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: 'example:land-sale\n--upload-pack=x' }, 'source is not a valid playbook source.'],
      [IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: `https://example.com/${long}` }, 'source is not a valid playbook source.'],
      [IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: 'example:land-sale\u202e' }, 'source is not a valid playbook source.'],
      [IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: 'example:land-sale', ref: '--upload-pack=x' }, 'ref is not a valid git ref.'],
      [IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: 'example:land-sale', ref: 7 }, 'ref is not a valid git ref.'],
      [IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: 'example:land-sale', acceptBudgetRaises: 'true' }, 'acceptBudgetRaises must be true or false.'],
      // proposal ids (pp-NNN) and repo paths
      [IPC.CASE_PLAYBOOK_PROPOSALS, { caseId: id, proposalId: '../pp-001' }, 'proposalId is not a valid proposal id.'],
      [IPC.CASE_APPLY_PLAYBOOK_PROPOSAL, { caseId: id }, 'proposalId is required.'],
      [IPC.CASE_APPLY_PLAYBOOK_PROPOSAL, { caseId: id, proposalId: 'pp-1' }, 'proposalId is not a valid proposal id.'],
      [IPC.CASE_APPLY_PLAYBOOK_PROPOSAL, { caseId: id, proposalId: 'pp-001', repoPath: 'relative/dir' }, 'repoPath must be an absolute folder path.'],
      [IPC.CASE_APPLY_PLAYBOOK_PROPOSAL, { caseId: id, proposalId: 'pp-001', repoPath: '\\\\host\\share\\repo' }, 'repoPath must be an absolute folder path.'],
      [IPC.CASE_APPLY_PLAYBOOK_PROPOSAL, { caseId: id, proposalId: 'pp-001', repoPath: `${os.tmpdir()}\nx` }, 'repoPath must be an absolute folder path.'],
      [IPC.CASE_REJECT_PLAYBOOK_PROPOSAL, { caseId: id, proposalId: 'PP-001' }, 'proposalId is not a valid proposal id.'],
      // booleans
      [IPC.CASE_UPDATE_PLAYBOOK, { caseId: id, name: 'land-sale', confirmSource: 'true' }, 'confirmSource must be true or false.'],
      [IPC.CASE_CHECK_PLAYBOOK_UPDATES, { caseId: id, confirmSource: 1 }, 'confirmSource must be true or false.']
    ];
    for (const [channel, payload, error] of cases) {
      assert.deepStrictEqual(await call(channel, payload), U({ ok: false, error }), `${channel} ${JSON.stringify(payload)?.slice(0, 80)}`);
    }
    assert.deepStrictEqual(runtime.getCase(id).playbooks, [], 'nothing was attached');
  });

  it('replies carry only panel-safe fields: no case dir, no package, no question text', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { runtime, call } = await world();
    const { id, dir } = await runtime.createCase({ title: 'Lakeside lot' });
    await call(IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: 'example:land-sale' });
    const listed = await call(IPC.CASE_PLAYBOOKS, { caseId: id });
    assert.deepStrictEqual(Object.keys(listed.playbooks[0]).sort(), ['errors', 'mode', 'name', 'pinnedVersion', 'reason', 'source', 'state', 'steps', 'submodule', 'version', 'warnings']);
    assert.deepStrictEqual(Object.keys(listed.pendingGating[0]).sort(), ['key', 'origins', 'recordId', 'required']);
    const text = JSON.stringify(listed);
    assert.ok(!text.includes(JSON.stringify(dir).slice(1, -1)), 'the case folder never reaches the renderer');
  });
});

// Ruling T5-recorded carried to IPC: a recorded local source is read on
// update only after the owner's confirmSource === true, and a refusal
// reaches the renderer with the code the panel acts on.
describe('confirmSource', () => {
  async function recorded() {
    const w = await world();
    const typed = await makeGitPackage(path.join(tmp(), 'land-sale'));
    const other = await makeGitPackage(path.join(tmp(), 'land-sale'), { 'playbook.yaml': PLAYBOOK_YAML.replace('"1.2.0"', '"1.9.9"') });
    const { id, dir } = await w.runtime.createCase({ title: 'Lakeside lot' });
    assert.strictEqual((await w.call(IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: typed })).ok, true);
    const s = readState(dir);
    s.vendored['land-sale'].source = `path:${other}`;
    writeState(dir, s);
    return { ...w, id, dir };
  }

  it('counts only === true; SOURCE_NEEDS_CONFIRM reaches the renderer as a code', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await recorded();
    const plain = await w.call(IPC.CASE_UPDATE_PLAYBOOK, { caseId: w.id, name: 'land-sale' });
    assert.strictEqual(plain.ok, false);
    assert.strictEqual(plain.code, 'SOURCE_NEEDS_CONFIRM');
    assert.strictEqual(plain.untrustedText, true);
    const [row] = (await w.call(IPC.CASE_CHECK_PLAYBOOK_UPDATES, { caseId: w.id })).updates;
    assert.strictEqual(row.code, 'SOURCE_NEEDS_CONFIRM');
    for (const confirmSource of ['true', 1, {}]) {
      for (const channel of [IPC.CASE_UPDATE_PLAYBOOK, IPC.CASE_CHECK_PLAYBOOK_UPDATES]) {
        assert.deepStrictEqual(
          await w.call(channel, { caseId: w.id, name: 'land-sale', confirmSource }),
          U({ ok: false, error: 'confirmSource must be true or false.' }),
          `${channel} ${JSON.stringify(confirmSource)}`
        );
      }
    }
    assert.strictEqual(readState(w.dir).vendored['land-sale'].onDiskVersion, '1.2.0', 'nothing was read or written');
    assert.deepStrictEqual(await w.call(IPC.CASE_CHECK_PLAYBOOK_UPDATES, { caseId: w.id, confirmSource: true }), U({ ok: false, error: 'confirmSource needs a playbook name.' }));
    const [checked] = (await w.call(IPC.CASE_CHECK_PLAYBOOK_UPDATES, { caseId: w.id, name: 'land-sale', confirmSource: true })).updates;
    assert.deepStrictEqual(checked, { name: 'land-sale', pinned: '1.2.0', upstream: '1.9.9', updateAvailable: true, sameMajor: true });
    const confirmed = await w.call(IPC.CASE_UPDATE_PLAYBOOK, { caseId: w.id, name: 'land-sale', confirmSource: true });
    assert.deepStrictEqual(confirmed, U({ ok: true, from: '1.2.0', to: '1.9.9', budgetRaises: [] }));
  });
  it('a confirmation covers only the named playbook; another recorded folder stays unconfirmed', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const w = await world();
    const farmYaml = (v) => PLAYBOOK_YAML.replace('name: land-sale', 'name: farm').replace('"1.2.0"', v);
    const typedA = await makeGitPackage(path.join(tmp(), 'land-sale'));
    const typedB = await makeGitPackage(path.join(tmp(), 'farm'), { 'playbook.yaml': farmYaml('"1.2.0"') });
    const otherA = await makeGitPackage(path.join(tmp(), 'land-sale'), { 'playbook.yaml': PLAYBOOK_YAML.replace('"1.2.0"', '"1.9.9"') });
    const otherB = await makeGitPackage(path.join(tmp(), 'farm'), { 'playbook.yaml': farmYaml('"1.8.8"') });
    const { id, dir } = await w.runtime.createCase({ title: 'Lakeside lot' });
    assert.strictEqual((await w.call(IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: typedA })).ok, true);
    assert.strictEqual((await w.call(IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: typedB })).ok, true);
    const s = readState(dir);
    s.vendored['land-sale'].source = `path:${otherA}`;
    s.vendored.farm.source = `path:${otherB}`;
    writeState(dir, s);
    w.settings.playbooks.autoUpdate = true;
    const confirmed = await w.call(IPC.CASE_CHECK_PLAYBOOK_UPDATES, { caseId: id, name: 'land-sale', confirmSource: true });
    assert.deepStrictEqual(confirmed.updates.map((u) => [u.name, u.upstream, u.applied]), [['land-sale', '1.9.9', '1.9.9']]);
    const after = await w.call(IPC.CASE_CHECK_PLAYBOOK_UPDATES, { caseId: id });
    const farm = after.updates.find((u) => u.name === 'farm');
    assert.strictEqual(farm.code, 'SOURCE_NEEDS_CONFIRM');
    assert.strictEqual(readState(dir).vendored.farm.onDiskVersion, '1.2.0', 'farm was never read or updated');
    assert.strictEqual(readState(dir).vendored['land-sale'].onDiskVersion, '1.9.9');
  });
});

describe('owner-only surface', () => {
  it('never exposes acknowledge or QuestionStore.updatePayload; apply and reject are not model tool actions', () => {
    const root = path.join(__dirname, '..');
    const ipcFiles = fs.readdirSync(path.join(root, 'src', 'ipc')).filter((f) => f.endsWith('.js')).map((f) => path.join(root, 'src', 'ipc', f));
    for (const file of [...ipcFiles, path.join(root, 'preload.js')]) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!/updatePayload/.test(text), `${file} mentions updatePayload`);
      assert.ok(!/\.acknowledge\(|acknowledgePlaybooks/.test(text), `${file} reaches acknowledge`);
    }
    const { PlaybookTool } = require('../src/tools/builtin/playbook-tool');
    assert.deepStrictEqual(PlaybookTool.parameters.properties.action.enum, ['list', 'read', 'propose']);
    for (const owner of ['repoPath', 'proposalId', 'confirmSource', 'force', 'source', 'acceptBudgetRaises']) {
      assert.ok(!(owner in PlaybookTool.parameters.properties), `the Playbook tool takes ${owner}`);
    }
  });
});

// Ruling M14: attached, every case:* playbook channel is proxied to the
// service, where these same handlers (and their checks) run.
describe('attached mode', () => {
  it('proxies every playbook channel and applies the same validation', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { runtime, context } = makeContext();
    const dispatcher = createBridgeDispatcher({
      core: { context },
      dataDir: tmp(),
      registerHandlers: (ipc, ctx) => {
        registerCaseHandlers(ipc, ctx);
        registerPlaybookHandlers(ipc, ctx);
      }
    });
    for (const channel of Object.values(CHANNELS)) assert.ok(dispatcher.served.handle.includes(channel), channel);
    const sent = [];
    const conn = createConnection({ deviceId: 'kld-aaaaaaaaaaaaaaaa', label: 'desk', send: (f) => sent.push(f) });
    const { id } = await runtime.createCase({ title: 'Lakeside lot' });
    let n = 0;
    const invoke = async (channel, payload) => {
      n += 1;
      await dispatcher.handleFrame(conn, { t: 'invoke', id: n, channel, args: [payload] });
      return sent.find((f) => f.t === 'result' && f.id === n).value;
    };
    assert.deepStrictEqual(await invoke(IPC.CASE_REMOVE_PLAYBOOK, { caseId: id, name: '../../evil' }), U({ ok: false, error: 'name is not a valid playbook name.' }));
    assert.deepStrictEqual(await invoke(IPC.CASE_UPDATE_PLAYBOOK, { caseId: id, name: 'land-sale', confirmSource: 'true' }), U({ ok: false, error: 'confirmSource must be true or false.' }));
    assert.deepStrictEqual(await invoke(IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: 'example:land-sale\r\nx' }), U({ ok: false, error: 'source is not a valid playbook source.' }));
    assert.deepStrictEqual(await invoke(IPC.CASE_CREATE, { title: 'Two', playbooks: [{ source: 'example:land-sale', ref: '-x' }] }), U({ ok: false, error: 'playbooks[0].ref is not a valid git ref.' }));
    assert.strictEqual((await invoke(IPC.CASE_ADD_PLAYBOOK, { caseId: id, source: 'example:land-sale' })).ok, true);
    assert.deepStrictEqual(runtime.getCase(id).playbooks.map((p) => p.name), ['land-sale']);
  });
});

describe('case:create with playbooks', () => {
  it('validates the form first: shape, count, sources, refs, acceptBudgetRaises', async () => {
    const { runtime, call } = await world();
    const bad = [
      [{ title: 'A', playbooks: 'example:land-sale' }, 'playbooks must be a list of { source, ref? }.'],
      [{ title: 'A', playbooks: Array.from({ length: 6 }, () => ({ source: 'example:land-sale' })) }, 'playbooks must be a list of at most 5 { source, ref? }.'],
      [{ title: 'A', playbooks: ['example:land-sale'] }, 'playbooks[0] must be { source, ref? }.'],
      [{ title: 'A', playbooks: [{ source: 'example:land-sale' }, { source: 'x\u0000y' }] }, 'playbooks[1].source is not a valid playbook source.'],
      [{ title: 'A', playbooks: [{}] }, 'playbooks[0].source is not a valid playbook source.'],
      [{ title: 'A', playbooks: [{ source: 'example:land-sale', ref: '--x' }] }, 'playbooks[0].ref is not a valid git ref.'],
      [{ title: 'A', playbooks: [{ source: 'example:land-sale' }], acceptBudgetRaises: 1 }, 'acceptBudgetRaises must be true or false.']
    ];
    for (const [payload, error] of bad) assert.deepStrictEqual(await call(IPC.CASE_CREATE, payload), U({ ok: false, error }), error);
    assert.deepStrictEqual(runtime.listCases(), []);
  });

  it('validates every source first: a bad second source creates no case', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { runtime, call } = await world();
    const bad = writePackage(path.join(tmp(), 'farm'), { 'playbook.yaml': PLAYBOOK_YAML.replace('name: land-sale', 'name: farm').replace('version: "1.2.0"', 'version: 1.2') });
    const r = await call(IPC.CASE_CREATE, { title: 'Lakeside lot', chatId: 'chat-1', playbooks: [{ source: 'example:land-sale' }, { source: bad }] });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.untrustedText, true);
    assert.match(r.error, /^The case was not created:\n.*farm: The playbook at path:.* is invalid:\nplaybook\.yaml: version must be a quoted string like "1\.2\.0"$/s);
    assert.deepStrictEqual(runtime.listCases(), []);
  });

  it('creates the case, attaches from the fetched copies, and reports questions and raises', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { runtime, call } = await world({ examples: { 'playbook.yaml': withYaml(/budgetDefaults: .*/, 'budgetDefaults: { usd: 40 }') } });
    const r = await call(IPC.CASE_CREATE, { title: 'Lakeside lot', chatId: 'chat-1', playbooks: [{ source: 'example:land-sale' }] });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.untrustedText, true);
    assert.strictEqual(r.case.type, 'general');
    assert.deepStrictEqual(r.playbooks.map((p) => [p.name, p.version, p.questionIds.length]), [['land-sale', '1.2.0', 2]]);
    assert.deepStrictEqual(r.budgetRaises, [{ playbook: 'land-sale', key: 'usd', from: 20, to: 40 }]);
    assert.strictEqual(r.chat.caseId, r.case.id);
    assert.deepStrictEqual(runtime.getCase(r.case.id).playbooks.map((p) => p.name), ['land-sale']);
    const accepted = await call(IPC.CASE_CREATE, { title: 'Second lot', playbooks: [{ source: 'example:land-sale' }], acceptBudgetRaises: true });
    assert.deepStrictEqual(accepted.budgetRaises, []);
    assert.strictEqual(runtime.getCase(accepted.case.id).budget.usd, 40);
  });

  it('infers the type from the playbooks, and refuses when they disagree', async (t) => {
    if (!(await git.isGitAvailable())) return t.skip('git is not on PATH');
    const { runtime, call, examplesDir } = await world({ examples: { 'playbook.yaml': withYaml(/caseType: general/, 'caseType: outreach') } });
    writePackage(path.join(examplesDir, 'farm'), { 'playbook.yaml': PLAYBOOK_YAML.replace('name: land-sale', 'name: farm') });
    const typed = await call(IPC.CASE_CREATE, { title: 'Lakeside lot', playbooks: [{ source: 'example:land-sale' }] });
    assert.strictEqual(typed.ok, true);
    assert.strictEqual(runtime.getCase(typed.case.id).type, 'outreach');
    const clash = await call(IPC.CASE_CREATE, { title: 'Two kinds', playbooks: [{ source: 'example:land-sale' }, { source: 'example:farm' }] });
    assert.deepStrictEqual(clash, U({ ok: false, error: 'Playbooks disagree on case type (outreach, general); pick a type.' }));
    const mismatch = await call(IPC.CASE_CREATE, { title: 'Typed', type: 'software-repo', playbooks: [{ source: 'example:land-sale' }] });
    assert.deepStrictEqual(mismatch, U({ ok: false, error: 'Playbook "land-sale" is for "outreach" cases; this case is "software-repo".' }));
  });

  it('a non-object payload gets the fixed title error, not a TypeError', async () => {
    const { call } = await world();
    for (const payload of [null, undefined, [], 'x']) {
      assert.deepStrictEqual(await call(IPC.CASE_CREATE, payload), { ok: false, error: 'A case needs a title.' }, JSON.stringify(payload));
    }
  });

  it('without playbooks the reply is unchanged', async () => {
    const { call } = await world();
    const r = await call(IPC.CASE_CREATE, { title: 'Plain' });
    assert.deepStrictEqual(Object.keys(r).sort(), ['case', 'chat', 'ok']);
  });
});

