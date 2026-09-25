// tests/cases-detour-tool.test.js
// The Detour tool, the Ask duplicate check and the Brief tool's type
// fields (cases stage 5 spec §3.2, §3.5, §3.7).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initializeTools, toolRegistry } = require('../src/tools');
const { CaseRuntime } = require('../src/cases');
const { DetourTool } = require('../src/tools/builtin/detour-tool');
const { AskTool } = require('../src/tools/builtin/case-unattended-tools');
const { BriefTool } = require('../src/tools/builtin/case-tools');
const { CASE_TOOL_NAMES, CASE_MODE_PROMPT } = require('../src/cases/chat-integration');
const { DetourLog } = require('../src/cases/detours/log');

initializeTools();

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-detour-tool-')); dirs.push(d); return d; };

async function activeCase(rt, title, objective, type = 'general') {
  const info = await rt.createCase({ title, objective, type, force: true });
  rt.brief(info.id).update('why', 'The owner asked for it', { provenance: 'user' });
  rt.brief(info.id).append('successCriteria', objective, { provenance: 'model' });
  if (type === 'software-repo') rt.brief(info.id).update('repo', 'https://github.com/example/phone-agent.git', { provenance: 'user' });
  rt.completeGating(info.id);
  return rt.getCase(info.id);
}

async function setup(ownerMessages = []) {
  const rt = new CaseRuntime({ root: tmp(), host: { interactive: () => true } });
  const door = await activeCase(rt, 'Rear door quotes', 'Three written quotes for the rear door', 'outreach');
  const phone = await activeCase(rt, 'Phone agent maintenance', 'Keep the phone agent answering and reporting call status');
  const turn = await rt.beginTurn(door.id, { turnId: 'turn-1', source: 'owner', ownerMessage: 'x' });
  return { rt, door, phone, turn, opts: { caseContext: rt.caseContext(turn, { ownerMessages }) } };
}

describe('Detour tool', () => {
  it('is a case tool that needs no approval, and the case prompt tells the model to use it', async () => {
    assert.ok(CASE_TOOL_NAMES.includes('Detour'));
    assert.strictEqual(toolRegistry.get('Detour').requiresApproval, false);
    assert.match(CASE_MODE_PROMPT, /- Work that does not serve the objective is a detour: propose it with the Detour tool and continue; never do it inline\./);
    const r = await DetourTool.execute({ action: 'list' }, {});
    assert.match(r.error, /not attached to a case/);
  });

  it('propose validates its input and returns the routing proposal with an instruction', async () => {
    const { rt, door, turn, opts } = await setup();
    assert.match((await DetourTool.execute({ action: 'propose', summary: '' }, opts)).error, /"summary" must be 1 to 300 characters/);
    assert.match((await DetourTool.execute({ action: 'propose', summary: 'x'.repeat(301) }, opts)).error, /"summary"/);
    assert.match((await DetourTool.execute({ action: 'propose', summary: 'Fix it', reason: 'r'.repeat(201) }, opts)).error, /"reason"/);
    assert.match((await DetourTool.execute({ action: 'propose', summary: 'Fix it', blocks: 'yes' }, opts)).error, /"blocks" must be true or false/);
    const r = await DetourTool.execute({ action: 'propose', summary: 'Fix the phone agent status polling', reason: 'A different project', blocks: true }, opts);
    assert.deepStrictEqual([r.ok, r.detourId, r.status], [true, 'd-0001', 'proposed']);
    assert.strictEqual(rt.questions(door.id).get(r.questionId).urgency, 'high');
    assert.ok(r.options.some((o) => o.label === 'Attach to "Phone agent maintenance" (active)'));
    assert.match(r.instruction, /continue with on-case work/);
    const [row] = new DetourLog(door.dir).rows();
    assert.deepStrictEqual([row.source, row.turnId], ['detour-tool', 'turn-1']);
    const list = await DetourTool.execute({ action: 'list' }, opts);
    assert.deepStrictEqual(list.detours.map((d) => [d.id, d.blocks]), [['d-0001', true]]);
    assert.deepStrictEqual(list.related, []);
    await rt.endTurn(turn, { summary: 'x' });
  });

  it('resolve maps an answer in words only, and journals the owner\'s words in both cases', async () => {
    const { rt, door, phone, turn, opts } = await setup();
    const p = await DetourTool.execute({ action: 'propose', summary: 'Fix the phone agent status polling', reason: 'A different project' }, opts);
    const early = await DetourTool.execute({ action: 'resolve', questionId: p.questionId, optionId: 'attach-1' }, opts);
    assert.match(early.error, /Detour d-0001 is proposed\. resolve is only for an owner's answer given in words\./);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', text: 'give it to the phone agent case' });
    await rt.detours.reconcile(door.id);
    const r = await DetourTool.execute({ action: 'resolve', questionId: p.questionId, optionId: 'attach-1' }, opts);
    assert.deepStrictEqual([r.ok, r.status, r.linkedCaseId], [true, 'attached', phone.id]);
    const words = 'Owner\'s words (mapped by the model): "give it to the phone agent case"';
    const journals = (dir) => fs.readdirSync(path.join(dir, 'journal')).map((n) => fs.readFileSync(path.join(dir, 'journal', n), 'utf8')).join('\n');
    assert.ok(journals(door.dir).includes(words));
    assert.ok(journals(phone.dir).includes(words));
    assert.match((await DetourTool.execute({ action: 'resolve', questionId: 'q-0099', optionId: 'attach-1' }, opts)).error, /not a routing question/);
    await rt.endTurn(turn, { summary: 'x' });
  });

  it('is refused while the case is paused, like every non-read op', async () => {
    const { rt, door, turn, opts } = await setup();
    rt.setStatus(door.id, 'paused', { kind: 'owner', by: 'owner' });
    for (const action of ['propose', 'resolve', 'list']) {
      const r = await DetourTool.execute({ action, summary: 'Fix it', questionId: 'q-0001', optionId: 'decline' }, opts);
      assert.deepStrictEqual(r, { ok: false, error: 'Case is paused (owner). Only reading is available.' }, action);
    }
    await rt.endTurn(turn, { summary: 'x' });
  });
});

