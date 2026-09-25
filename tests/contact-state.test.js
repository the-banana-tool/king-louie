// tests/contact-state.test.js — cases stage 4 §4.2, §4.3 (files under <dataDir>/contact/).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ContactState } = require('../src/cases/contact-state');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-contact-state-')); dirs.push(d); return path.join(d, 'contact'); };
const NOW = new Date('2026-09-25T14:00:00Z');

function delivery(overrides = {}) {
  return {
    channel: 'telegram', at: NOW.toISOString(), externalRef: '4812', batchToken: 'K7QD4M', idempotencyKey: 'd-1', status: 'sent',
    items: [{ n: 1, caseId: 'c-1', questionId: 'q-0012', token: '7QD4KM', kind: 'question' }],
    ...overrides
  };
}

describe('ContactState', () => {
  it('starts empty and writes ladder.json atomically', () => {
    const dir = tmp();
    const s = new ContactState({ dir, clock: () => NOW });
    assert.deepStrictEqual(s.ladder(), { version: 1, entries: {}, digest: { lastSentDay: null }, pins: {} });
    s.ladder().entries['c-1/q-0001'] = { token: 'AAAAAA' };
    s.saveLadder();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'ladder.json'), 'utf8')).entries, { 'c-1/q-0001': { token: 'AAAAAA' } });
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
  });

  it('renames an unreadable ladder.json and rebuilds', () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ladder.json'), '{ not json');
    const s = new ContactState({ dir, clock: () => NOW });
    assert.deepStrictEqual(s.ladder().entries, {});
    assert.ok(fs.existsSync(path.join(dir, `ladder.json.corrupt-${NOW.getTime()}`)));
  });

  it('a read-only view never renames or writes', () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ladder.json'), '{ not json');
    const s = new ContactState({ dir, clock: () => NOW, readOnly: true });
    assert.deepStrictEqual(s.ladder().entries, {});
    s.saveLadder();
    assert.strictEqual(fs.readFileSync(path.join(dir, 'ladder.json'), 'utf8'), '{ not json');
    const before = fs.readdirSync(dir).sort();
    s.writeInbox([{ caseId: 'c-1', questionId: 'q-0001', text: 'yes' }]);
    s.writeCursor('main', 'c-42');
    assert.strictEqual(s.markEventSeen('ev-1'), true);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, 'writeInbox, writeCursor and markEventSeen wrote nothing');
    assert.strictEqual(fs.existsSync(path.join(dir, 'inbox.jsonl')), false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'relay-main.cursor')), false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'relay-events.json')), false);
  });

  it('never hands out a token still in use by a ladder entry or a delivery', () => {
    const s = new ContactState({ dir: tmp(), clock: () => NOW });
    s.ladder().entries.x = { token: '000000' };
    s.recordDelivery('d-1', delivery({ batchToken: '000001', items: [{ n: 1, caseId: 'c', questionId: 'q-0001', token: '000002' }] }));
    const seq = [0, 1, 2, 3].map((n) => Buffer.from([0, 0, 0, n << 2]));
    let i = 0;
    assert.strictEqual(s.newToken(() => seq[i++]), '000003');
  });

  it('resolves a question token, a batch token, a delivery id and a channel message reference', () => {
    const s = new ContactState({ dir: tmp(), clock: () => NOW });
    s.recordDelivery('d-1', delivery());
    assert.strictEqual(s.resolve('7qd4km').item.questionId, 'q-0012');
    assert.strictEqual(s.resolve('K7QD4M').deliveryId, 'd-1');
    assert.strictEqual(s.resolve('d-1').item, null);
    assert.strictEqual(s.resolve('4812', { channel: 'telegram' }).deliveryId, 'd-1');
    assert.strictEqual(s.resolve('4812', { channel: 'discord' }), null);
    assert.strictEqual(s.resolve('ZZZZZZ'), null);
    assert.strictEqual(new ContactState({ dir: s.dir }).resolve('K7QD4M').deliveryId, 'd-1', 'read back from deliveries.json');
  });

  it('sets a delivery status by relay id or external reference', () => {
    const s = new ContactState({ dir: tmp(), clock: () => NOW });
    s.recordDelivery('d-1', delivery({ relayId: 'msg-9' }));
    assert.strictEqual(s.setDeliveryStatus('msg-9', 'bounced', '550 no such user'), 'd-1');
    assert.strictEqual(s.deliveries()['d-1'].status, 'bounced');
    assert.strictEqual(s.setDeliveryStatus('msg-unknown', 'failed'), null);
  });

  it('prunes deliveries 30 days old whose items are all closed', () => {
    const s = new ContactState({ dir: tmp(), clock: () => NOW });
    s.recordDelivery('d-old', delivery({ at: '2026-08-01T00:00:00Z' }));
    s.recordDelivery('d-open', delivery({ at: '2026-08-01T00:00:00Z', items: [{ n: 1, caseId: 'c-2', questionId: 'q-0001', token: 'AAAAAB' }] }));
    s.recordDelivery('d-new', delivery());
    assert.strictEqual(s.pruneDeliveries((caseId) => caseId === 'c-2'), 1);
    assert.deepStrictEqual(Object.keys(s.deliveries()).sort(), ['d-new', 'd-open']);
  });

  it('keeps pins until taken, the inbox as lines, relay cursors and seen event ids', () => {
    const s = new ContactState({ dir: tmp(), clock: () => NOW });
    s.pin('c-1/q-0002', 'telegram');
    assert.strictEqual(s.takePin('c-1/q-0002'), 'telegram');
    assert.strictEqual(new ContactState({ dir: s.dir, clock: () => NOW }).takePin('c-1/q-0002'), null, 'takePin persists the removal to ladder.json');
    assert.strictEqual(s.takePin('c-1/q-0002'), null);
    s.appendInbox({ caseId: 'c-1', questionId: 'q-0001', text: 'yes' });
    s.appendInbox({ caseId: 'c-1', questionId: 'q-0002', optionId: 'a' });
    assert.strictEqual(s.readInbox().length, 2);
    s.writeInbox(s.readInbox().slice(1));
    assert.deepStrictEqual(s.readInbox().map((l) => l.questionId), ['q-0002']);
    s.writeInbox([]);
    assert.deepStrictEqual(s.readInbox(), []);
    assert.strictEqual(s.readCursor('main'), null);
    s.writeCursor('main', 'c-42');
    assert.strictEqual(new ContactState({ dir: s.dir }).readCursor('main'), 'c-42');
    assert.strictEqual(s.markEventSeen('ev-1'), true);
    assert.strictEqual(new ContactState({ dir: s.dir }).markEventSeen('ev-1'), false);
    assert.match(s.newDeliveryId(), /^d-[0-9A-Z]+$/);
  });
});

