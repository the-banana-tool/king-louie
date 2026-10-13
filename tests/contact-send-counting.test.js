// tests/contact-send-counting.test.js
// Owner decision 2026-10-12: a ContactRouter.sendExternal to anyone but the
// owner (a) needs its channel named in the envelope the owner approved and
// (b) is counted against that envelope's caps, the case's contactsPerDay and
// the executor's global daily cap: reserved before it leaves, settled after.
// The real gate, the real envelope flow, a loopback channel; no network.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./helpers/executor-fixtures');
const { LoopbackChannel } = require('./helpers/loopback-channel');
const { ContactDeliveryError } = require('../src/channels/channel-plugin');
const { ContactRouter } = require('../src/cases/contact');
const { ContactState } = require('../src/cases/contact-state');
const { EnvelopeStore } = require('../src/cases/executors');
const envelopeOps = require('../src/cases/executors/envelope-ops');
const gates = require('../src/cases/gates');

after(fx.cleanup);

const OWNER = '+15550100';
const BROKER = '+15550101';
const OTHER = '+15550102';
const TEXT = 'Is the lot still listed?';

async function setup({
  channels = ['sms'], caps = { usd: 10, contacts: 2, attemptsPerContact: 2 }, allow = [BROKER, OTHER], perDay = 5, caseContacts = null,
  wire = {}
} = {}) {
  const env = fx.setupExecutors({ cases: { timeZone: 'UTC', ...(caseContacts ? { budgets: { contactsPerDay: caseContacts } } : {}) } });
  const ctl = fx.withFakeAgent(env, 'fake-agent', { entry: { constraints: { contactsPerDay: perDay } } });
  const rt = env.runtime;
  const reg = env.registry;
  const meta = await fx.activeCase(rt);
  const req = await envelopeOps.requestEnvelope(reg, { caseId: meta.id, turnId: 'turn-1' }, {
    executor: 'fake-agent', intent: 'Ask a broker for a listing quote', recipients: { allow }, caps,
    window: { start: '2026-10-26', end: '2026-10-30' }, ...(channels ? { channels } : {})
  });
  assert.strictEqual(req.ok, true, req.error);
  const question = rt.questions(meta.id).get(req.questionId);
  await rt.answerQuestion(meta.id, req.questionId, { channel: 'in-app', optionId: 'approve' });
  envelopeOps.syncEnvelopes(reg, meta.id);
  const adapters = new Map(['sms', 'email', 'voice'].map((id) => [id, new LoopbackChannel({ id, owner: id === 'email' ? 'owner@example.com' : OWNER })]));
  const state = new ContactState({ dir: path.join(env.dataDir, 'contact'), clock: () => env.clock.now });
  const router = new ContactRouter({
    state, runtime: rt, adapters, getGate: () => gates, clock: () => env.clock.now,
    checkEnvelope: (args) => reg.sendEnvelope(args),
    reserveSend: (args) => reg.reserveChannelSend(args),
    settleSend: (reservation, outcome) => reg.settleChannelSend(reservation, outcome),
    ...wire
  });
  const send = (over = {}) => router.sendExternal({
    caseId: meta.id, channelId: 'sms', target: BROKER, text: TEXT, envelopeId: req.envelopeId, executorId: 'fake-agent', ...over
  });
  const store = new EnvelopeStore(meta.dir);
  const sms = adapters.get('sms');
  const counts = () => {
    const e = store.get(req.envelopeId);
    return {
      contacts: e.usage.contacts, attempts: e.usage.attempts, states: (e.payloads || []).map((p) => p.state),
      caseToday: rt.budget(meta.id).status().contactsPerDay.spent, globalLeft: reg.globalRemaining('fake-agent')
    };
  };
  return { env, ctl, rt, reg, meta, adapters, sms, router, send, store, counts, question, envelopeId: req.envelopeId };
}

const NOTHING = (perDay = 5) => ({ contacts: [], attempts: {}, states: [], caseToday: 0, globalLeft: perDay });
const journals = (s) => fs.readdirSync(path.join(s.meta.dir, 'journal')).sort().map((n) => fs.readFileSync(path.join(s.meta.dir, 'journal', n), 'utf8'));
const failSend = (adapter, err) => {
  const real = adapter.send.bind(adapter);
  adapter.send = async () => {
    adapter.send = real;
    throw err;
  };
};