describe('Ask duplicate check', () => {
  it('refuses the same open question, shows a close one here, and names another case by title only', async () => {
    const { rt, door, phone, turn, opts } = await setup();
    const first = await AskTool.execute({ question: 'Is the side gate code still 4471?' }, opts);
    assert.strictEqual(first.ok, true);
    const same = await AskTool.execute({ question: '  is the side gate code still 4471 ' }, opts);
    const asked = rt.questions(door.id).get(first.questionId).createdAt.slice(0, 10);
    assert.deepStrictEqual(same, { ok: false, error: `This question is already open as ${first.questionId} (asked ${asked}). Wait for its answer instead of asking again.` });
    const close = await AskTool.execute({ question: 'Is the side gate code still the same?' }, opts);
    assert.deepStrictEqual(close.similar, [{ questionId: first.questionId, text: 'Is the side gate code still 4471?' }]);
    rt.createQuestion(phone.id, { kind: 'question', text: 'Which phone number should the agent forward dropped calls to?', urgency: 'low' });
    const elsewhere = await AskTool.execute({ question: 'Which number should dropped calls be forwarded to?' }, opts);
    assert.strictEqual(elsewhere.ok, true);
    assert.match(elsewhere.note, /A similar question is open in case "Phone agent maintenance"\./);
    assert.ok(!JSON.stringify(elsewhere).includes('forward dropped calls to'));
    await rt.endTurn(turn, { summary: 'x' });
  });
});

describe('Brief tool type fields', () => {
  it('refuses repo on a general case, needs the owner\'s quote on software-repo, and validates it', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const general = await rt.createCase({ title: 'Garage sale', objective: 'Clear the garage' });
    const repo = await rt.createCase({ title: 'Phone agent maintenance', type: 'software-repo', objective: 'Keep the phone agent healthy' });
    const opts = async (id, ownerMessages) => ({ caseContext: rt.caseContext(await rt.beginTurn(id, { turnId: `turn-${id}` }), { ownerMessages }) });
    const g = await opts(general.id, []);
    assert.deepStrictEqual(await BriefTool.execute({ action: 'update', field: 'repo', value: '/work/x', provenance: 'user', quote: 'x' }, g), { ok: false, error: 'Field "repo" is only for software-repo cases.' });
    const said = 'The code lives at https://github.com/example/phone-agent.git on our account';
    const r = await opts(repo.id, [said]);
    assert.match((await BriefTool.execute({ action: 'update', field: 'repo', value: 'https://github.com/example/phone-agent.git' }, r)).error, /"repo" can only be set from something the owner said/);
    assert.match((await BriefTool.execute({ action: 'update', field: 'repo', value: 'https://github.com/example/phone-agent.git', provenance: 'user', quote: 'somewhere else' }, r)).error, /does not appear/);
    assert.match((await BriefTool.execute({ action: 'update', field: 'repo', value: 'phone-agent', provenance: 'user', quote: 'The code lives at' }, r)).error, /repo must be an absolute path or a clone URL\./);
    const ok = await BriefTool.execute({ action: 'update', field: 'repo', value: 'https://github.com/example/phone-agent.git', provenance: 'user', quote: 'The code lives at https://github.com/example/phone-agent.git' }, r);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.brief.repo, 'https://github.com/example/phone-agent.git');
    const read = await BriefTool.execute({ action: 'read' }, r);
    assert.deepStrictEqual(read.missingForGating, ['why', 'successCriteria']);
    rt.releaseAll();
  });
});

