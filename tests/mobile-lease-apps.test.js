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
    const live = section(model, '// ---- Leases (fleet stage 5) ----', '// ---- Leases: end ----');
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
    assert.equal(count(model, 'updateLive(leaseId) { applyLease(envelope, pin, it, deviceId) }'), 1, 'the live view\'s loop passes this phone\'s device id');
    assert.equal(count(model, 'applyLease('), 7, 'declared once; called from the live view\'s loop (the views, and a fresh status before a watch), a reply\'s status, a listed lease, a followed one, and an ended lease a notification names (C-18)');
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

    // Android: the same; the token rides on the live view's read-key watch, and on the fingerprint watch its button sends.
    const kt = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];
    const android = read(...kt, 'AppModel.kt');
    const live = section(android, '// ---- Leases (fleet stage 5) ----', '// ---- Leases: end ----');
    const apply = section(live, 'private fun applyLease', '\n    }\n');
    assert.equal(count(apply, 'contactToken = status.contactToken ?: live.contactToken'), 1);
    assert.equal(count(apply, 'contactToken = view.contactToken ?: live.contactToken'), 1);
    assert.equal(count(live, 'contactToken = '), 2, 'only applyLease sets it');
    assert.match(live, /Leases\.watch\(current\.nodeId, current\.leaseId, deviceId, current\.contactToken, Messages\.randomNonce\(\), Timestamps\.string\(api\.now\(\)\)\)/);
    assert.match(live, /Leases\.watch\(live\.nodeId, live\.leaseId, k\.deviceId, live\.contactToken, Messages\.randomNonce\(\), Timestamps\.string\(api\.now\(\)\)\)/);
    const reply = section(live, 'private fun applyReplyStatus', '\n    }\n');
    assert.match(reply, /val signed = reply\["status"\]\?\.takeIf \{ it !is JsonNull \}\?\.let \{ runCatching \{ Envelope\.fromJson\(it\) \}\.getOrNull\(\) \} \?: return live/);
    assert.match(reply, /return applyLease\(signed, pin, live, deviceId\)/);
    assert.equal(count(live, 'applyReplyStatus('), 5, 'declared, after Allow, after the live view\'s watch, after the fingerprint watch, after Stop');
    assert.equal(count(live, '["status"]'), 4, 'a listed request\'s status, a listed lease\'s (twice: the list, and the live view\'s fresh status) and a reply\'s: all through verifiedMessage or applyLease');
    // The live view asks for a fresh status before a watch only when the token it holds is over a minute old by the phone's running clock.
    const refresh = section(live, '// ---- Live view loop (android-slim §7.6) ----', '// ---- Live view loop: end ----');
    assert.match(refresh, /if \(Leases\.tokenIsStale\(live\.contactTokenAtMs, SystemClock\.elapsedRealtime\(\)\)\) \{\n\s+for \(entry in api\.leases\(\)\) \{\n/);
    assert.ok(refresh.indexOf('Leases.tokenIsStale(') < refresh.indexOf('Leases.watch('), 'before the watch is built');
    assert.match(refresh, /if \(!isStatusOnly\(entry\) \|\| entry\["node_id"\]\.str\(\) != pin\.id\) continue\n\s+val signed = .*\n\s+updateLive\(leaseId\) \{ applyLease\(signed, pin, it, deviceId\) \}/);
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
    assert.equal(count(iosLeases, 'runningLeases.append('), 3, 'a listed lease, a pending lease an accepted listing names, and the lease that was on the live screen when another is followed');
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

    // Android: the same, in the list the foreground loop fetches (android-slim §10).
    const kt = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];
    const android = read(...kt, 'AppModel.kt');
    const live = section(android, '// ---- Leases (fleet stage 5) ----', '// ---- Leases: end ----');
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
    assert.equal(count(refreshAndroid, 'api.'), 1, 'one request, with the read key, for the requests and for what is running');
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
    // Each running lease is a row of the one list (android-slim §7.3), with Stop: the lease on the live screen and every listed one,
    // each from the status its node signed (verified again), and "Granted by" from the core (ApprovalList, Leases.grantedByOther).
    const rows = section(android, 'private fun runningLeaseRows', '\n    }\n');
    assert.match(rows, /for \(lease in runningLeases\) \{/);
    assert.match(rows, /val status = lease\.status\?\.let \{ signedStatus\(lease\.nodeId, it\) \} \?: continue/);
    assert.match(section(android, 'private fun signedStatus', '\n    }\n'), /Leases\.verifiedMessage\(envelope, pin\)\?\.let \{ LeaseStatus\.from\(it\) \}/);
    const press = section(android, 'fun press(row: ApprovalList.Row, button: ApprovalList.Button)', '\n    }\n');
    assert.match(press, /if \(liveLease\?\.leaseId == row\.ref\) killSwitch\(\) else runningLeases\.firstOrNull \{ it\.leaseId == row\.ref \}\?\.let \{ stopRunningLease\(it\) \}/);
    const listKt = read('mobile', 'android', 'protocol', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'protocol', 'ApprovalList.kt');
    assert.match(listKt, /val detail = if \(s\.state == "pending"\) Leases\.pendingDetail\(lease\.signedGrant\) else Leases\.grantedByOther\(s\.grantedByDevice, s\.grantedByName, input\.thisDevice\)/);
    assert.match(listKt, /buttons = listOf\(Button\.STOP\)/);
    const screens = read(...kt, 'LeaseScreens.kt');
    assert.match(screens, /val grantedByOther = Leases\.grantedByOther\(live\.grantedByDevice, live\.grantedByName, model\.deviceId\)/);
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

    // Android: the same, in the one list request the foreground loop makes (android-slim §10).
    const kt = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];
    const android = read(...kt, 'AppModel.kt');
    const live = section(android, '// ---- Leases (fleet stage 5) ----', '// ---- Leases: end ----');
    const refreshAndroid = section(live, 'fun refreshLeases', 'private fun verifiedLeaseRequest');
    assert.match(refreshAndroid, /val nonce = Messages\.randomNonce\(\)\n\s+val listed = api\.leases\(nonce\)\n/);
    assert.equal(count(refreshAndroid, 'api.'), 1, 'still one request, now with the read key');
    assert.match(refreshAndroid, /for \(pin in pins\) \{\n\s+val check = Leases\.checkListing\(listed, pin, nonce, deviceId \?: ""\)\n\s+leaseChecks\[pin\.id\] = if \(check\.accepted\) \{/);
    assert.match(refreshAndroid, /\} else \{\n\s+LeaseNodeCheck\.Unconfirmed\n\s+\}/);
    assert.match(refreshAndroid, /\} catch \(e: Exception\) \{\n\s+\/\/ No reply at all: nothing was confirmed with any node\.\n\s+for \(pin in storage\.nodes\) leaseChecks\[pin\.id\] = LeaseNodeCheck\.Unconfirmed\n\s+throw e/);
    assert.equal(count(live, 'leaseChecks[pin.id] = '), 2, 'from the check, and from a request that failed; nowhere else');
    assert.ok(android.indexOf('val leaseChecks = mutableStateMapOf<String, LeaseNodeCheck>()') < android.indexOf('\n    init {'));
    const api = read(...kt, 'RelayApi.kt');
    assert.match(api, /suspend fun leases\(nonce: String\? = null\): List<JsonElement> =\n\s+request\("GET", if \(nonce == null\) "\/v1\/leases\?wait=0" else "\/v1\/leases\?wait=0&nonce=\$nonce", READ\)/);
    // The list gets every node's check as it stands (ApprovalList builds "Could not confirm with" from it, §7.3).
    assert.match(android, /is LeaseNodeCheck\.Unconfirmed -> ApprovalList\.NodeCheck\.Unconfirmed/);
    const screens = read(...kt, 'LeaseScreens.kt');
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

    // Android: the same three, written only by refreshLeases (the loop's list request).
    const kt = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];
    const android = read(...kt, 'AppModel.kt');
    const live = section(android, '// ---- Leases (fleet stage 5) ----', '// ---- Leases: end ----');
    assert.match(live, /sealed class LeaseNodeCheck \{/);
    assert.match(live, /data class Confirmed\(val atMs: Long, val running: Int, val waiting: Int\) : LeaseNodeCheck\(\)/);
    assert.match(live, /object Unconfirmed : LeaseNodeCheck\(\)/);
    const refreshAndroid = section(live, 'fun refreshLeases', 'private fun verifiedLeaseRequest');
    assert.equal(count(android, 'LeaseNodeCheck.Confirmed('), 1, 'one way to be confirmed');
    inOrder(refreshAndroid, ['val checkedAt = System.currentTimeMillis()', 'leaseChecks[pin.id] = if (check.accepted) {', 'val named = Leases.listedStatuses(check, pin)',
      'LeaseNodeCheck.Confirmed(checkedAt, named.count { Leases.isLive(it.state) }, named.count { it.state == "pending" })']);
    // Nothing but refreshLeases writes an entry; a removed node's entry goes with it, and reset empties the map.
    const writes = (text) => (text.match(/leaseChecks\[[^\]]+\] = /g) || []).length;
    assert.equal(writes(android), 2);
    assert.equal(writes(android.replace(refreshAndroid, '')), 0, 'written only by refreshLeases');
    assert.equal(count(android, 'leaseChecks.remove(nodeId)'), 1, 'Remove on a node (C-15)');
    assert.equal(count(android, 'leaseChecks.clear()'), 1, 'reset');
    // The three reach the list as they are; ApprovalList words them (Not checked yet, a footer line, Could not confirm).
    assert.match(android, /is LeaseNodeCheck\.Confirmed -> ApprovalList\.NodeCheck\.Confirmed\(c\.atMs, c\.running, c\.waiting\)/);
    assert.match(android, /formatDateTime = \{ DateFormat\.getDateTimeInstance\(DateFormat\.SHORT, DateFormat\.SHORT\)\.format\(Date\(it\)\) \}/);
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
    // The row: its own words, and the Stop every row has. "May still start" only for a grant this phone
    // remembers signing (fifth security review, finding 1: a pending row no longer needs one).
    assert.match(section(iosLeases, 'func bannerTitle', '\n    }\n'), /if lease\.state == "pending" \{ return Leases\.pendingTitle\(nodeName: lease\.nodeName, signedGrant: signedLeaseGrants\[lease\.leaseId\] != nil\) \}/);
    assert.match(swift, /public static func pendingTitle\(nodeName: String, signedGrant: Bool\) -> String \{\n\s+signedGrant \? mayStillStartTitle\(nodeName: nodeName\) : requestWaitingTitle\(nodeName: nodeName\)\n\s+\}/);
    const views = read('mobile', 'ios', 'App', 'LeaseViews.swift');
    const banner = views.slice(views.indexOf('struct LeaseBanner'));
    assert.match(banner, /if lease\.state == "pending" \{ Text\(model\.pendingDetail\(lease\)\)/);
    assert.match(banner, /Button\("Stop", role: \.destructive\) \{ Task \{ await model\.stopLease\(lease\) \} \}/);
    // Stop is the owner's tap and nothing else: no revoke is built anywhere but in killSwitch (no automatic revoke after an unconfirmed grant).
    assert.equal(count(ios, 'Leases.revoke('), 1);
    assert.equal(count(ios, 'signedLeaseGrants = [:]'), 2, 'emptied when the phone is unpaired or reset');

    // Android: the same, and nothing sent by itself (R-F5-5).
    const kt = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];
    const android = read(...kt, 'AppModel.kt');
    const live = section(android, '// ---- Leases (fleet stage 5) ----', '// ---- Leases: end ----');
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
    assert.equal(count(live, 'scope.launch'), 4, 'decideLease, killSwitch and watchWithFingerprint, one per tap, and the live view\'s loop');
    // "May still start" only for a grant this phone remembers signing (fifth security review, finding 1): the row says so through ApprovalList.
    assert.match(live, /fun pendingLeaseTitle\(leaseId: String, nodeName: String\): String = Leases\.pendingTitle\(nodeName, leaseId in signedLeaseGrants\)/);
    assert.match(kotlin, /fun pendingTitle\(nodeName: String, signedGrant: Boolean\): String = if \(signedGrant\) mayStillStartTitle\(nodeName\) else requestWaitingTitle\(nodeName\)/);
    assert.equal(count(android, 'signedGrant = live.leaseId in signedLeaseGrants'), 1);
    assert.equal(count(android, 'signedGrant = lease.leaseId in signedLeaseGrants'), 1);
    assert.equal(count(android, 'signedLeaseGrants.clear()'), 1, 'reset (the demo is gone)');
  });

  // Fifth security review, finding 1. The memory of signed grants is the
  // app's own, so after a restart, and on any other enrolled phone, a
  // listing that passed named a lease as pending and the phone showed "1
  // request waiting" with no row and no Stop, while the relay could still
  // deliver the grant it held. Every pending lease a listing that passed
  // names now gets a row with the Stop every row has, whatever this phone
  // remembers; what it remembers only chooses the words.
  it('fifth review, finding 1: a pending lease an accepted listing names gets a row and a Stop on both phones, with no memory of a grant', () => {
    const swift = read('mobile', 'ios', 'KLProtocol', 'Sources', 'KLProtocol', 'Lease.swift');
    const kotlin = read('mobile', 'android', 'protocol', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'protocol', 'Lease.kt');
    // The rule, the same in both cores: pending gets a row; only an unanswered request that is on screen as a card does not get a second one.
    assert.match(swift, /public static func listedPendingGetsRow\(state: String, shownAsRequest: Bool, signedGrant: Bool\) -> Bool \{\n\s+state == "pending" && \(signedGrant \|\| !shownAsRequest\)\n\s+\}/);
    assert.match(kotlin, /fun listedPendingGetsRow\(state: String, shownAsRequest: Boolean, signedGrant: Boolean\): Boolean = state == "pending" && \(signedGrant \|\| !shownAsRequest\)/);
    // Honest words: a phone that remembers no grant does not say "may still start".
    assert.match(swift, /public static func requestWaitingTitle\(nodeName: String\) -> String \{ "A request is waiting on \\\(Display\.escape\(nodeName\)\)" \}/);
    assert.match(kotlin, /fun requestWaitingTitle\(nodeName: String\): String = "A request is waiting on \$\{Display\.escape\(nodeName\)\}"/);
    const DETAIL = 'Its computer says a request for computer use is waiting for a phone\'s answer. This phone does not remember allowing it. An Allow signed before this app was restarted, or on another phone, could still reach it. Stop cancels the request.';
    assert.ok(swift.includes(`public static let requestWaitingDetail = "${DETAIL}"`));
    assert.ok(kotlin.includes(`const val REQUEST_WAITING_DETAIL = "${DETAIL}"`));
    assert.match(swift, /public static func pendingDetail\(signedGrant: Bool\) -> String \{ signedGrant \? mayStillStartDetail : requestWaitingDetail \}/);
    assert.match(kotlin, /fun pendingDetail\(signedGrant: Boolean\): String = if \(signedGrant\) MAY_STILL_START_DETAIL else REQUEST_WAITING_DETAIL/);

    // iOS.
    const ios = read('mobile', 'ios', 'App', 'AppModel.swift');
    const iosLeases = section(ios, '// MARK: Leases (fleet stage 5)', '// MARK: Leases end');
    const refreshIos = section(iosLeases, 'func refreshLeases', 'func decideLease');
    // Only after that node's listing passed, and after the rows it no longer names were dropped.
    const accepted = refreshIos.indexOf('guard check.accepted else { checks[pin.id] = .unconfirmed; continue }');
    const noted = refreshIos.indexOf('notePendingListed(check, pin: pin, shownAsRequest: Set(items.map { $0.request.leaseId }))');
    assert.ok(accepted > 0 && accepted < refreshIos.indexOf('dropMayStartRows(') && refreshIos.indexOf('dropMayStartRows(') < noted);
    assert.equal(count(iosLeases, 'notePendingListed('), 2, 'declared, and called from that one place');
    const pendingIos = section(iosLeases, 'private func notePendingListed', '\n    }\n');
    assert.match(pendingIos, /guard check\.accepted else \{ return \}\n\s+for signed in check\.statuses \{\n\s+guard let message = Leases\.verifiedMessage\(signed, pin: pin\), let status = LeaseStatus\(message: message\) else \{ continue \}/);
    assert.match(pendingIos, /guard Leases\.listedPendingGetsRow\(state: status\.state, shownAsRequest: shownAsRequest\.contains\(status\.leaseId\), signedGrant: remembered\) else \{ continue \}/);
    assert.match(pendingIos, /guard Leases\.acceptsStatus\(status, appliedSeq: 0\) else \{ continue \}\n\s+runningLeases\.append\(RunningLease\(/);
    assert.match(pendingIos, /status: signed\)\)/, 'the row carries the signed status, so Stop starts from it');
    // Memory chooses the words and nothing else: no branch here returns for want of a remembered grant.
    assert.equal(count(pendingIos, 'signedLeaseGrants['), 1);
    none(pendingIos, ['client.', 'signEnvelope(', 'killSwitch(', 'Task {', 'Leases.revoke('], 'notePendingListed (iOS)');
    // A row that is there stays while its node still signs "pending", listing or no listing.
    const noteIos = section(iosLeases, 'private func noteListedLease', '\n    }\n');
    assert.match(noteIos, /if let known, status\.state == "pending" \{\n\s+runningLeases\[known\] = RunningLease\(/);
    assert.ok(noteIos.indexOf('guard Leases.acceptsStatus(') < noteIos.indexOf('if let known, status.state == "pending" {'), 'never from an older status');
    // An unremembered row has no expiry to wait for: it goes with the first accepted listing that does not name it.
    assert.match(section(iosLeases, 'private func dropMayStartRows', '\n    }\n'), /signedLeaseGrants\[leaseId\]\.map \{ \$0 < Date\(\) && \$0 < relayNow \} \?\? true/);
    // Stop from that row is the Stop of every row: followed, then the kill switch, which asks nothing about who granted.
    const kill = section(iosLeases, 'func killSwitch', '// Demo:');
    none(kill, ['signedLeaseGrants', 'grantedBy'], 'killSwitch (iOS)');
    assert.match(kill, /guard var live = liveLease, !live\.revoking, live\.state != "ended" else \{ return \}/);
    assert.match(section(iosLeases, 'private func follow', '\n    }\n'), /if let old = liveLease, Leases\.isLive\(state: old\.state\) \|\| \(old\.state == "pending" && old\.lastStatus != nil\) \{/);
    assert.equal(count(ios, 'Leases.revoke('), 1, 'still no revoke but the owner\'s Stop');

    // Android: the same, inside refreshLeases and nowhere else, sending nothing (R-F5-5).
    const kt = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];
    const android = read(...kt, 'AppModel.kt');
    const live = section(android, '// ---- Leases (fleet stage 5) ----', '// ---- Leases: end ----');
    const refreshAndroid = section(live, 'fun refreshLeases', 'private fun verifiedLeaseRequest');
    assert.match(refreshAndroid, /leaseChecks\[pin\.id\] = if \(check\.accepted\) \{\n\s+val named = Leases\.listedStatuses\(check, pin\)\n\s+dropMayStartRows\(pin, named\.map \{ it\.leaseId \}\.toSet\(\), api\)\n\s+notePendingListed\(check, pin, items\.map \{ it\.request\.leaseId \}\.toSet\(\)\)/);
    assert.equal(count(live, 'notePendingListed('), 2, 'declared, and called from that one place: refreshLeases');
    assert.equal(count(refreshAndroid, 'api.'), 1, 'still one request');
    const pendingKt = section(live, 'private fun notePendingListed', '\n    }\n');
    assert.match(pendingKt, /if \(!check\.accepted\) return\n\s+for \(signed in check\.statuses\) \{\n\s+val status = Leases\.verifiedMessage\(signed, pin\)\?\.let \{ LeaseStatus\.from\(it\) \} \?: continue/);
    assert.match(pendingKt, /if \(!Leases\.listedPendingGetsRow\(status\.state, status\.leaseId in shownAsRequest, status\.leaseId in signedLeaseGrants\)\) continue/);
    assert.match(pendingKt, /if \(!Leases\.acceptsStatus\(status, 0\)\) continue\n\s+runningLeases\.add\(RunningLease\(pin\.id, pin\.name, status\.leaseId, status\.state, status\.reason, status\.seq, status\.grantedByDevice, status\.grantedByName, signed\)\)/);
    none(pendingKt, ['api.', 'sendLease(', 'signEnvelope(', 'killSwitch(', 'scope.launch', 'delay(', 'while'], 'notePendingListed (Android)');
    const note = section(live, 'private fun noteListedLease', '\n    }\n');
    assert.match(note, /if \(known >= 0 && status\.state == "pending"\) \{\n\s+runningLeases\[known\] = RunningLease\(/);
    assert.ok(note.indexOf('if (!Leases.acceptsStatus(') < note.indexOf('if (known >= 0 && status.state == "pending") {'), 'never from an older status');
    assert.match(section(live, 'private fun dropMayStartRows', '\n    }\n'), /val expired = expires == null \|\| /);
    const killKt = section(live, 'fun killSwitch', '\n    }\n');
    none(killKt, ['signedLeaseGrants', 'grantedBy'], 'killSwitch (Android)');
    assert.equal(count(killKt, 'sendLease('), 1, 'R-F5-5: one revoke, sent once');
    assert.match(section(live, 'private fun followRunningLease', '\n    }\n'), /if \(old != null && \(Leases\.isLive\(old\.state\) \|\| \(old\.state == "pending" && old\.lastStatus != null\)\)\) \{/);
    assert.equal(count(live, 'scope.launch'), 4, 'decideLease, killSwitch, watchWithFingerprint and the live view\'s loop');
    assert.equal(count(android, 'Leases.revoke('), 1);
    assert.match(android, /import com\.example\.kinglouie\.protocol\.ListingCheck\n/);
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

  it('iOS\'s demo shows no typed text in its action log; the Android app has no demo (android-slim C-17)', () => {
    const ios = read('mobile', 'ios', 'App', 'AppModel.swift');
    assert.ok(!/Type \\"/.test(ios), 'no "Type \"…\"" summary');
    assert.match(ios, /Typed 6 characters/);
    const appDir = path.join(ROOT, 'mobile', 'android', 'app', 'src');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
    for (const file of walk(appDir).filter((f) => f.endsWith('.kt'))) {
      const text = fs.readFileSync(file, 'utf8');
      none(text, ['AppMode.DEMO', 'DemoFleet'], path.relative(ROOT, file));
    }
    const core = read('mobile', 'android', 'protocol', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'protocol', 'AppCore.kt');
    assert.match(core, /enum class AppMode \{ WELCOME, LIVE \}/);
    assert.ok(!core.includes('class DemoFleet'), 'DemoFleet is in the protocol module\'s tests');
    assert.ok(fs.existsSync(path.join(ROOT, 'mobile', 'android', 'protocol', 'src', 'test', 'kotlin', 'com', 'example', 'kinglouie', 'protocol', 'DemoFleet.kt')));
  });
});

// android-slim §12.1 (owner rulings R-AN-6 and R-AN-9 replace R-F5-1, R-F5-6
// and ruling T19-presence for Android; R-F5-5 stands for every decision).
// These are the model's rules; the screens' rules are in
// tests/mobile-android-slim.test.js.
describe('Android: the loops, the read-key watch and the decisions (android-slim §12.1)', () => {
  const dir = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];
  // Read inside each test, so a missing file or marker fails that test by name.
  function android() {
    const model = read(...dir, 'AppModel.kt');
    const live = section(model, '// ---- Leases (fleet stage 5) ----', '// ---- Leases: end ----');
    return {
      model,
      live,
      loop: section(model, '// ---- ForegroundLoop (android-slim §9) ----', '// ---- ForegroundLoop: end ----'),
      liveLoop: section(live, '// ---- Live view loop (android-slim §7.6) ----', '// ---- Live view loop: end ----'),
      api: read(...dir, 'RelayApi.kt'),
      app: read(...dir, 'KingLouieApplication.kt'),
      leaseScreens: read(...dir, 'LeaseScreens.kt'),
      core: read('mobile', 'android', 'protocol', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'protocol', 'Lease.kt')
    };
  }
  // What the loops must never name: the device key and every decision (§12.1).
  const DECIDES = ['signEnvelope(k,', 'DeviceKey', 'decide(', 'decideLease(', 'killSwitch(', 'answer(', 'stopRunningLease('];

  it('Android: the only loops are ForegroundLoop and the live view\'s, both with the lifecycle, and neither signs with the device key or decides', () => {
    const { model, live, loop, liveLoop, app, leaseScreens } = android();
    // ForegroundLoop: ON_START and ON_STOP of the process (C-7), and nothing else starts the app's loop.
    assert.match(app, /ProcessLifecycleOwner\.get\(\)\.lifecycle\.addObserver\(object : DefaultLifecycleObserver \{\n\s+override fun onStart\(owner: LifecycleOwner\) = model\.onForeground\(\)\n\s+override fun onStop\(owner: LifecycleOwner\) = model\.onBackground\(\)/);
    assert.equal(count(model, 'onForeground('), 1, 'declared in the model, called only by the lifecycle');
    assert.equal(count(model, 'onBackground('), 1);
    assert.match(loop, /private fun startLoop\(\) \{\n\s+if \(!foreground \|\| pairing \|\| mode != AppMode\.LIVE \|\| loop != null \|\| !readKeyKnown\) return/);
    assert.match(loop, /fun onBackground\(\) \{\n\s+foreground = false\n\s+stopLoop\(sayAway = true\)\n\s+stopLiveLoop\(\)/);
    assert.match(model, /private val readKeyKnown: Boolean get\(\) = readKey != null && !readKeyUnknown/);
    assert.equal(count(model, 'private inner class ForegroundLoop'), 1);
    // The live view's loop: started by the view's one DisposableEffect and the foreground, stopped by either.
    assert.match(liveLoop, /private fun startLiveLoop\(\) \{\n\s+if \(!liveViewVisible \|\| !foreground \|\| liveLoopJob\?\.isActive == true \|\| !readKeyKnown\) return/);
    assert.match(liveLoop, /fun liveViewHidden\(\) \{\n\s+liveViewVisible = false\n\s+stopLiveLoop\(\)/);
    assert.equal(count(leaseScreens, 'DisposableEffect('), 1);
    assert.match(leaseScreens, /DisposableEffect\(Unit\) \{\n\s+model\.liveViewShown\(\)\n\s+onDispose \{ model\.liveViewHidden\(\) \}\n\s+\}/);
    assert.equal(count(leaseScreens, 'model.liveViewShown('), 1);
    assert.equal(count(leaseScreens, 'model.liveViewHidden('), 1);
    // Neither loop names the device key or a decision.
    none(loop, DECIDES, 'ForegroundLoop');
    none(liveLoop, DECIDES, 'the live view\'s loop');
    // Each `while` in the model, with its reason. A new one fails here until it is named.
    const whiles = [...model.matchAll(/while \((.*)\) \{$/gm)].map((m) => m[1]);
    assert.deepEqual(whiles, [
      'isActive', // ForegroundLoop: presence every 60 s (C-8)
      'isActive', // ForegroundLoop: the approvals long poll (§9)
      'true', // the live view's loop (§7.6)
      'SystemClock.elapsedRealtime() < deadline', // a console pairing waits for its node (unchanged)
      'true', // a signed tool-approval response, re-sent while the node is offline and the request has time (unchanged)
      'openInvite === invite', // Add another phone: the claim, every 3 s with the read key (C-14)
      'reply.retryable && attempts < 3' // a pairing decision the front door could not save (unchanged)
    ]);
    assert.equal(count(loop, 'while ('), 2);
    assert.equal(count(liveLoop, 'while ('), 1);
    assert.equal(count(live.replace(liveLoop, ''), 'while ('), 0, 'no other loop in the leases section');
    // The leases section runs nothing else by itself: no timer, no flow, no ticker.
    none(live, ['postDelayed', 'Timer(', 'withTimeout', 'generateSequence', 'tailrec', 'ticker', 'Handler(', 'schedule', 'LaunchedEffect', '.collect', 'flow {'], 'the leases section');
    assert.equal(count(live.replace(liveLoop, ''), 'delay('), 0, 'only the live view\'s loop waits');
    // The loop's read-only steps (§9): the long poll, then the other kinds at most every 5 s.
    assert.match(loop, /val items = api\.approvals\(LONG_POLL_S\)/);
    assert.match(loop, /if \(lastRestAtMs != 0L && now - lastRestAtMs < REST_EVERY_MS\) return@withLock/);
    assert.match(loop, /each \{ fetchQuestions\(api\) \}\n\s+each \{ refreshLeases\(api\) \}\n\s+if \(frontDoorId != null\) \{\n\s+each \{ fetchPairings\(api\) \}\n\s+each \{ fetchAlerts\(api\) \}/);
    // Its errors, as §9 says: retry_after, 401 or rate_limited 15 s, pin_mismatch one re-pin, unknown_read_key the set-up row, else 5 s.
    assert.match(loop, /if \(e\.code == "unknown_read_key"\) \{\n\s+\/\/ [^\n]+\n\s+markReadKeyUnknown\(true\)/);
    assert.match(loop, /if \(!repinTried\) \{\n\s+repinTried = true\n\s+if \(tryRepin\(\)\) return false\n\s+\}/);
    assert.match(loop, /val seconds = e\.retryAfter\?\.coerceAtLeast\(1\)\n\s+\?: if \(e\.status == 401 \|\| e\.code == "rate_limited"\) BUSY_WAIT_S else ERROR_WAIT_S/);
    assert.match(loop, /"Can't reach the relay\. Trying again in \$seconds s\."/);
    // Presence (C-8): at the start and every 60 s, and one best-effort "not in front" on ON_STOP.
    assert.match(loop, /api\.presence\(true\)/);
    assert.match(loop, /delay\(PRESENCE_EVERY_MS\)/);
    assert.match(loop, /if \(sayAway\) scope\.launch \{\n\s+try \{\n\s+api\.presence\(false\)/);
    assert.match(model, /const val PRESENCE_EVERY_MS = 60_000L/);
    assert.match(model, /const val REST_EVERY_MS = 5_000L/);
    assert.match(model, /const val LONG_POLL_S = 25/);
    // Presence and the lists go with the read key (§8.4); the read key never signs a DEVICE route (tests/mobile-android-relay-keys.test.js).
    assert.match(read(...dir, 'RelayApi.kt'), /request\("POST", "\/v1\/presence", READ, /);
  });

  it('Android: the watch is signed with the read key in the live view\'s loop, every 20 s with the early-watch rule; the fingerprint watch only from its button', () => {
    const { model, live, liveLoop, leaseScreens } = android();
    // signRead: the read key, for a kl.lease.watch and nothing else (§8.5).
    const signRead = section(model, 'private suspend fun signRead(', '\n    }\n');
    assert.match(signRead, /if \(message\["type"\]\.str\(\) != "kl\.lease\.watch"\) throw /);
    assert.match(signRead, /rk\.sign\(bytes\)/);
    assert.match(signRead, /return Envelope\("ES256", id, B64Url\.encode\(bytes\), B64Url\.encode\(signature\)\)/);
    assert.equal(count(model, 'signRead('), 2, 'declared, and called once: in the live view\'s loop');
    assert.equal(count(liveLoop, 'signRead('), 1);
    assert.match(liveLoop, /val sent = sendLease\(api, "watch", leaseId, signRead\(watch\)\)/);
    // Every 20 s, plus one early watch for a fresher token while paused for want of contact (iOS's rule).
    assert.match(model, /const val WATCH_EVERY_MS = 20_000L/);
    assert.match(liveLoop, /val early = Leases\.isPausedForContact\(live\.state, live\.reason\) && !earlyUsed &&\n\s+live\.contactToken != null && live\.contactToken != lastWatchToken/);
    assert.match(liveLoop, /if \(!live\.readKeyRefused && \(lastWatchAtMs == 0L \|\| since >= WATCH_EVERY_MS \|\| early\)\) \{\n\s+earlyUsed = lastWatchAtMs != 0L && since < WATCH_EVERY_MS/);
    // The views long poll, read key; every status and view through applyLease.
    assert.match(liveLoop, /val entries = api\.leaseViews\(leaseId, cursor, waitS\)/);
    assert.match(liveLoop, /cursor = Leases\.cursorAfterWatch\(current\.lastSeq, sent\.json\)/);
    // A node that does not know the read key (bad_signature): no more read-key watches from this view; the fingerprint watch is offered.
    assert.match(liveLoop, /is SendOutcome\.Rejected -> if \(outcome\.reason == "bad_signature"\) \{/);
    assert.match(liveLoop, /updateLive\(leaseId\) \{ it\.copy\(readKeyRefused = true\) \}/);
    // The fingerprint watch: the device key, one watch, sent once, from its button only.
    const fallback = section(live, 'fun watchWithFingerprint()', '\n    }\n');
    assert.equal(count(fallback, 'signEnvelope(k, watch,'), 1);
    assert.equal(count(fallback, 'sendLease(api,'), 1);
    none(fallback, ['while (', 'delay(', 'repeat('], 'watchWithFingerprint');
    assert.equal(count(model, 'watchWithFingerprint('), 1, 'declared in the model and called from nowhere in it');
    assert.equal(count(leaseScreens, 'model.watchWithFingerprint('), 1, 'its button');
    assert.match(leaseScreens, /if \(live\.readKeyRefused\) \{\n\s+Text\(model\.readKeyRefusedText\(live\), /);
    assert.match(model, /does not know this phone's read key yet: run `king-louie-service device apply` there\./);
    assert.match(model, /const val FINGERPRINT_WATCH_BUTTON = "Keep it going with your fingerprint"/);
    // Two watches in the app and no more: the loop's and the button's.
    assert.equal(count(model, 'Leases.watch('), 2);
  });

  it('Android: Stop, Allow, Deny and the fingerprint watch are each signed once and sent once', () => {
    const { live, api, leaseScreens } = android();
    // One place posts a lease envelope, and it reports a failure instead of trying again.
    assert.equal(count(live, 'api.leaseDecision('), 1);
    const send = section(live, 'private suspend fun sendLease', '\n    }\n');
    assert.match(send, /= try \{\n\s+val json = api\.leaseDecision\(action, leaseId, envelope\)\n\s+val outcome = Leases\.sendOutcome\(json\)\n/);
    assert.match(send, /catch \(e: RelayException\) \{\n\s+LeaseReply\(SendOutcome\.Unconfirmed, null, /);
    assert.equal(count(section(api, 'suspend fun leaseDecision', '\n\n'), 'request('), 1);
    // The counts (§12.1), each with its reason.
    assert.equal(count(section(live, 'fun decideLease', 'fun followRunningLease'), 'sendLease(api,'), 1, 'Allow or Deny');
    assert.equal(count(live.slice(live.indexOf('fun killSwitch')), 'sendLease(api,'), 1, 'Stop');
    assert.equal(count(section(live, 'fun watchWithFingerprint()', '\n    }\n'), 'sendLease(api,'), 1, 'the fingerprint watch');
    assert.equal(count(section(live, '// ---- Live view loop (android-slim §7.6) ----', '// ---- Live view loop: end ----'), 'sendLease(api,'), 1, 'the read-key watch');
    assert.equal(count(live, 'sendLease(api,'), 4);
    assert.equal(count(live, 'signEnvelope(k,'), 4, 'grant, deny, revoke, and the fingerprint watch: one prompt each');
    // A send with no answer stays on screen as not confirmed, and is never shown as done.
    assert.match(section(live, 'fun decideLease', 'fun followRunningLease'), /is SendOutcome\.Unconfirmed ->\n\s+markLeaseUnconfirmed\(id, "Not confirmed: /);
    assert.match(live.slice(live.indexOf('fun killSwitch')), /next = next\.copy\(unconfirmed = Leases\.stopNotice\(sent\.outcome, sent\.problem\)\)/);
    assert.match(leaseScreens, /live\.unconfirmed\?\.let \{ Text\(it, /);
    assert.match(leaseScreens, /item\.unconfirmed\?\.let \{ Text\(it, /);
    // Stop and Allow can be tapped again: the buttons depend on what is in flight, not on the last answer.
    assert.match(leaseScreens, /Button\(\{ model\.killSwitch\(\) \}, Modifier\.fillMaxWidth\(\), enabled = !live\.busy && live\.state != "ended",/);
    assert.match(leaseScreens, /enabled = chosen\.isNotEmpty\(\) && !deciding\)/);
  });

  // Security review finding 1: a relay's reply to Stop (or to a watch) is not
  // signed by the node. It must never be what makes the screen say "ended".
  it('Android: a lease is shown as ended only by a status or view the pinned node signed', () => {
    const { live, liveLoop, core } = android();
    const kill = live.slice(live.indexOf('fun killSwitch'));
    const apply = section(live, 'private fun applyLease', '\n    }\n');
    none(kill, ['state = outcome.state', 'outcome.state', 'state = "ended"'], 'killSwitch (the relay\'s word used as the lease state)');
    // The watch reply's state is never the lease's: the loop applies only the status the node signed in it.
    none(liveLoop, ['state = outcome.state', 'outcome.state', 'copy(state'], 'the live view\'s loop');
    assert.match(liveLoop, /updateLive\(leaseId\) \{ applyReplyStatus\(sent\.json, pin, it, deviceId\) \}/);
    // The one place a live lease's state is written from the network: applyLease, from verified messages.
    assert.equal(count(apply, 'state = status.state'), 1);
    assert.equal(count(apply, 'state = view.state'), 1);
    assert.match(apply, /val status = Leases\.verifiedMessage\(envelope, pin\)\?\.let \{ LeaseStatus\.from\(it\) \}/);
    const outside = live.replace(apply, '');
    none(outside, ['state = status.state', 'state = view.state', 'state = sent.', 'state = json', 'state = reply', 'state = "ended"'], 'the lease section outside applyLease');
    // The core says what a Stop's reply lets the screen say, and "ended" is not in any of it.
    const notice = section(core, 'fun stopNotice', '\n    }\n');
    assert.match(notice, /is SendOutcome\.Confirmed -> "Stop sent, not yet confirmed by the computer\./);
    assert.doesNotMatch(notice, /ended|stopped\b/i);
  });

  it('Android: paused for want of contact says "Paused: open to let it continue"; the live view says what keeps it going', () => {
    const { leaseScreens, core } = android();
    assert.match(core, /const val NO_CONTACT = "no_contact"/);
    assert.match(core, /fun isPausedForContact\(state: String, reason: String\?\): Boolean = state == "suspended" && reason == NO_CONTACT/);
    // The row (ApprovalList, §7.3): the iOS words, for a lease this phone granted.
    const listKt = read('mobile', 'android', 'protocol', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'protocol', 'ApprovalList.kt');
    assert.match(listKt, /Leases\.isPausedForContact\(s\.state, s\.reason\) && grantedByThisPhone\(s, input\) -> "Paused: open to let it continue \(\$node\)"/);
    // The live view, from the signed state only.
    assert.match(leaseScreens, /if \(Leases\.isPausedForContact\(live\.state, live\.reason\)\) \{\n\s+if \(grantedByOther == null\) Text\("Paused: open to let it continue", /);
    assert.match(leaseScreens, /else if \(live\.state == "active" && grantedByOther == null\) \{\n\s+Text\(AppModel\.KEEP_OPEN_LINE, /);
    const model = read(...dir, 'AppModel.kt');
    assert.ok(model.includes('const val KEEP_OPEN_LINE = "Keep this open to keep it going. Closing it pauses clicks and typing after about two minutes."'));
    none(leaseScreens, ['Tap Refresh', 'This screen does not update by itself', 'model.refreshLiveLease('], 'LeaseScreens.kt');
  });

  it('Android: a lease push opens the lease\'s detail (§13), fetched with the read key', () => {
    const { model } = android();
    const pushed = section(model, 'fun openPushed(kind: String, id: String)', '\n    }\n');
    assert.match(pushed, /if \(!readyToRead\(\)\) return/);
    assert.match(pushed, /"lease", "session_paused", "session_ended" -> pushedLease\(api, kind, id\)/);
    assert.match(pushed, /if \(found != null\) selected = found else if \(listNotice == null\) listNotice = NO_LONGER_WAITING/);
    none(pushed, ['signEnvelope(', 'decide(', 'decideLease(', 'killSwitch(', 'answer(', 'noteLeasePush'], 'openPushed');
    const lease = section(model, 'private suspend fun pushedLease', '\n    }\n');
    assert.match(lease, /refreshLeases\(api\)/);
    assert.match(lease, /if \(kind == "lease"\) leaseRequests\.firstOrNull \{ it\.request\.requestId == id \}\?\.let \{ return Selection\.LeaseRequest\(id\) \}/);
    assert.match(lease, /no longer has this session; it is not running\./);
    assert.match(model, /const val NO_LONGER_WAITING = "That request is no longer waiting\."/);
    none(model, ['noteLeasePush', 'leasePushes', 'leaseNotice', 'fun refreshLeases()', 'fun refreshLiveLease(', 'fun checkNow('], 'AppModel.kt');
    // MainActivity routes a tapped notification there.
    assert.match(read(...dir, 'MainActivity.kt'), /model\.openPushed\(intent\.getStringExtra\(Push\.EXTRA_KIND\) \?: "approval", id\)/);
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
    none(live, ['.message()', 'payloadBytes', 'JsonText', '.payload'], 'the lease section (an envelope opened outside the core)');
    // The request detail draws the signed request, and the model keeps nothing else for it.
    assert.match(live, /data class LeaseRequestItem\(val request: LeaseRequest, val nodeName: String, val status: LeaseStatus\?, val unconfirmed: String\? = null\)/);
    for (const shown of ['item.request.apps', 'app.name', 'app.path', 'app.processes', 'item.request.reason', "Agent's reason (unverified)",
      'item.request.originClient', 'item.request.jobId', 'item.request.maxMinutes', 'item.request.limits', 'item.nodeName']) {
      assert.ok(leaseScreens.includes(shown), `the request screen shows ${shown}`);
    }
    none(leaseScreens, ['JsonElement', 'entry[', 'Envelope', 'relayText'], 'LeaseScreens.kt (unsigned data on a lease screen)');
  });

  it('Android: signed_at is the relay-corrected clock', () => {
    const { live } = android();
    assert.equal(count(live, 'Timestamps.string(api.now())'), 4, 'the decision, the read-key watch, the fingerprint watch and the revoke');
    assert.match(live, /val signedAt = Timestamps\.string\(api\.now\(\)\)/);
    assert.match(live, /Leases\.grant\(item\.request, apps\.toList\(\), minutes, k\.deviceId, signedAt\)/);
    assert.match(live, /Leases\.deny\(item\.request, k\.deviceId, signedAt\)/);
    assert.match(live, /Leases\.watch\(current\.nodeId, current\.leaseId, deviceId, current\.contactToken, Messages\.randomNonce\(\), Timestamps\.string\(api\.now\(\)\)\)/);
    assert.match(live, /Leases\.revoke\(live\.nodeId, live\.leaseId, "kill_switch", k\.deviceId, Messages\.randomNonce\(\), Timestamps\.string\(api\.now\(\)\)\)/);
    none(live, ['Instant.now()'], 'the lease section (the phone clock in a signed message)');
    // A request is dropped once it is past its expiry on that clock.
    assert.match(live, /\(Timestamps\.epochMillis\(request\.expiresAt\) \?: 0L\) <= api\.now\(\)\.toEpochMilli\(\)/);
  });

  it('Android: the read key\'s set-up (§8.7): two fingerprints, the statement kept and re-posted with the read key, an older relay named', () => {
    const { model, loop } = android();
    const setUp = section(model, 'fun setUpReadKey()', '\n    }\n');
    assert.match(setUp, /val envelope = signReadKeyStatement\(k, rk, api\)\n\s+val reply = postReadKey\(api, envelope, PhoneKey\.DEVICE\)/);
    assert.match(section(model, 'private suspend fun postReadKey', '\n    }\n'), /if \(e\.status == 404\) throw OwnerMessage\(OLDER_RELAY\)/);
    assert.match(model, /const val OLDER_RELAY = "This relay is older than this app\. Upgrade it, then try again\."/);
    assert.match(model, /const val READ_KEY_SETUP_TITLE = "Check for requests without your fingerprint\. Set up once: two fingerprints\."/);
    // Re-posted at each loop start, with the read key, only while a node answered offline and the statement has not expired.
    const repost = section(model, 'private suspend fun repostReadKeyStatement', '\n    }\n');
    assert.match(repost, /if \(readKeyNodes\.values\.none \{ it == RK_OFFLINE \}\) return\n\s+val envelope = keptStatement\(api\) \?: return\n\s+noteReadKeyReply\(api\.readKey\(envelope, PhoneKey\.READ\), firstPost = false\)/);
    assert.match(loop, /repostReadKeyStatement\(api\)/);
    // No fallback to the device key for reading (C-19): RelayApi gets the read signer, and the loop needs a read key the relay knows.
    assert.equal(count(model, 'PhoneKey.DEVICE'), 1, 'only the first post of the statement');
  });
});

// Revised 2026-10-24 (agent-driven demo takes, spec §6): a take is a lease of
// a second kind. Both cores check its exact keys, both request screens say
// what it may do in host-built lines, and both banners name it.
describe('take leases on the phones', () => {
  const UNATTENDED_LINE = 'Unattended: no check-ins; runs until it ends or you stop it';
  const BROWSER_TRUE_LINE = 'drive the browser on these sites (no scripts, no network changes, no uploads)';
  const CREDENTIALS_LINE = 'credentials from the vault';
  const SWIFT_VECTOR_TEST = 'mobile/ios/KLProtocol/Tests/KLProtocolTests/LeaseVectorTests.swift';
  const KOTLIN_VECTOR_TEST = 'mobile/android/protocol/src/test/kotlin/com/example/kinglouie/protocol/LeaseVectorTest.kt';
  for (const [label, file] of [['iOS', 'mobile/ios/KLProtocol/Sources/KLProtocol/Lease.swift'], ['Android', 'mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Lease.kt']]) {
    it(`${label} core validates kind take with its exact keys`, () => {
      const src = read(file);
      assert.match(src, /"take"/);
      for (const k of ['sites', 'credentials', 'unattended', 'max_minutes']) assert.match(src, new RegExp(`"${k}"`));
    });
  }

  // The mirror, against the node itself. The node does not export LEASE_KEYS,
  // so each kind's key list is read from a lease the node's checkLease accepts
  // (the take-grant and grant-valid vectors), and checkLease must refuse that
  // lease with any one key taken away or one added: so the list read is the
  // node's exact list. Each core's literal list must then be that list.
  const protocol = require('../src/gui/lease-protocol.js');
  const vectorLease = (name) => JSON.parse(read('tests', 'vectors', 'lease-v1', `${name}.json`)).given.pending[0].lease;
  function nodeKeys(name, kind) {
    const lease = vectorLease(name);
    assert.equal(lease.kind, kind);
    assert.ok(protocol.checkLease(lease), `${name}: the node accepts the lease`);
    const keys = Object.keys(lease);
    for (const k of keys) {
      const less = { ...lease };
      delete less[k];
      assert.equal(protocol.checkLease(less), false, `${kind} without ${k}`);
    }
    assert.equal(protocol.checkLease({ ...lease, extra: true }), false, `${kind} with a key too many`);
    return [...keys].sort();
  }
  const strings = (text) => [...text.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const CORES = {
    iOS: {
      file: 'mobile/ios/KLProtocol/Sources/KLProtocol/Lease.swift',
      list: (src, kind) => strings(src.match(new RegExp(`^\\s+"${kind}": \\[([^\\]]*)\\]`, 'm'))[1]),
      caps: [/public static let maxMinutes = (\d+)\n/, /public static let takeMaxMinutes = (\d+)\n/],
      maxRange: '(1...(take ? takeMaxMinutes : maxMinutes)).contains(minutes)',
      grantCap: ['let cap = min(request.maxMinutes, request.isTake ? takeMaxMinutes : maxMinutes)', 'guard cap >= 1, (1...cap).contains(minutes) else { throw'],
      status: ['let kind = message["kind"]?.stringValue, Leases.leaseKinds.contains(kind)',
        'let unattended = message["unattended"]?.boolValue, kind == "take" || !unattended',
        'let nameValue = message["name"], (kind == "take" ? Leases.isTakeName(nameValue) : nameValue.isNull) else { return nil }'],
      kinds: /static let leaseKinds = \["computer_use", "take"\]/
    },
    Android: {
      file: 'mobile/android/protocol/src/main/kotlin/com/example/kinglouie/protocol/Lease.kt',
      list: (src, kind) => strings(src.match(new RegExp(`^\\s+"${kind}" to listOf\\(([^)]*)\\)`, 'm'))[1]),
      caps: [/const val MAX_MINUTES = (\d+)\n/, /const val TAKE_MAX_MINUTES = (\d+)\n/],
      maxRange: 'if (minutes !in 1..(if (take) TAKE_MAX_MINUTES else MAX_MINUTES)) return false',
      grantCap: ['val cap = minOf(request.maxMinutes, if (request.isTake) TAKE_MAX_MINUTES else MAX_MINUTES)', 'if (minutes !in 1..cap) throw ProtocolException('],
      status: ['val kind = m["kind"].str()?.takeIf { it in Leases.LEASE_KINDS } ?: return null',
        'val unattended = m["unattended"].bool() ?: return null',
        'if (kind != "take" && unattended) return null',
        'val name = m["name"] ?: return null',
        'if (if (kind == "take") !Leases.isTakeName(name) else name !is JsonNull) return null'],
      kinds: /val LEASE_KINDS = listOf\("computer_use", "take"\)/
    }
  };
  for (const [label, core] of Object.entries(CORES)) {
    it(`${label} core holds the node's exact key lists, caps, grant cap and status agreement`, () => {
      const src = read(core.file);
      assert.deepEqual([...core.list(src, 'take')].sort(), nodeKeys('take-grant', 'take'), 'the take key list');
      assert.deepEqual([...core.list(src, 'computer_use')].sort(), nodeKeys('grant-valid', 'computer_use'), 'the computer_use key list');
      assert.equal(Number(src.match(core.caps[0])[1]), protocol.MAX_MINUTES);
      assert.equal(Number(src.match(core.caps[1])[1]), protocol.TAKE_MAX_MINUTES);
      assert.equal(protocol.TAKE_MAX_MINUTES, 240);
      assert.deepEqual(protocol.LEASE_KINDS, ['computer_use', 'take']);
      assert.match(src, core.kinds);
      // checkLease's max_minutes by kind, the grant's cap (the request's, and never past the kind's), the status rules.
      assert.equal(count(src, core.maxRange), 1, 'max_minutes by kind');
      for (const line of core.grantCap) assert.equal(count(src, line), 1, line);
      for (const line of core.status) assert.equal(count(src, line), 1, line);
      // The node's own status rules, so the pinned clauses are the right ones.
      const ok = { kind: 'take', unattended: true, name: 'A take' };
      const status = protocol.VALIDATORS['kl.lease.status'];
      const take = JSON.parse(Buffer.from(JSON.parse(read('tests', 'vectors', 'lease-v1', 'status-take.json')).input.payload, 'base64url').toString());
      assert.ok(status(take));
      assert.equal(status({ ...take, kind: 'computer_use', name: null, unattended: true }), false, 'computer_use is never unattended');
      assert.equal(status({ ...take, kind: 'computer_use' }), false, 'computer_use has no name');
      assert.equal(status({ ...take, name: null }), false, 'a take has a name');
      assert.ok(status({ ...take, ...ok, unattended: false }));
    });
  }
  // Review minor 5: the take's browser (its first app) cannot be left out of the grant.
  it('a take request keeps its browser app on in both apps', () => {
    const ios = read('mobile', 'ios', 'App', 'LeaseViews.swift');
    assert.equal(count(ios, '.disabled(item.request.isResume || isTakeBrowser(app))'), 1);
    assert.match(ios, /private func isTakeBrowser\(_ app: LeaseApp\) -> Bool \{ item\.request\.isTake && app\.id == item\.request\.apps\.first\?\.id \}/);
    const kt = read('mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'LeaseScreens.kt');
    assert.equal(count(kt, 'enabled = !item.request.isResume && !takeBrowser'), 1);
    assert.match(kt, /val takeBrowser = item\.request\.isTake && app\.id == item\.request\.apps\.firstOrNull\(\)\?\.id/);
    // The choice starts with every requested app, so the browser is on and stays on.
    assert.ok(ios.includes('chosen = Set(item.request.apps.map { $0.id })'));
    assert.ok(kt.includes('mutableStateOf(item.request.apps.map { it.id }.toSet())'));
  });
  // Review minor 1: the listed actions come from the request, so they carry a host label.
  it('listed browser actions carry a host label in both apps', () => {
    assert.ok(read('mobile', 'ios', 'App', 'LeaseViews.swift').includes('Text("Browser actions: " + actions.map { Display.escape($0) }.joined(separator: ", "))'));
    assert.ok(read('mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'LeaseScreens.kt')
      .includes('item.request.browserActions?.let { "Browser actions: " + it.joinToString(", ") { a -> Display.escape(a) } } ?: BROWSER_TRUE_LINE'));
  });
  for (const [label, file] of [['iOS', 'mobile/ios/App/LeaseViews.swift'], ['Android', 'mobile/android/app/src/main/kotlin/com/example/kinglouie/LeaseScreens.kt']]) {
    it(`${label} shows the unattended line, the browser line and the banner prefix`, () => {
      const src = read(file);
      for (const s of [UNATTENDED_LINE, BROWSER_TRUE_LINE, CREDENTIALS_LINE, 'Unattended take: ']) assert.ok(src.includes(s), s);
    });
  }
  it('both vector tests list the five take vectors', () => {
    for (const f of [SWIFT_VECTOR_TEST, KOTLIN_VECTOR_TEST]) {
      for (const n of ['take-grant', 'take-grant-minutes-over-cap', 'take-request-missing-name', 'computer-use-with-unattended', 'status-take']) {
        assert.ok(read(f).includes(`"${n}"`), `${f} ${n}`);
      }
    }
  });
});