describe('sendExternal: the envelope names the channel', () => {
  it('an envelope stored without the channels key allows no channel send either', async () => {
    const s = await setup({ channels: null });
    const { channels, ...legacy } = s.store.get(s.envelopeId);
    const { envelopeHash, envelopeCore } = require('../src/cases/executors/envelope');
    s.store.write({ ...legacy, hash: envelopeHash(envelopeCore(legacy)) });
    const r = await s.send();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /outside envelope env-01: allows channel sends on sms/);
    assert.deepStrictEqual(s.sms.plain, []);
  });

  it('an envelope with no channel list allows no channel send, though it is active and lists the recipient', async () => {
    const s = await setup({ channels: null });
    assert.deepStrictEqual(s.store.get(s.envelopeId).channels, [], 'a new envelope stores the empty list');
    assert.match(s.question.text, /\nChannel sends allowed: none\n/);
    const r = await s.send();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /outside envelope env-01: allows channel sends on sms/);
    assert.deepStrictEqual(s.sms.plain, []);
    assert.deepStrictEqual(s.counts(), NOTHING());
  });

  it('a channel the owner approved goes out; another channel to the same number is refused', async () => {
    const s = await setup({ channels: ['sms'] });
    assert.match(s.question.text, /\nChannel sends allowed: sms\n/);
    assert.deepStrictEqual(s.question.payload.envelope.channels, ['sms']);
    const voice = await s.send({ channelId: 'voice' });
    assert.strictEqual(voice.ok, false);
    assert.match(voice.error, /outside envelope env-01: allows channel sends on voice/);
    assert.deepStrictEqual(s.adapters.get('voice').plain, []);
    const ok = await s.send();
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.deepStrictEqual(s.sms.plain, [{ target: BROKER, text: TEXT }]);
  });

  it('a channel written into an approved envelope on disk breaks it', async () => {
    const s = await setup({ channels: ['sms'] });
    const env = s.store.get(s.envelopeId);
    s.store.write({ ...env, channels: ['sms', 'voice'] });
    const r = await s.send({ channelId: 'voice' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /changed since approval/);
    assert.deepStrictEqual(s.adapters.get('voice').plain, []);
  });

  it('adding a channel to an approved envelope takes the owner\'s approval of a delta question', async () => {
    const s = await setup({ channels: ['sms'] });
    const voice = () => s.send({ channelId: 'voice' });
    assert.strictEqual((await voice()).ok, false);
    const before = s.store.get(s.envelopeId);
    const questionId = await s.rt.systemAction(s.meta.id, 'ask for a channel', () => (
      envelopeOps.requestDelta(s.reg, s.meta.id, before, [{ kind: 'channel', value: 'voice' }])
    ));
    const q = s.rt.questions(s.meta.id).get(questionId);
    assert.match(q.text, /Envelope env-01 \(fake-agent\) needs your approval for:\n- allows channel sends on voice\n/);
    envelopeOps.syncEnvelopes(s.reg, s.meta.id);
    assert.strictEqual((await voice()).ok, false, 'asked, not approved: still refused');
    assert.deepStrictEqual(s.adapters.get('voice').plain, []);
    await s.rt.answerQuestion(s.meta.id, questionId, { channel: 'in-app', optionId: 'approve' });
    envelopeOps.syncEnvelopes(s.reg, s.meta.id);
    const after = s.store.get(s.envelopeId);
    assert.deepStrictEqual([after.channels, after.version, after.status], [['sms', 'voice'], 2, 'active']);
    assert.notStrictEqual(after.hash, before.hash);
    const ok = await voice();
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.deepStrictEqual(s.adapters.get('voice').plain, [{ target: BROKER, text: TEXT }]);
  });

  it('the check refuses a send that names no channel', async () => {
    const s = await setup();
    for (const channelId of [undefined, null, '', 42]) {
      const r = s.reg.sendEnvelope({ caseId: s.meta.id, envelopeId: s.envelopeId, executorId: 'fake-agent', recipients: [BROKER], channelId });
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /no channel was named/);
    }
    assert.strictEqual(s.reg.sendEnvelope({ caseId: s.meta.id, envelopeId: s.envelopeId, executorId: 'fake-agent', recipients: [BROKER], channelId: 'sms' }).ok, true);
  });

  it('call means voice', async () => {
    const s = await setup({ channels: ['call'] });
    assert.deepStrictEqual(s.store.get(s.envelopeId).channels, ['voice']);
    const args = { caseId: s.meta.id, envelopeId: s.envelopeId, executorId: 'fake-agent', recipients: [BROKER] };
    assert.strictEqual(s.reg.sendEnvelope({ ...args, channelId: 'call' }).ok, true);
    assert.strictEqual(s.reg.sendEnvelope({ ...args, channelId: 'voice' }).ok, true);
    assert.strictEqual(s.reg.sendEnvelope({ ...args, channelId: 'sms' }).ok, false);
  });
});