// Owner-trust carries (Task 5/7 reviews): the model cannot pass `force`,
// cannot pick the case, and can only map an owner's answer given in words
// to the detour whose routing question it answers.
describe('Detour tool owner-trust limits', () => {
  it('exposes no "force" and never forwards one to the router', async () => {
    assert.strictEqual(DetourTool.parameters.properties.force, undefined);
    assert.strictEqual(DetourTool.parameters.properties.caseId, undefined);
    const { rt, door, turn, opts } = await setup();
    const seen = [];
    const { propose, resolve } = rt.detours;
    rt.detours.propose = (id, o) => { seen.push(['propose', o.force]); return propose.call(rt.detours, id, o); };
    rt.detours.resolve = (id, d, o) => { seen.push(['resolve', o.force]); return resolve.call(rt.detours, id, d, o); };
    const p = await DetourTool.execute({ action: 'propose', summary: 'Fix the phone agent status polling', force: true }, opts);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', text: 'give it to the phone agent case' });
    await rt.detours.reconcile(door.id);
    const r = await DetourTool.execute({ action: 'resolve', questionId: p.questionId, optionId: 'attach-1', force: true }, opts);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(seen, [['propose', undefined], ['resolve', undefined]]);
    await rt.endTurn(turn, { summary: 'x' });
  });

  it('takes the case from the chat, never from params', async () => {
    const { rt, door, phone, turn, opts } = await setup();
    const p = await DetourTool.execute({ action: 'propose', summary: 'Fix the phone agent status polling', caseId: phone.id }, opts);
    assert.strictEqual(p.ok, true);
    assert.strictEqual(new DetourLog(door.dir).rows().length, 1);
    assert.strictEqual(new DetourLog(phone.dir).rows().length, 0);
    const list = await DetourTool.execute({ action: 'list', caseId: phone.id }, opts);
    assert.deepStrictEqual(list.detours.map((d) => d.id), ['d-0001']);
    await rt.endTurn(turn, { summary: 'x' });
  });

  it('refuses a failed detour: only IPC retries one', async () => {
    const { rt, door, turn, opts } = await setup();
    const p = await DetourTool.execute({ action: 'propose', summary: 'Fix the phone agent status polling' }, opts);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', text: 'the phone one' });
    await rt.detours.reconcile(door.id);
    const log = new DetourLog(door.dir);
    log.append({ type: 'resolution', id: 'd-0001', at: new Date().toISOString(), optionId: 'attach-1', by: 'in-app', status: 'failed', targetCaseId: null, error: 'x' });
    const r = await DetourTool.execute({ action: 'resolve', questionId: p.questionId, optionId: 'attach-1' }, opts);
    assert.deepStrictEqual(r, { ok: false, error: 'Detour d-0001 is failed. resolve is only for an owner\'s answer given in words.' });
    assert.strictEqual(log.detours().get('d-0001').status, 'failed');
    assert.ok(!(rt.getCase(door.id).related || []).some((x) => x.relation === 'related'), 'no link was made');
    await rt.endTurn(turn, { summary: 'x' });
  });

  it('refuses when the detour leaves awaiting-mapping before the router runs', async () => {
    const { rt, door, turn, opts } = await setup();
    const p = await DetourTool.execute({ action: 'propose', summary: 'Fix the phone agent status polling' }, opts);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', text: 'the phone one' });
    await rt.detours.reconcile(door.id);
    const log = new DetourLog(door.dir);
    const { resolve } = rt.detours;
    // A resolve racing in between the tool's check and the router's queue.
    rt.detours.resolve = (id, d, o) => {
      log.append({ type: 'resolution', id: d, at: new Date().toISOString(), optionId: 'attach-1', by: 'in-app', status: 'failed', targetCaseId: null, error: 'x' });
      return resolve.call(rt.detours, id, d, o);
    };
    const r = await DetourTool.execute({ action: 'resolve', questionId: p.questionId, optionId: 'attach-1' }, opts);
    assert.deepStrictEqual(r, { ok: false, error: 'Detour d-0001 is failed, not awaiting-mapping.' });
    assert.strictEqual(log.detours().get('d-0001').status, 'failed');
    await rt.endTurn(turn, { summary: 'x' });
  });

  it('maps an answer only to the detour whose routing question it is', async () => {
    const { rt, door, turn, opts } = await setup();
    const a = await DetourTool.execute({ action: 'propose', summary: 'Fix the phone agent status polling' }, opts);
    const b = await DetourTool.execute({ action: 'propose', summary: 'Renew the domain name for the family website' }, opts);
    assert.notStrictEqual(a.questionId, b.questionId);
    await rt.answerQuestion(door.id, a.questionId, { channel: 'in-app', text: 'drop the phone thing' });
    await rt.detours.reconcile(door.id);
    // b's question with a's detour id: the question decides, and b is not awaiting mapping.
    const wrong = await DetourTool.execute({ action: 'resolve', questionId: b.questionId, detourId: 'd-0001', optionId: 'decline' }, opts);
    assert.deepStrictEqual(wrong, { ok: false, error: 'Detour d-0002 is proposed. resolve is only for an owner\'s answer given in words.' });
    const asked = await AskTool.execute({ question: 'Is the side gate code still 4471?' }, opts);
    const notRouting = await DetourTool.execute({ action: 'resolve', questionId: asked.questionId, optionId: 'decline' }, opts);
    assert.deepStrictEqual(notRouting, { ok: false, error: `${asked.questionId} is not a routing question in this case.` });
    const statuses = new DetourLog(door.dir).detours();
    assert.deepStrictEqual([statuses.get('d-0001').status, statuses.get('d-0002').status], ['awaiting-mapping', 'proposed']);
    const right = await DetourTool.execute({ action: 'resolve', questionId: a.questionId, optionId: 'decline' }, opts);
    assert.deepStrictEqual([right.ok, right.detourId, right.status], [true, 'd-0001', 'declined']);
    await rt.endTurn(turn, { summary: 'x' });
  });
});

