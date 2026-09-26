// tests/frontdoor-alerts.test.js — fleet stage 4 §3.12–3.13.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AlertCenter, ALERT_KINDS } = require('../src/frontdoor/alerts');
const { recordFrontDoorEvent, FRONT_DOOR_AUDIT_KINDS } = require('../src/frontdoor/audit/own-ledger');

const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const file = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-alerts-')); temps.push(d); return path.join(d, 'alerts.json'); };

describe('AlertCenter', () => {
  it('raises, lists since an id, acks, and persists', async () => {
    let now = Date.parse('2026-09-23T10:00:00.000Z');
    const pushed = [];
    const f = file();
    const a = new AlertCenter({ file: f, now: () => now, push: (alert) => pushed.push(alert.id) });
    const first = a.raise('audit_chain_break', { subject: 'node:kl-hnef32472qzibi5r', detail: { seq: 4 } });
    const second = a.raise('dns_probe_failed', { subject: 'mesh.kl.example.com' });
    assert.deepEqual(a.list().map((x) => x.kind), ['audit_chain_break', 'dns_probe_failed']);
    assert.deepEqual(a.list({ since: first.id }).map((x) => x.id), [second.id]);
    assert.equal(a.ack(first.id), true);
    assert.equal(a.list()[0].acked, true);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(pushed, [first.id, second.id]);
    const reloaded = new AlertCenter({ file: f, now: () => now });
    assert.equal(reloaded.list().length, 2);
    assert.equal(reloaded.raise('tls_key_changed', { subject: 'x' }).id, String(Number(second.id) + 1));
  });

  it('deduplicates kind + subject within 24 h', () => {
    let now = 0;
    const a = new AlertCenter({ file: file(), now: () => now });
    assert.ok(a.raise('acme_renewal_failing', { subject: 'mcp.kl.example.com' }));
    now += 23 * 3600000;
    assert.equal(a.raise('acme_renewal_failing', { subject: 'mcp.kl.example.com' }), null);
    assert.ok(a.raise('acme_renewal_failing', { subject: 'other' }));
    now += 2 * 3600000;
    assert.ok(a.raise('acme_renewal_failing', { subject: 'mcp.kl.example.com' }));
  });

  it('keeps at most 500 alerts, dropping the oldest', () => {
    const a = new AlertCenter({ file: file(), now: () => 0 });
    for (let i = 0; i < 510; i += 1) a.raise('node_record_invalid', { subject: `node:${i}` });
    const all = a.list();
    assert.equal(all.length, 500);
    assert.equal(all[0].subject, 'node:10');
  });

  it('unknown_node_key: one alert a day, a running summary, one push', async () => {
    let now = Date.parse('2026-09-23T01:00:00.000Z');
    const pushed = [];
    const a = new AlertCenter({ file: file(), now: () => now, push: (x) => pushed.push(x.kind) });
    for (let i = 0; i < 12; i += 1) a.unknownNodeKey({ fingerprint: `${'a'.repeat(63)}${i % 7}`, ip: `203.0.113.${i}` });
    const day = a.list().filter((x) => x.kind === 'unknown_node_key');
    assert.equal(day.length, 1);
    assert.equal(day[0].subject, '2026-09-23');
    assert.equal(day[0].detail.count, 12);
    assert.equal(day[0].detail.top.length, 5);
    assert.equal(day[0].detail.top[0].count, 2);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(pushed, ['unknown_node_key']);
    now += 24 * 3600000;
    a.unknownNodeKey({ fingerprint: null, ip: '198.51.100.7' });
    assert.equal(a.list().filter((x) => x.kind === 'unknown_node_key').length, 2);
  });

  it('refuses an unknown kind', () => {
    assert.throws(() => new AlertCenter({ file: file() }).raise('made_up'), /unknown alert kind/);
    assert.ok(ALERT_KINDS.includes('node_replaced'));
  });

  // Carry from Task 19: the registry raises node_link_flapping when one
  // node's link is taken over repeatedly (3 in 10 minutes); it must be
  // accepted and deduplicated like every other kind.
  it('accepts and deduplicates node_link_flapping like the other kinds', () => {
    assert.ok(ALERT_KINDS.includes('node_link_flapping'));
    let now = 0;
    const a = new AlertCenter({ file: file(), now: () => now });
    const first = a.raise('node_link_flapping', { subject: 'node:kl-gpu-box', detail: { takeovers: 3, window_s: 600 } });
    assert.ok(first);
    assert.equal(a.raise('node_link_flapping', { subject: 'node:kl-gpu-box' }), null);
    now += 25 * 3600000;
    assert.ok(a.raise('node_link_flapping', { subject: 'node:kl-gpu-box' }));
  });

  // Carry: raise() must never throw into its caller — a push that throws is
  // logged and swallowed.
  it('swallows a throwing push instead of propagating it', async () => {
    const a = new AlertCenter({ file: file(), now: () => 0, push: () => { throw new Error('push exploded'); } });
    assert.doesNotThrow(() => a.raise('dns_probe_failed', { subject: 'x' }));
    await new Promise((r) => setImmediate(r));
  });

  // Carry: a failed persist is logged and does not lose the in-memory alert.
  it('keeps the in-memory alert when persisting fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-alerts-'));
    temps.push(dir);
    // A directory in place of the file makes every write fail.
    const badFile = path.join(dir, 'alerts.json');
    fs.mkdirSync(badFile);
    const a = new AlertCenter({ file: badFile, now: () => 0 });
    let alert;
    assert.doesNotThrow(() => { alert = a.raise('dns_probe_failed', { subject: 'x' }); });
    assert.ok(alert);
    assert.equal(a.list().length, 1);
    assert.doesNotThrow(() => a.ack(alert.id));
    assert.equal(a.list()[0].acked, true);
  });

  // Carry: cap detail's serialized size and cut anything longer.
  it('caps an oversized detail instead of storing it whole', () => {
    const a = new AlertCenter({ file: file(), now: () => 0 });
    const huge = 'x'.repeat(20000);
    const alert = a.raise('dns_probe_failed', { subject: 'y', detail: { error: huge } });
    const bytes = Buffer.byteLength(JSON.stringify(alert.detail), 'utf8');
    assert.ok(bytes <= 4096, `detail serialized to ${bytes} bytes`);
  });

  // Carry: strip [\p{Cc}\p{Cf}] from detail strings (network-sourced text).
  it('strips control and format characters from detail strings', () => {
    const a = new AlertCenter({ file: file(), now: () => 0 });
    const hostile = 'CN=evil\u0000​example.com';
    const alert = a.raise('dns_probe_failed', { subject: 'z', detail: { error: hostile } });
    assert.equal(alert.detail.error, 'CN=evilexample.com');
  });

  // Carry: detail must never override id, kind, at or acked on the alert.
  it('never lets detail override id, kind, at or acked', () => {
    const a = new AlertCenter({ file: file(), now: () => 0 });
    const alert = a.raise('dns_probe_failed', {
      subject: 'w',
      detail: { id: 'evil', kind: 'evil_kind', at: 'evil_at', acked: true }
    });
    assert.equal(alert.kind, 'dns_probe_failed');
    assert.equal(alert.acked, false);
    assert.equal(typeof alert.at, 'string');
    assert.notEqual(alert.at, 'evil_at');
    assert.ok(/^\d+$/.test(alert.id));
  });

  // Carry: a corrupt alerts.json logs a warning, starts empty and keeps a
  // .corrupt copy; max is enforced on load too.
  it('tolerates a corrupt alerts.json: starts empty and keeps a .corrupt copy', () => {
    const f = file();
    fs.writeFileSync(f, 'not json{{{');
    const a = new AlertCenter({ file: f, now: () => 0 });
    assert.equal(a.list().length, 0);
    assert.ok(fs.existsSync(`${f}.corrupt`));
    assert.equal(fs.readFileSync(`${f}.corrupt`, 'utf8'), 'not json{{{');
    // still usable afterwards
    assert.ok(a.raise('dns_probe_failed', { subject: 'ok' }));
  });

  it('enforces max on load, keeping only the newest', () => {
    const f = file();
    const alerts = [];
    for (let i = 0; i < 510; i += 1) alerts.push({ id: String(i + 1), kind: 'node_record_invalid', subject: `node:${i}`, detail: {}, at: new Date(0).toISOString(), acked: false });
    fs.writeFileSync(f, JSON.stringify({ v: 1, seq: 510, alerts }));
    const a = new AlertCenter({ file: f, now: () => 0 });
    const all = a.list();
    assert.equal(all.length, 500);
    assert.equal(all[0].subject, 'node:10');
  });

  it('does not treat a missing file as corrupt', () => {
    const f = file();
    const a = new AlertCenter({ file: f, now: () => 0 });
    assert.equal(a.list().length, 0);
    assert.equal(fs.existsSync(`${f}.corrupt`), false);
  });
});

describe('the front door\'s own ledger', () => {
  it('appends only the §3.12 kinds, and never throws on an audit failure', async () => {
    const entries = [];
    const ledger = { append: async (e) => { entries.push(e); return e; } };
    await recordFrontDoorEvent(ledger, 'frontdoor.token.issued', { grant_id: 'gr_x', kind: 'access' });
    assert.deepEqual(entries, [{ kind: 'frontdoor.token.issued', data: { grant_id: 'gr_x', kind: 'access' } }]);
    await assert.rejects(recordFrontDoorEvent(ledger, 'frontdoor.made_up', {}), /unknown front-door audit kind/);
    await recordFrontDoorEvent({ append: async () => { throw new Error('disk full'); } }, 'frontdoor.alert.ack', { id: '1' });
    assert.equal(FRONT_DOOR_AUDIT_KINDS.length, 11);
  });
});