describe('sendExternal: a send that goes out is counted', () => {
  it('against the envelope, the case contacts for the day and the global daily cap; the owner path counts nothing', async () => {
    const s = await setup();
    const owner = await s.router.sendExternal({ caseId: s.meta.id, channelId: 'sms', target: OWNER, text: 'A status line.' });
    assert.strictEqual(owner.ok, true);
    assert.deepStrictEqual(s.counts(), NOTHING());
    const r = await s.send();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(s.counts(), { contacts: [BROKER], attempts: { [BROKER]: 1 }, states: ['sent'], caseToday: 1, globalLeft: 4 });
    const [entry] = s.store.get(s.envelopeId).payloads;
    assert.deepStrictEqual(
      [entry.n, entry.sendId, entry.channel, entry.recipients, entry.rendered, entry.estimateUsd],
      [1, r.deliveryId, 'sms', [BROKER], { text: TEXT }, 0]
    );
    assert.strictEqual(s.store.get(s.envelopeId).nextN, 1);
    assert.ok(journals(s).some((j) => j.includes(`Channel send ${r.deliveryId} on sms to ${BROKER} under env-01.`) && j.includes(TEXT)));
    // A second message to the same contact is one more attempt, not a new contact.
    assert.strictEqual((await s.send()).ok, true);
    assert.deepStrictEqual(s.counts(), { contacts: [BROKER], attempts: { [BROKER]: 2 }, states: ['sent', 'sent'], caseToday: 1, globalLeft: 4 });
    assert.strictEqual(require('../src/cases/executors/envelope').envelopeIntact(s.store.get(s.envelopeId)), true, 'usage is outside the hash');
  });

  it('a send past attemptsPerContact is refused before anything leaves', async () => {
    const s = await setup({ caps: { usd: 10, contacts: 2, attemptsPerContact: 1 } });
    assert.strictEqual((await s.send()).ok, true);
    const before = s.counts();
    const r = await s.send();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /outside envelope env-01: raises attempts per contact from 1 to 2/);
    assert.strictEqual(s.sms.plain.length, 1);
    assert.deepStrictEqual(s.counts(), before);
  });

  it('a send past the envelope contacts cap is refused', async () => {
    const s = await setup({ caps: { usd: 10, contacts: 1, attemptsPerContact: 2 } });
    assert.strictEqual((await s.send()).ok, true);
    const r = await s.send({ target: OTHER });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /raises contacts cap from 1 to 2/);
    assert.deepStrictEqual(s.sms.plain.map((p) => p.target), [BROKER]);
  });

  it('a send past the case contactsPerDay is refused, and reaching it tells the owner once', async () => {
    const s = await setup({ caseContacts: 1 });
    assert.strictEqual((await s.send()).ok, true);
    const daily = () => s.rt.questions(s.meta.id).open().filter((q) => q.payload?.type === 'budget-daily');
    assert.strictEqual(daily().length, 1, 'the day allowance is used: the owner is told');
    const r = await s.send({ target: OTHER });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /the case has 0 contacts left today; this send needs 1/);
    assert.deepStrictEqual(s.sms.plain.map((p) => p.target), [BROKER]);
    assert.deepStrictEqual(s.counts(), { contacts: [BROKER], attempts: { [BROKER]: 1 }, states: ['sent'], caseToday: 1, globalLeft: 4 });
    assert.strictEqual((await s.send()).ok, true, 'the contact already counted today may be messaged again');
  });

  it('a send past the global daily cap is refused and what it had counted is given back', async () => {
    const s = await setup({ perDay: 1 });
    assert.strictEqual((await s.send()).ok, true);
    const r = await s.send({ target: OTHER });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /fake-agent daily cap 1 reached/);
    assert.deepStrictEqual(s.sms.plain.map((p) => p.target), [BROKER]);
    assert.deepStrictEqual(s.counts(), { contacts: [BROKER], attempts: { [BROKER]: 1 }, states: ['sent'], caseToday: 1, globalLeft: 0 });
  });

  it('the global cap is shared with another case on this data dir', async () => {
    const s = await setup({ perDay: 1 });
    await s.reg.reserveContacts('fake-agent', 1, { caseId: 'another-case' });
    const r = await s.send();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /daily cap 1 reached/);
    assert.deepStrictEqual(s.sms.plain, []);
    assert.deepStrictEqual(s.counts(), { ...NOTHING(1), globalLeft: 0 });
  });

  it('two concurrent sends cannot both pass an attempts cap of one', async () => {
    const s = await setup({ caps: { usd: 10, contacts: 2, attemptsPerContact: 1 } });
    const results = await Promise.all([s.send(), s.send(), s.send()]);
    assert.deepStrictEqual(results.map((r) => r.ok).sort(), [false, false, true]);
    assert.strictEqual(s.sms.plain.length, 1);
    assert.deepStrictEqual(s.counts(), { contacts: [BROKER], attempts: { [BROKER]: 1 }, states: ['sent'], caseToday: 1, globalLeft: 4 });
  });

  it('two concurrent sends cannot both pass a case, envelope or global cap of one contact', async () => {
    for (const over of [{ caseContacts: 1 }, { caps: { usd: 10, contacts: 1, attemptsPerContact: 2 } }, { perDay: 1 }]) {
      const s = await setup(over);
      const results = await Promise.all([s.send(), s.send({ target: OTHER })]);
      assert.deepStrictEqual(results.map((r) => r.ok).sort(), [false, true], JSON.stringify(over));
      assert.strictEqual(s.sms.plain.length, 1, JSON.stringify(over));
      const c = s.counts();
      assert.deepStrictEqual([c.contacts.length, c.states, c.caseToday], [1, ['sent'], 1], JSON.stringify(over));
      assert.strictEqual(c.globalLeft, (over.perDay || 5) - 1, JSON.stringify(over));
    }
  });
});

