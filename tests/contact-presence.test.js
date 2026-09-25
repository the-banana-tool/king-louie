// tests/contact-presence.test.js — cases stage 4 §3.4.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Presence } = require('../src/cases/presence');
const { defaultPolicy } = require('../src/cases/contact-format');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmpFile = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-presence-')); dirs.push(d); return path.join(d, 'contact', 'presence.json'); };

function make({ policy = defaultPolicy(), interactive = true, enabled = ['telegram', 'email', 'sms', 'mobile'], tz = 'UTC', start = '2026-09-25T14:00:00Z' } = {}) {
  let now = new Date(start);
  const presence = new Presence({
    file: tmpFile(),
    getPolicy: () => policy,
    clock: () => now,
    interactive: () => interactive,
    isEnabled: (c) => enabled.includes(c),
    getTimeZone: () => tz
  });
  return { presence, advance: (ms) => { now = new Date(now.getTime() + ms); return now; }, at: (iso) => { now = new Date(iso); return now; }, now: () => now };
}

describe('presentChannel (§3.4 table)', () => {
  it('no candidates → null', () => {
    const { presence } = make();
    assert.strictEqual(presence.presentChannel(), null);
  });

  it('desktop is present only while the heartbeat is fresh, focused and recently used', () => {
    const t = make();
    t.presence.heartbeat({ focused: true, lastInputAt: t.now().toISOString() });
    assert.strictEqual(t.presence.presentChannel(), 'in-app');
    t.advance(91 * 1000);
    assert.strictEqual(t.presence.presentChannel(), null, 'heartbeat older than 90 s');
    t.presence.heartbeat({ focused: false, lastInputAt: t.now().toISOString() });
    assert.strictEqual(t.presence.presentChannel(), null, 'unfocused');
    t.presence.heartbeat({ focused: true, lastInputAt: new Date(t.now().getTime() - 6 * 60000).toISOString() });
    assert.strictEqual(t.presence.presentChannel(), null, 'idle longer than desktopIdleMin');
  });

  it('clamps a lastInputAt in the future to now', () => {
    const t = make();
    t.presence.heartbeat({ focused: true, lastInputAt: '2027-01-01T00:00:00Z' });
    assert.strictEqual(t.presence.status().signals.desktop.lastInputAt, t.now().toISOString());
  });

  it('a channel counts when enabled and owner-proven inbound is recent', () => {
    const t = make();
    t.presence.noteInbound('telegram');
    assert.strictEqual(t.presence.presentChannel(), 'telegram');
    t.advance(11 * 60000);
    assert.strictEqual(t.presence.presentChannel(), null);
    t.presence.noteInbound('discord');
    assert.strictEqual(t.presence.presentChannel(), null, 'discord is not enabled');
  });

  it('persists only channel last-seen times', () => {
    const t = make();
    t.presence.noteInbound('telegram');
    t.presence.heartbeat({ focused: true });
    const again = new Presence({ file: t.presence.file, getPolicy: () => defaultPolicy(), clock: t.now, interactive: () => true, isEnabled: () => true });
    assert.deepStrictEqual(Object.keys(again.status().signals.channels), ['telegram']);
    assert.strictEqual(again.status().signals.desktop, null);
  });

  it('both present: the one touched last wins (desktop and phone app)', () => {
    const t = make();
    t.presence.heartbeat({ focused: true, lastInputAt: new Date(t.now().getTime() - 30000).toISOString() });
    t.presence.mobileForeground({ deviceId: 'd-aaaaaaaaaaaaaaaa', foreground: true });
    assert.strictEqual(t.presence.presentChannel(), 'mobile');
    t.advance(10000);
    t.presence.heartbeat({ focused: true, lastInputAt: t.now().toISOString() });
    assert.strictEqual(t.presence.presentChannel(), 'in-app');
    t.advance(121 * 1000);
    t.presence.heartbeat({ focused: true, lastInputAt: t.now().toISOString() });
    assert.strictEqual(t.presence.presentChannel(), 'in-app', 'the mobile ping is stale after 120 s');
  });

  it('ties go to the desktop, then mobile, then ladder order', () => {
    const t = make();
    const at = t.now().toISOString();
    t.presence.heartbeat({ focused: true, lastInputAt: at });
    t.presence.mobileForeground({ deviceId: 'd-aaaaaaaaaaaaaaaa' });
    t.presence.noteInbound('telegram', t.now());
    assert.strictEqual(t.presence.presentChannel(), 'in-app');
  });

  it('away overrides everything', () => {
    const policy = { ...defaultPolicy(), away: { mode: 'email-only', until: '2026-09-26T00:00:00Z' } };
    const t = make({ policy });
    t.presence.heartbeat({ focused: true });
    assert.strictEqual(t.presence.presentChannel(), 'email');
    assert.strictEqual(t.presence.status().away, true);
    const noEmail = make({ policy, enabled: [] });
    assert.strictEqual(noEmail.presence.presentChannel(), null);
    const inApp = make({ policy: { ...defaultPolicy(), away: { mode: 'in-app-only', until: '2026-09-26T00:00:00Z' } }, interactive: false });
    assert.strictEqual(inApp.presence.presentChannel(), null, 'in-app-only without an interactive host');
  });

  it('desktopPresentSince is the latest absent → present transition', () => {
    const t = make();
    assert.strictEqual(t.presence.desktopPresentSince(), null);
    t.presence.heartbeat({ focused: true });
    const first = t.now().toISOString();
    assert.strictEqual(t.presence.desktopPresentSince().toISOString(), first);
    t.advance(100 * 1000);
    assert.strictEqual(t.presence.presentChannel(), null);
    t.presence.heartbeat({ focused: true });
    assert.strictEqual(t.presence.desktopPresentSince().toISOString(), t.now().toISOString());
  });

  it('reports the time zone source', () => {
    assert.strictEqual(make({ tz: 'America/Chicago' }).presence.status().timeZoneSource, 'settings');
    assert.strictEqual(make({ tz: '' }).presence.status().timeZoneSource, 'host');
  });
});

