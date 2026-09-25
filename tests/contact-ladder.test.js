// tests/contact-ladder.test.js — cases stage 4 §3.6, §3.7 (LadderEngine).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { ContactState } = require('../src/cases/contact-state');
const { ContactRouter } = require('../src/cases/contact');
const { Presence } = require('../src/cases/presence');
const { LadderEngine } = require('../src/cases/ladder');
const { defaultPolicy } = require('../src/cases/contact-format');
const { LoopbackChannel } = require('./helpers/loopback-channel');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

function quietPolicy() {
  const p = defaultPolicy();
  p.digest = null;
  return p;
}

async function world({ start = '2026-09-25T09:00:00Z', interactive = false, tz = 'UTC', policy = quietPolicy(), channels = ['telegram', 'email', 'sms', 'voice'], casesRoot = null, dataDir = null } = {}) {
  let now = new Date(start);
  const clock = () => now;
  const root = casesRoot || tmp('kl-ladder-cases-');
  const data = dataDir || tmp('kl-ladder-data-');
  const runtime = new CaseRuntime({ root, now: clock, host: { interactive: () => interactive } });
  const state = new ContactState({ dir: path.join(data, 'contact'), clock });
  const adapters = new Map();
  const caps = {
    telegram: {},
    discord: {},
    email: { authenticatedReplies: false, interrupts: false, idempotentSend: true },
    sms: { authenticatedReplies: false, requiresToken: true, idempotentSend: true },
    voice: { authenticatedReplies: false, voice: true, idempotentSend: true },
    'in-app': { interrupts: false }
  };
  for (const id of channels) adapters.set(id, new LoopbackChannel({ id, owner: id === 'email' ? 'owner@example.com' : `${id}-owner`, caps: caps[id] || {} }));
  const presence = new Presence({
    file: path.join(data, 'contact', 'presence.json'), getPolicy: () => policy, clock, interactive: () => interactive,
    isEnabled: (c) => adapters.has(c), getTimeZone: () => tz
  });
  const router = new ContactRouter({ state, runtime, adapters, presence, clock, getTimeZone: () => tz });
  for (const [id, a] of adapters) a.onContactReply((cid, answer, meta) => router.handleReply(id, cid, answer, meta));
  const ladder = new LadderEngine({ state, casesRoot: root, runtime, router, presence, getPolicy: () => policy, clock, tickMs: 30000, dataDir: data });
  const lot = await runtime.createCase({ title: 'Lakeside lot', objective: 'Sell the lot' });
  return {
    runtime, state, router, adapters, presence, ladder, lot, policy, root, data,
    now: () => now,
    at: (iso) => { now = new Date(iso); return now; },
    advance: (ms) => { now = new Date(now.getTime() + ms); return now; },
    ask: (record, caseId = lot.id) => runtime.createQuestion(caseId, { kind: 'question', urgency: 'normal', options: [], ...record }, { charge: false }),
    entry: (q, caseId = lot.id) => state.ladder().entries[`${caseId}/${q.id}`],
    tickAt: async (iso) => { now = new Date(iso); return ladder.tick(now); }
  };
}

const outcomes = (e) => e.attempts.map((a) => `${a.channel}:${a.outcome}${a.reason ? `:${a.reason}` : ''}`);
const journals = (w, caseId = w.lot.id) => {
  const dir = path.join(w.runtime.getCase(caseId).dir, 'journal');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') : '';
};