describe('sendExternal: settling a counted send', () => {
  it('a send the channel clearly refused gives its count back', async () => {
    for (const code of ['rejected', 'not-configured', 'too-large', 'rate-limited']) {
      const s = await setup({ caseContacts: 1 });
      failSend(s.sms, new ContactDeliveryError(code, `loopback ${code}`));
      const r = await s.send();
      assert.deepStrictEqual(r, { ok: false, error: `loopback ${code}` }, code);
      assert.deepStrictEqual(s.counts(), NOTHING(), code);
      assert.deepStrictEqual(s.rt.questions(s.meta.id).open().filter((q) => q.payload?.type === 'budget-daily'), [], 'no allowance notice for a send that never left');
      const again = await s.send();
      assert.strictEqual(again.ok, true, JSON.stringify(again));
      assert.deepStrictEqual(s.counts(), { contacts: [BROKER], attempts: { [BROKER]: 1 }, states: ['sent'], caseToday: 1, globalLeft: 4 });
    }
  });

  it('a send that may have left stays counted', async () => {
    for (const err of [new ContactDeliveryError('unreachable', 'relay timed out'), new Error('socket hang up')]) {
      const s = await setup({ caps: { usd: 10, contacts: 2, attemptsPerContact: 1 } });
      failSend(s.sms, err);
      const r = await s.send();
      assert.deepStrictEqual(r, { ok: false, error: err.message, counted: true });
      assert.deepStrictEqual(s.counts(), { contacts: [BROKER], attempts: { [BROKER]: 1 }, states: ['unconfirmed'], caseToday: 1, globalLeft: 4 });
      assert.ok(journals(s).some((j) => j.includes('may have left') && j.includes(err.message)));
      const again = await s.send();
      assert.strictEqual(again.ok, false, 'the attempt is used');
      assert.match(again.error, /raises attempts per contact/);
    }
  });

  it('a released send gives back only what it alone counted', async () => {
    const s = await setup();
    assert.strictEqual((await s.send()).ok, true);
    failSend(s.sms, new ContactDeliveryError('rejected', 'refused'));
    assert.strictEqual((await s.send()).ok, false);
    assert.deepStrictEqual(s.counts(), { contacts: [BROKER], attempts: { [BROKER]: 1 }, states: ['sent'], caseToday: 1, globalLeft: 4 });
  });

  it('a reservation that is never settled (a crash mid-send) stays counted', async () => {
    const s = await setup({ caps: { usd: 10, contacts: 2, attemptsPerContact: 1 } });
    const held = await s.reg.reserveChannelSend({
      caseId: s.meta.id, envelopeId: s.envelopeId, executorId: 'fake-agent', channelId: 'sms', recipients: [BROKER], sendId: 'd-crash', rendered: TEXT,
      expectedHash: s.store.get(s.envelopeId).hash
    });
    assert.strictEqual(held.ok, true, held.error);
    assert.deepStrictEqual(s.counts(), { contacts: [BROKER], attempts: { [BROKER]: 1 }, states: ['reserved'], caseToday: 1, globalLeft: 4 });
    const r = await s.send();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /raises attempts per contact/);
    // Settling is idempotent: a second release gives nothing back twice.
    assert.deepStrictEqual(await s.reg.settleChannelSend(held.reservation, { sent: false }), { ok: true, state: 'released' });
    assert.deepStrictEqual(await s.reg.settleChannelSend(held.reservation, { sent: false }), { ok: true, state: 'released' });
    assert.deepStrictEqual(await s.reg.settleChannelSend({ ...held.reservation, settled: null }, { sent: false }), { ok: true, state: 'missing' });
    assert.deepStrictEqual(s.counts(), NOTHING());
  });

  it('a failed settle leaves the send counted and never fails a send that went out', async () => {
    const s = await setup({ wire: { settleSend: async () => { throw new Error('disk full'); } } });
    const r = await s.send();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(s.counts(), { contacts: [BROKER], attempts: { [BROKER]: 1 }, states: ['reserved'], caseToday: 1, globalLeft: 4 });
  });
});

