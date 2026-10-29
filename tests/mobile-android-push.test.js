// tests/mobile-android-push.test.js
//
// Push spec §7.2 (R-PU-4, C-6, C-8): what the Android fcm flavor shows for a
// push and where a tap goes. The app module has no test target, so this reads
// the Kotlin sources, as tests/mobile-lease-apps.test.js does: it shows the
// rules are written into the code, not that the app behaves (the gradle build
// and protocol's PushTextTest, which runs the texts, tags and channels, do
// the rest).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'mobile', 'android', 'app', 'src');
const KT = ['kotlin', 'com', 'example', 'kinglouie'];
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const fcm = () => read(APP, 'fcm', ...KT, 'push', 'Push.kt');
const nopush = () => read(APP, 'nopush', ...KT, 'push', 'Push.kt');
const main = (name) => read(APP, 'main', ...KT, name);
const pushText = () => read(ROOT, 'mobile', 'android', 'protocol', 'src', 'main', ...KT, 'protocol', 'PushText.kt');

const EIGHT = ['approval', 'question', 'lease', 'pairing', 'alert', 'session_ended', 'session_paused', 'test'];

function section(text, start, end) {
  const a = text.indexOf(start);
  assert.ok(a >= 0, `"${start}" is there`);
  const b = text.indexOf(end, a + start.length);
  assert.ok(b > a, `"${end}" follows "${start}"`);
  return text.slice(a, b + end.length);
}

function appKinds() {
  const m = /val KINDS = setOf\(([^)]*)\)/.exec(pushText());
  assert.ok(m, 'PushText.KINDS is one setOf');
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

describe('Android push (spec 3 §7.2)', () => {
  it('the app accepts the relay\'s fcm kinds and ignores any other', () => {
    const kinds = appKinds();
    assert.deepEqual([...kinds].sort(), [...EIGHT].sort());
    // The relay's list (src/frontdoor/push/text.js) less grant, which goes to
    // APNs only. Until T01 lands the relay knows only the first five; then the
    // two lists must be equal.
    const relay = require('../src/frontdoor/push/text.js').KINDS.filter((k) => k !== 'grant');
    for (const k of relay) assert.ok(kinds.includes(k), `the app accepts the relay's ${k}`);
    if (relay.includes('session_ended')) assert.deepEqual([...kinds].sort(), [...relay].sort());
    const received = section(fcm(), 'override fun onMessageReceived(message: RemoteMessage) {', '\n    }\n');
    assert.match(received, /if \(kind !in PushText\.KINDS\) return/);
  });

  it('no action buttons on any notification (R-PU-4)', () => {
    const body = code(fcm());
    assert.ok(!body.includes('addAction'), 'Push.kt adds no action');
    assert.ok(!body.includes('Notification.Action'), 'Push.kt builds no action');
  });

  it('channels, tags, the monochrome banana and the replaced Approvals notification', () => {
    const body = code(fcm());
    assert.match(body, /NotificationChannel\(PushText\.APPROVALS_CHANNEL, "Approvals", NotificationManager\.IMPORTANCE_HIGH\)/);
    assert.match(body, /NotificationChannel\(PushText\.SESSIONS_CHANNEL, "Sessions", NotificationManager\.IMPORTANCE_DEFAULT\)/);
    assert.match(body, /\.setSmallIcon\(R\.drawable\.ic_launcher_monochrome\)/);
    assert.ok(!body.includes('ic_dialog_alert'), 'the stock alert icon is gone');
    assert.ok(fs.existsSync(path.join(APP, 'main', 'res', 'drawable', 'ic_launcher_monochrome.xml')));
    // One notification per tag, with one id: a new Approvals push replaces the last.
    assert.match(body, /manager\.notify\(tag, Push\.NOTIFICATION_ID, notification\)/);
    assert.match(body, /PushText\.tag\(kind, rid\)/);
    assert.match(body, /PushText\.nodeName\(message\.data\["n"\]\)/);
    // The running count: c added when present, kept across process death, shown above 1.
    assert.match(body, /PushText\.itemsIn\(message\.data\["c"\]\)/);
    assert.match(body, /PushText\.approvalText\(kind, node, count\)/);
    assert.match(body, /PushText\.otherText\(kind, node\)/);
  });

  it('the count resets when the app comes to the front; a paused notification goes on a status that is not suspended', () => {
    const model = main('AppModel.kt');
    const fore = section(model, 'fun onForeground() {', '\n    }\n');
    assert.match(fore, /Push\.appInFront\(appContext\)/);
    const f = code(fcm());
    assert.match(section(f, 'fun appInFront(context: Context) {', '\n    }\n'), /COUNT_KEY/);
    assert.match(section(f, 'fun leaseNotSuspended(context: Context, leaseId: String) {', '\n    }\n'), /cancel\(PushText\.tag\("session_paused", leaseId\), NOTIFICATION_ID\)/);
    // Every signed status this app applies passes through statusApplied.
    const hook = section(model, 'private fun statusApplied(status: LeaseStatus) {', '\n    }\n');
    assert.match(hook, /if \(status\.state != "suspended"\) Push\.leaseNotSuspended\(appContext, status\.leaseId\)/);
    const apply = section(model, 'private fun applyLease(', '\n    }\n');
    assert.match(apply, /statusApplied\(status\)/);
    const listed = section(model, 'private fun noteListedLease(', '\n    }\n');
    assert.match(listed, /statusApplied\(status\)/);
    // The nopush flavor has the same hooks, doing nothing.
    const n = nopush();
    assert.match(n, /const val EXTRA_COUNT = "kl\.c"/);
    assert.match(n, /fun appInFront\(context: Context\) = Unit/);
    assert.match(n, /fun leaseNotSuspended\(context: Context, leaseId: String\) = Unit/);
    assert.match(fcm(), /const val EXTRA_COUNT = "kl\.c"/);
  });

  it('a tap carries the count; a count above 1 or a test opens the list; openPushed names every kind', () => {
    const act = main('MainActivity.kt');
    assert.match(act, /model\.openPushed\(intent\.getStringExtra\(Push\.EXTRA_KIND\) \?: "approval", id, intent\.getIntExtra\(Push\.EXTRA_COUNT, 1\)\)/);
    assert.match(code(fcm()), /putExtra\(Push\.EXTRA_COUNT, count\)/);
    const pushed = section(main('AppModel.kt'), 'fun openPushed(kind: String, id: String, count: Int = 1)', '\n    }\n');
    assert.match(pushed, /if \(PushText\.opensList\(kind, count\)\) return/);
    for (const k of EIGHT) assert.ok(pushed.includes(`"${k}"`), `openPushed names ${k}`);
  });
});