describe('Brief tool owner-only type fields', () => {
  it('refuses repo with a quote the owner never said, and writes nothing', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const repo = await rt.createCase({ title: 'Phone agent maintenance', type: 'software-repo', objective: 'Keep the phone agent healthy' });
    const turn = await rt.beginTurn(repo.id, { turnId: 'turn-1' });
    const opts = { caseContext: rt.caseContext(turn, { ownerMessages: ['Please keep the phone agent healthy'] }) };
    const r = await BriefTool.execute({ action: 'update', field: 'repo', value: 'https://github.com/example/phone-agent.git', provenance: 'user', quote: 'https://github.com/example/phone-agent.git' }, opts);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /does not appear/);
    assert.strictEqual(rt.brief(repo.id).read().data.repo ?? null, null);
    rt.releaseAll();
  });

  // Ruling T9-repo: the git refresh reads whatever repo names, so the owner
  // must have said the value itself, not just any words.
  it('needs the repo value itself inside the owner\'s quote', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const repo = await rt.createCase({ title: 'Phone agent maintenance', type: 'software-repo', objective: 'Keep the phone agent healthy' });
    const turn = await rt.beginTurn(repo.id, { turnId: 'turn-1' });
    const said = 'Keep the agent healthy; the code is at https://github.com/example/phone-agent.git for now';
    const opts = { caseContext: rt.caseContext(turn, { ownerMessages: [said] }) };
    const vague = await BriefTool.execute({ action: 'update', field: 'repo', value: '~/private-notes', provenance: 'user', quote: 'the' }, opts);
    assert.deepStrictEqual(vague, { ok: false, error: 'The owner\'s quote must contain the repo value itself ("~/private-notes"). Ask the owner for the repository path or clone URL.' });
    const other = await BriefTool.execute({ action: 'update', field: 'repo', value: 'https://github.com/example/other.git', provenance: 'user', quote: 'the code is at https://github.com/example/phone-agent.git' }, opts);
    assert.match(other.error, /must contain the repo value itself/);
    assert.strictEqual(rt.brief(repo.id).read().data.repo ?? null, null);
    const ok = await BriefTool.execute({ action: 'update', field: 'repo', value: 'https://github.com/example/phone-agent.git', provenance: 'user', quote: 'the code is at https://github.com/example/phone-agent.git' }, opts);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(rt.brief(repo.id).read().data.repo, 'https://github.com/example/phone-agent.git');
    rt.releaseAll();
  });

  // Fix round 2: a token of the quote must equal the value, not contain it.
  it('refuses a prefix of what the owner said, and accepts the exact value', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const repo = await rt.createCase({ title: 'Phone agent maintenance', type: 'software-repo', objective: 'Keep the phone agent healthy' });
    const turn = await rt.beginTurn(repo.id, { turnId: 'turn-1' });
    const said = 'The checkout is "/work/phone-agent/", the remote is `https://github.com/example/phone-agent.git`.';
    const opts = { caseContext: rt.caseContext(turn, { ownerMessages: [said] }) };
    const set = (value) => BriefTool.execute({ action: 'update', field: 'repo', value, provenance: 'user', quote: said }, opts);
    for (const value of ['/work/phone', 'https://github.com/example/phone', 'https://github.com/example/phone-agent/tree']) {
      assert.match((await set(value)).error, /must contain the repo value itself/, value);
    }
    assert.strictEqual(rt.brief(repo.id).read().data.repo ?? null, null);
    for (const value of ['/work/phone-agent', '/work/phone-agent/', 'https://github.com/example/phone-agent', 'https://github.com/example/phone-agent.git']) {
      assert.strictEqual((await set(value)).ok, true, value);
    }
    rt.releaseAll();
  });

  it('refuses a case variant of the owner\'s path on linux, even with the quote in that casing', { skip: process.platform !== 'linux' && 'case-sensitive paths only' }, async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const repo = await rt.createCase({ title: 'Phone agent maintenance', type: 'software-repo', objective: 'Keep the phone agent healthy' });
    const turn = await rt.beginTurn(repo.id, { turnId: 'turn-1' });
    const opts = { caseContext: rt.caseContext(turn, { ownerMessages: ['The checkout is /work/phone-agent on this box'] }) };
    const r = await BriefTool.execute({ action: 'update', field: 'repo', value: '/work/Phone-Agent', provenance: 'user', quote: 'checkout is /work/Phone-Agent' }, opts);
    assert.match(r.error, /must contain the repo value itself/);
    rt.releaseAll();
  });

  it('checks the owner\'s own message text, not only the normalized quote', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const repo = await rt.createCase({ title: 'Phone agent maintenance', type: 'software-repo', objective: 'Keep the phone agent healthy' });
    const turn = await rt.beginTurn(repo.id, { turnId: 'turn-1' });
    // The quote check maps an en dash to "-"; the owner's path has the en dash.
    const opts = { caseContext: rt.caseContext(turn, { ownerMessages: ['The checkout is /work/phone–agent on this box'] }) };
    const r = await BriefTool.execute({ action: 'update', field: 'repo', value: '/work/phone-agent', provenance: 'user', quote: 'checkout is /work/phone-agent' }, opts);
    assert.match(r.error, /must contain the repo value itself/);
    rt.releaseAll();
  });
});