describe('sendExternal: counting fails closed', () => {
  it('a router that cannot count refuses every non-owner send', async () => {
    for (const wire of [{ reserveSend: null }, { settleSend: null }, { reserveSend: () => null }, { reserveSend: () => ({ ok: true }) }, { reserveSend: async () => { throw new Error('exploded'); } }]) {
      const s = await setup({ wire });
      const r = await s.send();
      assert.strictEqual(r.ok, false, JSON.stringify(wire));
      assert.strictEqual(typeof r.error, 'string');
      assert.deepStrictEqual(s.sms.plain, []);
      assert.strictEqual((await s.router.sendExternal({ caseId: s.meta.id, channelId: 'sms', target: OWNER, text: 'A status line.' })).ok, true);
    }
  });

  it('the reservation checks the envelope again: revoked, changed or another version since the gate ran', async () => {
    const s = await setup();
    const args = {
      caseId: s.meta.id, envelopeId: s.envelopeId, executorId: 'fake-agent', channelId: 'sms', recipients: [BROKER], sendId: 'd-1', rendered: TEXT,
      expectedHash: s.store.get(s.envelopeId).hash
    };
    const stale = await s.reg.reserveChannelSend({ ...args, expectedHash: 'sha256:another-version' });
    assert.strictEqual(stale.ok, false);
    assert.match(stale.error, /changed while the send was being checked/);
    for (const expectedHash of [undefined, null, '', 42]) {
      const none = await s.reg.reserveChannelSend({ ...args, expectedHash });
      assert.strictEqual(none.ok, false, String(expectedHash));
      assert.match(none.error, /does not say which version of the envelope/);
    }
    assert.deepStrictEqual(s.counts(), NOTHING());
    for (const bad of [{ sendId: '' }, { recipients: [] }, { rendered: undefined }, { channelId: undefined }, { channelId: 'email' }, { executorId: 'no-such-agent' }]) {
      const r = await s.reg.reserveChannelSend({ ...args, ...bad });
      assert.strictEqual(r.ok, false, JSON.stringify(bad));
    }
    await envelopeOps.revokeEnvelope(s.reg, s.meta.id, s.envelopeId);
    const revoked = await s.reg.reserveChannelSend(args);
    assert.strictEqual(revoked.ok, false);
    assert.match(revoked.error, /envelope env-01 is revoked/);
    assert.deepStrictEqual(s.counts(), NOTHING());
  });

  it('through the router: an envelope that changes between the gate and the count sends nothing', async () => {
    // The owner approves a wider version while the gate is running: the send
    // was checked against the old one, so it is not counted or sent.
    let widen = null;
    const s = await setup({
      wire: {
        getGate: () => ({
          gateLeaves: async (payload, opts) => {
            await widen();
            return gates.gateLeaves(payload, opts);
          }
        })
      }
    });
    widen = async () => {
      const questionId = await s.rt.systemAction(s.meta.id, 'ask for a channel', () => (
        envelopeOps.requestDelta(s.reg, s.meta.id, s.store.get(s.envelopeId), [{ kind: 'channel', value: 'voice' }])
      ));
      await s.rt.answerQuestion(s.meta.id, questionId, { channel: 'in-app', optionId: 'approve' });
      envelopeOps.syncEnvelopes(s.reg, s.meta.id);
    };
    const before = s.store.get(s.envelopeId).hash;
    const r = await s.send();
    assert.notStrictEqual(s.store.get(s.envelopeId).hash, before, 'the envelope did change');
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /envelope env-01 changed while the send was being checked; nothing was sent/);
    assert.deepStrictEqual(s.sms.plain, []);
    assert.deepStrictEqual(s.counts(), NOTHING());
    widen = async () => {};
    assert.strictEqual((await s.send()).ok, true, 'checked again against the new version, it goes out');
  });

  it('through the router: an envelope check that returns no hash sends nothing', async () => {
    const s = await setup();
    s.router.checkEnvelope = (args) => {
      const checked = s.reg.sendEnvelope(args);
      const { hash, ...rest } = checked.envelope;
      return { ok: true, envelope: rest };
    };
    const r = await s.send();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /does not say which version of the envelope/);
    assert.deepStrictEqual(s.sms.plain, []);
  });

  it('a paused case sends nothing', async () => {
    const s = await setup();
    s.rt.setStatus(s.meta.id, 'paused', { kind: 'owner', by: 'owner' });
    const r = await s.send();
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /the case is paused; a channel send needs an active case\. Nothing was sent\./);
    assert.deepStrictEqual(s.sms.plain, []);
    assert.deepStrictEqual(s.counts(), NOTHING());
  });

  it('a gate block counts nothing', async () => {
    const s = await setup();
    s.rt.ledger(s.meta.id).assert({
      stmt: 'The lowest price the owner takes', subject: 'lot', attr: 'floor price', value: 187500, provenance: 'sourced', category: 'financial',
      source: { kind: 'url', ref: 'https://records.example.org/notes' }
    });
    const r = await s.send({ text: 'We would take 187500.' });
    assert.strictEqual(r.ok, false);
    assert.ok(Array.isArray(r.blocked) && r.blocked.length);
    assert.deepStrictEqual(s.counts(), NOTHING());
  });
});

