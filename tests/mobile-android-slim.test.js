// tests/mobile-android-slim.test.js
//
// android-slim §6, §7, §12.1: the Android app is four screens (Scanner,
// Approvals, Approval detail, Settings) and nothing else. The app module has
// no test target, so this reads the Kotlin sources, as
// tests/mobile-lease-apps.test.js does: it shows the rules are written into
// the code, not that the app builds or behaves (the gradle build does the
// first). The model's rules (the loops, the read-key watch, the decisions)
// are in tests/mobile-lease-apps.test.js; every call RelayApi makes is
// checked against the relay's table in tests/mobile-android-relay-keys.test.js.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_MAIN = path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main');
const KT_DIR = path.join(APP_MAIN, 'kotlin', 'com', 'example', 'kinglouie');
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const kt = (name) => read(path.join(KT_DIR, name));
const count = (text, needle) => text.split(needle).length - 1;
// Code only: line and block comments removed (KDoc too).
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function kotlinFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...kotlinFiles(p));
    else if (e.name.endsWith('.kt')) out.push(p);
  }
  return out;
}
// Every Kotlin file of the app, both flavors' push included.
const appFiles = () => kotlinFiles(path.join(ROOT, 'mobile', 'android', 'app', 'src'));

// §8.4's table, as the spec writes it, one route a row. `POST /v1/devices/read-key`
// is "device for the first send, read after" in the spec: the relay takes either
// key on it (`read`), and the app sends the first statement with the device key.
const SPEC_ROUTE_AUTH = [
  ['GET', '/v1/approvals', 'read'],
  ['GET', '/v1/approvals/{request_id}', 'read'],
  ['GET', '/v1/questions', 'read'],
  ['GET', '/v1/leases', 'read'],
  ['GET', '/v1/leases/{lease_id}/views', 'read'],
  ['POST', '/v1/leases/{lease_id}/watch', 'read'],
  ['POST', '/v1/presence', 'read'],
  ['GET', '/v1/nodes', 'read'],
  ['GET', '/v1/devices', 'read'],
  ['GET', '/v1/devices/invites/{id}', 'read'],
  ['GET', '/v1/pairings/pending', 'read'],
  ['GET', '/v1/alerts', 'read'],
  ['GET', '/v1/clients', 'read'],
  ['GET', '/v1/frontdoor', 'read'],
  ['GET', '/v1/nodes/{node_id}/audit-status', 'read'],
  ['GET', '/v1/nodes/{node_id}/history', 'read'],
  ['PUT', '/v1/push-token', 'read'],
  ['POST', '/v1/challenges', 'read'],
  ['POST', '/v1/approvals/{request_id}/response', 'read'],
  ['POST', '/v1/leases/{lease_id}/grant', 'read'],
  ['POST', '/v1/leases/{lease_id}/revoke', 'read'],
  ['POST', '/v1/questions/{token}/answer', 'read'],
  ['POST', '/v1/grants/{id}/decision', 'read'],
  ['POST', '/v1/clients/{grant_id}/revoke', 'read'],
  ['POST', '/v1/pairings/{id}/decision', 'read'],
  ['POST', '/v1/nodes/{node_id}/remove', 'read'],
  ['POST', '/v1/devices/enroll', 'read'],
  ['POST', '/v1/devices/revoke', 'read'],
  ['POST', '/v1/devices/read-key', 'read'],
  ['GET', '/v1/grants/pending', 'device'],
  ['POST', '/v1/alerts/{id}/ack', 'device'],
  ['POST', '/v1/pairing-codes', 'device'],
  ['POST', '/v1/devices/invites', 'device'],
  ['GET', '/v1/time', 'none'],
  ['POST', '/v1/enroll/{code_id}', 'code'],
  ['GET', '/v1/enroll/{code_id}', 'code'],
  ['POST', '/v1/devices/invites/{id}/claim', 'invite'],
  ['GET', '/v1/repin', 'none']
];