describe('LadderEngine timing', () => {
  it('batches one turn\'s questions at createdAt + batchDelaySec and times later steps from startedAt', async () => {
    const w = await world();
    const kitchen = await w.runtime.createCase({ title: 'Kitchen quotes', objective: 'Pick a builder' });
    const q1 = w.ask({ text: 'Seller financing?' });
    w.advance(20 * 1000);
    const q2 = w.ask({ text: 'Which week?' }, kitchen.id);
    await w.tickAt('2026-09-25T09:00:30Z');
    assert.deepStrictEqual(w.entry(q1).attempts, [], 'nothing before the batch delay');
    await w.tickAt('2026-09-25T09:01:25Z');
    assert.deepStrictEqual(outcomes(w.entry(q1)), ['present:absent']);
    assert.strictEqual(w.entry(q1).nextAt, '2026-09-25T09:30:00.000Z');
    await w.tickAt('2026-09-25T09:30:30Z');
    const tg = w.adapters.get('telegram');
    assert.strictEqual(tg.sent.length, 1, 'both cases in one Telegram message');
    assert.strictEqual(tg.last().message.items.length, 2);
    assert.deepStrictEqual(outcomes(w.entry(q2, kitchen.id)), ['present:absent', 'telegram:sent']);
    assert.strictEqual(w.entry(q1).nextAt, '2026-09-25T13:00:00.000Z', 'email 240 min after startedAt');
  });

  it('a failed send advances to the next step at once; an async failure advances on the next tick', async () => {
    const w = await world();
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T09:01:00Z');
    w.adapters.get('telegram').failNext('unreachable');
    const r = await w.tickAt('2026-09-25T09:30:00Z');
    assert.strictEqual(r.failed, 1);
    const e = w.entry(q);
    assert.deepStrictEqual(outcomes(e), ['present:absent', 'telegram:failed']);
    assert.deepStrictEqual(e.attempts[1].error, { code: 'unreachable', message: 'loopback unreachable' });
    assert.strictEqual(e.nextAt, '2026-09-25T09:30:00.000Z');
    await w.tickAt('2026-09-25T09:30:30Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['present:absent', 'telegram:failed', 'email:sent']);

    // async failure: the relay later reports the email bounced.
    const last = w.entry(q).attempts[2];
    w.state.setDeliveryStatus(last.deliveryId, 'bounced', '550 mailbox unavailable');
    await w.tickAt('2026-09-25T09:31:00Z');
    assert.deepStrictEqual(w.entry(q).attempts[2].error, { code: 'bounced', message: '550 mailbox unavailable' });
    assert.strictEqual(w.entry(q).exhausted, true);
  });

  it('after downtime only the latest overdue step fires, on every tick', async () => {
    const w = await world();
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T14:00:00Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['present:skipped:overdue', 'telegram:skipped:overdue', 'email:sent']);
    assert.strictEqual(w.adapters.get('telegram').sent.length, 0);
  });

  it('a channel already delivered to is skipped as a duplicate', async () => {
    const policy = quietPolicy();
    policy.ladders.normal = [{ channel: 'telegram' }, { channel: 'present', afterMin: 5 }, { channel: 'email', afterMin: 10 }];
    const w = await world({ policy });
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T09:01:00Z');
    w.presence.noteInbound('telegram');
    await w.tickAt('2026-09-25T09:05:00Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['telegram:sent', 'telegram:skipped:duplicate', 'email:sent'], 'present resolved to telegram: skipped, and the next step is due at once');
    assert.strictEqual(w.adapters.get('telegram').sent.length, 1);
  });

  it('the journal step writes a question journal line', async () => {
    const w = await world();
    const q = w.ask({ text: 'Is the well shared?', urgency: 'low' });
    await w.tickAt('2026-09-25T09:01:00Z');
    await w.tickAt('2026-09-25T09:01:30Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['in-app:skipped:not-configured', 'journal:sent']);
    assert.match(journals(w), new RegExp(`${q.id} waiting: Is the well shared\\?`));
  });

  it('case.yaml channels override the ladder, with aliases', async () => {
    const w = await world();
    w.runtime.store.updateMeta(w.lot.id, { channels: { 'urgency.normal': ['sms', { channel: 'call', afterMin: 5 }] } });
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T09:01:00Z');
    await w.tickAt('2026-09-25T09:05:00Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['sms:sent', 'voice:sent']);
  });
});

describe('LadderEngine exhaustion, briefings and expiry', () => {
  it('exhausts, journals it, and retries the journal while the case is busy', async () => {
    const w = await world({ channels: [] });
    const q = w.ask({ text: 'Seller financing?' });
    const lock = path.join(w.runtime.getCase(w.lot.id).dir, '.kl', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ turnId: 'other', pid: process.ppid, at: new Date().toISOString() }));
    await w.tickAt('2026-09-25T09:01:00Z');
    const r = await w.tickAt('2026-09-25T09:30:00Z');
    assert.strictEqual(r.exhausted, 1);
    assert.strictEqual(w.entry(q).exhausted, true);
    assert.strictEqual(w.entry(q).exhaustJournaled, false);
    fs.rmSync(lock);
    await w.tickAt('2026-09-25T09:30:30Z');
    assert.strictEqual(w.entry(q).exhaustJournaled, true);
    assert.match(journals(w), new RegExp(`Ladder exhausted for ${q.id}: tried present absent, telegram skipped \\(not-configured\\), email skipped \\(not-configured\\)\\. The question stays open\\.`));
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).answer, null);
  });

  it('a briefing stops after its first sent step', async () => {
    const w = await world();
    const b = w.runtime.createQuestion(w.lot.id, { kind: 'briefing', urgency: 'normal', text: 'The appraisal came back at 41k.' }, { charge: false });
    await w.tickAt('2026-09-25T09:01:00Z');
    await w.tickAt('2026-09-25T09:30:00Z');
    await w.tickAt('2026-09-25T13:00:00Z');
    assert.deepStrictEqual(outcomes(w.entry(b)), ['present:absent', 'telegram:sent']);
    assert.strictEqual(w.entry(b).stopped, true);
    assert.strictEqual(w.adapters.get('email').sent.length, 0);
  });

  it('expired hold is not re-enqueued', async () => {
    const w = await world();
    const q = w.ask({ text: 'Seller financing?', expiresAt: '2026-09-25T09:10:00Z' });
    await w.tickAt('2026-09-25T09:01:00Z');
    await w.tickAt('2026-09-25T09:11:00Z');
    assert.strictEqual(w.entry(q).expired, true);
    await w.tickAt('2026-09-25T13:30:00Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['present:absent'], 'no later step after expiry');
    assert.strictEqual(Object.keys(w.state.ladder().entries).length, 1);
  });

  it('expiry in flight: the attempt is recorded, no later step fires, a later hold reply is accepted', async () => {
    const w = await world();
    const q = w.ask({ text: 'Seller financing?', options: [{ id: 'a', label: 'No' }], expiresAt: '2026-09-25T09:31:00Z' });
    await w.tickAt('2026-09-25T09:01:00Z');
    const release = w.adapters.get('telegram').holdNext();
    const ticking = w.tickAt('2026-09-25T09:30:30Z');
    w.at('2026-09-25T09:32:00Z');
    release();
    await ticking;
    assert.deepStrictEqual(outcomes(w.entry(q)), ['present:absent', 'telegram:sent']);
    await w.tickAt('2026-09-25T13:10:00Z');
    assert.strictEqual(w.entry(q).expired, true);
    assert.deepStrictEqual(outcomes(w.entry(q)), ['present:absent', 'telegram:sent']);
    w.runtime.questions(w.lot.id).expire(w.now());
    const token = w.entry(q).token;
    const r = await w.adapters.get('telegram').reply(token, { optionId: 'a' }, { senderId: 'telegram-owner' });
    assert.strictEqual(r.outcome, 'recorded');
  });
});