describe('sendExternal: the case lock', () => {
  it('counts inside a turn this process holds without waiting on its own lock, and outside one', async () => {
    const s = await setup();
    const { turn } = await fx.openTurn(s.rt, s.meta.id, { turnId: 'turn-send' });
    const inside = await s.send();
    assert.strictEqual(inside.ok, true, JSON.stringify(inside));
    assert.ok(s.rt.runningTurn(s.meta.id), 'the turn still holds the case');
    await s.rt.endTurn(turn);
    const outside = await s.send({ target: OTHER });
    assert.strictEqual(outside.ok, true, JSON.stringify(outside));
    assert.deepStrictEqual(s.counts().states, ['sent', 'sent']);
    assert.strictEqual(fs.existsSync(path.join(s.meta.dir, '.kl', 'lock')), false, 'no lock is left behind');
  });

  it('a case another process holds refuses the send before anything leaves', async () => {
    const s = await setup();
    const lock = path.join(s.meta.dir, '.kl', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ turnId: 'turn-elsewhere', pid: process.ppid, at: new Date().toISOString() }));
    try {
      const r = await s.send();
      assert.strictEqual(r.ok, false);
      assert.match(r.error, /busy.*Nothing was sent/s);
      assert.deepStrictEqual(s.sms.plain, []);
    } finally {
      fs.rmSync(lock, { force: true });
    }
    assert.deepStrictEqual(s.counts(), NOTHING());
    assert.strictEqual((await s.send()).ok, true);
  });
});

// Security review 2026-10-12, finding 3: a channel send and an executor job
// under one envelope count against the same caps and the same contacts.
describe('sendExternal and Executor.submit under one envelope', () => {
  const { submitJob } = require('../src/cases/executors/submit');
  const { JobStore } = require('../src/cases/executors');
  const job = (s, target, over = {}) => submitJob(s.reg, { caseId: s.meta.id, turnId: 'turn-job' }, {
    executor: 'fake-agent', envelopeId: s.envelopeId,
    payload: JSON.stringify({ recipients: [{ address: target, name: 'Harbor Realty' }], text: 'Hello, is the lot still listed?', attemptsPerContact: 1, ...over })
  });
  // Resolves once the job is on disk, still inside adapter.submit.
  const inSubmit = async (s) => {
    const jobs = new JobStore(s.meta.dir);
    for (let i = 0; i < 400; i += 1) {
      if (jobs.list().some((j) => j.state === 'submitting')) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('no job reached submitting');
  };
  const reserve = (s, target, sendId = 'd-held') => s.reg.reserveChannelSend({
    caseId: s.meta.id, envelopeId: s.envelopeId, executorId: 'fake-agent', channelId: 'sms', recipients: [target], sendId, rendered: TEXT,
    expectedHash: s.store.get(s.envelopeId).hash
  });

  it('a send cannot pass an attempts cap of one while a job to that contact is inside adapter.submit', async () => {
    const s = await setup({ caps: { usd: 10, contacts: 2, attemptsPerContact: 1 } });
    s.ctl.submitDelayMs = 400;
    const pending = job(s, BROKER);
    await inSubmit(s);
    assert.deepStrictEqual(s.store.get(s.envelopeId).usage.attempts, {}, 'the job has not recorded its usage yet');
    const r = await s.send();
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /raises attempts per contact from 1 to 2/);
    assert.deepStrictEqual(s.sms.plain, []);
    const done = await pending;
    assert.strictEqual(done.ok, true, JSON.stringify(done));
    assert.deepStrictEqual(s.counts(), { contacts: [BROKER], attempts: { [BROKER]: 1 }, states: [undefined], caseToday: 1, globalLeft: 4 });
  });

  it('a send cannot pass a contacts cap of one while a job to another contact is inside adapter.submit', async () => {
    const s = await setup({ caps: { usd: 10, contacts: 1, attemptsPerContact: 2 } });
    s.ctl.submitDelayMs = 400;
    const pending = job(s, BROKER);
    await inSubmit(s);
    const r = await s.send({ target: OTHER });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /raises contacts cap from 1 to 2/);
    assert.deepStrictEqual(s.sms.plain, []);
    assert.strictEqual((await pending).ok, true);
    assert.deepStrictEqual(s.counts().contacts, [BROKER]);
  });

  it('a send cannot pass a case contactsPerDay of one while a job to another contact is inside adapter.submit', async () => {
    const s = await setup({ caseContacts: 1 });
    s.ctl.submitDelayMs = 400;
    const pending = job(s, BROKER);
    await inSubmit(s);
    assert.strictEqual(s.rt.budget(s.meta.id).status().contactsPerDay.spent, 0, 'the job charges its contact only when it commits');
    const r = await s.send({ target: OTHER });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /the case has 0 contacts left today; this send needs 1/);
    assert.deepStrictEqual(s.sms.plain, []);
    assert.strictEqual((await pending).ok, true);
    assert.strictEqual(s.counts().caseToday, 1);
  });

  it('a job cannot pass a cap of one that a send reserved while the job was still being checked', async () => {
    const s = await setup({ caps: { usd: 10, contacts: 2, attemptsPerContact: 1 } });
    // The detour gate awaits after the job read its envelope: a send is counted in that gap.
    let held = null;
    s.rt.detourGate = async () => {
      held = await reserve(s, BROKER);
      return { ok: true };
    };
    const r = await job(s, BROKER);
    assert.strictEqual(held.ok, true, held.error);
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /raises attempts per contact from 1 to 2/);
    assert.deepStrictEqual(s.ctl.calls.filter((c) => c[0] === 'submit'), [], 'nothing was submitted');
    assert.deepStrictEqual(s.counts().attempts, { [BROKER]: 1 });
  });

  it('a released send never gives back a contact an open job relies on', async () => {
    const s = await setup();
    const held = await reserve(s, BROKER);
    assert.strictEqual(held.ok, true, held.error);
    assert.deepStrictEqual(s.counts(), { contacts: [BROKER], attempts: { [BROKER]: 1 }, states: ['reserved'], caseToday: 1, globalLeft: 4 });
    // The job sees the contact as already counted and charges nothing for it.
    s.ctl.submitDelayMs = 400;
    const pending = job(s, BROKER);
    await inSubmit(s);
    // The send is then clearly refused: its release must not take the contact with it.
    assert.deepStrictEqual(await s.reg.settleChannelSend(held.reservation, { sent: false }), { ok: true, state: 'released' });
    const mid = s.counts();
    assert.deepStrictEqual([mid.contacts, mid.caseToday, mid.globalLeft], [[BROKER], 1, 4]);
    assert.strictEqual((await pending).ok, true);
    assert.deepStrictEqual(s.counts(), { contacts: [BROKER], attempts: { [BROKER]: 1 }, states: [undefined], caseToday: 1, globalLeft: 4 });
  });
});