describe('quiet hours', () => {
  const quiet = (start, end) => ({ ...defaultPolicy(), quietHours: { start, end, breakthrough: ['high'] } });

  it('a window across midnight', () => {
    const t = make({ policy: quiet('22:00', '07:00') });
    assert.strictEqual(t.presence.inQuietHours(t.at('2026-09-25T23:10:00Z')), true);
    assert.strictEqual(t.presence.inQuietHours(t.at('2026-09-25T06:59:00Z')), true);
    assert.strictEqual(t.presence.inQuietHours(t.at('2026-09-25T07:00:00Z')), false);
    assert.strictEqual(t.presence.nextQuietEnd(t.at('2026-09-25T23:10:30Z')).toISOString(), '2026-09-26T07:00:00.000Z');
  });

  it('DST quiet hours: fall-back (America/Chicago, 2026-11-01) ends at 07:00 CST', () => {
    const t = make({ policy: quiet('22:00', '07:00'), tz: 'America/Chicago' });
    // 23:30 CDT on Oct 31 is 04:30Z; 07:00 CST on Nov 1 is 13:00Z.
    assert.strictEqual(t.presence.inQuietHours(t.at('2026-11-01T04:30:00Z')), true);
    assert.strictEqual(t.presence.nextQuietEnd(t.now()).toISOString(), '2026-11-01T13:00:00.000Z');
  });

  it('DST quiet hours: an end in the repeated hour resolves to its first occurrence', () => {
    const t = make({ policy: quiet('22:00', '01:30'), tz: 'America/Chicago' });
    // 01:30 CDT (first occurrence) is 06:30Z; 01:30 CST would be 07:30Z.
    assert.strictEqual(t.presence.nextQuietEnd(t.at('2026-11-01T04:30:00Z')).toISOString(), '2026-11-01T06:30:00.000Z');
    assert.strictEqual(t.presence.inQuietHours(t.at('2026-11-01T07:10:00Z')), true, 'the repeated 01:10 is inside the window again');
  });

  it('DST quiet hours: an end in the spring-forward gap resolves to 03:00 (America/Chicago, 2027-03-14)', () => {
    const t = make({ policy: quiet('22:00', '02:30'), tz: 'America/Chicago' });
    // 23:00 CST on Mar 13 is 05:00Z; 02:30 does not exist; 03:00 CDT is 08:00Z.
    assert.strictEqual(t.presence.nextQuietEnd(t.at('2027-03-14T05:00:00Z')).toISOString(), '2027-03-14T08:00:00.000Z');
  });

  it('no quiet hours: never quiet', () => {
    const t = make();
    assert.strictEqual(t.presence.inQuietHours(), false);
  });
});