describe('LadderEngine in-app and quiet hours', () => {
  it('in-app re-surfaces after the owner comes back to the desktop', async () => {
    const policy = quietPolicy();
    policy.ladders.normal = [{ channel: 'present' }, { channel: 'present', afterMin: 30 }];
    const w = await world({ interactive: true, policy, channels: [] });
    const events = [];
    const { DesktopChannelPlugin } = require('../src/channels/channel-plugin');
    w.adapters.set('in-app', new DesktopChannelPlugin({ sendToUi: (ev, p) => events.push([ev, p]) }));
    const q = w.ask({ text: 'Seller financing?' });
    assert.strictEqual(w.runtime.questions(w.lot.id).get(q.id).deliveries[0].deliveryId, `in-app-${q.id}`);
    await w.tickAt('2026-09-25T09:01:00Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['present:absent']);
    w.at('2026-09-25T09:29:30Z');
    w.presence.heartbeat({ focused: true, lastInputAt: w.now().toISOString() });
    await w.tickAt('2026-09-25T09:30:00Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['present:absent', 'in-app:sent']);
    assert.deepStrictEqual(events, [['case:changed', { caseId: w.lot.id, what: 'questions', questionId: q.id, attention: 'banner' }]]);
  });

  it('in-app on a record stage 2 delivered is sent without sending', async () => {
    const policy = quietPolicy();
    policy.ladders.normal = [{ channel: 'in-app' }];
    const w = await world({ interactive: true, policy, channels: [] });
    const { DesktopChannelPlugin } = require('../src/channels/channel-plugin');
    const events = [];
    w.adapters.set('in-app', new DesktopChannelPlugin({ sendToUi: (ev, p) => events.push([ev, p]) }));
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T09:01:00Z');
    assert.deepStrictEqual(w.entry(q).attempts.map((a) => [a.channel, a.outcome, a.deliveryId]), [['in-app', 'sent', `in-app-${q.id}`]]);
    assert.deepStrictEqual(events, []);
  });

  it('quiet hours across fall-back: a 23:30 normal Telegram step waits until 07:00 local, once', async () => {
    const policy = quietPolicy();
    policy.quietHours = { start: '22:00', end: '07:00', breakthrough: ['high'] };
    policy.digest = null;
    // 23:00 CDT Oct 31 = 04:00Z Nov 1; the Telegram step is due at 04:30Z (23:30 local).
    const w = await world({ start: '2026-11-01T04:00:00Z', tz: 'America/Chicago', policy });
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-11-01T04:01:00Z');
    await w.tickAt('2026-11-01T04:30:00Z');
    assert.strictEqual(w.entry(q).nextAt, '2026-11-01T13:00:00.000Z', '07:00 CST');
    assert.strictEqual(w.adapters.get('telegram').sent.length, 0);
    await w.tickAt('2026-11-01T13:00:00Z');
    assert.strictEqual(w.adapters.get('telegram').sent.length, 1);
  });

  it('a deferred step is not deferred again on the repeated hour', async () => {
    const policy = quietPolicy();
    policy.quietHours = { start: '22:00', end: '01:30', breakthrough: ['high'] };
    policy.digest = null;
    const w = await world({ start: '2026-11-01T04:00:00Z', tz: 'America/Chicago', policy });
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-11-01T04:01:00Z');
    await w.tickAt('2026-11-01T04:30:00Z');
    assert.strictEqual(w.entry(q).nextAt, '2026-11-01T06:30:00.000Z', 'the first 01:30');
    // Down until 01:10 CST (07:10Z), which is inside the window again.
    await w.tickAt('2026-11-01T07:10:00Z');
    assert.strictEqual(w.adapters.get('telegram').sent.length, 1);
  });

  it('high urgency breaks through quiet hours', async () => {
    const policy = quietPolicy();
    policy.quietHours = { start: '00:00', end: '23:59', breakthrough: ['high'] };
    const w = await world({ policy });
    w.ask({ text: 'Accept the offer by noon?', urgency: 'high' });
    await w.tickAt('2026-09-25T09:01:00Z');
    await w.tickAt('2026-09-25T09:15:00Z');
    assert.strictEqual(w.adapters.get('sms').sent.length, 1);
  });
});

describe('LadderEngine digest', () => {
  it('sends digest-step entries and exhausted ones once a day at digest.at, late if the process was down', async () => {
    const w = await world({ start: '2026-09-25T06:00:00Z', policy: defaultPolicy() });
    const low = w.ask({ text: 'Any preference on the realtor?', urgency: 'low' });
    await w.tickAt('2026-09-25T06:01:00Z');
    await w.tickAt('2026-09-25T06:01:30Z');
    await w.tickAt('2026-09-25T06:02:00Z');
    assert.strictEqual(w.entry(low).steps[w.entry(low).step].digest, true);
    assert.strictEqual(w.adapters.get('email').sent.length, 0, 'waits for the digest');
    // Down at 08:00; the first tick after sends it.
    await w.tickAt('2026-09-25T10:45:00Z');
    assert.strictEqual(w.adapters.get('email').sent.length, 1);
    assert.match(w.adapters.get('email').last().message.text, /Any preference on the realtor\?/);
    assert.strictEqual(w.state.ladder().digest.lastSentDay, '2026-09-25');
    await w.tickAt('2026-09-25T11:00:00Z');
    assert.strictEqual(w.adapters.get('email').sent.length, 1, 'once a day');
    await w.tickAt('2026-09-26T08:00:00Z');
    assert.strictEqual(w.adapters.get('email').sent.length, 2, 'the next day again, while it stays open');
  });

  it('skips an empty digest', async () => {
    const w = await world({ policy: defaultPolicy() });
    await w.tickAt('2026-09-25T09:00:00Z');
    assert.strictEqual(w.state.ladder().digest.lastSentDay, '2026-09-25');
    assert.strictEqual(w.adapters.get('email').sent.length, 0);
  });
});

describe('LadderEngine mirror and restarts', () => {
  it('mirrors sent attempts into the record\'s deliveries', async () => {
    const w = await world();
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T09:01:00Z');
    await w.tickAt('2026-09-25T09:30:00Z');
    const rec = w.runtime.questions(w.lot.id).get(q.id);
    assert.deepStrictEqual(rec.deliveries.map((d) => d.channel), ['telegram']);
    assert.strictEqual(rec.deliveries[0].deliveryId, w.entry(q).attempts[1].deliveryId);
    assert.strictEqual(w.entry(q).attempts[1].mirrored, true);
  });

  it('restart: an inFlight relay attempt is re-sent with the same key; others become unknown', async () => {
    const w = await world();
    const q1 = w.ask({ text: 'Accept the offer by noon?', urgency: 'high' });
    const q2 = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T09:01:00Z');
    const e1 = w.entry(q1);
    const e2 = w.entry(q2);
    e1.step = 1;
    e1.attempts.push({ step: 1, channel: 'sms', at: '2026-09-25T09:15:00Z', outcome: 'inFlight', deliveryId: 'd-SMS1', batchToken: 'ABCDEF', idempotencyKey: 'd-SMS1', mirrored: false });
    e2.step = 1;
    e2.attempts.push({ step: 1, channel: 'telegram', at: '2026-09-25T09:30:00Z', outcome: 'inFlight', deliveryId: 'd-TG1', batchToken: 'GHJKMN', idempotencyKey: 'd-TG1', mirrored: false });
    w.state.saveLadder();

    const fresh = new LadderEngine({ state: new ContactState({ dir: w.state.dir, clock: w.now }), casesRoot: w.root, runtime: w.runtime, router: new ContactRouter({ state: w.state, runtime: w.runtime, adapters: w.adapters, presence: w.presence, clock: w.now }), presence: w.presence, getPolicy: () => w.policy, clock: w.now, dataDir: w.data });
    await fresh.tick(w.at('2026-09-25T09:31:00Z'));
    const sms = w.adapters.get('sms').sent;
    assert.strictEqual(sms.length, 1);
    assert.strictEqual(sms[0].meta.deliveryId, 'd-SMS1', 'same Idempotency-Key');
    assert.strictEqual(sms[0].meta.batchToken, 'ABCDEF');
    const after2 = fresh.state.ladder().entries[`${w.lot.id}/${q2.id}`];
    assert.strictEqual(after2.attempts[after2.attempts.length - 2].outcome, 'unknown');
  });
});

describe('LadderEngine lease', () => {
  it('a second process stays passive and serves the holder\'s state; a stale lease is taken over', async () => {
    const w = await world();
    w.ask({ text: 'Seller financing?' });
    assert.strictEqual(w.ladder.tryAcquire(), true);
    await w.tickAt('2026-09-25T09:01:00Z');

    const otherData = tmp('kl-ladder-other-');
    const other = new LadderEngine({
      state: new ContactState({ dir: path.join(otherData, 'contact'), clock: w.now }), casesRoot: w.root, runtime: w.runtime,
      router: w.router, presence: w.presence, getPolicy: () => w.policy, clock: w.now, tickMs: 30000, dataDir: otherData, hostName: 'web-01'
    });
    assert.strictEqual(other.tryAcquire(), false);
    assert.deepStrictEqual(other.status(), { runsHere: false, holder: JSON.parse(fs.readFileSync(path.join(w.root, '.contact.lock'), 'utf8')) });
    assert.deepStrictEqual(Object.keys(other.list()), Object.keys(w.ladder.list()), 'read-only view of the holder\'s ladder');

    w.advance(91 * 1000);
    assert.strictEqual(other.tryAcquire(), true, 'older than 3 × tickMs');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(w.root, '.contact.lock'), 'utf8')).host, 'web-01');
    await other.stop();
    assert.strictEqual(fs.existsSync(path.join(w.root, '.contact.lock')), false);
  });

  it('list() reports the ladder state per question', async () => {
    const w = await world();
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T09:01:00Z');
    const s = w.ladder.list()[`${w.lot.id}/${q.id}`];
    assert.deepStrictEqual({ ...s, attempts: s.attempts.map((a) => [a.channel, a.outcome]) }, {
      step: 1, nextAt: '2026-09-25T09:30:00.000Z', nextChannel: 'telegram', expired: false, exhausted: false, attempts: [['present', 'absent']]
    });
  });
});

