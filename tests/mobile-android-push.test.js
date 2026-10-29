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
    // A coalesced push (c above 1) of any kind joins the Approvals
    // notification and its running count, so tag, channel and count take the
    // items; c absent or 1 leaves the session kinds their own notifications.
    assert.match(body, /val items = PushText\.itemsIn\(message\.data\["c"\]\)/);
    assert.match(body, /PushText\.tag\(kind, rid, items\)/);
    assert.match(body, /val approvals = PushText\.joinsApprovals\(kind, items\)/);
    assert.match(body, /Push\.addToCount\(this, items\)/);
    assert.match(body, /Notification\.Builder\(this, PushText\.channel\(kind, items\)\)/);
    assert.match(body, /PushText\.nodeName\(message\.data\["n"\]\)/);
    // The running count: c added when present, kept across process death, shown above 1.
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

describe('Android push token (spec 3 §7.3, C-10, R-PU-5)', () => {
  const api = () => main('RelayApi.kt');
  const model = () => main('AppModel.kt');

  it('RelayApi deletes and reads the token on the read key', () => {
    assert.match(api(), /suspend fun deletePushToken\(\) \{\n\s+request\("DELETE", "\/v1\/push-token", READ\)/);
    const state = section(api(), 'suspend fun pushTokenState(): PushTokenState {', '\n    }\n');
    assert.match(state, /request\("GET", "\/v1\/push-token", READ\)/);
    assert.match(state, /\["registered"\]\.bool\(\) == true/);
    assert.match(state, /\["sender"\]\.bool\(\) == true/);
  });

  it('the token goes again at every cold start, changed or not, and right after an enrollment', () => {
    const m = model();
    // Once per process (in memory), never "once per token value" from storage.
    assert.match(m, /private var pushTokenSentHere: String\? = null/);
    const send = section(m, 'private suspend fun sendPushToken(again: Boolean = false) {', '\n    }\n');
    assert.ok(!send.includes('storage.pushTokenSent ||') && !/token == storage\.pushTokenSent/.test(send), 'storage does not decide');
    assert.match(send, /if \(!again && token == pushTokenSentHere\) return/);
    assert.match(send, /pushTokenSentHere = token/);
    // The loop sends at its start and after each poll that got through (a no-op once sent in this process).
    const loop = section(m, 'private suspend fun run() = coroutineScope {', '\n        }\n    }\n');
    assert.ok((loop.match(/sendPushToken\(\)/g) || []).length >= 2, 'the loop sends at its start and after a poll that got through');
    // A finished console enrollment sends at once.
    const done = section(m, '"done" -> {', '\n                }\n');
    assert.match(done, /sendPushToken\(again = true\)/);
  });

  it('onNewToken sends at once when enrolled; not enrolled, it only stores', () => {
    assert.match(code(fcm()), /override fun onNewToken\(token: String\) \{\n\s+\(application as KingLouieApplication\)\.model\.registerPushToken\(token\)/);
    const reg = section(model(), 'fun registerPushToken(token: String) {', '\n    }\n');
    assert.match(reg, /storage\.pushToken = token/);
    assert.match(reg, /if \(readyToRead\(\)\) scope\.launch \{ sendPushToken\(\) \}/);
  });

  it('Reset this phone: DELETE first (best effort), then the keys, then the stored token', () => {
    const m = model();
    const reset = section(m, 'fun reset() {', '\n    }\n');
    assert.match(reset, /resetJob = scope\.launch/);
    const finish = section(m, 'private suspend fun finishReset(api: RelayApi?) {', '\n    }\n');
    const del = finish.indexOf('api.deletePushToken()');
    const keys = finish.indexOf('DeviceKey.delete()');
    const cleared = finish.indexOf('storage.clear()');
    assert.ok(del >= 0 && keys > del && cleared > keys, 'DELETE, then the keys, then storage (which holds the token)');
    assert.match(finish, /withTimeout\(RESET_DELETE_MS\)/);
    // A new pairing waits for the reset, so the old key's deletion cannot take the new key.
    assert.match(section(m, 'fun scanned(text: String) = scope.launch {', '\n    }\n'), /resetJob\?\.join\(\)/);
  });

  it('the gear shows one Notifications row from GET /v1/push-token and the phone\'s state', () => {
    const settings = main('SettingsScreen.kt');
    for (const words of ['Notifications: on', 'Notifications: off in Android settings', 'Notifications: this build has no push',
      'Notifications: the relay has no push credential', 'Notifications: not registered yet']) {
      assert.ok(settings.includes(words) || model().includes(words), words);
    }
    assert.match(settings, /Settings\.ACTION_APP_NOTIFICATION_SETTINGS/);
    assert.match(settings, /Settings\.EXTRA_APP_PACKAGE/);
    assert.match(section(model(), 'fun refreshSettings() {', '\n    }\n'), /refreshNotifications\(api\)/);
    // Whether a Firebase app exists: fcm without a config reports no push; nopush never has one.
    assert.match(nopush(), /fun available\(context: Context\): Boolean = false/);
    assert.match(code(fcm()), /fun available\(context: Context\): Boolean = FirebaseApp\.getApps\(context\)\.isNotEmpty\(\)/);
  });
});