describe('ContactState.resolve channel isolation', () => {
  it('a channel message reference sent by SMS cannot be resolved from an email reply', () => {
    const s = new ContactState({ dir: tmp(), clock: () => NOW });
    s.recordDelivery('d-sms', delivery({ channel: 'sms', externalRef: '+15550100', batchToken: 'S1S1S1', items: [] }));
    assert.strictEqual(s.resolve('+15550100', { channel: 'sms' }).deliveryId, 'd-sms');
    assert.strictEqual(s.resolve('+15550100', { channel: 'email' }), null);
  });
});

describe('ContactState.resolve across channels', () => {
  it('a question token prefers the delivery on the asking channel', () => {
    const s = new ContactState({ dir: tmp(), clock: () => NOW });
    s.recordDelivery('d-mobile', delivery({ channel: 'mobile', at: '2026-09-25T13:00:00Z', externalRef: null }));
    s.recordDelivery('d-telegram', delivery({ channel: 'telegram', at: '2026-09-25T13:30:00Z', batchToken: 'B2B2B2' }));
    assert.strictEqual(s.resolve('7QD4KM', { channel: 'mobile' }).deliveryId, 'd-mobile');
    assert.strictEqual(s.resolve('7QD4KM', { channel: 'telegram' }).deliveryId, 'd-telegram');
    assert.strictEqual(s.resolve('7QD4KM', { channel: 'sms' }).deliveryId, 'd-telegram', 'else the newest');
  });
});