// Security review 2026-10-12, finding 4: a release gives back only into the
// day the reservation was counted on.
describe('sendExternal: a release across midnight', () => {
  const reserve = (s) => s.reg.reserveChannelSend({
    caseId: s.meta.id, envelopeId: s.envelopeId, executorId: 'fake-agent', channelId: 'sms', recipients: [BROKER], sendId: 'd-late', rendered: TEXT,
    expectedHash: s.store.get(s.envelopeId).hash
  });

  it('takes nothing off the new day, in the global cap or the case contacts', async () => {
    const s = await setup();
    s.env.clock.now = new Date('2026-10-26T23:59:30Z');
    const held = await reserve(s);
    assert.strictEqual(held.ok, true, held.error);
    assert.deepStrictEqual([s.counts().caseToday, s.counts().globalLeft], [1, 4]);
    // The next day: this case counts one contact of its own, then yesterday's send is released.
    s.env.clock.now = new Date('2026-10-27T00:00:30Z');
    assert.strictEqual((await s.reg.reserveContacts('fake-agent', 1, { caseId: s.meta.id })).ok, true);
    s.rt.budget(s.meta.id).charge('contactsPerDay', 1);
    assert.deepStrictEqual([s.counts().caseToday, s.counts().globalLeft], [1, 4]);
    assert.deepStrictEqual(await s.reg.settleChannelSend(held.reservation, { sent: false }), { ok: true, state: 'released' });
    assert.deepStrictEqual(s.counts(), { contacts: [], attempts: {}, states: [], caseToday: 1, globalLeft: 4 });
  });

  it('on the same day the release gives the contact back in both', async () => {
    const s = await setup();
    s.env.clock.now = new Date('2026-10-26T23:00:00Z');
    const held = await reserve(s);
    s.env.clock.now = new Date('2026-10-26T23:59:00Z');
    await s.reg.settleChannelSend(held.reservation, { sent: false });
    assert.deepStrictEqual(s.counts(), NOTHING());
  });

  it('releaseContacts with a day releases only into that day', async () => {
    const s = await setup();
    const first = await s.reg.reserveContacts('fake-agent', 2, { caseId: s.meta.id });
    assert.strictEqual(first.day, '2026-10-26');
    assert.deepStrictEqual(await s.reg.releaseContacts('fake-agent', 1, { caseId: s.meta.id, day: '2026-10-25' }), { ok: true, released: 0 });
    assert.deepStrictEqual(await s.reg.releaseContacts('fake-agent', 1, { caseId: s.meta.id, day: '2026-10-26' }), { ok: true, released: 1 });
    assert.strictEqual(s.reg.globalRemaining('fake-agent'), 4);
  });
});

