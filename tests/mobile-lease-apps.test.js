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
    assert.equal(count(model, 'applyLease('), 7, 'declared once; called from Refresh (the views, and a fresh status first), the demo, a reply\'s status, a listed lease and a followed one');
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
    assert.equal(count(iosLeases, 'applyReplyStatus('), 4, 'declared, after Allow, after each watch, and after each revoke');
    assert.equal(count(iosLeases, '["status"]'), 3, 'a listed request\'s status, a listed lease\'s status and a reply\'s: all through verifiedMessage');
    // One early watch at most per 20 s, so a phone that is never contact does not loop.
    const iosLive = section(iosLeases, 'func openLiveLease', 'private func apply(');
    assert.match(iosLive, /let early = Leases\.isPausedForContact\(state: live\.state, reason: live\.reason\) && !earlyUsed\n\s+&& live\.contactToken != nil && live\.contactToken != lastWatchToken/);
    assert.match(iosLive, /if self\.liveViewVisible, sinceWatch >= 20 \|\| early, live\.state != "ended" \{\n\s+earlyUsed = sinceWatch < 20\n/);

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
    assert.equal(count(live, '["status"]'), 4, 'a listed request\'s status, a listed lease\'s (twice: the list, and Refresh\'s own) and a reply\'s: all through verifiedMessage or applyLease');
    // Refresh asks for a fresh status first only when the token it holds is over a minute old by the phone's running clock.
    const refresh = section(live, 'fun refreshLiveLease', 'private fun applyLease');
    assert.match(refresh, /if \(next\.state != "ended" && Leases\.tokenIsStale\(next\.contactTokenAtMs, SystemClock\.elapsedRealtime\(\)\)\) \{\n\s+val fresh = try \{\n\s+api\.leases\(\)\n/);
    assert.ok(refresh.indexOf('Leases.tokenIsStale(') < refresh.indexOf('Leases.watch('), 'before the watch is built');
    assert.match(refresh, /if \(!isStatusOnly\(entry\) \|\| entry\["node_id"\]\.str\(\) != pin\.id\) continue\n\s+val signed = .*\n\s+next = applyLease\(signed, pin, next, k\.deviceId\)/);
    assert.equal(count(apply, 'SystemClock.elapsedRealtime()'), 2, 'the token\'s age is taken when it is applied');
    assert.match(kotlin, /const val TOKEN_FRESH_MS = 60_000L/);
    assert.match(kotlin, /fun tokenIsStale\(appliedAtMs: Long\?, nowMs: Long\): Boolean = appliedAtMs == null \|\| nowMs - appliedAtMs >= TOKEN_FRESH_MS/);
  });

  // R-F5-18 (owner ruling, 2026-10-13): any enrolled phone can stop a
  // lease. Each phone learns what is running from statuses the node signs,
  // asked for with the one request it already makes for pending requests,
  // and shows a banner row with a working Stop for each, saying who granted
  // a lease this phone did not.
  it('R-F5-18: both phones list running leases from node-signed statuses, give each a Stop, and say who granted the ones they did not', () => {
    // The cores.
    const swift = read('mobile', 'ios', 'KLProtocol', 'Sources', 'KLProtocol', 'Lease.swift');
    assert.match(swift, /public static func isLive\(state: String\) -> Bool \{ state == "active" \|\| state == "suspended" \}/);
    assert.match(swift, /public static func grantedByOther\(device: String\?, name: String\?, thisDevice: String\?\) -> String\? \{\n\s+guard let device, device != thisDevice else \{ return nil \}/);
    assert.match(swift, /return "Granted by \\\(Display\.escape\(name\)\)"/);
    assert.match(swift, /self\.grantedByDevice = message\["granted_by"\]\?\["device_id"\]\?\.stringValue/);
    const kotlin = read('mobile', 'android', 'protocol', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'protocol', 'Lease.kt');
    assert.match(kotlin, /fun isLive\(state: String\): Boolean = state == "active" \|\| state == "suspended"/);
    assert.match(kotlin, /if \(device == null \|\| device == thisDevice\) return null/);
    assert.match(kotlin, /"Granted by \$\{Display\.escape\(name\)\}"/);
    assert.match(kotlin, /m\["contact_token"\]\.str\(\), m\["granted_by"\]\["device_id"\]\.str\(\), m\["granted_by"\]\["name"\]\.str\(\)/);

    // iOS.
    const ios = read('mobile', 'ios', 'App', 'AppModel.swift');
    const iosLeases = section(ios, '// MARK: Leases (fleet stage 5)', '// MARK: Leases end');
    const listed = section(iosLeases, 'private func noteListedLease', '\n    }\n');
    // Only a status the pinned node it is listed under signed; then by seq, and gone once the node says ended.
    assert.match(listed, /guard let nodeId = entry\["node_id"\]\?\.stringValue, let pin = state\.nodes\.first\(where: \{ \$0\.id == nodeId \}\),\n\s+let json = entry\["status"\], let signed = try\? Envelope\(json: json\),\n\s+let message = Leases\.verifiedMessage\(signed, pin: pin\), let status = LeaseStatus\(message: message\) else \{ return \}/);
    assert.match(listed, /apply\(signed, pin: pin, deviceId: deviceId, to: &live\)/);
    assert.match(listed, /guard Leases\.acceptsStatus\(status, appliedSeq: known\.map \{ runningLeases\[\$0\]\.appliedSeq \} \?\? 0\) else \{ return \}/);
    assert.match(listed, /guard Leases\.isLive\(state: status\.state\) \|\| mayStart else \{\n\s+if status\.state == "ended" \{ signedLeaseGrants\[status\.leaseId\] = nil \}\n\s+return\n\s+\}/);
    assert.ok(listed.indexOf('Leases.verifiedMessage(') < listed.indexOf('runningLeases.append('));
    // It comes with the one list request, and only from entries that carry no request.
    const refreshIos = section(iosLeases, 'func refreshLeases', 'func decideLease');
    assert.match(refreshIos, /if entry\["envelope"\]\?\.isNull \?\? true \{\n\s+noteListedLease\(entry, deviceId: key\.deviceId\)\n\s+continue\n\s+\}/);
    assert.equal(count(iosLeases, 'client.leases('), 1, 'one request lists both');
    assert.equal(count(iosLeases, 'runningLeases.append('), 2, 'a listed lease, and the lease that was on the live screen when another is followed');
    // On opening the app: only with a session already unlocked, never a prompt of its own.
    const open = section(iosLeases, 'func loadLeasesWhenUnlocked', '\n    }\n');
    assert.match(open, /if key\.isSessionUnlocked \{\n\s+await self\.refreshLeases\(onlyIfUnlocked: true\)\n\s+return\n\s+\}/);
    none(open, ['signEnvelope', 'unlockSession', 'refreshLeases()'], 'loadLeasesWhenUnlocked');
    assert.match(ios, /if mode == \.live, !pairing \{ loadLeasesWhenUnlocked\(\) \}/);
    // Stop from a banner row: the lease is followed, then the kill switch as always (a fresh Face ID over the revoke).
    const stop = section(iosLeases, 'func stopLease', '\n    }\n');
    assert.match(stop, /follow\(lease\)\n\s+await killSwitch\(\)/);
    const follow = section(iosLeases, 'private func follow', '\n    }\n');
    assert.match(follow, /apply\(signed, pin: pin, deviceId: key\.deviceId, to: &live\)/);
    assert.match(follow, /runningLeases\.append\(runningRow\(old\)\)/);
    const kill = section(iosLeases, 'func killSwitch', '// Demo:');
    assert.equal(count(kill, 'key.signEnvelope('), 1);
    none(kill, ['grantedBy', 'deviceId ==', 'deviceId !='], 'killSwitch (no check that this phone granted the lease)');
    assert.match(kill, /if reply\?\["state"\]\?\.stringValue == "rejected" \{/);
    // The banner: one row for each, and who granted the ones this phone did not.
    const views = read('mobile', 'ios', 'App', 'LeaseViews.swift');
    const banner = views.slice(views.indexOf('struct LeaseBanner'));
    assert.match(banner, /ForEach\(model\.bannerLeases\) \{ lease in/);
    assert.match(banner, /Button\("Stop", role: \.destructive\) \{ Task \{ await model\.stopLease\(lease\) \} \}/);
    assert.match(banner, /if let by = model\.grantedByOtherText\(device: lease\.grantedByDevice, name: lease\.grantedByName\) \{/);
    assert.match(banner, /\.sheet\(isPresented: \$model\.showLiveLease\)/);
    assert.match(iosLeases, /if let live = liveLease, live\.state != "ended" \{ rows\.append\(runningRow\(live\)\) \}\n\s+rows\.append\(contentsOf: runningLeases\.filter \{ \$0\.leaseId != liveLease\?\.leaseId \}\)/);
    assert.match(views, /if let by = model\.grantedByOtherText\(device: live\.grantedByDevice, name: live\.grantedByName\) \{ Text\(by\)/);

    // Android: the same, on the owner's tap only.
    const kt = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];
    const android = read(...kt, 'AppModel.kt');
    const live = section(android, '// ---- Leases (fleet stage 5) ----', '// ---- Leases: demo ----');
    const note = section(live, 'private fun noteListedLease', '\n    }\n');
    assert.match(note, /if \(!isStatusOnly\(entry\)\) return\n\s+val pin = pins\.firstOrNull \{ it\.id == entry\["node_id"\]\.str\(\) \} \?: return/);
    assert.match(note, /val status = Leases\.verifiedMessage\(signed, pin\)\?\.let \{ LeaseStatus\.from\(it\) \} \?: return/);
    assert.match(note, /liveLease = applyLease\(signed, pin, live, deviceId \?: ""\)/);
    assert.match(note, /if \(!Leases\.acceptsStatus\(status, if \(known >= 0\) runningLeases\[known\]\.appliedSeq else 0\)\) return/);
    assert.match(note, /if \(!Leases\.isLive\(status\.state\) && !Leases\.mayStillStart\(status\.state, status\.leaseId in signedLeaseGrants\)\) \{\n\s+if \(status\.state == "ended"\) signedLeaseGrants\.remove\(status\.leaseId\)\n\s+return\n\s+\}/);
    assert.ok(note.indexOf('Leases.verifiedMessage(') < note.indexOf('runningLeases.add('));
    const refreshAndroid = section(live, 'fun refreshLeases', 'private fun verifiedLeaseRequest');
    assert.match(refreshAndroid, /val listed = api\.leases\(nonce\)\n/, 'R-F5-20: the list request carries this request\'s nonce');
    assert.match(refreshAndroid, /for \(entry in listed\) noteListedLease\(entry, pins\)/);
    assert.equal(count(refreshAndroid, 'api.'), 1, 'one request, one prompt, for the requests and for what is running');
    // The list is declared where init can reach it, like leaseRequests.
    assert.ok(android.indexOf('val runningLeases = mutableStateListOf<RunningLease>()') < android.indexOf('\n    init {'));
    // Stop from a banner row: followed, then the same Stop as always.
    const stopRow = section(live, 'fun stopRunningLease', '\n    }\n');
    assert.match(stopRow, /followRunningLease\(lease\)\n\s+if \(liveLease\?\.leaseId == lease\.leaseId\) killSwitch\(\)/);
    const followRow = section(live, 'private fun followRunningLease', '\n    }\n');
    none(followRow, ['api.', 'scope.launch', 'signEnvelope'], 'followRunningLease (it fetches and sends nothing)');
    assert.match(followRow, /liveLease = if \(lease\.status != null\) applyLease\(lease\.status, pin, opened, deviceId \?: ""\) else opened/);
    const killAndroid = live.slice(live.indexOf('fun killSwitch'));
    none(killAndroid, ['grantedBy'], 'killSwitch (no check that this phone granted the lease)');
    const screens = read(...kt, 'LeaseScreens.kt');
    const bannerKt = screens.slice(screens.indexOf('fun LeaseBanner'));
    assert.match(bannerKt, /for \(lease in model\.runningLeases\) \{/);
    assert.match(bannerKt, /Button\(\{ model\.stopRunningLease\(lease\) \}, colors = /);
    assert.equal(count(bannerKt, 'Leases.grantedByOther('), 2, 'the lease on the live screen, and each listed one');
    assert.match(screens, /val grantedByOther = Leases\.grantedByOther\(live\.grantedByDevice, live\.grantedByName, model\.deviceId\)/);
    none(screens, ['LaunchedEffect', 'DisposableEffect', 'SideEffect', 'produceState', 'rememberCoroutineScope', 'delay(', 'while (', 'ticker('], 'LeaseScreens.kt');
  });

  // R-F5-20 (owner ruling, 2026-10-13): a relay cannot hide a live lease
  // from a phone. Each list request carries a fresh nonce; a node's answer
  // counts only as a listing it signed over that nonce for this phone, with
  // a signed status for every lease it names. A pinned node without one is
  // shown as "Could not confirm with <node>", never as nothing running.
  it('R-F5-20: both phones ask with a fresh nonce, take a node\'s listing whole or not at all, and say "Could not confirm with" for the rest', () => {
    // The cores: the check, in the order of verifyLeaseListing (src/gui/lease-protocol.js).
    const swift = read('mobile', 'ios', 'KLProtocol', 'Sources', 'KLProtocol', 'Lease.swift');
    const verifySwift = section(swift, 'public static func verifyListing', '\n    }\n');
    const inOrder = (text, needles, where) => {
      let at = -1;
      for (const n of needles) {
        const next = text.indexOf(n, at + 1);
        assert.ok(next > at, `"${n}" in ${where}, after the check before it`);
        at = next;
      }
    };
    inOrder(verifySwift, ['envelope.kid == pin.id', 'envelope.verifyEd25519(spkiHex: pin.key)', 'isListing(m)', 'm["node_id"]?.stringValue == pin.id',
      'signedNonce == nonce', 'toDevice == deviceId', 'verifiedMessage(candidate, pin: pin)', '$0.status.leaseId == leaseId && $0.status.seq == seq', 'accepted: true'], 'verifyListing (Swift)');
    assert.match(verifySwift, /guard !nonce\.isEmpty, signedNonce == nonce else \{ return refused\("nonce_mismatch"\) \}/);
    assert.match(verifySwift, /else \{ return refused\("status_missing"\) \}/);
    assert.equal(count(verifySwift, 'accepted: true'), 1, 'one way to be accepted');
    const checkSwift = section(swift, 'public static func checkListing', '\n    }\n');
    assert.match(checkSwift, /for entry in entries where entry\["node_id"\]\?\.stringValue == pin\.id && \(entry\["envelope"\]\?\.isNull \?\? true\) \{/);
    assert.match(checkSwift, /guard let listing else \{ return ListingCheck\(accepted: false, reason: "no_listing", statuses: \[\]\) \}\n\s+return verifyListing\(listing, pin: pin, nonce: nonce, deviceId: deviceId, statuses: statuses\)/);
    assert.match(swift, /public static func couldNotConfirm\(nodeName: String\) -> String \{ "Could not confirm with \\\(Display\.escape\(nodeName\)\)" \}/);

    const kotlin = read('mobile', 'android', 'protocol', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'protocol', 'Lease.kt');
    const verifyKotlin = section(kotlin, 'fun verifyListing', '\n    }\n');
    inOrder(verifyKotlin, ['envelope.kid != pin.id', '!envelope.verifyEd25519(pin.key)', '!isListing(m)', 'm["node_id"].str() != pin.id',
      'signedNonce != nonce', 'toDevice != deviceId', 'verifiedMessage(candidate, pin)', 'it.first.leaseId == leaseId && it.first.seq == seq', 'ListingCheck(true, null, listed)'], 'verifyListing (Kotlin)');
    assert.match(verifyKotlin, /if \(nonce\.isEmpty\(\) \|\| signedNonce != nonce\) return refused\("nonce_mismatch"\)/);
    assert.match(verifyKotlin, /\?: return refused\("status_missing"\)/);
    assert.equal(count(verifyKotlin, 'ListingCheck(true'), 1, 'one way to be accepted');
    const checkKotlin = section(kotlin, 'fun checkListing', '\n    }\n');
    assert.match(checkKotlin, /entry\["node_id"\]\.str\(\) == pin\.id && entry\["envelope"\]\.let \{ it == null \|\| it is JsonNull \}/);
    assert.match(checkKotlin, /\?: return ListingCheck\(false, "no_listing", emptyList\(\)\)\n\s+return verifyListing\(listing, pin, nonce, deviceId, /);
    assert.match(kotlin, /fun couldNotConfirm\(nodeName: String\): String = "Could not confirm with \$\{Display\.escape\(nodeName\)\}"/);
    // Neither core has words for "nothing is running" to show in its place.
    for (const core of [swift, kotlin]) none(core, ['No computer-use', 'Nothing is running', 'No leases'], 'the lease core');

    // iOS: a fresh nonce for each list request, in the request it signs; every pinned node is checked against it.
    const ios = read('mobile', 'ios', 'App', 'AppModel.swift');
    const iosLeases = section(ios, '// MARK: Leases (fleet stage 5)', '// MARK: Leases end');
    const refreshIos = section(iosLeases, 'func refreshLeases', 'func decideLease');
    assert.match(refreshIos, /let nonce = Messages\.randomNonce\(\)\n\s+let entries = try await client\.leases\(nonce: nonce, signWith: onlyIfUnlocked \? Self\.sessionOnlySigner\(key\) : nil\)/);
    assert.equal(count(refreshIos, 'Messages.randomNonce()'), 1);
    // Every pinned node is checked: confirmed only by a listing that was accepted, else unconfirmed.
    assert.match(refreshIos, /for pin in state\.nodes \{\n\s+let check = Leases\.checkListing\(entries, pin: pin, nonce: nonce, deviceId: key\.deviceId\)\n\s+guard check\.accepted else \{ checks\[pin\.id\] = \.unconfirmed; continue \}/);
    // A request that fails confirms nothing; a locked session asks nothing and changes nothing.
    assert.match(refreshIos, /\} catch is SessionLocked \{\n(?:\s+\/\/[^\n]*\n)+\s+\} catch \{\n\s+\/\/ No reply at all: nothing was confirmed with any node\.\n\s+var none: \[String: LeaseNodeCheck\] = \[:\]\n\s+for pin in state\.nodes \{ none\[pin\.id\] = \.unconfirmed \}\n\s+leaseChecks = none\n\s+fail\(error\)/);
    assert.equal(count(iosLeases, 'leaseChecks = '), 2, 'set from the check, and from a request that failed; nowhere else');
    assert.match(read('mobile', 'ios', 'App', 'RelayAPI.swift'), /func leases\(wait: Int = 0, nonce: String, signWith: Signer\? = nil\) async throws -> \[JSONValue\] \{\n\s+try await request\("GET", "\/v1\/leases\?wait=\\\(wait\)&nonce=\\\(nonce\)", signWith: signWith\)/);
    // The banner, on every tab: one row for each such node.
    const views = read('mobile', 'ios', 'App', 'LeaseViews.swift');
    const banner = views.slice(views.indexOf('struct LeaseBanner'));
    assert.match(banner, /if !model\.unconfirmedLeaseRows\.isEmpty \{/);
    assert.match(banner, /ForEach\(model\.unconfirmedLeaseRows\) \{ row in\n\s+Text\(model\.leaseCheckText\(row\)\)/);
    assert.match(iosLeases, /var unconfirmedLeaseRows: \[LeaseCheckRow\] \{ leaseCheckRows\.filter \{ \$0\.check == \.unconfirmed \} \}/);
    assert.match(iosLeases, /case \.some\(\.unconfirmed\):\n\s+return Leases\.couldNotConfirm\(nodeName: row\.nodeName\)/);
    assert.match(banner, /Text\(Leases\.couldNotConfirmDetail\)/);
    none(views, ['No computer-use', 'Nothing is running', 'No leases'], 'LeaseViews.swift');

    // Android: the same, on the owner's tap only, in the one request that tap already made.
    const kt = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];
    const android = read(...kt, 'AppModel.kt');
    const live = section(android, '// ---- Leases (fleet stage 5) ----', '// ---- Leases: demo ----');
    const refreshAndroid = section(live, 'fun refreshLeases', 'private fun verifiedLeaseRequest');
    assert.match(refreshAndroid, /val nonce = Messages\.randomNonce\(\)\n\s+val listed = api\.leases\(nonce\)\n/);
    assert.equal(count(refreshAndroid, 'api.'), 1, 'R-F5-1, R-F5-5: still one request, one prompt, sent once');
    assert.match(refreshAndroid, /for \(pin in pins\) \{\n\s+val check = Leases\.checkListing\(listed, pin, nonce, deviceId \?: ""\)\n\s+leaseChecks\[pin\.id\] = if \(check\.accepted\) \{/);
    assert.match(refreshAndroid, /\} else \{\n\s+LeaseNodeCheck\.Unconfirmed\n\s+\}/);
    assert.match(refreshAndroid, /\} catch \(e: Exception\) \{\n\s+\/\/ No reply at all: nothing was confirmed with any node\.\n\s+for \(pin in storage\.nodes\) leaseChecks\[pin\.id\] = LeaseNodeCheck\.Unconfirmed\n\s+fail\(e\)/);
    assert.equal(count(live, 'leaseChecks[pin.id] = '), 2, 'from the check, and from a request that failed; nowhere else');
    assert.ok(android.indexOf('val leaseChecks = mutableStateMapOf<String, LeaseNodeCheck>()') < android.indexOf('\n    init {'));
    const api = read(...kt, 'RelayApi.kt');
    assert.match(api, /suspend fun leases\(nonce: String\? = null\): List<JsonElement> =\n\s+request\("GET", if \(nonce == null\) "\/v1\/leases\?wait=0" else "\/v1\/leases\?wait=0&nonce=\$nonce"\)/);
    const screens = read(...kt, 'LeaseScreens.kt');
    const pending = section(screens, 'fun LeaseRequests(', '\n}\n');
    assert.match(pending, /is AppModel\.LeaseNodeCheck\.Unconfirmed -> Text\(Leases\.couldNotConfirm\(pin\.name\), /);
    assert.match(pending, /if \(model\.nodes\.any \{ model\.leaseChecks\[it\.id\] is AppModel\.LeaseNodeCheck\.Unconfirmed \}\) Text\(Leases\.COULD_NOT_CONFIRM_DETAIL \+ /);
    none(screens, ['No computer-use', 'Nothing is running', 'No leases'], 'LeaseScreens.kt');
  });

  // Fourth security review, finding 4: both phone cores check a listing's
  // shape as the node's validator does (VALIDATORS['kl.lease.listing'] in
  // src/gui/lease-protocol.js), after the signature and before they read
  // anything from it; the listing vectors for it are run by both.
  it('finding 4: both cores check a listing\'s whole shape (exact keys, a real `at`, at most eight leases, each once) and run every listing vector', () => {
    const L = require('../src/gui/lease-protocol');
    const swift = read('mobile', 'ios', 'KLProtocol', 'Sources', 'KLProtocol', 'Lease.swift');
    const kotlin = read('mobile', 'android', 'protocol', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'protocol', 'Lease.kt');
    assert.equal(L.LISTING_MAX, 8);
    assert.match(swift, /public static let listingMax = 8\n/);
    assert.match(kotlin, /const val LISTING_MAX = 8\n/);
    const shapeSwift = section(swift, 'static func isListing(_ message: JSONValue) -> Bool', '\n    }\n');
    for (const needle of ['Rules.hasExactKeys(m, ["v", "type", "node_id", "to_device", "nonce", "at", "leases"])', 'm["v"]?.intValue == 1', 'm["type"]?.stringValue == "kl.lease.listing"',
      'Rules.isNodeId(m["node_id"])', 'Rules.isDeviceId(m["to_device"])', 'Rules.isNonce(m["nonce"])', 'Rules.isTimestamp(m["at"])', 'leases.count <= listingMax',
      'Rules.hasExactKeys(e, ["lease_id", "seq"])', 'Rules.isUuidV4(e["lease_id"])', 'Rules.isInteger(seq)', 'n >= 1', 'seen.insert(leaseId).inserted']) {
      assert.ok(shapeSwift.includes(needle), `${needle} in isListing (Swift)`);
    }
    const shapeKotlin = section(kotlin, 'internal fun isListing(message: JsonElement): Boolean', '\n    }\n');
    for (const needle of ['Rules.hasExactKeys(m, listOf("v", "type", "node_id", "to_device", "nonce", "at", "leases"))', 'm["v"].int() != 1', 'm["type"].str() != "kl.lease.listing"',
      '!Rules.isNodeId(m["node_id"])', '!Rules.isDeviceId(m["to_device"])', '!Rules.isNonce(m["nonce"])', '!Rules.isTimestamp(m["at"])', 'leases.size > LISTING_MAX',
      '!Rules.hasExactKeys(e, listOf("lease_id", "seq"))', '!Rules.isUuidV4(e["lease_id"])', '!Rules.isInteger(seq)', '(seq.int() ?: 0) < 1', '!seen.add(leaseId)']) {
      assert.ok(shapeKotlin.includes(needle), `${needle} in isListing (Kotlin)`);
    }
    // It refuses as "malformed", as the node's check does.
    assert.match(section(swift, 'public static func verifyListing', '\n    }\n'), /guard let m = try\? envelope\.message\(\), isListing\(m\),\n[^\n]+\n[^\n]+else \{ return refused\("malformed"\) \}/);
    assert.match(section(kotlin, 'fun verifyListing', '\n    }\n'), /if \(!isListing\(m\)\) return refused\("malformed"\)/);
    // Both cores' vector tests name every listing vector the generator marks for phones, and no other.
    const dir = path.join(ROOT, 'tests', 'vectors', 'lease-v1');
    const listing = fs.readdirSync(dir).filter((f) => f.startsWith('listing-')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    assert.equal(listing.length, 14);
    for (const v of listing) assert.deepEqual(v.consumers.slice().sort(), ['android', 'ios', 'node'], v.name);
    const names = listing.map((v) => v.name).sort();
    const swiftTests = read('mobile', 'ios', 'KLProtocol', 'Tests', 'KLProtocolTests', 'LeaseVectorTests.swift');
    const kotlinTests = read('mobile', 'android', 'protocol', 'src', 'test', 'kotlin', 'com', 'example', 'kinglouie', 'protocol', 'LeaseVectorTest.kt');
    const namedIn = (text) => [...new Set(text.match(/"listing-[a-z-]+"/g).map((s) => s.slice(1, -1)))].sort();
    assert.deepEqual(namedIn(section(swiftTests, 'static let listingVectors = [', ']')), names);
    assert.deepEqual(namedIn(section(kotlinTests, 'private val listingVectors = setOf(', ')')), names);
    assert.deepEqual(namedIn(section(swiftTests, 'func testEveryIosVectorIsCovered', '\n    }\n')), names);
    assert.match(swiftTests, /func testListingShape\(\) throws \{/);
    assert.match(kotlinTests, /fun listingShape\(\) \{/);
  });

  // Fourth security review, finding 2. "Never asked" used to look the same
  // as "the node signed that nothing is running": both were an empty
  // screen. Each pinned node now has one of three states, each said as what
  // it is: not asked yet; checked at a time, with what it listed; could not
  // confirm. Only an accepted listing gives the second, and it always
  // carries the time this phone accepted it.
  it('finding 2: per node, "not checked yet", "checked <node> at <time>: …" and "could not confirm" are three different things on both phones', () => {
    const swift = read('mobile', 'ios', 'KLProtocol', 'Sources', 'KLProtocol', 'Lease.swift');
    const kotlin = read('mobile', 'android', 'protocol', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'protocol', 'Lease.kt');
    // The words, once in each core. "no computer-use session" exists only inside the sentence that names the time.
    assert.match(swift, /public static func notCheckedYet\(nodeName: String\) -> String \{ "Not checked yet: \\\(Display\.escape\(nodeName\)\)" \}/);
    assert.match(kotlin, /fun notCheckedYet\(nodeName: String\): String = "Not checked yet: \$\{Display\.escape\(nodeName\)\}"/);
    const checkedSwift = section(swift, 'public static func checked(nodeName: String, at time: String, running: Int, waiting: Int)', '\n    }\n');
    assert.match(checkedSwift, /running == 0 \? "no computer-use session" : /);
    assert.match(checkedSwift, /return "Checked \\\(Display\.escape\(nodeName\)\) at \\\(time\): \\\(sessions\)\\\(requests\)"/);
    const checkedKotlin = section(kotlin, 'fun checked(nodeName: String, time: String, running: Int, waiting: Int)', '\n    }\n');
    assert.match(checkedKotlin, /if \(running == 0\) "no computer-use session" else /);
    assert.match(checkedKotlin, /return "Checked \$\{Display\.escape\(nodeName\)\} at \$time: \$sessions\$requests"/);
    for (const core of [swift, kotlin]) assert.equal(count(core, 'no computer-use session'), 1, 'only in the sentence that says when it was checked');
    // What a listing listed is read only from one that was accepted.
    assert.match(swift, /public static func listedStatuses\(_ check: ListingCheck, pin: NodePin\) -> \[LeaseStatus\] \{\n\s+guard check\.accepted else \{ return \[\] \}/);
    assert.match(kotlin, /fun listedStatuses\(check: ListingCheck, pin: NodePin\): List<LeaseStatus> =\n\s+if \(!check\.accepted\) emptyList\(\) else /);

    // iOS: the state per node; absent means not asked.
    const ios = read('mobile', 'ios', 'App', 'AppModel.swift');
    const iosLeases = section(ios, '// MARK: Leases (fleet stage 5)', '// MARK: Leases end');
    assert.match(iosLeases, /enum LeaseNodeCheck: Equatable \{\n\s+case confirmed\(at: Date, running: Int, waiting: Int\)\n\s+case unconfirmed\n\s+\}/);
    assert.match(iosLeases, /@Published var leaseChecks: \[String: LeaseNodeCheck\] = \[:\]/);
    const refreshIos = section(iosLeases, 'func refreshLeases', 'func decideLease');
    // Confirmed: one place, after the check accepted, with this phone's clock and what the node listed.
    assert.equal(count(ios, '.confirmed(at: '), 1, 'one way to be confirmed');
    const inOrder = (text, needles) => { let at = -1; for (const n of needles) { const next = text.indexOf(n, at + 1); assert.ok(next > at, `"${n}" after the one before it`); at = next; } };
    inOrder(refreshIos, ['let checkedAt = Date()', 'guard check.accepted else { checks[pin.id] = .unconfirmed; continue }', 'let listed = Leases.listedStatuses(check, pin: pin)',
      'checks[pin.id] = .confirmed(at: checkedAt, running: listed.filter { Leases.isLive(state: $0.state) }.count,', 'waiting: listed.filter { $0.state == "pending" }.count)', 'leaseChecks = checks']);
    // The words of a row: nothing asked is "not checked yet"; a confirmed row always shows its time (and its
    // date when that was not today), so a session that lapsed does not leave an old answer looking current.
    const text = section(iosLeases, 'func leaseCheckText', '\n    }\n');
    assert.match(text, /case \.none:\n\s+return Leases\.notCheckedYet\(nodeName: row\.nodeName\)/);
    assert.match(text, /case \.some\(\.confirmed\(let at, let running, let waiting\)\):\n\s+let time = at\.formatted\(date: Calendar\.current\.isDateInToday\(at\) \? \.omitted : \.abbreviated, time: \.shortened\)\n\s+return Leases\.checked\(nodeName: row\.nodeName, at: time, running: running, waiting: waiting\)/);
    assert.equal(count(ios, 'Leases.checked('), 1);
    // A locked session writes nothing: the catch holds comments only.
    assert.match(refreshIos, /\} catch is SessionLocked \{\n(?:\s+\/\/[^\n]*\n)+\s+\} catch \{/);
    assert.equal(count(ios, 'leaseChecks = [:]'), 2, 'emptied when the phone is unpaired or reset');
    // The screen: every pinned node has a line; the first two states in the Computer use section, the third in the banner.
    const views = read('mobile', 'ios', 'App', 'LeaseViews.swift');
    const requests = section(views, 'struct LeaseRequestsSection', '\nstruct LeaseRequestView');
    assert.match(requests, /if !model\.leaseRequests\.isEmpty \|\| !model\.leaseStatusRows\.isEmpty \{/);
    assert.match(requests, /ForEach\(model\.leaseStatusRows\) \{ row in\n\s+Text\(model\.leaseCheckText\(row\)\)/);
    assert.match(requests, /if model\.leaseStatusRows\.contains\(where: \{ \$0\.check == nil \}\) \{\n\s+Text\(Leases\.notCheckedYetDetail\)/);
    assert.match(iosLeases, /var leaseStatusRows: \[LeaseCheckRow\] \{ leaseCheckRows\.filter \{ \$0\.check != \.unconfirmed \} \}/);
    assert.match(iosLeases, /return state\.nodes\.map \{ LeaseCheckRow\(id: \$0\.id, nodeName: \$0\.name, check: leaseChecks\[\$0\.id\]\) \}/);

    // Android: the same three, written only on the owner's tap.
    const kt = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];
    const android = read(...kt, 'AppModel.kt');
    const live = section(android, '// ---- Leases (fleet stage 5) ----', '// ---- Leases: demo ----');
    assert.match(live, /sealed class LeaseNodeCheck \{/);
    assert.match(live, /data class Confirmed\(val atMs: Long, val running: Int, val waiting: Int\) : LeaseNodeCheck\(\)/);
    assert.match(live, /object Unconfirmed : LeaseNodeCheck\(\)/);
    const refreshAndroid = section(live, 'fun refreshLeases', 'private fun verifiedLeaseRequest');
    assert.equal(count(android, 'LeaseNodeCheck.Confirmed('), 1, 'one way to be confirmed');
    inOrder(refreshAndroid, ['val checkedAt = System.currentTimeMillis()', 'leaseChecks[pin.id] = if (check.accepted) {', 'val named = Leases.listedStatuses(check, pin)',
      'LeaseNodeCheck.Confirmed(checkedAt, named.count { Leases.isLive(it.state) }, named.count { it.state == "pending" })']);
    // Nothing but that tap's function writes an entry; unpairing and reset empty the map.
    assert.equal(count(android, 'leaseChecks['), 2);
    assert.equal(count(android, 'leaseChecks.clear()'), 2);
    assert.equal(count(android.replace(refreshAndroid, ''), 'leaseChecks['), 0, 'written only by refreshLeases (R-F5-1: on the owner\'s tap)');
    const screens = read(...kt, 'LeaseScreens.kt');
    const pending = section(screens, 'fun LeaseRequests(', '\n}\n');
    assert.match(pending, /for \(pin in model\.nodes\) \{\n\s+when \(val check = model\.leaseChecks\[pin\.id\]\) \{\n\s+null -> Text\(Leases\.notCheckedYet\(pin\.name\)\)/);
    assert.match(pending, /is AppModel\.LeaseNodeCheck\.Confirmed ->\n\s+Text\(Leases\.checked\(pin\.name, DateFormat\.getDateTimeInstance\(DateFormat\.SHORT, DateFormat\.SHORT\)\.format\(Date\(check\.atMs\)\), check\.running, check\.waiting\)\)/);
    assert.match(pending, /if \(model\.nodes\.any \{ model\.leaseChecks\[it\.id\] == null \}\) Text\(Leases\.NOT_CHECKED_YET_DETAIL \+ /);
    assert.equal(count(screens, 'Leases.checked('), 1);
  });

  // Fourth security review, finding 3. A relay can answer a grant with 503
  // and deliver it just after a verified listing; the lease was "pending"
  // then, which is not "live", so the phone showed nothing running. A lease
  // this phone signed a grant for that its node lists as pending is now a
  // row that says "May still start", with the same Stop as any other row
  // (a revoke the phone signs; any enrolled phone may stop, R-F5-18). The
  // row goes when the node signs that the lease ended, or when a listing
  // that was accepted no longer names it after the request has expired.
  it('finding 3: a pending lease this phone signed a grant for is shown as "May still start", with a working Stop, until a signed word says it cannot', () => {
    const swift = read('mobile', 'ios', 'KLProtocol', 'Sources', 'KLProtocol', 'Lease.swift');
    const kotlin = read('mobile', 'android', 'protocol', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'protocol', 'Lease.kt');
    assert.match(swift, /public static func mayStillStart\(state: String, signedGrant: Bool\) -> Bool \{ state == "pending" && signedGrant \}/);
    assert.match(kotlin, /fun mayStillStart\(state: String, signedGrant: Boolean\): Boolean = state == "pending" && signedGrant/);
    assert.match(swift, /public static func mayStillStartTitle\(nodeName: String\) -> String \{ "May still start on \\\(Display\.escape\(nodeName\)\)" \}/);
    assert.match(kotlin, /fun mayStillStartTitle\(nodeName: String\): String = "May still start on \$\{Display\.escape\(nodeName\)\}"/);
    // Absent from an accepted listing: gone only once the request has expired. Named: kept only while still pending.
    assert.match(swift, /public static func keepsMayStart\(listedState: String\?, requestExpired: Bool\) -> Bool \{\n\s+guard let listedState else \{ return !requestExpired \}\n\s+return listedState == "pending"\n\s+\}/);
    assert.match(kotlin, /fun keepsMayStart\(listedState: String\?, requestExpired: Boolean\): Boolean = if \(listedState == null\) !requestExpired else listedState == "pending"/);

    // iOS.
    const ios = read('mobile', 'ios', 'App', 'AppModel.swift');
    const iosLeases = section(ios, '// MARK: Leases (fleet stage 5)', '// MARK: Leases end');
    // The grant is remembered once it is signed, before it is sent: whatever the relay then answers.
    const decideIos = section(iosLeases, 'func decideLease', '\n    }\n');
    assert.ok(decideIos.indexOf('envelope = try await key.signEnvelope(message, reason: "Allow computer use') < decideIos.indexOf('signedLeaseGrants[item.request.leaseId] = '));
    assert.ok(decideIos.indexOf('signedLeaseGrants[item.request.leaseId] = ') < decideIos.indexOf('client.leaseDecision("grant"'));
    assert.equal(count(decideIos, 'signedLeaseGrants['), 1, 'for a grant only, never a deny');
    // A status its node signed: live, or pending with a grant this phone signed, gets a row; "ended" forgets the grant.
    const noteIos = section(iosLeases, 'private func noteListedLease', '\n    }\n');
    assert.match(noteIos, /let mayStart = Leases\.mayStillStart\(state: status\.state, signedGrant: signedLeaseGrants\[status\.leaseId\] != nil\)\n\s+guard Leases\.isLive\(state: status\.state\) \|\| mayStart else \{\n\s+if status\.state == "ended" \{ signedLeaseGrants\[status\.leaseId\] = nil \}\n\s+return\n\s+\}/);
    assert.ok(noteIos.indexOf('Leases.verifiedMessage(signed, pin: pin)') < noteIos.indexOf('Leases.mayStillStart('), 'only on the pinned node\'s signed word');
    // Dropped for an absence only after a listing that was accepted, and only once the request has expired on both clocks.
    const refreshIos = section(iosLeases, 'func refreshLeases', 'func decideLease');
    assert.ok(refreshIos.indexOf('guard check.accepted else { checks[pin.id] = .unconfirmed; continue }') < refreshIos.indexOf('dropMayStartRows(of: pin, named: Set(listed.map { $0.leaseId }), relayNow: client.now())'));
    assert.equal(count(iosLeases, 'dropMayStartRows('), 2, 'declared, and called from that one place');
    const dropIos = section(iosLeases, 'private func dropMayStartRows', '\n    }\n');
    assert.match(dropIos, /signedLeaseGrants\[leaseId\]\.map \{ \$0 < Date\(\) && \$0 < relayNow \} \?\? true/);
    assert.match(dropIos, /Leases\.keepsMayStart\(listedState: nil, requestExpired: expired\)/);
    assert.match(dropIos, /where row\.nodeId == pin\.id && row\.state == "pending" && !named\.contains\(row\.leaseId\)/);
    // The row: its own words, and the Stop every row has.
    assert.match(section(iosLeases, 'func bannerTitle', '\n    }\n'), /if lease\.state == "pending" \{ return Leases\.mayStillStartTitle\(nodeName: lease\.nodeName\) \}/);
    const views = read('mobile', 'ios', 'App', 'LeaseViews.swift');
    const banner = views.slice(views.indexOf('struct LeaseBanner'));
    assert.match(banner, /if lease\.state == "pending" \{ Text\(Leases\.mayStillStartDetail\)/);
    assert.match(banner, /Button\("Stop", role: \.destructive\) \{ Task \{ await model\.stopLease\(lease\) \} \}/);
    // Stop is the owner's tap and nothing else: no revoke is built anywhere but in killSwitch (no automatic revoke after an unconfirmed grant).
    assert.equal(count(ios, 'Leases.revoke('), 1);
    assert.equal(count(ios, 'signedLeaseGrants = [:]'), 2, 'emptied when the phone is unpaired or reset');

    // Android: the same, and nothing by itself (R-F5-5).
    const kt = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];
    const android = read(...kt, 'AppModel.kt');
    const live = section(android, '// ---- Leases (fleet stage 5) ----', '// ---- Leases: demo ----');
    const decide = section(live, 'fun decideLease', '\n    }\n');
    assert.match(decide, /if \(grant\) signedLeaseGrants\[item\.request\.leaseId\] = Timestamps\.epochMillis\(item\.request\.expiresAt\) \?: Long\.MAX_VALUE\n\s+val sent = sendLease\(api, "grant", /);
    assert.equal(count(decide, 'sendLease('), 1, 'R-F5-5: the grant is still sent once');
    const note = section(live, 'private fun noteListedLease', '\n    }\n');
    assert.match(note, /if \(!Leases\.isLive\(status\.state\) && !Leases\.mayStillStart\(status\.state, status\.leaseId in signedLeaseGrants\)\) \{\n\s+if \(status\.state == "ended"\) signedLeaseGrants\.remove\(status\.leaseId\)\n\s+return\n\s+\}/);
    const refreshAndroid = section(live, 'fun refreshLeases', 'private fun verifiedLeaseRequest');
    assert.match(refreshAndroid, /leaseChecks\[pin\.id\] = if \(check\.accepted\) \{\n\s+val named = Leases\.listedStatuses\(check, pin\)\n\s+dropMayStartRows\(pin, named\.map \{ it\.leaseId \}\.toSet\(\), api\)/);
    assert.equal(count(live, 'dropMayStartRows('), 2, 'declared, and called from that one place');
    const drop = section(live, 'private fun dropMayStartRows', '\n    }\n');
    assert.match(drop, /val relayNowMs = api\.now\(\)\.toEpochMilli\(\)/);
    assert.equal(count(drop, 'api.'), 1, 'the relay-corrected clock, and no request');
    assert.match(drop, /val expired = expires == null \|\| \(expires < System\.currentTimeMillis\(\) && expires < relayNowMs\)\n\s+return !Leases\.keepsMayStart\(null, expired\)/);
    assert.match(drop, /it\.nodeId == pin\.id && it\.state == "pending" && gone\(it\.leaseId\)/);
    // The drop sends nothing and signs nothing; neither does anything else outside a tap.
    none(drop, ['api.lease', 'sendLease(', 'signEnvelope(', 'killSwitch(', 'scope.launch'], 'dropMayStartRows');
    assert.equal(count(android, 'Leases.revoke('), 1, 'a revoke is built only by "Stop now", on the owner\'s tap: no automatic revoke');
    assert.equal(count(live, 'scope.launch'), 4, 'still one coroutine per tap');
    const screens = read(...kt, 'LeaseScreens.kt');
    const bannerKt = screens.slice(screens.indexOf('fun LeaseBanner('));
    assert.equal(count(bannerKt, 'Leases.mayStillStartTitle('), 2, 'the row of the lease on the live screen, and the rows of the others');
    assert.equal(count(bannerKt, 'Leases.MAY_STILL_START_DETAIL'), 2);
    assert.match(bannerKt, /Button\(\{ model\.stopRunningLease\(lease\) \}/);
    assert.equal(count(android, 'signedLeaseGrants.clear()'), 2);
  });

  // R-F5-19 (owner ruling, 2026-10-13): iOS watches only while the live
  // view is visible, as the spec says. Closing the live lease sheet or
  // backgrounding the app stops the watch; the banner and Stop stay. The
  // lease then pauses after the contact window (R-F5-15) and continues
  // when the view is opened again, and the banner says so. This fails if a
  // watch can be sent while the live view is not visible.
  it('R-F5-19: iOS sends a watch only while the live view is visible; the banner says "Paused: open to let it continue"', () => {
    const model = read('mobile', 'ios', 'App', 'AppModel.swift');
    const leases = section(model, '// MARK: Leases (fleet stage 5)', '// MARK: Leases end');
    const views = read('mobile', 'ios', 'App', 'LeaseViews.swift');

    // One place builds, signs and sends a watch: the loop, and only under liveViewVisible.
    assert.equal(count(model, 'Leases.watch('), 1);
    assert.equal(count(model, 'signWatchEnvelope('), 1);
    assert.equal(count(model, 'leaseDecision("watch"'), 1);
    const loop = section(leases, 'private func startLiveLoop', 'private func apply(');
    const gate = loop.indexOf('if self.liveViewVisible, sinceWatch >= 20 || early, live.state != "ended" {');
    const build = loop.indexOf('Leases.watch(');
    const sign = loop.indexOf('signWatchEnvelope(');
    const regate = loop.indexOf('if self.liveViewVisible {');
    const send = loop.indexOf('leaseDecision("watch"');
    const poll = loop.indexOf('client.leaseViews(');
    assert.ok(gate > 0 && gate < build && build < sign && sign < regate && regate < send && send < poll,
      'visible is checked before the watch is built, and again after it is signed, before it is sent');
    assert.equal(count(loop, 'self.liveViewVisible'), 2);
    // Nothing between the gate and its closing brace is outside it: the watch block ends before the poll.
    assert.match(loop, /if self\.liveViewVisible \{\n\s+do \{\n\s+let reply = try await client\.leaseDecision\("watch", leaseId: leaseId, envelope: envelope, signWith: AppModel\.sessionOnlySigner\(key\)\)/);
    // The poll for statuses goes on with the view closed, so the banner tells the truth; it signs nothing of the lease.
    none(loop.slice(poll), ['Leases.watch(', 'signWatchEnvelope(', 'leaseDecision('], 'after the poll');

    // The flag has one writer, and that writer is told only by the live view.
    assert.match(leases, /@Published private\(set\) var liveViewVisible = false/);
    assert.equal(count(model, 'liveViewVisible = '), 2, 'its declaration and setLiveViewVisible');
    const setter = section(leases, 'func setLiveViewVisible', '\n    }\n');
    assert.match(setter, /guard visible != liveViewVisible else \{ return \}\n\s+liveViewVisible = visible\n/);
    assert.equal(count(model, 'setLiveViewVisible('), 1, 'declared in the model and called from nowhere in it');
    const live = views.slice(views.indexOf('struct LiveLeaseView'), views.indexOf('struct LeaseBanner'));
    assert.equal(count(views, 'setLiveViewVisible('), 4);
    assert.equal(count(live, 'setLiveViewVisible('), 4, 'only the live view calls it');
    assert.match(live, /\.onAppear \{ model\.setLiveViewVisible\(scenePhase != \.background\) \}/);
    assert.match(live, /\.onChange\(of: scenePhase\) \{ _, phase in\n\s+if phase == \.background \{ model\.setLiveViewVisible\(false\) \} else if phase == \.active \{ model\.setLiveViewVisible\(true\) \}\n\s+\}/);
    assert.match(live, /\.onDisappear \{\n\s+model\.setLiveViewVisible\(false\)\n/);
    assert.equal(count(views, 'setLiveViewVisible(true)'), 1, 'true only when the scene is active with the view on screen');
    // The earlier departure is gone: opening a lease starts no watch by itself.
    const open = section(leases, 'func openLiveLease', 'func setLiveViewVisible');
    none(open, ['Leases.watch(', 'signWatchEnvelope(', 'liveViewVisible = true'], 'openLiveLease');
    none(model, ['until the lease\n    /// ends or is closed'], 'the old comment');

    // The banner and Stop stay with the view closed; a lease paused for want of contact says what to do.
    assert.match(leases, /if Leases\.isPausedForContact\(state: lease\.state, reason: lease\.reason\) \{\n\s+return grantedByOtherText\(device: lease\.grantedByDevice, name: lease\.grantedByName\) == nil\n\s+\? "Paused: open to let it continue \(\\\(node\)\)"/);
    const banner = views.slice(views.indexOf('struct LeaseBanner'));
    assert.match(banner, /Button\(model\.bannerTitle\(lease\)\) \{ model\.showLease\(lease\) \}/);
    assert.match(banner, /Button\("Stop", role: \.destructive\)/);
    none(banner, ['liveViewVisible', 'setLiveViewVisible'], 'the banner (it neither needs the view nor counts as it)');
    // Allow shows the live view at once (the watch needs it on screen).
    assert.match(section(leases, 'func decideLease', 'private func applyReplyStatus'), /applyReplyStatus\(result, leaseId: item\.request\.leaseId\)\n[\s\S]*?showLiveLease = true\n/);
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
  const ACTS = ['model.refreshLeases(', 'model.refreshLiveLease(', 'model.killSwitch(', 'model.decideLease(', 'model.openLiveLease(', 'model.stopRunningLease(', 'model.openRunningLease('];

  it('Android: the live lease section has no loop and no timer', () => {
    const { live, screens, leaseScreens } = android();
    none(live, ['while (', 'while(', 'do {', 'delay(', 'repeat(', 'postDelayed', 'Timer(', 'withTimeout', 'pollJob', '.retry',
      'forEach', 'generateSequence', 'tailrec', 'ticker', 'Handler(', 'schedule', 'LaunchedEffect', '.collect', 'flow {'], 'the live lease section');
    // Each `for` walks the entries one fetch returned (the views, the list, the fresh statuses before a
    // watch) or, after the one list request, the pinned nodes (what each one's listing came to; fourth
    // security review, finding 2). None of them sends anything.
    assert.equal(count(live, 'for ('), 5);
    assert.match(live, /for \(entry in entries\)/);
    assert.match(live, /for \(entry in listed\)/);
    assert.match(live, /for \(entry in fresh\)/);
    assert.match(live, /for \(pin in pins\) \{\n\s+val check = Leases\.checkListing\(/);
    assert.match(live, /for \(pin in storage\.nodes\) leaseChecks\[pin\.id\] = LeaseNodeCheck\.Unconfirmed/);
    // No function here calls itself or another tap's function: each name appears once, where it is declared.
    for (const name of ['fun refreshLeases(', 'fun refreshLiveLease(', 'fun decideLease(', 'private fun noteLeasePush(', 'fun stopRunningLease(', 'fun openRunningLease(']) {
      assert.equal(count(live, name), 1, name);
      assert.equal(count(live, name.split(' ').pop()), 1, `${name.split(' ').pop()} is called from the section`);
    }
    // The one exception (R-F5-18): Stop on a banner row is the same Stop, for the lease it names.
    assert.equal(count(live, 'fun killSwitch('), 1);
    assert.equal(count(live, 'killSwitch('), 2);
    assert.match(section(live, 'fun stopRunningLease', '\n    }\n'), /killSwitch\(\)/);
    // One coroutine per tap: the list, a decision, a Refresh, a Stop.
    assert.equal(count(live, 'scope.launch'), 4);
    // The screens: nothing runs by itself. The model is called only from a button's onClick.
    none(leaseScreens, ['LaunchedEffect', 'DisposableEffect', 'SideEffect', 'produceState', 'rememberCoroutineScope', 'delay(', 'while (', 'ticker('], 'LeaseScreens.kt');
    assert.equal(count(leaseScreens, 'OutlinedButton({ model.refreshLeases() }'), 1);
    assert.equal(count(leaseScreens, 'OutlinedButton({ model.refreshLiveLease() }'), 1);
    assert.equal(count(leaseScreens, 'Button({ model.killSwitch() }'), 2, 'the live screen and the banner');
    assert.equal(count(leaseScreens, 'Button({ model.decideLease('), 2, 'Allow and Deny');
    for (const [call, n] of [['model.refreshLeases(', 1], ['model.refreshLiveLease(', 1], ['model.killSwitch(', 2], ['model.decideLease(', 2], ['model.openLiveLease(', 0],
      ['model.stopRunningLease(', 1], ['model.openRunningLease(', 1]]) {
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
    assert.match(leaseScreens, /if \(Leases\.isPausedForContact\(live\.state, live\.reason\)\) \{\n\s+if \(grantedByOther == null\) Text\("Paused: tap Refresh to let it continue\."/);
    // A lease another phone granted is not kept going from here, and the screen does not say it is.
    assert.match(leaseScreens, /else Text\("Paused: the phone that granted it has not been in touch\. You can still stop it here\."/);
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
    assert.equal(count(live, 'api.leases('), 2, 'the list the owner asks for, and the fresh status before a watch whose token is old');
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