// Carries from Tasks 2–5 (progress.md): app-only notices, router errors,
// quiet-hours journal, and the timer and lease lifecycle.
describe('LadderEngine carries', () => {
  it('an app-only question goes to Telegram as an "Answer this in the app" notice and to the phone with its options', async () => {
    const policy = quietPolicy();
    policy.ladders.normal = [{ channel: 'telegram' }, { channel: 'mobile', afterMin: 5 }];
    const w = await world({ policy, channels: ['telegram', 'mobile'] });
    const q = w.ask({ text: 'Raise the usd limit for Lakeside lot?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], payload: { type: 'budget-grant', budget: 'usd', mcpAnswerable: false } });
    await w.tickAt('2026-09-25T09:01:00Z');
    const tg = w.adapters.get('telegram').last();
    assert.strictEqual(tg.message.text, 'King Louie: 1 question\n\n1. Answer this in the app: Raise the usd limit for Lakeside lot? (Lakeside lot)');
    assert.deepStrictEqual(tg.message.items.map((i) => [i.answerable, i.options.length]), [[false, 0]]);
    assert.deepStrictEqual(tg.meta.options, []);
    assert.strictEqual(tg.meta.expectsReply, false, 'a notice invites no reply');
    await w.tickAt('2026-09-25T09:05:00Z');
    const phone = w.adapters.get('mobile').last();
    assert.deepStrictEqual(phone.message.items.map((i) => [i.answerable, i.options.map((o) => o.id)]), [[true, ['yes', 'no']]]);
    assert.match(phone.message.text, /Reply "#[0-9A-Z]{6} yes"/);
    assert.deepStrictEqual(outcomes(w.entry(q)), ['telegram:sent', 'mobile:sent']);
  });

  it('an approval goes to email as a notice without options or a reply code', async () => {
    const policy = quietPolicy();
    policy.ladders.normal = [{ channel: 'email' }];
    const w = await world({ policy });
    w.runtime.questions(w.lot.id).create({ kind: 'approval', urgency: 'normal', text: 'Send the offer letter?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] });
    await w.tickAt('2026-09-25T09:01:00Z');
    const m = w.adapters.get('email').last().message;
    assert.match(m.text, /1\. Answer this in the app: Send the offer letter\? \(Lakeside lot\)/);
    assert.doesNotMatch(m.text, /Reply|#[0-9A-Z]{6}|approve\)/);
  });

  it('a delivery that throws something other than ContactDeliveryError is a failed step, not a crashed tick', async () => {
    const w = await world();
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-09-25T09:01:00Z');
    w.adapters.get('telegram').sendContact = async () => { throw new Error('socket hang up'); };
    const r = await w.tickAt('2026-09-25T09:30:00Z');
    assert.deepStrictEqual(r, { delivered: 0, failed: 1, exhausted: 0 });
    assert.deepStrictEqual(w.entry(q).attempts[1].error, { code: 'unreachable', message: 'socket hang up' });
    await w.tickAt('2026-09-25T09:30:30Z');
    assert.deepStrictEqual(outcomes(w.entry(q)), ['present:absent', 'telegram:failed', 'email:sent'], 'escalates to the next step');
  });

  it('quiet hours journal one "held until" line per deferred step', async () => {
    const policy = quietPolicy();
    policy.quietHours = { start: '22:00', end: '07:00', breakthrough: ['high'] };
    const w = await world({ start: '2026-11-01T04:00:00Z', tz: 'America/Chicago', policy });
    const q = w.ask({ text: 'Seller financing?' });
    await w.tickAt('2026-11-01T04:01:00Z');
    await w.tickAt('2026-11-01T04:30:00Z');
    await w.tickAt('2026-11-01T05:00:00Z');
    const held = journals(w).split('\n').filter((l) => l.includes('held until'));
    assert.deepStrictEqual(held, [`${q.id} held until Nov 1 07:00 (quiet hours): Seller financing?`]);
    assert.strictEqual(w.entry(q).heldJournaled, true);
  });

  it('start() takes the lease with an unref\'d timer, ticks on it, and stop() clears the timer and releases the lease', async () => {
    const { holdEventLoop } = require('./helpers/hold-event-loop');
    const release = holdEventLoop();
    try {
      const w = await world();
      w.ask({ text: 'Seller financing?' });
      w.at('2026-09-25T09:30:00Z');
      const ladder = new LadderEngine({ state: w.state, casesRoot: w.root, runtime: w.runtime, router: w.router, presence: w.presence, getPolicy: () => w.policy, clock: w.now, tickMs: 20, dataDir: w.data });
      ladder.start();
      assert.deepStrictEqual(ladder.status(), { runsHere: true });
      assert.strictEqual(ladder.timer.hasRef(), false, 'the tick timer never keeps the process alive');
      const lock = path.join(w.root, '.contact.lock');
      assert.strictEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
      for (let i = 0; i < 500 && !w.adapters.get('telegram').sent.length; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(w.adapters.get('telegram').sent.length, 1, 'the timer ran the tick');
      await ladder.stop();
      assert.strictEqual(ladder.timer, null);
      assert.strictEqual(fs.existsSync(lock), false);
      assert.deepStrictEqual(ladder.status(), { runsHere: false, holder: null });
    } finally {
      release();
    }
  });

  it('stop() on a passive process leaves the holder\'s lease alone', async () => {
    const w = await world();
    assert.strictEqual(w.ladder.tryAcquire(), true);
    const otherData = tmp('kl-ladder-other-');
    const other = new LadderEngine({ state: new ContactState({ dir: path.join(otherData, 'contact'), clock: w.now }), casesRoot: w.root, runtime: w.runtime, router: w.router, presence: w.presence, getPolicy: () => w.policy, clock: w.now, dataDir: otherData, hostName: 'web-01' });
    other.start();
    assert.strictEqual(other.status().runsHere, false);
    await other.stop();
    assert.strictEqual(fs.existsSync(path.join(w.root, '.contact.lock')), true);
    await w.ladder.stop();
    assert.strictEqual(fs.existsSync(path.join(w.root, '.contact.lock')), false);
  });
});