// Second review 2026-10-13, findings 6, 8 and 9.
describe('jobs, sends and the counting lock', () => {
  const { submitJob } = require('../src/cases/executors/submit');
  const { JobStore } = require('../src/cases/executors');
  const job = (s, target) => submitJob(s.reg, { caseId: s.meta.id, turnId: 'turn-job' }, {
    executor: 'fake-agent', envelopeId: s.envelopeId,
    payload: JSON.stringify({ recipients: [{ address: target, name: 'Harbor Realty' }], text: 'Hello, is the lot still listed?', attemptsPerContact: 1 })
  });
  const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

  it('two jobs submitted together cannot both pass a case contactsPerDay of one', async () => {
    const s = await setup({ caseContacts: 1 });
    s.ctl.submitDelayMs = 150;
    const results = await Promise.all([job(s, BROKER), job(s, OTHER)]);
    assert.deepStrictEqual(results.map((r) => r.ok).sort(), [false, true], JSON.stringify(results));
    assert.match(results.find((r) => !r.ok).error, /the case has 0 contacts left today; this job needs 1/);
    assert.strictEqual(s.ctl.calls.filter((c) => c[0] === 'submit').length, 1);
    assert.strictEqual(s.counts().caseToday, 1);
  });

  // The lock alone: the job has passed its fit and is waiting on the global
  // cap, with no job file yet and nothing recorded. Only the lock keeps a
  // send from being counted in that gap.
  it('a send waits for a job that is between its fit and its job file', async () => {
    const s = await setup({ caps: { usd: 10, contacts: 2, attemptsPerContact: 1 } });
    const real = s.reg.reserveContacts.bind(s.reg);
    let sent = null;
    let first = true;
    s.reg.reserveContacts = async (...args) => {
      if (first) {
        first = false;
        // The job is inside its checked section: start a send to the same contact now.
        assert.deepStrictEqual(new JobStore(s.meta.dir).list(), [], 'no job file yet');
        sent = s.send();
        await tick(60);
      }
      return real(...args);
    };
    const done = await job(s, BROKER);
    const r = await sent;
    assert.strictEqual(done.ok, true, JSON.stringify(done));
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /raises attempts per contact from 1 to 2/);
    assert.deepStrictEqual(s.sms.plain, []);
    assert.deepStrictEqual(s.counts().attempts, { [BROKER]: 1 });
  });

  it('a release waits for a job that is between its fit and its job file, and then leaves its contact', async () => {
    const s = await setup();
    const held = await s.reg.reserveChannelSend({
      caseId: s.meta.id, envelopeId: s.envelopeId, executorId: 'fake-agent', channelId: 'sms', recipients: [BROKER], sendId: 'd-held', rendered: TEXT,
      expectedHash: s.store.get(s.envelopeId).hash
    });
    assert.strictEqual(held.ok, true, held.error);
    // The job treats BROKER as already counted, then waits (on the detour
    // gate's follow-up work here; on any await in its checked section).
    const order = [];
    let release = null;
    const realIndex = s.reg.indexJob.bind(s.reg);
    let hooked = false;
    const realFit = require('../src/cases/executors/envelope-ops').withPendingJobs;
    const ops = require('../src/cases/executors/envelope-ops');
    ops.withPendingJobs = (...args) => {
      if (!hooked) {
        hooked = true;
        // Inside the job's checked section, before its job file exists.
        release = s.reg.settleChannelSend(held.reservation, { sent: false }).then((out) => { order.push('released'); return out; });
      }
      return realFit(...args);
    };
    s.reg.indexJob = async (...args) => { order.push('job file written'); return realIndex(...args); };
    try {
      const done = await job(s, BROKER);
      assert.strictEqual(done.ok, true, JSON.stringify(done));
      assert.deepStrictEqual(await release, { ok: true, state: 'released' });
    } finally {
      ops.withPendingJobs = realFit;
    }
    assert.deepStrictEqual(order.slice(0, 1), ['job file written'], 'the release ran after the job left its checked section');
    assert.ok(order.includes('released'));
    const c = s.counts();
    assert.deepStrictEqual([c.contacts, c.caseToday, c.globalLeft], [[BROKER], 1, 4], 'the contact the job relies on stays counted');
  });
});
