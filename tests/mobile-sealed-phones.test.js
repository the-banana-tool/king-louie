// tests/mobile-sealed-phones.test.js
//
// Sealed phones (plan docs/superpowers/plans/2026-11-04-sealed-phones.md, R-SP-6,
// R-SP-10, R-SP-15, Review Focus 2): what the Android app does with the box key,
// the statement flow and messages it cannot read. The app module has no test
// target, so this reads the Kotlin sources (as tests/mobile-lease-apps.test.js
// does): it shows the rules are written into the code, not that the app behaves.
// The protocol core's rules are proven by its vectors (SealVectorTest.kt).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const KT = ['mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie'];
const CORE = ['mobile', 'android', 'protocol', 'src', 'main', 'kotlin', 'com', 'example', 'kinglouie', 'protocol'];
const kt = (file) => read(...KT, file);
const count = (text, needle) => text.split(needle).length - 1;

function section(text, from, to) {
  const a = text.indexOf(from);
  assert.ok(a >= 0, `found ${from}`);
  const b = text.indexOf(to, a + from.length);
  assert.ok(b > a, `found the end of ${from}`);
  return text.slice(a, b);
}

describe('Android: the box key (R-SP-10)', () => {
  it('BoxKey.kt makes an agreement key that needs no prompt and an unlocked phone', () => {
    const box = kt('BoxKey.kt');
    assert.match(box, /const val ALIAS = "kl\.box-key"/);
    assert.match(box, /KeyGenParameterSpec\.Builder\(ALIAS, KeyProperties\.PURPOSE_AGREE_KEY\)/);
    assert.match(box, /ECGenParameterSpec\("secp256r1"\)/);
    assert.match(box, /\.setUserAuthenticationRequired\(false\)/);
    assert.match(box, /\.setUnlockedDeviceRequired\(true\)/);
    assert.match(box, /\.setIsStrongBoxBacked\(strongBox\)/);
    assert.match(box, /KeyAgreement\.getInstance\("ECDH", "AndroidKeyStore"\)/);
    assert.match(box, /fun agree\(x: String, y: String\): ByteArray/);
    assert.match(box, /Messages\.boxKeyFingerprint\(x, y\)/);
    assert.match(box, /Messages\.jwk\(x, y\)/);
    assert.ok(!box.includes('BiometricPrompt'), 'the box key never prompts');
  });

  it('StrongBox falls back to the TEE on both refusals, before Seal.open can see one', () => {
    const box = kt('BoxKey.kt');
    const create = section(box, 'fun create(): BoxKey', 'fun delete()');
    assert.match(create, /catch \(e: StrongBoxUnavailableException\)/);
    assert.match(create, /catch \(e: ProviderException\)/);
    assert.equal(count(create, 'generate(strongBox = false)'), 2);
    // The first agreement runs while the key is made: a StrongBox that makes the key but will not agree is found here.
    assert.match(section(box, 'private fun generate(', '\n        }\n'), /firstAgreement\(/);
  });

  it('a locked phone is never open_failed: every Keystore failure in agree is the unavailable exception', () => {
    const box = kt('BoxKey.kt');
    assert.match(box, /class BoxKeyUnavailableException\b[^\n]*: SealKeyUnavailableException\(/);
    const agree = section(box, 'fun agree(x: String, y: String)', '\n    }\n');
    assert.match(agree, /catch \(e: GeneralSecurityException\) \{\n\s+throw BoxKeyUnavailableException\(\)/);
    assert.match(agree, /catch \(e: ProviderException\) \{\n\s+throw BoxKeyUnavailableException\(\)/);
    assert.match(agree, /catch \(e: IOException\) \{\n\s+throw BoxKeyUnavailableException\(\)/);
  });

  it('DeviceKey.create makes a box key beside the read key, and delete removes it', () => {
    const dk = kt('DeviceKey.kt');
    const create = section(dk, 'fun create(): DeviceKey', 'fun delete()');
    assert.match(create, /runCatching \{ BoxKey\.create\(\) \}\.onFailure \{ runCatching \{ BoxKey\.delete\(\) \} \}/);
    assert.match(dk.slice(dk.indexOf('fun delete()')), /BoxKey\.delete\(\)/);
  });

  it('an enrollment carries the box key, and a phone that refuses it enrolls without one', () => {
    const model = kt('AppModel.kt');
    const device = section(model, 'private fun deviceJson(k: DeviceKey)', '\n    }\n');
    assert.equal(count(device, 'readKey?.jwk, boxKey?.jwk)'), 2);
    assert.match(kt('SettingsScreen.kt'), /if \(model\.boxKeyRefused\) Text\(AppModel\.BOX_KEY_REFUSED_LINE/);
    assert.equal(count(model, 'const val BOX_KEY_REFUSED_LINE = "This phone cannot hold a box key; sealed nodes will not show here."'), 1);
    assert.match(model, /boxKeyNodes\.markRefused\(true\)/);
  });
});

describe('Android: the box key statement (R-SP-10)', () => {
  it('is signed with the device key, one fingerprint, never with the read key', () => {
    const model = kt('AppModel.kt');
    const sign = section(model, 'private suspend fun signBoxKeyStatement', '\n    }\n');
    assert.match(sign, /k: DeviceKey/);
    assert.match(sign, /Messages\.boxKeyStatement\(k\.deviceId, bk\.jwk,/);
    assert.match(sign, /signEnvelope\(k, message,/);
    assert.ok(!/signRead|readKey|rk\.sign/.test(sign), 'the read key signs a watch and nothing else');
  });

  it('RelayApi posts it to the route ROUTE_AUTH names', () => {
    const table = read('tests', 'frontdoor-phone-routes.test.js');
    assert.match(table, /\['POST', '\/v1\/devices\/box-key', 'read'\]/);
    assert.match(kt('RelayApi.kt'), /suspend fun boxKey\(statement: Envelope\): JsonElement\? = request\("POST", "\/v1\/devices\/box-key", ENVELOPE, statement\.json\)\.second/);
  });

  it("BoxKeyNodes keeps each node's answer and the statement until it expires", () => {
    const nodes = kt('BoxKeyNodes.kt');
    for (const state of ['box-key-pending-apply', 'applied', 'duplicate', 'rejected']) assert.ok(nodes.includes(`"${state}"`), state);
    assert.match(nodes, /fun kept\(relayNowMs: Long\): Envelope\?/);
    assert.match(nodes, /val anyOffline: Boolean/);
    assert.match(nodes, /storage\.boxKeyStatement = null/);
  });

  it('goes again to nodes that answered offline, from the loop, with no prompt', () => {
    const model = kt('AppModel.kt');
    const repost = section(model, 'private suspend fun repostBoxKeyStatement', '\n    }\n');
    assert.match(repost, /if \(!boxKeyNodes\.anyOffline\) return/);
    assert.match(repost, /boxKeyNodes\.kept\(api\.now\(\)\.toEpochMilli\(\)\)/);
    assert.match(repost, /firstPost = false/);
    assert.ok(!repost.includes('signEnvelope'));
    assert.match(section(model, 'private inner class ForegroundLoop', 'private fun takeApprovals'), /repostBoxKeyStatement\(api\)/);
  });

  it('the list and Settings offer it, and the statement lives at most seven days', () => {
    const model = kt('AppModel.kt');
    assert.match(model, /const val BOX_KEY_STATEMENT_MS = 7L \* 24 \* 60 \* 60 \* 1000/);
    assert.match(kt('Screens.kt'), /model\.boxKeySetupNeeded/);
    assert.match(kt('Screens.kt'), /model\.setUpBoxKey\(\)/);
    const settings = kt('SettingsScreen.kt');
    assert.match(settings, /model\.boxKeyFingerprint/);
    assert.match(settings, /AppModel\.BoxKeyNodeState\.WAITING_FOR_APPLY -> /);
    assert.match(settings, /model\.sendBoxKeyAgain\(\)/);
  });
});

describe('Android: sealedSeen (R-SP-15)', () => {
  it('is persisted beside the pins, by node id, and Reset clears it', () => {
    assert.match(section(kt('Storage.kt'), 'var nodes: List<NodePin>', 'class PendingItem'), /var sealedSeen: Set<String>/);
    const model = kt('AppModel.kt');
    assert.match(model, /private var sealedSeen: Set<String> = storage\.sealedSeen/);
    assert.match(section(kt('Storage.kt'), 'fun clear()', '\n'), /prefs\.edit\(\)\.clear\(\)/);
    const reset = section(model, 'private suspend fun finishReset', 'companion object');
    assert.ok(reset.indexOf('storage.clear()') >= 0 && reset.indexOf('storage.clear()') < reset.indexOf('sealedSeen = storage.sealedSeen'), 'read back after the store is cleared');
  });

  it('forgetting a node does not forget that it seals', () => {
    assert.ok(!section(kt('AppModel.kt'), 'fun forgetNode(nodeId: String)', '\n    }\n').includes('sealedSeen'));
  });

  it('the three deciding readers get the persisted set and the opener', () => {
    const model = kt('AppModel.kt');
    assert.ok(!model.includes('sealedSeen = emptySet()'), 'no placeholder is left');
    assert.match(section(model, 'private fun receive(', '\n    }\n'), /Display\.view\(envJson, pins, opener\(\), sealedSeen = sealedSeen\)/);
    assert.match(section(model, 'private fun verifiedQuestion', '\n    }\n'), /QuestionItem\.from\(message, pin\.name, opener\(\), sealedSeen = sealedSeen\)/);
    assert.match(section(model, 'private fun verifiedLeaseRequest', '\n    }\n'), /LeaseRequest\.check\(message, opener\(\), sealedSeen = sealedSeen\)/);
    assert.ok(!model.includes('LeaseRequest.from('), 'check keeps the reason for the row and the state for the mark');
  });

  it('only a verified open marks a node, through one function, statuses and views included', () => {
    const model = kt('AppModel.kt');
    const note = section(model, 'private fun noteSeal(nodeId: String, state: SealState)', '\n    }\n');
    assert.match(note, /Seal\.noteSealedSeen\(sealedSeen, nodeId, state\)/);
    assert.match(note, /storage\.sealedSeen = next/);
    assert.equal(count(model, 'Seal.noteSealedSeen('), 1);
    // A request: Display.view reports OPENED only past the signature; the kid is then the node.
    const receive = section(model, 'private fun receive(', '\n    }\n');
    assert.match(receive, /if \(view\.seal == SealState\.OPENED\) noteSeal\(envelope\.kid, view\.seal\)/);
    // A question: the pin's own, its signature held, before anything opens; marked for the pin, never a name inside.
    const question = section(model, 'private fun verifiedQuestion', '\n    }\n');
    assert.ok(question.indexOf('envelope.verifyEd25519(pin.key)') < question.indexOf('QuestionItem.from('));
    assert.ok(question.indexOf('message["node_id"].str() != pin.id') < question.indexOf('QuestionItem.from('));
    assert.match(question, /noteSeal\(pin\.id, item\.seal\)/);
    assert.match(section(model, 'private fun verifiedLeaseRequest', '\n    }\n'), /noteSeal\(pin\.id, check\.seal\)/);
    // A status and a view.
    const status = section(model, 'private fun readStatus(', '\n    }\n');
    assert.match(status, /Leases\.verifiedMessage\(envelope, pin\)\?\.let \{ LeaseStatus\.from\(it, opener\(\)\) \}/);
    assert.match(status, /noteSeal\(pin\.id, status\.seal\)/);
    const apply = section(model, 'private fun applyLease', '\n    }\n');
    assert.match(apply, /Leases\.verifyView\(envelope, pin, opener\(\)\)/);
    assert.match(apply, /noteSeal\(pin\.id, view\.seal\)/);
    // A rejected view marks nothing: it comes after check.accepted.
    assert.ok(apply.indexOf('check.accepted') < apply.indexOf('noteSeal(pin.id, view.seal)'));
  });

  it('every status read off the network goes through readStatus', () => {
    const model = kt('AppModel.kt');
    for (const [from, to] of [
      ['private fun verifiedLeaseRequest', '\n    }\n'],
      ['private fun noteListedLease', '\n    }\n'],
      ['private fun notePendingListed', '\n    }\n'],
      ['private fun applyLease', '\n    }\n'],
      ['private suspend fun pushedLease', '\n    }\n']
    ]) assert.match(section(model, from, to), /readStatus\(/, from);
  });

  it('what the UI calls while drawing never decrypts, and the counts need nothing opened', () => {
    const model = kt('AppModel.kt');
    for (const from of ['private fun signedStatus(', 'private fun unattendedTake(nodeId: String', 'private fun runningLeaseRows()', 'fun approvalList()']) {
      assert.ok(!section(model, from, '\n    }\n').includes('opener()'), from);
    }
    assert.match(model, /val named = Leases\.listedStatuses\(check, pin\)\n/);
  });

  it('the last known name of a take or task stays, and an unread one is never empty', () => {
    const model = kt('AppModel.kt');
    assert.match(section(model, 'private fun readStatus(', '\n    }\n'), /status\.name\?\.let \{ noteLeaseName\(status\.leaseId, it\) \}/);
    assert.match(section(model, 'private fun signedStatus(', '\n    }\n'), /named\(/);
    assert.match(section(model, 'private fun named(', '\n    }\n'), /leaseNames\[s\.leaseId\] \?: SEALED_NAME/);
    assert.match(section(model, 'private fun unattendedTake(nodeId: String', '\n    }\n'), /val status = signedStatus\(nodeId, signed\) \?: return null/);
    assert.match(section(model, 'fun killSwitch()', '// ---- Leases: end'), /leaseNames\[live\.leaseId\] \?: Leases\.taskStopName\(signedStatus\)/);
  });

  it('a decision looks again when it is made, and again after the prompt', () => {
    const model = kt('AppModel.kt');
    assert.match(section(model, 'private fun heldToSealing(', '\n'), /seal == SealState\.CLEAR && nodeId in sealedSeen/);
    const decide = section(model, 'private suspend fun decideNow', '\n    }\n');
    assert.equal(count(decide, 'approvalHeld(item)'), 2);
    assert.ok(decide.indexOf('approvalHeld(item)') < decide.indexOf('signEnvelope('));
    assert.ok(decide.lastIndexOf('approvalHeld(item)') > decide.indexOf('signEnvelope('));
    const answer = section(model, 'fun answer(item: QuestionItem', '\n    }\n');
    assert.equal(count(answer, 'heldToSealing(item.nodeId, item.seal)'), 2);
    assert.ok(answer.lastIndexOf('heldToSealing') > answer.indexOf('signEnvelope('));
    const lease = section(model, 'fun decideLease(', '\n    }\n');
    assert.equal(count(lease, 'heldToSealing(item.request.nodeId, item.seal)'), 2);
    assert.ok(lease.lastIndexOf('heldToSealing') > lease.indexOf('signEnvelope('));
  });

  it('the first sealed open also takes the buttons off what is already on screen', () => {
    const model = kt('AppModel.kt');
    assert.match(section(model, 'private fun noteSeal(nodeId: String, state: SealState)', '\n    }\n'), /demoteClear\(nodeId\)/);
    const demote = section(model, 'private fun demoteClear(', '\n    }\n');
    for (const store of ['pending', 'questions', 'leaseRequests']) assert.ok(demote.includes(store), store);
    // And the fetch that made the mark keeps the row, and looks again at what it read before the mark.
    assert.match(section(model, 'private fun takeApprovals', '\n    }\n'), /it\.ref !in unread && it\.ref\.removePrefix\(TOOL_REF\) !in listed/);
    assert.match(section(model, 'private suspend fun fetchQuestions', '\n    }\n'), /read\.partition \{ it\.unreadable != null \|\| heldToSealing\(it\.nodeId, it\.seal\) \}/);
    assert.match(section(model, 'private suspend fun refreshLeases', '\n    }\n'), /read\.partition \{ heldToSealing\(it\.request\.nodeId, it\.seal\) \}/);
  });
});

describe('Android: a sealed request is answered from what it opened to', () => {
  it('uses the salted check and responseToOpened, and keeps the clear path as it was', () => {
    const decide = section(kt('AppModel.kt'), 'private suspend fun decideNow', '\n    }\n');
    assert.match(decide, /Messages\.validateOpenedRequest\(opened\)/);
    assert.match(decide, /Messages\.responseToOpened\(opened, if \(approve\) "approve" else "deny", k\.deviceId, Timestamps\.string\(api\.now\(\)\)\)/);
    assert.match(decide, /Messages\.response\(item\.message, if \(approve\) "approve" else "deny", k\.deviceId, Timestamps\.string\(api\.now\(\)\)\)/);
    // The unsalted hash is only for a clear request.
    assert.ok(decide.indexOf('if (opened != null)') < decide.indexOf('Digest.sha256B64url'));
    const receive = section(kt('AppModel.kt'), 'private fun receive(', '\n    }\n');
    assert.match(receive, /opened = view\.opened/);
    assert.match(receive, /Display\.build\(view\.opened \?: message, collapse = false\)/);
  });

  it("a question goes through the core, which seals to the ask's own box", () => {
    assert.match(read(...CORE, 'Questions.kt'), /sealTo: JsonObject\? = item\.nodeBox/);
    assert.match(section(kt('AppModel.kt'), 'fun answer(item: QuestionItem', '\n    }\n'), /Questions\.answer\(item, optionId, text, k\.deviceId, Messages\.randomNonce\(\), Timestamps\.string\(api\.now\(\)\)\)/);
  });
});

describe('Android: what cannot be read offers no decision (R-SP-6, R-SP-15, Review Focus 2)', () => {
  it('the core gives such a row no button', () => {
    const list = read(...CORE, 'ApprovalList.kt');
    assert.match(list, /val sealedUnreadable: List<SealedUnreadable> = emptyList\(\)/);
    const row = section(list, 'private fun sealedRow(', '\n    )\n');
    assert.match(row, /buttons = emptyList\(\)/);
    assert.match(row, /enabled = false/);
    assert.match(row, /hasDetail = false/);
    assert.ok(!row.includes('decisionRow'));
    assert.ok(!/Button\.(APPROVE|DENY|REVIEW|OPEN|GOT_IT)/.test(row));
    assert.match(row, /Display\.escape\(/);
  });

  it('the app files them apart from what can be decided, from the verified clear part', () => {
    const model = kt('AppModel.kt');
    assert.match(section(model, 'fun approvalList()', '\n    }\n'), /sealedUnreadable = /);
    // Each reader's refusal goes to the row, past its signature.
    assert.match(section(model, 'private fun receive(', '\n    }\n'), /view\.reason in UNREADABLE_REASONS/);
    assert.match(section(model, 'private fun verifiedLeaseRequest', '\n    }\n'), /check\.reason in UNREADABLE_REASONS/);
    assert.match(section(model, 'private suspend fun fetchQuestions', '\n    }\n'), /\.unreadable/);
    assert.match(model, /val UNREADABLE_REASONS = setOf\("not_recipient", "open_failed", Seal\.KEY_LOCKED, Seal\.CLEAR_AFTER_SEALED\)/);
    // No decision can reach one: they are in no store a press or a detail reads.
    assert.match(section(model, 'fun press(row: ApprovalList.Row', '\n    }\n'), /ApprovalList\.Kind\.UNREADABLE -> Unit/);
    assert.match(section(model, 'fun open(row: ApprovalList.Row', '\n    }\n'), /ApprovalList\.Kind\.UNREADABLE -> null/);
  });

  it('the words are in one place, once each, and the node name in them is escaped', () => {
    const text = kt('OwnerText.kt');
    assert.equal(count(text, "Sealed for this node's other phones"), 1);
    assert.equal(count(text, 'Run device apply on'), 1);
    assert.match(text, /Sealed for this node's other phones\. Run device apply on \$\{Display\.escape\(nodeName\)\} for this phone\./);
    assert.equal(count(text, 'This node seals its messages. This one was not sealed, so it may be old.'), 1);
    assert.equal(count(text, 'Unlock to read'), 1);
    for (const file of ['AppModel.kt', 'Screens.kt', 'DetailScreens.kt', 'LeaseScreens.kt']) {
      for (const words of ["node's other phones", 'Run device apply', 'may be old', 'Unlock to read']) assert.ok(!kt(file).includes(words), `${file}: ${words}`);
    }
  });

  it('clear_after_sealed, key_locked and sealed_required have words where a refusal is read', () => {
    const friendly = section(kt('OwnerText.kt'), 'internal fun friendlyReason', '\n}\n');
    for (const code of ['Seal.CLEAR_AFTER_SEALED', 'Seal.KEY_LOCKED', '"sealed_required"']) assert.ok(friendly.includes(code), code);
  });
});