// The relay test's ROUTE_AUTH, read as text: requiring that file would run its tests here too.
function relayRouteAuth() {
  const text = read(path.join(ROOT, 'tests', 'frontdoor-phone-routes.test.js'));
  const a = text.indexOf('const ROUTE_AUTH = Object.freeze([');
  const b = text.indexOf(']);', a);
  assert.ok(a >= 0 && b > a, 'ROUTE_AUTH in tests/frontdoor-phone-routes.test.js');
  return [...text.slice(a, b).matchAll(/\['(GET|POST|PUT|DELETE)', '([^']+)', '([a-z]+)'\]/g)].map((m) => [m[1], m[2], m[3]]);
}

describe('Android: four screens and nothing else (android-slim §6, §12)', () => {
  it('the four screens exist, in the files §12 names', () => {
    assert.match(kt('Screens.kt'), /\nfun Root\(model: AppModel\)/);
    assert.match(kt('Screens.kt'), /\nfun ApprovalsScreen\(/);
    assert.match(kt('ScannerScreen.kt'), /\nfun ScannerScreen\(/);
    assert.match(kt('SettingsScreen.kt'), /\nfun SettingsScreen\(/);
    const details = kt('DetailScreens.kt');
    for (const f of ['ToolApprovalDetail', 'QuestionDetail', 'ClientConnectionDetail', 'PairingDetail', 'AlertDetail']) {
      assert.match(details, new RegExp(`\\nfun ${f}\\(`), f);
    }
    const lease = kt('LeaseScreens.kt');
    assert.match(lease, /\nfun LeaseRequestScreen\(/);
    assert.match(lease, /\nfun LiveLeaseScreen\(/);
    for (const gone of ['fun LeaseRequests(', 'fun LeaseBanner(']) assert.ok(!lease.includes(gone), gone);
    assert.ok(!fs.existsSync(path.join(KT_DIR, 'FrontDoorScreens.kt')), 'FrontDoorScreens.kt is deleted');
    assert.ok(!fs.existsSync(path.join(KT_DIR, 'Questions.kt')), "the app's Questions.kt is deleted");
    assert.ok(fs.existsSync(path.join(APP_MAIN, 'res', 'drawable', 'ic_scan.xml')), 'the scanner icon');
  });

  it('nothing else is a screen: no bottom bar, no Tab enum, no History, FrontDoor, Questions, Nodes, Devices or Welcome composable', () => {
    for (const file of appFiles()) {
      const src = read(file);
      const base = path.basename(file);
      for (const word of ['NavigationBar', 'enum class Tab', 'fun History(', 'fun FrontDoor(', 'fun Questions(', 'fun Nodes(', 'fun Devices(', 'fun Welcome(', 'fun Pending(', 'fun PendingCard(', 'fun Main(']) {
        assert.ok(!src.includes(word), `${base}: ${word}`);
      }
    }
  });

  it('no tap-only fetch is left: none of "Check for requests", "Show devices", "Try demo", "Check for computer-use requests", "Check for questions", "Refresh online state"', () => {
    for (const file of appFiles()) {
      // §8.7's set-up row says "Check for requests without your fingerprint": that one constant is the spec's words.
      const src = read(file).split('\n').filter((l) => !/const val READ_KEY_SETUP_TITLE = "Check for requests without your fingerprint\./.test(l)).join('\n');
      for (const s of ['Check for requests', 'Show devices', 'Try demo', 'Check for computer-use requests', 'Check for questions', 'Refresh online state', 'Refresh status']) {
        assert.ok(!src.includes(s), `${path.basename(file)}: "${s}"`);
      }
    }
    assert.match(kt('AppModel.kt'), /const val READ_KEY_SETUP_TITLE = "Check for requests without your fingerprint\. Set up once: two fingerprints\."/);
  });

  it('Approvals is the root: a top bar with the scanner and the gear, Back returns to it, an unpaired phone opens on the Scanner (C-10)', () => {
    const s = kt('Screens.kt');
    assert.match(s, /painterResource\(R\.drawable\.ic_scan\)/);
    assert.match(s, /Icons\.Filled\.Settings/);
    assert.match(s, /mutableStateOf\(if \(model\.mode == AppMode\.WELCOME\) Screen\.SCANNER else Screen\.APPROVALS\)/);
    assert.match(s, /BackHandler\(enabled = screen != Screen\.APPROVALS\) \{ screen = Screen\.APPROVALS \}/);
    assert.match(s, /BackHandler\(enabled = model\.selected != null\) \{ model\.closeDetail\(\) \}/);
    // The edge-to-edge bars (target SDK 37) draw over bgSidebarHdr (§11.2).
    assert.match(s, /Box\(Modifier\.fillMaxSize\(\)\.background\(KlTokens\.bgSidebarHdr\)\)/);
    assert.match(s, /\.safeDrawingPadding\(\)/);
    const icon = read(path.join(APP_MAIN, 'res', 'drawable', 'ic_scan.xml'));
    assert.match(icon, /<vector /);
  });

  it('each detail is the selected one, from the model (§6.3)', () => {
    const s = kt('Screens.kt');
    for (const [sel, screen] of [
      ['Tool', 'ToolApprovalDetail'], ['Question', 'QuestionDetail'], ['LeaseRequest', 'LeaseRequestScreen'], ['RunningLease', 'LiveLeaseScreen'],
      ['Client', 'ClientConnectionDetail'], ['Pairing', 'PairingDetail'], ['Alert', 'AlertDetail']
    ]) {
      assert.match(s, new RegExp(`is AppModel\\.Selection\\.${sel} -> [^\\n]*${screen}\\(`), `${sel} opens ${screen}`);
    }
  });
});

describe('Android: the Approvals list (android-slim §6.2, §7)', () => {
  it('the rows come from ApprovalList through the model, and a summary that does not fit reports itself (C-12)', () => {
    const s = kt('Screens.kt');
    assert.match(s, /val list = model\.approvalList\(\)/);
    assert.match(s, /onTextLayout = \{ model\.reportOverflow\(row\.id, it\.hasVisualOverflow\) \}/);
    assert.match(s, /maxLines = 1, overflow = TextOverflow\.Ellipsis/);
    // A button press goes to the model as the row's button; nothing else decides from a row.
    assert.match(s, /model\.press\(row, button\)/);
    assert.match(s, /onClick = \{ model\.open\(row\) \}/);
    for (const word of ['model.decide(', 'model.decideLease(', 'model.killSwitch(', 'model.answer(', 'model.decideGrant(', 'model.decidePairing(', 'model.ackAlert(']) {
      assert.ok(!s.includes(word), `Screens.kt: ${word} (a row decides only through press)`);
    }
    // Pull to refresh (§6.2), the one line about the loop, the set-up row (§8.7), the notice (§13), the footer, the empty state (§7.5).
    assert.match(s, /PullToRefreshBox\(isRefreshing = model\.isRefreshing, onRefresh = \{ model\.refresh\(\) \}/);
    assert.match(s, /model\.pollProblem\?\.let/);
    assert.match(s, /if \(model\.readKeySetupNeeded\)/);
    assert.match(s, /Text\(AppModel\.READ_KEY_SETUP_TITLE/);
    assert.match(s, /model\.listNotice\?\.let/);
    assert.match(s, /for \(line in list\.footer\)/);
    assert.match(s, /list\.empty\?\.let/);
    assert.match(s, /if \(empty\.toScanner\)/);
  });

  it('the running-lease rows wear the error tint over bgElevated, and "Could not confirm" the warning colour (§11.1)', () => {
    const s = kt('Screens.kt');
    assert.match(s, /ApprovalList\.Kind\.RUNNING_LEASE -> KlTokens\.errorBg\.compositeOver\(KlTokens\.bgElevated\)/);
    assert.match(s, /if \(row\.warning\) statusColors\.warning/);
  });

  it('the old banner\'s colours are gone with it (T09 left them for this ticket)', () => {
    const theme = kt('Theme.kt');
    for (const w of ['alertContainer', 'onAlertContainer', 'demoContainer']) assert.ok(!theme.includes(w), w);
  });
});

describe('Android: the Scanner and Settings (android-slim §6.1, §6.4)', () => {
  it('the Scanner has two tabs, takes a code from the camera or the field, and gets a pairing code', () => {
    const s = kt('ScannerScreen.kt');
    for (const w of ['"Scan a code"', '"Get a code"', '"Or type a code"', '"A client\'s code connects it through your front door."']) assert.ok(s.includes(w), w);
    assert.match(s, /QrScanner\(/);
    assert.match(s, /model\.scanned\(/);
    assert.match(s, /if \(model\.acceptsClientCode\)/);
    assert.match(s, /model\.getPairingCode\(/);
    assert.ok(s.includes('On the node, run'), 'the pairing words');
    assert.ok(s.includes('king-louie-service pair'));
    assert.match(s, /SelectionContainer/);
  });

  it('Settings reads its lists when it opens, removes a pin only after a confirm, and keeps reset behind one', () => {
    const s = kt('SettingsScreen.kt');
    assert.match(s, /LaunchedEffect\(model\.readKeySetupNeeded\) \{ model\.refreshSettings\(\) \}/);
    assert.match(s, /model\.settingsNodes\(\)/);
    for (const call of ['model.forgetNode(', 'model.removeNode(', 'model.revokeClient(', 'model.revoke(', 'model.startInvite()', 'model.confirmInvited()', 'model.sendReadKeyAgain()', 'model.reset()']) {
      assert.ok(s.includes(call), call);
    }
    assert.ok(count(s, 'AlertDialog(') >= 2, 'Remove and Reset each ask first');
    assert.ok(s.includes('It shows the same — add it'));
    for (const gone of ['The new phone has scanned it', 'notices when it has']) assert.ok(!s.includes(gone), gone);
    assert.ok(s.includes('No analytics. The relay sees every action you are asked to approve, and when this app is open. See PRIVACY.md.'));
    for (const w of ['read key in use', 'waiting for `device apply` on the node', 'not sent yet']) assert.ok(s.includes(w), w);
  });
});

describe('Android: the read key and the routes (android-slim §8.4, §12.1)', () => {
  it('this copy of §8.4\'s table is the relay test\'s ROUTE_AUTH', () => {
    const sort = (rows) => rows.map((r) => r.join(' ')).sort();
    assert.deepEqual(sort(SPEC_ROUTE_AUTH), sort(relayRouteAuth()));
  });

  it('the read key signs only for RelayApi\'s read routes, presence and the watch', () => {
    // AppModel: the read key signs in two places, RelayApi's signer and signRead (a kl.lease.watch only).
    const model = kt('AppModel.kt');
    assert.equal(count(model, 'rk.sign('), 2);
    assert.match(model, /private fun readSigner\(\): \(suspend \(ByteArray\) -> ByteArray\)\? \{\n\s+val rk = readKey \?: return null\n\s+return \{ data -> withContext\(Dispatchers\.IO\) \{ rk\.sign\(data\) \} \}/);
    assert.equal(count(model, 'readSigner()'), 2, 'declared, and handed to RelayApi once');
    assert.match(model, /if \(message\["type"\]\.str\(\) != "kl\.lease\.watch"\) throw /);
    // RelayApi: its read signer signs a READ request (presence, the lists, the watch's transport) and an
    // ENVELOPE one (the request carrying a device-key envelope), never a DEVICE one.
    const api = code(kt('RelayApi.kt'));
    assert.match(api, /READ -> \(readSigner \?: throw /);
    assert.match(api, /ENVELOPE -> if \(readSigner != null\) readSigner to PhoneKey\.READ else deviceSigner to PhoneKey\.DEVICE\n/);
    assert.equal(count(api, 'readSigner'), 4, 'declared, READ, and ENVELOPE\'s check and use');
    // No screen touches either key.
    for (const file of appFiles()) {
      const base = path.basename(file);
      if (['AppModel.kt', 'ReadKey.kt', 'DeviceKey.kt', 'RelayApi.kt'].includes(base)) continue;
      const src = read(file);
      for (const w of [/\bReadKey\b/, /\bDeviceKey\b/, /\breadSigner\b/, /\bsignRead\(/]) assert.doesNotMatch(src, w, base);
    }
  });
});

// The code review's spec findings (P1, P2, P3, P6): what each fix wrote into the app.
describe('Android: review fixes (android-slim §4, §6.4, §7.2, §9)', () => {
  // Every model file of the app (AppModel.kt and the files split out of it).
  const modelText = () => ['AppModel.kt', 'Storage.kt', 'ReadKeyNodes.kt', 'InviteFlow.kt', 'OwnerText.kt', 'ScannerCodes.kt']
    .filter((f) => fs.existsSync(path.join(KT_DIR, f))).map((f) => kt(f)).join('\n');

  it('a decided row of every yes/no kind stays at the bottom until a minute past its expiry (§7.2, P1)', () => {
    const list = section(kt('AppModel.kt'), 'fun approvalList(): ApprovalList.Result {', '\n    }\n');
    assert.match(list, /ApprovalList\.LeaseRequestItem\([^\n]*decided = /);
    assert.match(list, /ApprovalList\.ClientConnection\([^\n]*decided = /);
    assert.match(list, /ApprovalList\.NodePairing\([^\n]*decided = /);
    const model = kt('AppModel.kt');
    // A confirmed lease decision keeps its row, decided, instead of dropping it at once.
    assert.match(model, /leaseDecided\[id\] = /);
    assert.match(model, /clientDecided = /);
    assert.match(model, /pairingDecided\[pairing\.pairingId\] = /);
    // Each leaves a minute past its expiry.
    assert.match(model, /DECIDED_KEEP_MS = 60_000L/);
  });

  it('an unanswered Allow, Deny or Stop says so on its row, and Stop stays enabled (R-F5-5, P2)', () => {
    const list = section(kt('AppModel.kt'), 'fun approvalList(): ApprovalList.Result {', '\n    }\n');
    assert.match(list, /unconfirmed = item\.unconfirmed/);
    const rows = section(kt('AppModel.kt'), 'private fun runningLeaseRows', '\n    }\n');
    assert.match(rows, /unconfirmed = live\.unconfirmed/);
    const s = kt('Screens.kt');
    assert.match(s, /row\.notConfirmed\?\.let \{ Text\(it, [^\n]*statusColors\.warning/);
  });

  it('Settings without a read key shows the set-up line and what the phone knows (§6.4, P3)', () => {
    const s = kt('SettingsScreen.kt');
    assert.match(s, /if \(model\.readKeySetupNeeded\) \{/);
    assert.match(s, /Text\(AppModel\.SETTINGS_READ_KEY_LINE/);
    assert.match(s, /model\.setUpReadKey\(\)/);
    // Read again once the read key is set up.
    assert.match(s, /LaunchedEffect\(model\.readKeySetupNeeded\) \{ model\.refreshSettings\(\) \}/);
    assert.match(modelText(), /const val SETTINGS_READ_KEY_LINE = "Set up the read key to see nodes and phones\."/);
    // The pins, the fingerprints and Reset do not wait for the read key.
    assert.match(s, /val nodes = model\.settingsNodes\(\)/);
    assert.match(s, /model\.deviceFingerprint/);
    assert.match(s, /resetAsked = true/);
  });

  it('a notification arriving while the app is in front runs step 2 at once (§9, P6)', () => {
    const fcm = read(path.join(ROOT, 'mobile', 'android', 'app', 'src', 'fcm', 'kotlin', 'com', 'example', 'kinglouie', 'push', 'Push.kt'));
    const received = section(fcm, 'override fun onMessageReceived(message: RemoteMessage) {', '\n    }\n');
    assert.match(received, /\(application as KingLouieApplication\)\.model\.onNotificationArrived\(\)/);
    // The notification kinds are spec 3's, unchanged.
    assert.match(received, /setOf\("approval", "pairing", "alert", "question", "lease"\)/);
    const arrived = section(kt('AppModel.kt'), 'fun onNotificationArrived() {', '\n    }\n');
    assert.match(arrived, /scope\.launch \{ if \(foreground\) refresh\(\) \}/);
  });
});

function section(text, start, end) {
  const a = text.indexOf(start);
  assert.ok(a >= 0, `"${start}" is there`);
  const b = text.indexOf(end, a + start.length);
  assert.ok(b > a, `"${end}" follows "${start}"`);
  return text.slice(a, b + end.length);
}
