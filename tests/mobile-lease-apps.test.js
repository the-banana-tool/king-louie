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
    assert.match(section(leases, 'func openLiveLease', 'private func apply'), /signWatchEnvelope\(/);
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
    const liveView = section(leases, 'func openLiveLease', 'private func apply');
    assert.equal(count(liveView, 'Leases.watch('), 1);
    none(liveView, ['Leases.grant(', 'Leases.deny(', 'Leases.revoke(', 'key.signEnvelope('], 'the live view');
  });

  it('iOS: the live view never asks for Face ID by itself', () => {
    const { leases, screens } = ios();
    // It waits while the API session is locked instead of unlocking it.
    const liveView = section(leases, 'func openLiveLease', 'private func apply');
    assert.match(liveView, /guard key\.isSessionUnlocked else \{/);
    assert.ok(liveView.indexOf('guard key.isSessionUnlocked else {') < liveView.indexOf('signWatchEnvelope('), 'checked before the watch is signed');
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
    const apply = section(leases, 'private func apply', 'func closeLiveLease');
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
