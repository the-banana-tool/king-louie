// tests/mobile-lease-apps.test.js
//
// The phone apps have no test target of their own (only their protocol cores
// do), so the rules the owner set for their lease screens on 2026-10-12 are
// pinned here by reading the sources, as tests/longhaul-verify-web.test.js
// does for innerHTML. It runs on any machine and builds nothing: it shows the
// rules are still written into the code, not that the apps compile or behave.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// A Windows checkout may hold these files with CRLF line endings.
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const count = (text, needle) => text.split(needle).length - 1;
// The text from `start` up to (not including) the next `end`; `start` must be there exactly once.
function section(text, start, end) {
  assert.equal(count(text, start), 1, `marker "${start}" appears exactly once`);
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  assert.ok(b > a, `"${end}" follows "${start}"`);
  return text.slice(a, b);
}
const none = (text, words, where) => { for (const w of words) assert.ok(!text.includes(w), `"${w}" in ${where}`); };

describe('iOS lease screens (owner ruling R-F5-8)', () => {
  // Read inside each test, so a missing file or marker fails that test by name.
  function ios() {
    const model = read('mobile', 'ios', 'App', 'AppModel.swift');
    const leases = section(model, '// MARK: Leases (fleet stage 5)', '// MARK: Leases end');
    return {
      model,
      leases,
      // Everything before the demo: the part that talks to a relay and signs.
      live: section(leases, '// MARK: Leases (fleet stage 5)', '// Demo:'),
      key: read('mobile', 'ios', 'App', 'DeviceKey.swift'),
      views: read('mobile', 'ios', 'App', 'LeaseViews.swift'),
      screens: read('mobile', 'ios', 'App', 'Views.swift'),
      core: read('mobile', 'ios', 'KLProtocol', 'Sources', 'KLProtocol', 'Lease.swift')
    };
  }

  it('iOS: only the watch is signed with the session', () => {
    const { model, leases, live, key } = ios();
    // DeviceKey: the session signature is for kl.lease.watch and for nothing else.
    const sign = section(key, 'func signWatchEnvelope', '\n    }\n');
    assert.match(sign, /guard message\["type"\]\?\.stringValue == "kl\.lease\.watch" else/);
    assert.match(sign, /signForSession\(/);
    // AppModel: one use in the whole app, in the live view.
    assert.equal(count(model, 'signWatchEnvelope('), 1);
    assert.equal(count(leases, 'signWatchEnvelope('), 1);
    assert.match(section(leases, 'func openLiveLease', 'private func apply('), /signWatchEnvelope\(/);
    // No lease message is signed with the session any other way.
    none(leases, ['signForSession', 'signIfUnlocked', 'signRefusalEnvelope'], 'the lease section');
    // Grants and denies take a fresh prompt (signEnvelope), never the session.
    const decide = section(leases, 'func decideLease', 'func openLiveLease');
    assert.equal(count(decide, 'key.signEnvelope('), 2, 'one for the grant, one for the deny');
    assert.match(decide, /key\.signEnvelope\(message, reason:/, 'the grant');
    assert.match(decide, /key\.signEnvelope\(Leases\.deny\(/, 'the deny');
    none(decide, ['signWatchEnvelope', 'sessionOnlySigner'], 'decideLease');
    // So does the kill switch.
    const kill = section(leases, 'func killSwitch', '// Demo:');
    assert.equal(count(kill, 'key.signEnvelope('), 1);
    assert.match(kill, /Leases\.revoke\(/);
    none(kill, ['signWatchEnvelope', 'sessionOnlySigner'], 'killSwitch');
    // Three fresh prompts in the section and no more: grant, deny, revoke.
    assert.equal(count(live, 'key.signEnvelope('), 3);
    // The watch is the only message the live view builds.
    const liveView = section(leases, 'func openLiveLease', 'private func apply(');
    assert.equal(count(liveView, 'Leases.watch('), 1);
    none(liveView, ['Leases.grant(', 'Leases.deny(', 'Leases.revoke(', 'key.signEnvelope('], 'the live view');
  });

  it('iOS: the live view does not unlock the app by itself', () => {
    const { leases, screens } = ios();
    // It waits while the API session is locked instead of unlocking it.
    const liveView = section(leases, 'func openLiveLease', 'private func apply(');
    assert.match(liveView, /guard key\.isSessionUnlocked else \{/);
    assert.ok(liveView.indexOf('guard key.isSessionUnlocked else {') < liveView.indexOf('signWatchEnvelope('), 'checked before the watch is signed');
    // Its two relay requests (the watch and the poll) are signed only with a session already unlocked.
    assert.match(liveView, /client\.leaseDecision\("watch", leaseId: leaseId, envelope: envelope, signWith: AppModel\.sessionOnlySigner\(key\)\)/);
    assert.match(liveView, /client\.leaseViews\(leaseId, afterSeq: live\.lastSeq, wait: 20, signWith: AppModel\.sessionOnlySigner\(key\)\)/);
    assert.equal(count(liveView, 'client.'), 3, 'the two requests, and the relay clock for signed_at');
    // The list is loaded without a prompt when the screen merely appears.
    assert.match(section(leases, 'func refreshLeases', 'func decideLease'), /signWith: onlyIfUnlocked \? Self\.sessionOnlySigner\(key\) : nil/);
    assert.match(screens, /\.task \{ await model\.refreshLeases\(onlyIfUnlocked: true\) \}/);
  });

  it('iOS: a lease is shown only when a pinned node signed it', () => {
    const { leases, live, views, core } = ios();
    // The core: signature, kid and node_id are the pin's; the lease is the one hashed.
    const verified = section(core, 'public static func verifiedMessage', '\n    }\n');
    assert.match(verified, /envelope\.kid == pin\.id/);
    assert.match(verified, /envelope\.verifyEd25519\(spkiHex: pin\.key\)/);
    assert.match(verified, /message\["node_id"\]\?\.stringValue == pin\.id/);
    assert.match(section(core, 'public struct LeaseRequest', 'public struct LeaseStatus'), /Digest\.sha256B64url\(JCS\.data\(lease\)\) == leaseHash/);
    const view = section(core, 'public static func verifyView', '\n    }\n');
    assert.match(view, /guard envelope\.verifyEd25519\(spkiHex: pin\.key\) else/);
    assert.match(view, /guard Digest\.sha256B64url\(data\) == hash else/);
    // The app: requests come through the pin and the core, and nothing else opens an envelope.
    const refresh = section(leases, 'func refreshLeases', 'func decideLease');
    assert.match(refresh, /let pin = state\.nodes\.first\(where: \{ \$0\.id == envelope\.kid \}\)/);
    assert.match(refresh, /let message = Leases\.verifiedMessage\(envelope, pin: pin\), let request = LeaseRequest\(message: message\)/);
    assert.match(refresh, /LeaseRequestItem\(request: request, nodeName: pin\.name, status: status\)/);
    const apply = section(leases, 'private func apply(', 'func closeLiveLease');
    assert.match(apply, /Leases\.verifiedMessage\(envelope, pin: pin\)/);
    assert.match(apply, /let check = Leases\.verifyView\(envelope, pin: pin\)\n\s+guard check\.accepted, let view = check\.view, view\.leaseId == live\.leaseId else \{ return \}/);
    none(live, ['.message()', 'payloadData', 'JSONParser', '.payload'], 'the lease section (an envelope opened outside the core)');
    // The request screen draws the signed request, and the model keeps nothing else for it.
    assert.match(leases, /struct LeaseRequestItem: Identifiable, Equatable \{\n\s+var id: String \{ request\.requestId \}\n\s+let request: LeaseRequest\n\s+let nodeName: String\n\s+var status: LeaseStatus\?\n\s+\}/);
    for (const shown of ['item.request.apps', 'app.name', 'app.path', 'app.processes', 'item.request.reason', "Agent's reason (unverified)",
      'item.request.originClient', 'item.request.jobId', 'item.request.maxMinutes', 'item.request.limits', 'item.nodeName']) {
      assert.ok(views.includes(shown), `the request screen shows ${shown}`);
    }
    none(views, ['JSONValue', 'entry[', 'Envelope'], 'LeaseViews.swift (unsigned data on a lease screen)');
  });

  it('iOS: signed_at is the relay-corrected clock', () => {
    const { live } = ios();
    assert.equal(count(live, 'Timestamps.string(client.now())'), 3, 'the decision, the watch and the revoke');
    assert.equal(count(live, 'signedAt:'), 4, 'grant, deny, watch, revoke');
    assert.equal(count(live, 'signedAt: signedAt'), 2, 'the grant and the deny share one reading');
    assert.equal(count(live, 'signedAt: Timestamps.string(client.now())'), 2, 'the watch and the revoke');
    assert.match(live, /let signedAt = Timestamps\.string\(client\.now\(\)\)/);
    none(live, ['Timestamps.string(Date())', 'Timestamps.string(.now'], 'the lease section (the phone clock in a signed message)');
    // A request is dropped once it is past its expiry on that clock.
    assert.match(live, /let expires = Timestamps\.date\(request\.expiresAt\), expires > client\.now\(\)/);
  });
});

// R-F5-16 (owner ruling, 2026-10-13): both phones drop a status or a view
// whose node seq is not newer than the newest one already applied for that
// lease, and a view that is not addressed to this device. The rule lives in
// the protocol cores (unit-tested there); these checks show the apps use it.
describe('both phones enforce order and addressee (owner ruling R-F5-16)', () => {
  const kt = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];

  it('Android: the core has the rule, and applyLease applies nothing that fails it', () => {
    const core = read('mobile', 'android', 'protocol', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'protocol', 'Lease.kt');
    assert.match(core, /fun acceptsStatus\(status: LeaseStatus, appliedSeq: Int\): Boolean = status\.seq > appliedSeq/);
    assert.match(core, /fun acceptsView\(view: LeaseView, appliedSeq: Int, deviceId: String\): Boolean = view\.seq > appliedSeq && view\.toDevice == deviceId/);
    assert.match(core, /m\["to_device"\]\.str\(\) \?: return ViewCheck\(false, "malformed", null\)/, 'a view without to_device is malformed');
    const model = read(...kt, 'AppModel.kt');
    const live = section(model, '// ---- Leases (fleet stage 5) ----', '// ---- Leases: demo ----');
    const apply = section(live, 'private fun applyLease', '\n    }\n');
    assert.match(apply, /private fun applyLease\(envelope: Envelope, pin: NodePin, live: LiveLease, deviceId: String\): LiveLease \{/);
    assert.match(apply, /if \(status\.leaseId != live\.leaseId \|\| !Leases\.acceptsStatus\(status, live\.appliedSeq\)\) return live/);
    assert.match(apply, /if \(!Leases\.acceptsView\(view, live\.appliedSeq, deviceId\)\) return live/);
    assert.equal(count(apply, 'appliedSeq = status.seq'), 1);
    assert.equal(count(apply, 'appliedSeq = view.seq'), 1);
    // Both checks come before anything is copied onto the screen's lease.
    assert.ok(apply.indexOf('Leases.acceptsStatus(') < apply.indexOf('state = status.state'));
    assert.ok(apply.indexOf('Leases.acceptsView(') < apply.indexOf('state = view.state'));
    assert.match(live, /val appliedSeq: Int = 0/);
    assert.equal(count(model, 'applyLease(envelope, pin, next, k.deviceId)'), 1, 'the live path passes this phone\'s device id');
    assert.equal(count(model, 'applyLease('), 4, 'declared once, called from Refresh, from the demo and for the status an answer carries');
  });

  it('iOS: the core has the rule, and apply applies nothing that fails it', () => {
    const core = read('mobile', 'ios', 'KLProtocol', 'Sources', 'KLProtocol', 'Lease.swift');
    assert.match(core, /public static func acceptsStatus\(_ status: LeaseStatus, appliedSeq: Int\) -> Bool \{ status\.seq > appliedSeq \}/);
    assert.match(core, /public static func acceptsView\(_ view: LeaseView, appliedSeq: Int, deviceId: String\) -> Bool \{ view\.seq > appliedSeq && view\.toDevice == deviceId \}/);
    assert.match(core, /let toDevice = m\["to_device"\]\?\.stringValue/);
    const model = read('mobile', 'ios', 'App', 'AppModel.swift');
    const leases = section(model, '// MARK: Leases (fleet stage 5)', '// MARK: Leases end');
    const apply = section(leases, 'private func apply(', 'func closeLiveLease');
    assert.match(apply, /private func apply\(_ envelope: Envelope, pin: NodePin, deviceId: String, to live: inout LiveLease\) \{/);
    assert.match(apply, /guard status\.leaseId == live\.leaseId, Leases\.acceptsStatus\(status, appliedSeq: live\.appliedSeq\) else \{ return \}/);
    assert.match(apply, /guard Leases\.acceptsView\(view, appliedSeq: live\.appliedSeq, deviceId: deviceId\) else \{ return \}/);
    assert.equal(count(apply, 'live.appliedSeq = status.seq'), 1);
    assert.equal(count(apply, 'live.appliedSeq = view.seq'), 1);
    assert.ok(apply.indexOf('Leases.acceptsStatus(') < apply.indexOf('live.state = status.state'));
    assert.ok(apply.indexOf('Leases.acceptsView(') < apply.indexOf('live.state = view.state'));
    assert.match(leases, /var appliedSeq = 0/);
    assert.equal(count(leases, 'self.apply(envelope, pin: pin, deviceId: key.deviceId, to: &current)'), 1);
    assert.equal(count(leases, 'self.apply('), 2, 'the live view and the demo');
  });

  // R-F5-15 (second security review, finding 3): a watch is contact only
  // when it echoes a contact token the node issued recently. Each phone
  // keeps the token of the newest status or view it applied, sends it in
  // its watch, and takes a fresh one from the status a node's answer
  // carries, which it verifies like any other status.
  it('both phones echo the newest contact token in a watch, and read a reply\'s status only through the verified path', () => {
    // The cores: the watch carries the token (null when there is none); statuses and views give it.
    const swift = read('mobile', 'ios', 'KLProtocol', 'Sources', 'KLProtocol', 'Lease.swift');
    assert.match(swift, /public static func watch\(nodeId: String, leaseId: String, deviceId: String, contactToken: String\?, nonce: String, signedAt: String\) -> JSONValue \{/);
    assert.match(swift, /"contact_token": token,/);
    assert.match(swift, /let token: JSONValue = contactToken\.map \{ JSONValue\.string\(\$0\) \} \?\? JSONValue\.null/);
    assert.equal(count(swift, 'self.contactToken = message["contact_token"]?.stringValue'), 1, 'LeaseStatus');
    assert.equal(count(swift, 'contactToken: m["contact_token"]?.stringValue'), 1, 'LeaseView');
    const kotlin = read('mobile', 'android', 'protocol', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'protocol', 'Lease.kt');
    assert.match(kotlin, /fun watch\(nodeId: String, leaseId: String, deviceId: String, contactToken: String\?, nonce: String, signedAt: String\): JsonObject \{/);
    assert.match(kotlin, /val token: JsonElement = if \(contactToken != null\) jsonString\(contactToken\) else JsonNull/);
    assert.match(kotlin, /"contact_token" to token,/);
    assert.equal(count(kotlin, 'm["contact_token"].str()'), 2, 'LeaseStatus and LeaseView');

    // iOS: the token is kept by apply (and nowhere else), and the watch echoes it.
    const ios = read('mobile', 'ios', 'App', 'AppModel.swift');
    const iosLeases = section(ios, '// MARK: Leases (fleet stage 5)', '// MARK: Leases end');
    const iosApply = section(iosLeases, 'private func apply(', 'func closeLiveLease');
    assert.equal(count(iosApply, 'if let token = status.contactToken { live.contactToken = token }'), 1);
    assert.equal(count(iosApply, 'if let token = view.contactToken { live.contactToken = token }'), 1);
    assert.equal(count(iosLeases, 'contactToken = '), 2, 'only apply sets it');
    assert.match(iosLeases, /Leases\.watch\(nodeId: nodeId, leaseId: leaseId, deviceId: key\.deviceId, contactToken: live\.contactToken,/);
    // A reply's status goes through the pin and `apply`; nothing else of a reply is applied.
    const iosReply = section(iosLeases, 'private func applyReplyStatus', '\n    }\n');
    assert.match(iosReply, /guard let json = reply\?\["status"\], let signed = try\? Envelope\(json: json\), let key,/);
    assert.match(iosReply, /let pin = state\.nodes\.first\(where: \{ \$0\.id == current\.nodeId \}\) else \{ return \}/);
    assert.match(iosReply, /apply\(signed, pin: pin, deviceId: key\.deviceId, to: &current\)/);
    assert.equal(count(iosLeases, 'applyReplyStatus('), 3, 'declared, after Allow, and after each watch');
    assert.equal(count(iosLeases, '["status"]'), 2, 'the listed request\'s status and a reply\'s: both through verifiedMessage');
    // One early watch at most per 20 s, so a phone that is never contact does not loop.
    const iosLive = section(iosLeases, 'func openLiveLease', 'private func apply(');
    assert.match(iosLive, /let early = Leases\.isPausedForContact\(state: live\.state, reason: live\.reason\) && !earlyUsed\n\s+&& live\.contactToken != nil && live\.contactToken != lastWatchToken/);
    assert.match(iosLive, /if sinceWatch >= 20 \|\| early, live\.state != "ended" \{\n\s+earlyUsed = sinceWatch < 20\n/);

    // Android: the same, with no loop: the token rides on the one watch a Refresh sends.
    const kt = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];
    const android = read(...kt, 'AppModel.kt');
    const live = section(android, '// ---- Leases (fleet stage 5) ----', '// ---- Leases: demo ----');
    const apply = section(live, 'private fun applyLease', '\n    }\n');
    assert.equal(count(apply, 'contactToken = status.contactToken ?: live.contactToken'), 1);
    assert.equal(count(apply, 'contactToken = view.contactToken ?: live.contactToken'), 1);
    assert.equal(count(live, 'contactToken = '), 2, 'only applyLease sets it');
    assert.match(live, /Leases\.watch\(next\.nodeId, next\.leaseId, k\.deviceId, next\.contactToken, Messages\.randomNonce\(\), Timestamps\.string\(api\.now\(\)\)\)/);
    const reply = section(live, 'private fun applyReplyStatus', '\n    }\n');
    assert.match(reply, /val signed = reply\["status"\]\?\.takeIf \{ it !is JsonNull \}\?\.let \{ runCatching \{ Envelope\.fromJson\(it\) \}\.getOrNull\(\) \} \?: return live/);
    assert.match(reply, /return applyLease\(signed, pin, live, deviceId\)/);
    assert.equal(count(live, 'applyReplyStatus('), 4, 'declared, after Allow, after the watch, after Stop');
    assert.equal(count(live, '["status"]'), 2, 'the listed request\'s status and a reply\'s: both through verifiedMessage');
  });

  it('neither app\'s demo shows typed text in its action log', () => {
    for (const text of [read(...kt, 'AppModel.kt'), read('mobile', 'ios', 'App', 'AppModel.swift')]) {
      assert.ok(!/Type \\"/.test(text), 'no "Type \"…\"" summary');
      assert.match(text, /Typed 6 characters/);
    }
  });
});

describe('Android lease screens (owner rulings R-F5-1, R-F5-5, R-F5-6)', () => {
  const dir = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];
  // Read inside each test, so a missing file or marker fails that test by name.
  function android() {
    const model = read(...dir, 'AppModel.kt');
    return {
      model,
      // The live part of the section: everything before the demo, which may loop.
      live: section(model, '// ---- Leases (fleet stage 5) ----', '// ---- Leases: demo ----'),
      api: read(...dir, 'RelayApi.kt'),
      screens: read(...dir, 'Screens.kt'),
      leaseScreens: read(...dir, 'LeaseScreens.kt'),
      core: read('mobile', 'android', 'protocol', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'protocol', 'Lease.kt')
    };
  }
  // What the model does for a lease, as the screens call it.
  const ACTS = ['model.refreshLeases(', 'model.refreshLiveLease(', 'model.killSwitch(', 'model.decideLease(', 'model.openLiveLease('];

  it('Android: the live lease section has no loop and no timer', () => {
    const { live, screens, leaseScreens } = android();
    none(live, ['while (', 'while(', 'do {', 'delay(', 'repeat(', 'postDelayed', 'Timer(', 'withTimeout', 'pollJob', '.retry',
      'forEach', 'generateSequence', 'tailrec', 'ticker', 'Handler(', 'schedule', 'LaunchedEffect', '.collect', 'flow {'], 'the live lease section');
    // The only `for` walks the entries one fetch returned.
    assert.equal(count(live, 'for ('), 1);
    assert.match(live, /for \(entry in entries\)/);
    // No function here calls itself or another tap's function: each name appears once, where it is declared.
    for (const name of ['fun refreshLeases(', 'fun refreshLiveLease(', 'fun killSwitch(', 'fun decideLease(', 'private fun noteLeasePush(']) {
      assert.equal(count(live, name), 1, name);
      assert.equal(count(live, name.split(' ').pop()), 1, `${name.split(' ').pop()} is called from the section`);
    }
    // One coroutine per tap: the list, a decision, a Refresh, a Stop.
    assert.equal(count(live, 'scope.launch'), 4);
    // The screens: nothing runs by itself. The model is called only from a button's onClick.
    none(leaseScreens, ['LaunchedEffect', 'DisposableEffect', 'SideEffect', 'produceState', 'rememberCoroutineScope', 'delay(', 'while (', 'ticker('], 'LeaseScreens.kt');
    assert.equal(count(leaseScreens, 'OutlinedButton({ model.refreshLeases() }'), 1);
    assert.equal(count(leaseScreens, 'OutlinedButton({ model.refreshLiveLease() }'), 1);
    assert.equal(count(leaseScreens, 'Button({ model.killSwitch() }'), 2, 'the live screen and the banner');
    assert.equal(count(leaseScreens, 'Button({ model.decideLease('), 2, 'Allow and Deny');
    for (const [call, n] of [['model.refreshLeases(', 1], ['model.refreshLiveLease(', 1], ['model.killSwitch(', 2], ['model.decideLease(', 2], ['model.openLiveLease(', 0]]) {
      assert.equal(count(leaseScreens, call), n, `${call} in LeaseScreens.kt`);
    }
    none(screens, ACTS, 'Screens.kt (a lease action outside the lease screens)');
  });

  it('Android: Stop, Allow and Refresh send once', () => {
    const { live, api, leaseScreens } = android();
    // One place posts a lease envelope, and it reports a failure instead of trying again.
    assert.equal(count(live, 'api.leaseDecision('), 1);
    const send = section(live, 'private suspend fun sendLease', '\n    }\n');
    assert.match(send, /= try \{\n\s+val json = api\.leaseDecision\(action, leaseId, envelope\)\n\s+val outcome = Leases\.sendOutcome\(json\)\n/);
    assert.match(send, /catch \(e: RelayException\) \{\n\s+LeaseReply\(SendOutcome\.Unconfirmed, null, /);
    assert.equal(count(section(api, 'suspend fun leaseDecision', '\n\n'), 'request('), 1);
    // One call per action, three in all.
    assert.equal(count(section(live, 'fun decideLease', 'fun openLiveLease'), 'sendLease(api,'), 1);
    assert.equal(count(section(live, 'fun refreshLiveLease', 'private fun applyLease'), 'sendLease(api,'), 1);
    const kill = live.slice(live.indexOf('fun killSwitch'));
    assert.equal(count(kill, 'sendLease(api,'), 1);
    assert.equal(count(live, 'sendLease(api,'), 3);
    // Each is signed once, with a prompt of its own.
    assert.equal(count(live, 'signEnvelope(k,'), 4, 'grant, deny, watch, revoke');
    // A send with no answer stays on screen as not confirmed, and is never shown as done.
    assert.ok(count(live, 'unconfirmed =') >= 3);
    assert.match(section(live, 'fun decideLease', 'fun openLiveLease'), /is SendOutcome\.Unconfirmed ->\n\s+markLeaseUnconfirmed\(id, "Not confirmed: /);
    assert.match(kill, /next = next\.copy\(unconfirmed = Leases\.stopNotice\(sent\.outcome, sent\.problem\)\)/);
    assert.match(leaseScreens, /live\.unconfirmed\?\.let \{ Text\(it, /);
    assert.match(leaseScreens, /item\.unconfirmed\?\.let \{ Text\(it, /);
    // The owner can tap again: the buttons depend on what is in flight, not on the last answer.
    assert.match(leaseScreens, /Button\(\{ model\.killSwitch\(\) \}, Modifier\.fillMaxWidth\(\), enabled = !live\.busy && live\.state != "ended",/);
    assert.match(leaseScreens, /OutlinedButton\(\{ model\.refreshLiveLease\(\) \}, enabled = !live\.busy\)/);
    assert.match(leaseScreens, /enabled = chosen\.isNotEmpty\(\) && !deciding\)/);
  });

  // Security review finding 1: a relay's reply to Stop (or to a watch) is not
  // signed by the node. It must never be what makes the screen say "ended".
  it('Android: a lease is shown as ended only by a status or view the pinned node signed', () => {
    const { live, core } = android();
    const kill = live.slice(live.indexOf('fun killSwitch'));
    const refresh = section(live, 'fun refreshLiveLease', 'private fun applyLease');
    const apply = section(live, 'private fun applyLease', '\n    }\n');
    // Stop: whatever comes back, the screen keeps its state and says what the reply was worth.
    assert.equal(count(kill, 'state = "ended"'), 1, 'only the demo, which has no node');
    assert.match(kill, /if \(mode == AppMode\.DEMO\) \{\n\s+demoLeaseJob\?\.cancel\(\)\n\s+liveLease = live\.copy\(state = "ended", reason = "revoked"\)\n\s+return\n\s+\}/);
    none(kill, ['state = outcome.state', 'outcome.state'], 'killSwitch (the relay\'s word used as the lease state)');
    // Refresh: the watch reply's state only decides how long to wait for the signed view.
    none(refresh, ['state = outcome.state', 'next.copy(state'], 'refreshLiveLease');
    assert.match(refresh, /waitForFrame = outcome\.state == "active"/);
    assert.equal(count(refresh, 'outcome.state'), 1);
    // The one place a live lease's state is written from the network: applyLease, from verified messages.
    assert.equal(count(apply, 'state = status.state'), 1);
    assert.equal(count(apply, 'state = view.state'), 1);
    assert.match(apply, /val status = Leases\.verifiedMessage\(envelope, pin\)\?\.let \{ LeaseStatus\.from\(it\) \}/);
    const outside = live.replace(apply, '');
    none(outside, ['state = status.state', 'state = view.state', 'state = sent.', 'state = json', 'state = reply'], 'the lease section outside applyLease');
    assert.equal(count(outside, 'state = "ended"'), 1, 'the demo Stop');
    // The core says what a Stop's reply lets the screen say, and "ended" is not in any of it.
    const notice = section(core, 'fun stopNotice', '\n    }\n');
    assert.match(notice, /is SendOutcome\.Confirmed -> "Stop sent, not yet confirmed by the computer\./);
    assert.doesNotMatch(notice, /ended|stopped\b/i);
    // Stop stays enabled until a signed message ends the lease.
    const { leaseScreens } = android();
    assert.match(leaseScreens, /Button\(\{ model\.killSwitch\(\) \}, Modifier\.fillMaxWidth\(\), enabled = !live\.busy && live\.state != "ended",/);
  });

  // R-F5-15 (owner ruling, 2026-10-13): the node pauses input when the
  // granting phone has not been in touch. Android fetches on tap (R-F5-1), so
  // its owner has to tap Refresh inside the window; the screen says so, and
  // still does nothing by itself.
  it('Android: the live screen says input is paused for want of contact, and what keeps it going, with no timer', () => {
    const { live, leaseScreens, core } = android();
    assert.match(core, /const val NO_CONTACT = "no_contact"/);
    assert.match(core, /fun isPausedForContact\(state: String, reason: String\?\): Boolean = state == "suspended" && reason == NO_CONTACT/);
    // From the signed state only: what applyLease read from a status the pinned node signed.
    assert.match(leaseScreens, /if \(Leases\.isPausedForContact\(live\.state, live\.reason\)\) Text\("Paused: tap Refresh to let it continue\."/);
    assert.match(leaseScreens, /The computer pauses clicks and typing when this phone has not refreshed for about two minutes\. Tap Refresh to keep it going\./);
    // Nothing new runs by itself (R-F5-1, R-F5-5): the same checks as above, on the changed files.
    none(leaseScreens, ['LaunchedEffect', 'DisposableEffect', 'SideEffect', 'produceState', 'rememberCoroutineScope', 'delay(', 'while (', 'ticker('], 'LeaseScreens.kt');
    none(live, ['delay(', 'while (', 'Timer(', 'postDelayed', 'ticker'], 'the live lease section');
    assert.equal(count(leaseScreens, 'model.refreshLiveLease('), 1, 'Refresh is still only the button');
    assert.equal(count(live, 'scope.launch'), 4, 'no coroutine was added');
  });

  it('Android: a lease push fetches nothing; Refresh waits with Leases.REFRESH_WAIT_S', () => {
    const { model, live, api, screens, leaseScreens } = android();
    // The push branch only notes that something is waiting.
    assert.match(model, /"lease" -> noteLeasePush\(\)/);
    const note = section(live, 'private fun noteLeasePush', '\n    }\n');
    none(note, ['api', 'client', 'refresh', 'launch', 'sign', 'open'], 'noteLeasePush');
    // The list is fetched from one place: the button the owner taps.
    assert.equal(count(model, 'refreshLeases()'), 1, 'declared in the model and called from nowhere in it');
    assert.match(leaseScreens, /model\.refreshLeases\(\)/);
    // The screen's part of a push: the Pending tab, and nothing else.
    const effect = section(screens, 'LaunchedEffect(model.leasePushes)', '\n    }\n');
    none(effect, ['model.refresh', 'model.open', 'model.kill', 'model.decide', 'showLive = true', 'launch'], 'the lease-push effect');
    assert.equal(count(screens, 'LaunchedEffect('), 2, 'the push effect and the one-second ticker; neither calls the model');
    // Refresh: views from the position the watch reply gives, waiting for the frame.
    const refresh = section(live, 'fun refreshLiveLease', 'private fun applyLease');
    assert.match(refresh, /cursor = Leases\.cursorAfterWatch\(next\.lastSeq, sent\.json\)/);
    assert.match(refresh, /api\.leaseViews\(next\.leaseId, cursor, if \(waitForFrame\) Leases\.REFRESH_WAIT_S else 0\)/);
    assert.equal(count(live, 'api.leaseViews('), 1);
    assert.equal(count(live, 'api.leases('), 1);
    assert.match(api, /views\?after_seq=\$afterSeq&wait=\$waitS/);
    // No frame is not a reason to ask again: the screen says so.
    assert.match(leaseScreens, /if \(live\.noFrame\) Text\(/);
  });

  it('Android: a lease is shown only when a pinned node signed it', () => {
    const { live, leaseScreens, core } = android();
    // The core: signature, kid and node_id are the pin's; the lease is the one hashed.
    assert.match(core, /if \(envelope\.alg != "Ed25519" \|\| envelope\.kid != pin\.id \|\| !envelope\.verifyEd25519\(pin\.key\)\) return null/);
    assert.match(core, /return m\.takeIf \{ it\["node_id"\]\.str\(\) == pin\.id \}/);
    assert.match(core, /if \(Digest\.sha256B64url\(Jcs\.bytes\(lease\)\) != leaseHash\) return null/);
    assert.match(core, /if \(!envelope\.verifyEd25519\(pin\.key\)\) return ViewCheck\(false, "bad_signature", null\)/);
    assert.match(core, /if \(Digest\.sha256B64url\(data\) != hash\) return ViewCheck\(false, "frame_hash_mismatch", null\)/);
    // The app: requests come through the pin and the core, and nothing else opens an envelope.
    const verified = section(live, 'private fun verifiedLeaseRequest', '\n    }\n');
    assert.match(verified, /val pin = pins\.firstOrNull \{ it\.id == envelope\.kid \} \?: return null/);
    assert.match(verified, /val request = Leases\.verifiedMessage\(envelope, pin\)\?\.let \{ LeaseRequest\.from\(it\) \} \?: return null/);
    assert.match(verified, /return LeaseRequestItem\(request, pin\.name, status\)/);
    const apply = section(live, 'private fun applyLease', '\n    }\n');
    assert.match(apply, /Leases\.verifiedMessage\(envelope, pin\)\?\.let \{ LeaseStatus\.from\(it\) \}/);
    assert.match(apply, /val view = check\.view\?\.takeIf \{ check\.accepted && it\.leaseId == live\.leaseId \} \?: return live/);
    none(live, ['.message()', 'payloadBytes', 'JsonText', '.payload'], 'the live lease section (an envelope opened outside the core)');
    // The request screen draws the signed request, and the model keeps nothing else for it.
    assert.match(live, /data class LeaseRequestItem\(val request: LeaseRequest, val nodeName: String, val status: LeaseStatus\?, val unconfirmed: String\? = null\)/);
    for (const shown of ['item.request.apps', 'app.name', 'app.path', 'app.processes', 'item.request.reason', "Agent's reason (unverified)",
      'item.request.originClient', 'item.request.jobId', 'item.request.maxMinutes', 'item.request.limits', 'item.nodeName']) {
      assert.ok(leaseScreens.includes(shown), `the request screen shows ${shown}`);
    }
    none(leaseScreens, ['JsonElement', 'entry[', 'Envelope', 'relayText'], 'LeaseScreens.kt (unsigned data on a lease screen)');
  });

  it('Android: signed_at is the relay-corrected clock', () => {
    const { live } = android();
    assert.equal(count(live, 'Timestamps.string(api.now())'), 3, 'the decision, the watch and the revoke');
    assert.match(live, /val signedAt = Timestamps\.string\(api\.now\(\)\)/);
    assert.match(live, /Leases\.grant\(item\.request, apps\.toList\(\), minutes, k\.deviceId, signedAt\)/);
    assert.match(live, /Leases\.deny\(item\.request, k\.deviceId, signedAt\)/);
    assert.match(live, /Leases\.watch\(next\.nodeId, next\.leaseId, k\.deviceId, next\.contactToken, Messages\.randomNonce\(\), Timestamps\.string\(api\.now\(\)\)\)/);
    assert.match(live, /Leases\.revoke\(live\.nodeId, live\.leaseId, "kill_switch", k\.deviceId, Messages\.randomNonce\(\), Timestamps\.string\(api\.now\(\)\)\)/);
    none(live, ['Instant.now()'], 'the live lease section (the phone clock in a signed message)');
    // A request is dropped once it is past its expiry on that clock.
    assert.match(live, /\(Timestamps\.epochMillis\(request\.expiresAt\) \?: 0L\) <= api\.now\(\)\.toEpochMilli\(\)/);
  });
});