describe('repoInQuote', () => {
  const { repoInQuote } = require('../src/cases/case-types/software-repo');
  it('matches one whole token of the quote, never a prefix', () => {
    assert.strictEqual(repoInQuote('/work/phone', 'it lives in /work/phone-agent', { platform: 'linux' }), false);
    assert.strictEqual(repoInQuote('C:\\Work\\phone', 'it lives in C:\\Work\\phone-agent', { platform: 'win32' }), false);
    assert.strictEqual(repoInQuote('C:\\Work\\phone-agent', 'it lives in \'C:\\Work\\Phone-Agent\\\';', { platform: 'win32' }), true);
    assert.strictEqual(repoInQuote('https://github.com/example/phone', 'see https://github.com/example/phone-agent.git', { platform: 'linux' }), false);
    assert.strictEqual(repoInQuote('https://github.com/example/phone-agent', 'see https://github.com/example/phone-agent.git,', { platform: 'linux' }), true);
  });
  it('case-folds paths only on win32 and darwin', () => {
    assert.strictEqual(repoInQuote('/work/Phone-Agent', 'at /work/phone-agent', { platform: 'linux' }), false);
    assert.strictEqual(repoInQuote('/work/Phone-Agent', 'at /work/phone-agent', { platform: 'darwin' }), true);
    assert.strictEqual(repoInQuote('/work/phone-agent/', 'at /work/phone-agent:', { platform: 'linux' }), true);
  });
});

describe('Detour list errors', () => {
  it('returns ok: false when the router cannot list', async () => {
    const { rt, turn, opts } = await setup();
    rt.detours._list = () => { throw new Error('detours.jsonl is unreadable'); };
    assert.deepStrictEqual(await DetourTool.execute({ action: 'list' }, opts), { ok: false, error: 'detours.jsonl is unreadable' });
    await rt.endTurn(turn, { summary: 'x' });
  });
});
