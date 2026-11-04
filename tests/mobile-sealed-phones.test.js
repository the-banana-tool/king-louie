// tests/mobile-sealed-phones.test.js
//
// Sealed phones (plan docs/superpowers/plans/2026-11-04-sealed-phones.md, R-SP-6,
// R-SP-10, R-SP-15, Review Focus 2): what the two apps do with the box key,
// the statement flow and messages they cannot read. The app modules have no test
// target, so this reads their sources (as tests/mobile-lease-apps.test.js
// does): it shows the rules are written into the code, not that the app behaves.
// The protocol cores' rules are proven by their vectors (SealVectorTest.kt, SealVectorTests.swift).
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
    assert.match(kt('SettingsScreen.kt'), /if \(model\.boxKeyRefused\) \{\n\s+Text\(AppModel\.BOX_KEY_REFUSED_LINE/);
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
    assert.match(section(model, 'private fun takeApprovals', '\n    }\n'), /u\.ref !in unread && \(id !in listed \|\| pending\.any \{ it\.id == id \}\)/);
    assert.match(section(model, 'private suspend fun fetchQuestions', '\n    }\n'), /read\.partition \{ it\.unreadable != null \|\| heldToSealing\(it\.nodeId, it\.seal\) \}/);
    assert.match(section(model, 'private suspend fun refreshLeases', '\n    }\n'), /read\.partition \{ heldToSealing\(it\.request\.nodeId, it\.seal\) \}/);
  });
});

describe('Android: a box key that stopped working, or was refused', () => {
  it('a failure while unlocked that lasts gets its own reason, line and remedy', () => {
    const model = kt('AppModel.kt');
    assert.match(section(model, 'private fun deviceLocked()', '\n'), /KeyguardManager::class\.java\)\?\.isDeviceLocked == true/);
    const warm = section(model, 'private suspend fun warmSeals', '\n    }\n');
    assert.match(warm, /catch \(e: SealKeyUnavailableException\)/);
    assert.match(warm, /if \(deviceLocked\(\)\) sawLocked = true else sawFailure = true/);
    assert.match(warm, /boxKeyHealth\.failedUnlocked\(SystemClock\.elapsedRealtime\(\)\)/);
    assert.match(warm, /boxKeyBroken = boxKeyHealth\.broken/);
    const text = kt('OwnerText.kt');
    assert.equal(count(text, "This phone's box key stopped working. Make a new one in Settings."), 1);
    assert.match(section(text, 'internal fun unreadableLine', '\n}\n'), /AppModel\.BOX_KEY_BROKEN -> /);
    assert.match(section(model, 'private fun rowReason(', '\n'), /private fun rowReason\(u: UnreadableItem\)/);
    assert.match(section(model, 'private fun rowReason(', '\n    }\n'), /u\.reason == Seal\.KEY_LOCKED && boxKeyBroken -> BOX_KEY_BROKEN/);
    assert.match(section(model, 'fun approvalList()', '\n    }\n'), /unreadableLine\(rowReason\(u\), u\.nodeName\)/);
    assert.match(kt('SettingsScreen.kt'), /model\.boxKeyBroken/);
    assert.match(kt('SettingsScreen.kt'), /model\.remakeBoxKey\(\)/);
    const remake = section(model, 'fun remakeBoxKey()', '\n    }\n');
    for (const step of ['BoxKey.delete()', 'clearOpened()', 'boxKeyNodes.forget()', 'setUpBoxKey()']) assert.ok(remake.includes(step), step);
    assert.ok(remake.indexOf('BoxKey.delete()') < remake.indexOf('setUpBoxKey()'));
  });

  it('an entry that is gone is that failure too, not a wrap for someone else', () => {
    assert.match(section(kt('BoxKey.kt'), 'fun agree(x: String, y: String)', '\n    }\n'), /stored as\? PrivateKey \?: throw BoxKeyUnavailableException\(\)/);
  });

  it('a refusal can be tried again, a locked phone is never marked, and rows say the refusal', () => {
    const model = kt('AppModel.kt');
    assert.equal(count(model, 'if (!deviceLocked()) boxKeyNodes.markRefused(true)'), 1);
    assert.equal(count(model, 'if (boxKey == null && !deviceLocked()) boxKeyNodes.markRefused(true)'), 1);
    assert.equal(count(model, 'boxKeyNodes.markRefused(true)'), 2);
    const retry = section(model, 'fun retryBoxKey()', '\n    }\n');
    assert.ok(retry.indexOf('boxKeyNodes.markRefused(false)') >= 0 && retry.indexOf('boxKeyNodes.markRefused(false)') < retry.indexOf('setUpBoxKey()'));
    assert.match(kt('SettingsScreen.kt'), /model\.retryBoxKey\(\)[^\n]*\{ Text\("Try again"\) \}/);
    assert.match(section(model, 'private fun rowReason(', '\n    }\n'), /boxKeyNodes\.refused && u\.reason in setOf\("not_recipient", "open_failed"\) -> BOX_KEY_REFUSED/);
    assert.match(section(kt('OwnerText.kt'), 'internal fun unreadableLine', '\n}\n'), /AppModel\.BOX_KEY_REFUSED -> AppModel\.BOX_KEY_REFUSED_LINE/);
  });

  it('pairing a new node does not call old nodes told, when they never were', () => {
    const model = kt('AppModel.kt');
    const enrolled = section(model, 'private fun enrolledWithBoxKey(', '\n    }\n');
    assert.match(enrolled, /if \(boxKeyNodes\.sent \|\| storage\.nodes\.all \{ it\.id in enrolled \}\) boxKeyNodes\.markSent\(\)/);
    assert.equal(count(model, 'boxKeyNodes.markSent()'), 2, 'after a post, and here');
    assert.match(section(model, 'private suspend fun pairAtConsole', '\n    }\n'), /enrolledWithBoxKey\(setOf\(pin\.id\)\)/);
    assert.match(section(model, 'private suspend fun claimInvite', '\n    }\n'), /enrolledWithBoxKey\(pins\.map \{ it\.id \}\.toSet\(\)\)/);
  });

  it('the one-way mark is written at once, and again if the store lost it', () => {
    assert.match(section(kt('Storage.kt'), 'var sealedSeen: Set<String>', '\n\n'), /\.commit\(\)/);
    assert.match(section(kt('AppModel.kt'), 'private fun noteSeal(nodeId: String, state: SealState)', '\n    }\n'), /if \(storage\.sealedSeen != next\) storage\.sealedSeen = next/);
  });

  it('a retry looks again before each send, and the label is not a guess', () => {
    const model = kt('AppModel.kt');
    const loop = section(section(model, 'private suspend fun sendResponse', '\n    }\n'), 'while (true) {', 'api.respond(');
    assert.match(loop, /if \(approvalHeld\(item\)\) \{\n\s+refuseHeldApproval\(item\)\n\s+return null/);
    assert.match(section(model, 'private fun unreadableLease(', '\n    )\n'), /leaseLabel\(item\.request\.kind\)/);
    assert.match(section(model, 'private fun verifiedLeaseRequest', '\n    }\n'), /leaseLabel\(status\?\.kind\)/);
    const label = section(kt('OwnerText.kt'), 'internal fun leaseLabel', '\n}\n');
    for (const [kind, word] of [['computer_use', 'Computer use'], ['take', 'Take'], ['task', 'Task']]) assert.ok(label.includes(`"${kind}" -> "${word}"`), kind);
    assert.match(label, /else -> "Request"/);
    assert.ok(!model.includes('"Computer use", '), 'no guess is left');
    assert.ok(!/\(none, or the Keystore did not answer\)/.test(kt('BoxKey.kt')));
  });
});

describe('Android: the Keystore, off the main thread, and plaintext kept briefly', () => {
  it('warmSeals verifies first, opens off the main thread and marks nothing', () => {
    const model = kt('AppModel.kt');
    const warm = section(model, 'private suspend fun warmSeals', '\n    }\n');
    assert.match(warm, /withContext\(Dispatchers\.IO\)/);
    assert.ok(warm.indexOf('verifiedSealed(raw, pins)') >= 0 && warm.indexOf('verifiedSealed(raw, pins)') < warm.indexOf('open('));
    assert.ok(!warm.includes('noteSeal('));
    const verified = section(model, 'private fun verifiedSealed(', '\n    }\n');
    assert.match(verified, /Leases\.verifiedMessage\(envelope, pin\)/);
    assert.match(verified, /containsKey\("sealed"\)/);
    // What already opened is not asked for again, and a fresh open is what proves the key.
    assert.match(warm, /message in openedMemo/);
    assert.match(warm, /sawOpen = true/);
  });

  it('a failure is remembered for one fetch and the memo keeps only successes', () => {
    const model = kt('AppModel.kt');
    const opener = section(model, 'private fun opener(): Opener?', '\n    }\n');
    assert.match(opener, /val failed = synchronized\(openedMemo\) \{ failedOpens\[message\] \}\n\s+if \(failed != null\) throw failed/);
    // The only write to the memo is after an open returned, and only for the generation that asked.
    assert.equal(count(model, 'openedMemo[message] = '), 1);
    assert.match(opener, /open\(type, message\)\.also \{ opened ->\n\s+synchronized\(openedMemo\) \{ if \(generation == openedGeneration\) openedMemo\[message\] = opened \}/);
    const warm = section(model, 'private suspend fun warmSeals', '\n    }\n');
    assert.match(warm, /failedOpens\.clear\(\)/);
    assert.match(warm, /if \(generation == openedGeneration\) failedOpens\[message\] = e/);
  });

  it('every reader the network reaches off a fetch warms first', () => {
    const model = kt('AppModel.kt');
    assert.match(section(model, 'fun openPushed(', '\n    }\n'), /api\.approval\(id\)\?\.let \{ entry ->\n\s+warmSeals\(listOf\(entry\)\)\n\s+receive\(entry, storage\.nodes\)/);
    const decide = section(model, 'fun decideLease(', '\n    }\n');
    assert.ok(decide.indexOf('warmSeals(listOfNotNull(sent.json))') >= 0);
    assert.ok(decide.indexOf('warmSeals(listOfNotNull(sent.json))') < decide.indexOf('noteListedLease('));
    assert.match(section(model, 'fun watchWithFingerprint()', '\n    }\n'), /warmSeals\(listOfNotNull\(sent\.json\)\)/);
    assert.match(section(model, 'fun killSwitch()', '\n    }\n'), /warmSeals\(listOfNotNull\(sent\.json\)\)/);
    const liveLoop = section(model, '// ---- Live view loop (android-slim §7.6) ----', '// ---- Live view loop: end ----');
    assert.equal(count(liveLoop, 'warmSeals('), 3, 'a listing, a watch reply and each view');
    const fetches = [section(model, 'private fun takeApprovals', '\n    }\n'), section(model, 'private suspend fun fetchQuestions', '\n    }\n'), section(model, 'private suspend fun refreshLeases', '\n    }\n')];
    assert.match(fetches[1], /warmSeals\(listed\)/);
    assert.match(fetches[2], /warmSeals\(listed\)/);
    assert.match(section(model, 'private inner class ForegroundLoop', 'private fun takeApprovals'), /warmSeals\(items\)\n\s+takeApprovals\(items\)/);
  });

  it('plaintext leaves with the screen, and nothing in flight brings it back', () => {
    const model = kt('AppModel.kt');
    const clear = section(model, 'private fun clearOpened()', '\n    }\n');
    assert.match(clear, /openedGeneration\+\+/);
    assert.match(clear, /openedMemo\.clear\(\)/);
    assert.match(clear, /failedOpens\.clear\(\)/);
    assert.match(section(model, 'fun onBackground()', '\n    }\n'), /clearOpened\(\)/);
    assert.match(section(model, 'fun closeLiveLease()', '\n    }\n'), /clearOpened\(\)/);
    assert.match(section(model, 'private suspend fun finishReset', 'companion object'), /clearOpened\(\)/);
    // A view's entry goes once it was read, applied or not.
    const apply = section(model, 'private fun applyLease', '\n    }\n');
    assert.ok(apply.indexOf('dropOpenedViews()') > apply.indexOf('Leases.verifyView('));
    assert.ok(apply.indexOf('dropOpenedViews()') < apply.indexOf('check.view?.takeIf'));
    assert.match(section(model, 'private fun dropOpenedViews()', '\n    }\n'), /"kl\.lease\.view"/);
  });
});

describe('Android: the shape of the gate', () => {
  it('approvalHeld is exactly a clear item of a node seen sealing', () => {
    assert.match(kt('AppModel.kt'), /private fun approvalHeld\(item: PendingItem\): Boolean = item\.opened == null && heldToSealing\(item\.display\["node"\]\["id"\]\.str\(\) \?: "", SealState\.CLEAR\)\n/);
  });

  it('demoteClear leaves what is decided or under way, and only that node', () => {
    const demote = section(kt('AppModel.kt'), 'private fun demoteClear(', '\n    }\n');
    assert.match(demote, /pending\.filter \{ approvalHeld\(it\) && it\.status == null && !it\.deciding && it\.display\["node"\]\["id"\]\.str\(\) == nodeId \}/);
    assert.match(demote, /questions\.filter \{ it\.nodeId == nodeId && heldToSealing\(it\.nodeId, it\.seal\) && it\.token !in answering \}/);
    assert.match(demote, /leaseRequests\.filter \{ it\.request\.nodeId == nodeId && heldToSealing\(it\.request\.nodeId, it\.seal\) && it\.request\.requestId !in decidingLease \}/);
  });

  it('a key counts as sent only after the post returned', () => {
    const setUp = section(kt('AppModel.kt'), 'fun setUpBoxKey()', '\n    }\n');
    assert.ok(setUp.indexOf('postBoxKey(api, envelope)') >= 0 && setUp.indexOf('postBoxKey(api, envelope)') < setUp.indexOf('boxKeyNodes.markSent()'));
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

// ---- iOS (Task 11). The app module cannot be compiled here, so these read the
// Swift sources as the rest of this file reads the Kotlin. ----

const IOS = ['mobile', 'ios', 'App'];
const SWIFT_CORE = ['mobile', 'ios', 'KLProtocol', 'Sources', 'KLProtocol'];
const ios = (file) => read(...IOS, file);
const iosModel = () => ios('AppModel.swift');

describe('iOS: the box key (R-SP-10)', () => {
  it('BoxKey.swift makes a Secure Enclave agreement key with no biometry, usable only while unlocked', () => {
    const box = ios('BoxKey.swift');
    assert.match(box, /SecureEnclave\.P256\.KeyAgreement\.PrivateKey\(accessControl: access\)/);
    assert.match(box, /SecAccessControlCreateWithFlags\(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,\s+\[\.privateKeyUsage\], &error\)/);
    assert.ok(!box.includes('.biometryCurrentSet'), 'a box key never prompts');
    assert.ok(!box.includes('.userPresence'));
    assert.ok(!box.includes('LAContext'), 'no prompt, no context');
    assert.match(box, /static let account = "kl\.box-key"/);
    assert.match(box, /kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
    assert.match(box, /Messages\.boxKeyFingerprint\(x: x, y: y\)/);
    assert.match(box, /Messages\.jwk\(x: x, y: y\)/);
  });

  it('agree gives the raw secret, and a locked phone is SealKeyUnavailable, never open_failed', () => {
    const agree = section(ios('BoxKey.swift'), 'func agree(x: String, y: String) throws -> Data', '\n    }\n');
    assert.match(agree, /sharedSecretFromKeyAgreement\(with: peer\)/);
    assert.match(agree, /withUnsafeBytes \{ Data\(\$0\) \}/);
    // Every Secure Enclave step is inside the do, and its catch has one answer.
    const body = agree.slice(agree.indexOf('do {'));
    assert.ok(body.indexOf('SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation:') < body.indexOf('} catch {'));
    assert.ok(body.indexOf('sharedSecretFromKeyAgreement') < body.indexOf('} catch {'));
    assert.match(body, /\} catch \{\n\s+throw SealKeyUnavailable\(/);
  });

  it('DeviceKey.create makes it once the device key is written, and delete removes it', () => {
    const dk = ios('DeviceKey.swift');
    const create = section(dk, 'static func create() throws -> DeviceKey', '\n    }\n');
    // keychainWrite calls delete(), which takes the box key with it: so it comes after.
    assert.ok(create.indexOf('try keychainWrite(') >= 0 && create.indexOf('try keychainWrite(') < create.indexOf('BoxKey.create()'));
    assert.match(create, /do \{ _ = try BoxKey\.create\(\) \} catch \{ BoxKey\.delete\(\) \}/);
    assert.match(section(dk, 'static func delete()', '\n    }\n'), /BoxKey\.delete\(\)/);
  });

  it('an enrollment and an invite claim carry it', () => {
    const device = section(iosModel(), 'private func deviceObject(for key: DeviceKey)', '\n    }\n');
    assert.match(device, /Messages\.device\(deviceId: key\.deviceId, name: UIDevice\.current\.name, platform: "ios", x: key\.jwkX, y: key\.jwkY, boxKey: boxKey\?\.jwk\)/);
  });

  it('an inviter takes a claim that carries one, on both phones, bound by the same mac', () => {
    const claim = section(iosModel(), 'private func verifiedClaim', '\n    }\n');
    assert.match(claim, /Messages\.device\(deviceId: id, name: name, platform: platform, x: x, y: y, boxKey: device\["box_key"\]\), rebuilt == device/);
    const flow = kt('InviteFlow.kt');
    const android = section(flow, 'private fun verifiedClaim', '\n    }\n');
    assert.match(android, /val boxJwk = device\["box_key"\]\?\.takeIf \{ it !is JsonNull \}\?\.let \{ bk ->\n\s+Messages\.jwk\(bk\["x"\]\.str\(\) \?: return null, bk\["y"\]\.str\(\) \?: return null\)/);
    assert.match(android, /Messages\.device\(id, name, platform, x, y, readJwk, boxJwk\)/);
    assert.match(android, /if \(rebuilt != device \|\| id == ownDeviceId\) return null/);
  });
});

describe('iOS: the box key statement (R-SP-10)', () => {
  it('is signed with signEnvelope, a fresh prompt, and never with the session', () => {
    const sign = section(iosModel(), 'private func signBoxKeyStatement', '\n    }\n');
    assert.match(sign, /Messages\.boxKeyStatement\(deviceId: key\.deviceId, boxKey: box\.jwk,/);
    assert.match(sign, /key\.signEnvelope\(message, reason:/);
    assert.ok(!/signForSession|signIfUnlocked|signRefusalEnvelope|signWatchEnvelope|sessionOnlySigner/.test(sign));
    assert.match(iosModel(), /static let boxKeyStatementSeconds: TimeInterval = 7 \* 24 \* 60 \* 60/);
  });

  it('RelayAPI posts it to the route ROUTE_AUTH names, and an older relay says so', () => {
    assert.match(ios('RelayAPI.swift'), /func postBoxKey\(_ statement: Envelope, signWith: Signer\? = nil\) async throws -> JSONValue\? \{\n\s+try await request\("POST", "\/v1\/devices\/box-key", body: statement\.json, signWith: signWith\)\.1/);
    const post = section(iosModel(), 'private func postBoxKey', '\n    }\n');
    assert.match(post, /catch let e as RelayError where e\.status == 404/);
    assert.match(post, /throw ProtocolError\.malformed\(Self\.olderRelay\)/);
    assert.equal(count(iosModel(), 'static let olderRelay = "This relay is older than this app. Upgrade it, then try again."'), 1);
  });

  it("keeps each node's answer and the statement until it expires, beside the pins", () => {
    const nodes = section(ios('BoxKey.swift'), 'struct BoxKeyNodes', '\n}\n');
    for (const state of ['box-key-pending-apply', 'applied', 'duplicate', 'rejected']) assert.ok(nodes.includes(`"${state}"`), state);
    assert.match(nodes, /mutating func kept\(relayNow: Date\) -> Envelope\?/);
    assert.match(nodes, /var anyOffline: Bool/);
    assert.match(nodes, /statement = nil/);
    assert.match(nodes, /UserDefaults\.standard/);
  });

  it('goes again to nodes that answered offline, from the poll, with no prompt', () => {
    const model = iosModel();
    const repost = section(model, 'private func repostBoxKeyStatement', '\n    }\n');
    assert.match(repost, /guard boxKeyNodes\.anyOffline/);
    assert.match(repost, /boxKeyNodes\.kept\(relayNow: client\.now\(\)\)/);
    assert.match(repost, /signWith: Self\.sessionOnlySigner\(key\)/);
    assert.match(repost, /firstPost: false/);
    assert.ok(!repost.includes('signEnvelope'));
    assert.match(section(model, 'private func pollLoop', '\n    }\n'), /await repostBoxKeyStatement\(client\)/);
  });

  it('a key counts as sent only after the post returned, and a new node is not the old ones told', () => {
    const model = iosModel();
    const setUp = section(model, 'func setUpBoxKey() async', '\n    }\n');
    assert.ok(setUp.indexOf('postBoxKey(client, envelope)') >= 0 && setUp.indexOf('postBoxKey(client, envelope)') < setUp.indexOf('boxKeyNodes.markSent()'));
    const enrolled = section(model, 'private func enrolledWithBoxKey(', '\n    }\n');
    assert.match(enrolled, /if boxKeyNodes\.sent \|\| state\.nodes\.allSatisfy\(\{ enrolled\.contains\(\$0\.id\) \}\) \{ boxKeyNodes\.markSent\(\) \}/);
    assert.equal(count(model, 'boxKeyNodes.markSent()'), 2, 'after a post, and here');
    assert.match(section(model, 'private func pairAtConsole', '\n    }\n'), /enrolledWithBoxKey\(\[pin\.id\]\)/);
    assert.match(section(model, 'private func claimInvite', '\n    }\n'), /enrolledWithBoxKey\(Set\(pins\.map \{ \$0\.id \}\)\)/);
  });

  it('the list and Settings offer it', () => {
    const views = ios('Views.swift');
    assert.match(views, /if model\.boxKeySetupNeeded \{/);
    assert.match(views, /await model\.setUpBoxKey\(\)/);
    assert.match(views, /model\.boxKeyFingerprint/);
    assert.match(views, /await model\.sendBoxKeyAgain\(\)/);
    assert.match(views, /case \.waitingForApply:/);
    const android = read(...KT, 'AppModel.kt').match(/const val BOX_KEY_SETUP_TITLE = "([^"]+)"/)[1];
    // The one difference from Android: iOS's prompt unlocks, whichever biometry the phone has.
    assert.ok(android.includes('one fingerprint'));
    assert.equal(count(iosModel(), `static let boxKeySetupTitle = "${android.replace('one fingerprint', 'one unlock')}"`), 1);
    // And the row shows only when the post needs no second prompt.
    assert.match(section(iosModel(), 'var boxKeySetupNeeded: Bool', '\n'), /key\?\.isSessionUnlocked == true/);
  });

  it('the key a pairing made, or a locked launch could not read, reaches the model', () => {
    const model = iosModel();
    const ensure = section(model, 'private func ensureKey() throws -> DeviceKey', '\n    }\n');
    assert.ok(ensure.indexOf('key = created') >= 0 && ensure.indexOf('key = created') < ensure.indexOf('boxKeyMade()'));
    assert.match(section(model, 'private func boxKeyMade()', '\n    }\n'), /boxKey = BoxKey\.load\(\)/);
    assert.match(section(model, '    init() {', '\n    }\n'), /boxKey = BoxKey\.load\(\)/);
    assert.match(section(model, 'func resumePolling()', '\n    }\n'), /if boxKey == nil, mode == \.live \{ boxKey = BoxKey\.load\(\) \}/);
  });

  it('a key that cannot agree is never kept', () => {
    const create = section(ios('BoxKey.swift'), 'static func create() throws -> BoxKey', '\n    }\n');
    const first = create.indexOf('_ = try key.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PrivateKey().publicKey)');
    assert.ok(first >= 0 && first < create.indexOf('delete()') && first < create.indexOf('SecItemAdd('));
  });

  it('what a fetch read reaches the stores a screen draws', () => {
    const model = iosModel();
    const questions = section(model, 'func refreshQuestions(', '\n    }\n');
    assert.match(questions, /questions = read\.filter \{ \$0\.unreadable == nil && !heldToSealing\(\$0\.nodeId, \$0\.seal\) \}/);
    const leases = section(model, 'func refreshLeases', 'func decideLease');
    assert.match(leases, /let items = read\.filter \{ !heldToSealing\(\$0\.request\.nodeId, \$0\.seal\) \}\n/);
    assert.match(leases, /leaseRequests = items\n/);
  });

  it('an open request screen loses Allow and Deny once the request cannot be decided', () => {
    const views = ios('LeaseViews.swift');
    const body = section(section(views, 'struct LeaseRequestView: View', '\n}\n'), 'var body: some View {', '\n    }\n');
    assert.match(body, /if model\.leaseRequests\.contains\(where: \{ \$0\.id == item\.id \}\) \{\n\s+requestForm\n\s+\} else \{/);
    assert.ok(!/Button|decideLease/.test(body));
    assert.ok(section(views, 'private var requestForm: some View', '\n    }\n').includes('await model.decideLease(item,'));
  });
});

describe('iOS: sealedSeen (R-SP-15)', () => {
  it('is persisted beside the pins, durably, apart from what a pairing puts back', () => {
    const model = iosModel();
    const store = section(model, 'enum SealedSeenStore', '\n}\n');
    assert.match(store, /UserDefaults\.standard\.set\(nodes\.sorted\(\), forKey: key\)/);
    assert.match(section(store, 'static func save(', '\n    }\n'), /synchronize\(\)/);
    // In StoredState a new key would fail the old decode and lose the pins, and `restore` would put an old set back.
    assert.ok(!section(model, 'struct StoredState: Codable', '\n}\n').includes('sealedSeen'));
    assert.match(model, /private var sealedSeen: Set<String> = SealedSeenStore\.load\(\)/);
  });

  it('Reset clears it, on disk and in memory, and nothing else does', () => {
    const model = iosModel();
    const reset = section(model, 'func reset() {', '\n    }\n');
    assert.match(reset, /SealedSeenStore\.clear\(\)/);
    assert.match(reset, /sealedSeen = \[\]/);
    assert.equal(count(model, 'SealedSeenStore.clear()'), 1);
  });

  it('the three deciding readers get the persisted set and the opener; only the demo has an empty one', () => {
    const model = iosModel();
    assert.equal(count(model, 'sealedSeen: []'), 1);
    assert.match(section(model, 'func startDemo()', '\n    }\n'), /sealedSeen: \[\]/);
    assert.match(section(model, 'private func receive(', '\n    }\n'), /Display\.view\(envJSON, pinned: pins, open: opener\(\), sealedSeen: sealedSeen\)/);
    assert.match(section(model, 'private func verifiedQuestion', '\n    }\n'), /QuestionItem\(message: message, nodeName: pin\.name, open: opener\(\), sealedSeen: sealedSeen\)/);
    assert.match(section(model, 'private func verifiedLeaseRequest', '\n    }\n'), /LeaseRequest\.check\(message, open: opener\(\), sealedSeen: sealedSeen\)/);
    assert.equal(count(model, 'LeaseRequest(message:'), 1, 'the demo alone: check keeps the reason and the state');
  });

  it('every one of the eight calls that default to no opener is passed one', () => {
    const model = iosModel();
    // No LeaseStatus and no view is read with the default.
    assert.ok(!/LeaseStatus\(message: [^,)]+\)/.test(model), 'LeaseStatus(message:) always has its open');
    assert.ok(!/Leases\.verifyView\(envelope, pin: pin\)/.test(model), 'verifyView always has its open');
    assert.ok(!/Leases\.listedStatuses\(check, pin: pin\)/.test(model), 'listedStatuses always has its open');
    // The network's: readStatus, the one reader that opens a status.
    const status = section(model, 'private func readStatus(', '\n    }\n');
    assert.match(status, /Leases\.verifiedMessage\(envelope, pin: pin\)\.flatMap\(\{ LeaseStatus\(message: \$0, open: opener\(\)\) \}\)/);
    for (const [from, to] of [
      ['private func verifiedLeaseRequest', '\n    }\n'], // refreshLeases' request status
      ['private func apply(', '\n    }\n'],
      ['private func noteListedLease', '\n    }\n'],
      ['private func notePendingListed', '\n    }\n']
    ]) assert.match(section(model, from, to), /readStatus\(/, from);
    assert.match(section(model, 'private func apply(', '\n    }\n'), /Leases\.verifyView\(envelope, pin: pin, open: opener\(\)\)/);
    // Drawing and the counts: what is already open, and nothing that asks the key.
    assert.match(section(model, 'func unattendedTake(', '\n    }\n'), /LeaseStatus\(message: message, open: openedOnly\(\)\)/);
    assert.match(section(model, 'func runningTask(', '\n    }\n'), /LeaseStatus\(message: message, open: openedOnly\(\)\)/);
    assert.match(section(model, 'func refreshLeases', 'func decideLease'), /Leases\.listedStatuses\(check, pin: pin, open: openedOnly\(\)\)/);
  });

  it('what drawing calls never decrypts, and the last known name stays', () => {
    const model = iosModel();
    for (const from of ['func unattendedTake(', 'func runningTask(', 'func bannerTitle(', 'func pendingDetail(', 'func unreadableRows(', 'func unreadableText(']) {
      const body = section(model, from, '\n    }\n');
      assert.ok(!body.includes('opener()') && !body.includes('readStatus(') && !body.includes('agree'), from);
    }
    const only = section(ios('BoxKey.swift'), 'var openedOnly: Opener', '\n    }\n');
    assert.ok(!only.includes('agree') && !only.includes('open('), 'the memo, or a refusal');
    assert.match(only, /throw SealKeyUnavailable\(/);
    assert.match(section(model, 'private func readStatus(', '\n    }\n'), /if let name = status\.name \{ noteLeaseName\(status\.leaseId, name\) \}/);
    assert.match(section(model, 'private func shownName(', '\n    }\n'), /status\.name \?\? leaseNames\[status\.leaseId\] \?\? Self\.sealedName/);
    assert.match(section(model, 'func unattendedTake(', '\n    }\n'), /shownName\(status\)/);
    assert.match(section(model, 'func runningTask(', '\n    }\n'), /shownName\(status\)/);
    assert.match(section(model, 'func killSwitch()', '\n    }\n'), /leaseNames\[leaseId\] \?\? Leases\.taskStopName\(signedStatus\)/);
    assert.match(section(model, 'func reset() {', '\n    }\n'), /leaseNames = \[:\]/);
  });

  it('only a verified open marks a node, through one function, statuses and views included', () => {
    const model = iosModel();
    const note = section(model, 'private func noteSeal(_ nodeId: String, _ state: SealState)', '\n    }\n');
    assert.match(note, /Seal\.noteSealedSeen\(sealedSeen, nodeId: nodeId, state: state\)/);
    assert.match(note, /if SealedSeenStore\.load\(\) != next \{ SealedSeenStore\.save\(next\) \}/);
    assert.match(note, /if marked \{ demoteClear\(nodeId\) \}/);
    assert.equal(count(model, 'Seal.noteSealedSeen('), 1);
    assert.match(section(model, 'private func receive(', '\n    }\n'), /if view\.seal == \.opened \{ noteSeal\(env\.kid, view\.seal\) \}/);
    const question = section(model, 'private func verifiedQuestion', '\n    }\n');
    assert.ok(question.indexOf('envelope.verifyEd25519(spkiHex: pin.key)') >= 0 && question.indexOf('envelope.verifyEd25519(spkiHex: pin.key)') < question.indexOf('QuestionItem('));
    assert.ok(question.indexOf('message["node_id"]?.stringValue == pin.id') >= 0 && question.indexOf('message["node_id"]?.stringValue == pin.id') < question.indexOf('QuestionItem('));
    assert.match(question, /noteSeal\(pin\.id, item\.seal\)/);
    assert.match(section(model, 'private func verifiedLeaseRequest', '\n    }\n'), /noteSeal\(pin\.id, check\.seal\)/);
    assert.match(section(model, 'private func readStatus(', '\n    }\n'), /noteSeal\(pin\.id, status\.seal\)/);
    const apply = section(model, 'private func apply(', '\n    }\n');
    assert.ok(apply.indexOf('guard check.accepted') >= 0 && apply.indexOf('guard check.accepted') < apply.indexOf('noteSeal(pin.id, view.seal)'), 'a rejected view marks nothing');
  });

  it('a decision looks again when it is made, again after the prompt, and again in a retry', () => {
    const model = iosModel();
    assert.match(section(model, 'private func heldToSealing(', '\n'), /seal == \.clear && sealedSeen\.contains\(nodeId\)/);
    assert.match(model, /private func approvalHeld\(_ item: PendingItem\) -> Bool \{ item\.opened == nil && heldToSealing\(item\.display\["node"\]\?\["id"\]\?\.stringValue \?\? "", \.clear\) \}/);
    const decide = section(model, 'func decide(_ item: PendingItem, approve: Bool) async', '\n    }\n');
    assert.equal(count(decide, 'approvalHeld(item)'), 2);
    assert.ok(decide.indexOf('approvalHeld(item)') < decide.indexOf('signEnvelope('));
    assert.ok(decide.lastIndexOf('approvalHeld(item)') > decide.indexOf('signEnvelope('));
    const answer = section(model, 'func answer(_ item: QuestionItem', '\n    }\n');
    assert.equal(count(answer, 'heldToSealing(item.nodeId, item.seal)'), 2);
    assert.ok(answer.indexOf('heldToSealing') < answer.indexOf('signEnvelope('));
    assert.ok(answer.lastIndexOf('heldToSealing') > answer.indexOf('signEnvelope('));
    const lease = section(model, 'func decideLease(', '\n    }\n');
    assert.equal(count(lease, 'heldToSealing(item.request.nodeId, item.seal)'), 2);
    assert.ok(lease.indexOf('heldToSealing') < lease.indexOf('signEnvelope('));
    assert.ok(lease.lastIndexOf('heldToSealing') > lease.lastIndexOf('signEnvelope('));
    const loop = section(section(model, 'private func sendResponse', '\n    }\n'), 'while true {', 'client.respond(');
    assert.match(loop, /if approvalHeld\(item\) \{\n\s+refuseHeldApproval\(item\)\n\s+return nil/);
  });

  it('the first sealed open also takes the buttons off what is already on screen', () => {
    const model = iosModel();
    const demote = section(model, 'private func demoteClear(', '\n    }\n');
    assert.match(demote, /pending\.filter\(\{ approvalHeld\(\$0\) && \$0\.status == nil && !decidingApprovals\.contains\(\$0\.id\) && \$0\.display\["node"\]\?\["id"\]\?\.stringValue == nodeId \}\)/);
    assert.match(demote, /questions\.filter\(\{ \$0\.nodeId == nodeId && heldToSealing\(\$0\.nodeId, \$0\.seal\) && !answering\.contains\(\$0\.token\) \}\)/);
    assert.match(demote, /leaseRequests\.filter\(\{ \$0\.request\.nodeId == nodeId && heldToSealing\(\$0\.request\.nodeId, \$0\.seal\) && !decidingLease\.contains\(\$0\.id\) \}\)/);
    // And the fetch that made the mark looks again at what it read before the mark.
    assert.match(section(model, 'func refreshQuestions(', '\n    }\n'), /read\.filter \{ \$0\.unreadable != nil \|\| heldToSealing\(\$0\.nodeId, \$0\.seal\) \}/);
    assert.match(section(model, 'func refreshLeases', 'func decideLease'), /read\.filter \{ !heldToSealing\(\$0\.request\.nodeId, \$0\.seal\) \}/);
    // A stale row goes when its item can be read now, and one this batch made stays.
    assert.match(section(model, 'private func takeApprovals', '\n    }\n'), /!unread\.contains\(u\.ref\) && \(!listed\.contains\(id\) \|\| pending\.contains\(where: \{ \$0\.id == id \}\)\)/);
  });
});

describe('iOS: reading off the main actor, and plaintext kept briefly', () => {
  it('warmSeals verifies first, opens detached from the main actor and marks nothing', () => {
    const model = iosModel();
    const warm = section(model, 'private func warmSeals', '\n    }\n');
    assert.match(warm, /Task\.detached/);
    assert.ok(warm.indexOf('AppModel.verifiedSealed(raw, pins: pins)') >= 0 && warm.indexOf('AppModel.verifiedSealed(raw, pins: pins)') < warm.indexOf('try open('));
    assert.ok(!warm.includes('noteSeal('));
    assert.match(warm, /memo\.holds\(message\)/);
    const verified = section(model, 'nonisolated private static func verifiedSealed', '\n    }\n');
    assert.match(verified, /Leases\.verifiedMessage\(envelope, pin: pin\)/);
    assert.match(verified, /message\["sealed"\] != nil/);
  });

  it('every reader the network reaches warms first', () => {
    const model = iosModel();
    assert.match(section(model, 'func refreshQuestions(', '\n    }\n'), /await warmSeals\(listed\)/);
    assert.match(section(model, 'func refreshLeases', 'func decideLease'), /await warmSeals\(entries\)/);
    assert.match(section(model, 'private func pollLoop', '\n    }\n'), /await warmSeals\(items\)\n\s+takeApprovals\(items\)/);
    assert.match(section(model, 'func openPushed(requestId: String) async', '\n    }\n'), /await warmSeals\(\[item\]\)\n\s+receive\(item, pins: state\.nodes\)/);
    assert.match(section(model, 'func decide(_ item: PendingItem, approve: Bool) async', '\n    }\n'), /await warmSeals\(\[fresh\]\)\n\s+receive\(fresh, pins: state\.nodes\)/);
    const decide = section(model, 'func decideLease(', '\n    }\n');
    assert.ok(decide.indexOf('await warmReply(result)') >= 0 && decide.indexOf('await warmReply(result)') < decide.indexOf('noteListedLease('));
    const loop = section(model, 'private func startLiveLoop()', '\n    }\n');
    assert.match(loop, /await self\.warmReply\(reply\)\n\s+\/\/ The status the node signed for this watch/);
    assert.ok(loop.indexOf('await self.warmSeals(entries)') >= 0 && loop.indexOf('await self.warmSeals(entries)') < loop.indexOf('guard var current = self.liveLease'), 'no await between reading the lease and writing it back');
    assert.match(section(model, 'func killSwitch()', '\n    }\n'), /await self\.warmReply\(reply\)/);
  });

  it('the memo keeps only successes, for the generation that asked', () => {
    const memo = section(ios('BoxKey.swift'), 'final class SealMemo', '\n}\n');
    assert.equal(count(memo, 'opened[key] = '), 1);
    assert.match(memo, /if asked == generation && !paused \{/);
    assert.match(section(memo, 'func clear()', '\n    }\n'), /generation \+= 1/);
    assert.match(section(memo, 'func clear()', '\n    }\n'), /opened = \[:\]/);
    assert.match(section(memo, 'func clear()', '\n    }\n'), /failed = \[:\]/);
  });

  it('plaintext leaves with the screen, and nothing in flight brings it back', () => {
    const model = iosModel();
    assert.match(section(model, 'func didEnterBackground()', '\n    }\n'), /clearOpened\(\)/);
    assert.match(section(model, 'func didEnterBackground()', '\n    }\n'), /sealMemo\.pause\(\)/);
    assert.match(ios('KingLouieApp.swift'), /case \.background: model\.didEnterBackground\(\)/);
    assert.match(section(model, 'func resumePolling()', '\n    }\n'), /sealMemo\.resume\(\)/);
    assert.match(section(model, 'func closeLiveLease()', '\n    }\n'), /clearOpened\(\)/);
    assert.match(section(model, 'func setLiveViewVisible(', '\n    }\n'), /if !visible \{ clearOpened\(\) \}/);
    assert.match(section(model, 'func reset() {', '\n    }\n'), /clearOpened\(\)/);
    assert.match(section(model, 'private func dropInvalidKey()', '\n    }\n'), /clearOpened\(\)/);
    // A view's entry goes once it was read, applied or not.
    const apply = section(model, 'private func apply(', '\n    }\n');
    assert.ok(apply.indexOf('dropOpenedView(envelope)') > apply.indexOf('Leases.verifyView('));
    assert.ok(apply.indexOf('dropOpenedView(envelope)') < apply.indexOf('guard check.accepted'));
    // A set-up whose await a Reset overtook sets nothing.
    assert.match(section(model, 'func setUpBoxKey() async', '\n    }\n'), /guard self\.key === key else \{ return \}/);
  });
});

describe('iOS: a box key that stopped working, or was refused', () => {
  it('a failure on an unlocked phone that lasts gets its own reason, line and remedy', () => {
    const model = iosModel();
    assert.match(section(model, 'private func deviceLocked()', '\n'), /!UIApplication\.shared\.isProtectedDataAvailable/);
    const warm = section(model, 'private func warmSeals', '\n    }\n');
    assert.match(warm, /boxKeyHealth\.opened\(\)/);
    assert.match(warm, /if deviceLocked\(\) \{ boxKeyHealth\.locked\(\) \} else \{ boxKeyHealth\.failedUnlocked\(nowMs: healthNowMs\(\)\) \}/);
    assert.match(warm, /boxKeyBroken = boxKeyHealth\.broken/);
    assert.match(section(model, 'private func rowReason(', '\n    }\n'), /reason == Seal\.keyLocked && boxKeyBroken/);
    const views = ios('Views.swift');
    assert.match(views, /model\.boxKeyBroken/);
    assert.match(views, /await model\.remakeBoxKey\(\)/);
    const remake = section(model, 'func remakeBoxKey() async', '\n    }\n');
    for (const step of ['BoxKey.delete()', 'clearOpened()', 'boxKeyNodes.forget()', 'await setUpBoxKey()']) assert.ok(remake.includes(step), step);
    assert.ok(remake.indexOf('BoxKey.delete()') < remake.indexOf('await setUpBoxKey()'));
  });

  it('a refusal can be tried again, a locked phone is never marked, and rows say the refusal', () => {
    const model = iosModel();
    assert.equal(count(model, 'boxKeyNodes.markRefused(true)'), 2);
    assert.equal(count(model, 'if !deviceLocked() { boxKeyNodes.markRefused(true) }'), 1);
    assert.equal(count(model, 'if boxKey == nil && !deviceLocked() { boxKeyNodes.markRefused(true) }'), 1);
    const retry = section(model, 'func retryBoxKey() async', '\n    }\n');
    assert.ok(retry.indexOf('boxKeyNodes.markRefused(false)') >= 0 && retry.indexOf('boxKeyNodes.markRefused(false)') < retry.indexOf('await setUpBoxKey()'));
    assert.match(ios('Views.swift'), /Button\("Try again"\) \{ Task \{ await model\.retryBoxKey\(\) \} \}/);
    assert.match(section(model, 'private func rowReason(', '\n    }\n'), /boxKeyNodes\.refused && \["not_recipient", "open_failed"\]\.contains\(reason\)/);
  });

  it('the label is the kind that was read, never a guess', () => {
    const model = iosModel();
    assert.match(section(model, 'private func unreadableLease(', '\n    }\n'), /Self\.leaseLabel\(item\.request\.kind\)/);
    assert.match(section(model, 'private func verifiedLeaseRequest', '\n    }\n'), /Self\.leaseLabel\(status\?\.kind\)/);
    const label = section(model, 'static func leaseLabel(', '\n    }\n');
    for (const [kind, word] of [['computer_use', 'Computer use'], ['take', 'Take'], ['task', 'Task']]) assert.ok(label.includes(`case "${kind}"?: return "${word}"`), kind);
    assert.match(label, /default: return "Request"/);
  });
});

describe('iOS: a sealed request is answered from what it opened to', () => {
  it('uses the salted check and responseToOpened, and keeps the clear path as it was', () => {
    const decide = section(iosModel(), 'func decide(_ item: PendingItem, approve: Bool) async', '\n    }\n');
    assert.match(decide, /Messages\.validateOpenedRequest\(opened\)/);
    assert.match(decide, /Messages\.responseToOpened\(opened, decision: approve \? "approve" : "deny", deviceId: key\.deviceId,/);
    assert.match(decide, /Messages\.response\(to: item\.message, decision: approve \? "approve" : "deny", deviceId: key\.deviceId,/);
    assert.ok(decide.indexOf('if let opened = item.opened') < decide.indexOf('Digest.sha256B64url'));
    const receive = section(iosModel(), 'private func receive(', '\n    }\n');
    assert.match(receive, /opened: view\.opened/);
    assert.match(receive, /Display\.build\(view\.opened \?\? message, collapse: false\)/);
    assert.match(receive, /message: view\.opened \?\? message/);
  });

  it("a question goes through the core, which seals to the ask's own box", () => {
    assert.match(read(...SWIFT_CORE, 'Questions.swift'), /sealTo: item\.nodeBox/);
    assert.match(section(iosModel(), 'func answer(_ item: QuestionItem', '\n    }\n'), /Questions\.answer\(to: item, optionId: optionId, text: text, deviceId: key\.deviceId,/);
  });
});

describe('iOS: what cannot be read offers no decision (R-SP-6, R-SP-15, Review Focus 2)', () => {
  it('the core gives such a row no button, by its type', () => {
    const list = read(...SWIFT_CORE, 'ApprovalList.swift');
    assert.match(list, /public enum Kind: Equatable \{\n\s+case unreadable/);
    assert.match(list, /public enum Button: Equatable \{\}/);
    assert.match(list, /public static func build\(sealedUnreadable: \[SealedUnreadable\]\) -> \[Row\]/);
    const row = section(list, 'private static func sealedRow(', '\n    }\n');
    assert.match(row, /buttons: \[\]/);
    assert.match(row, /enabled: false/);
    assert.match(row, /hasDetail: false/);
    assert.match(row, /Display\.escape\(/);
  });

  it('the row view has no Allow, no Deny, no answer and no way into a detail', () => {
    const row = section(ios('Views.swift'), 'struct UnreadableRow: View', '\n}\n');
    assert.ok(!/Button|NavigationLink|TextField|\.onTapGesture|model\./.test(row), 'it draws and does nothing else');
    assert.ok(!/Allow|Deny|Approve/.test(row));
    assert.match(section(ios('Views.swift'), 'struct PendingListView', '\n}\n'), /ForEach\(model\.unreadableRows\(AppModel\.toolRef\)\) \{ row in\n\s+UnreadableRow\(row: row\)/);
    assert.match(section(ios('LeaseViews.swift'), 'struct LeaseRequestsSection', '\n}\n'), /ForEach\(model\.unreadableRows\(AppModel\.leaseRef\)\) \{ row in\n\s+UnreadableRow\(row: row\)/);
    assert.match(ios('Questions.swift'), /ForEach\(model\.unreadableRows\(AppModel\.questionRef\)\) \{ row in\n\s+UnreadableRow\(row: row\)/);
  });

  it('a sealed ask branches on unreadable before any option or field is drawn', () => {
    const view = section(ios('Questions.swift'), 'ForEach(model.questions) { item in', '.padding(.vertical, 4)');
    const branch = view.indexOf('if let why = item.unreadable {');
    assert.ok(branch >= 0);
    const orElse = view.indexOf('} else {', branch);
    const unread = view.slice(branch, orElse);
    assert.ok(!/Button|TextField|item\.text|item\.options|caseTitle/.test(unread), 'no text and no way to answer');
    for (const drawn of ['item.text', 'item.options', 'TextField(', 'Button("Got it")', 'Button("Send")']) assert.ok(view.indexOf(drawn) > orElse, drawn);
  });

  it('the app files them apart from what can be decided, from the verified clear part', () => {
    const model = iosModel();
    assert.match(section(model, 'private func receive(', '\n    }\n'), /Self\.unreadableReasons\.contains\(reason\)/);
    assert.match(section(model, 'private func verifiedLeaseRequest', '\n    }\n'), /Self\.unreadableReasons\.contains\(reason\)/);
    assert.match(section(model, 'func refreshQuestions(', '\n    }\n'), /replaceUnreadable\(Self\.questionRef,/);
    assert.match(model, /static let unreadableReasons: Set<String> = \["not_recipient", "open_failed", Seal\.keyLocked, Seal\.clearAfterSealed\]/);
    assert.match(section(model, 'func unreadableRows(', '\n    }\n'), /ApprovalList\.build\(sealedUnreadable: /);
    assert.match(section(model, 'func reset() {', '\n    }\n'), /unreadable = \[\]/);
  });

  it("the words are Android's, once each, and the node name in them is escaped", () => {
    const model = iosModel();
    const owner = kt('OwnerText.kt');
    for (const words of [
      'This node seals its messages. This one was not sealed, so it may be old.',
      'Unlock to read',
      "This phone's box key stopped working. Make a new one in Settings.",
      'this node takes only a sealed answer here'
    ]) {
      assert.equal(count(owner, words), 1, `Android: ${words}`);
      assert.equal(count(model, words), 1, `iOS: ${words}`);
    }
    const refused = read(...KT, 'AppModel.kt').match(/const val BOX_KEY_REFUSED_LINE = "([^"]+)"/)[1];
    assert.equal(count(model, refused), 1);
    assert.equal(count(model, "Sealed for this node's other phones. Run device apply on \\(Display.escape(nodeName)) for this phone."), 1);
    assert.ok(owner.includes("Sealed for this node's other phones. Run device apply on ${Display.escape(nodeName)} for this phone."));
    for (const file of ['Views.swift', 'LeaseViews.swift', 'Questions.swift', 'BoxKey.swift']) {
      for (const words of ["node's other phones", 'Run device apply', 'may be old', 'Unlock to read']) assert.ok(!ios(file).includes(words), `${file}: ${words}`);
    }
    const line = section(model, 'static func unreadableLine(', '\n    }\n');
    for (const code of ['Seal.clearAfterSealed', 'Seal.keyLocked', 'Self.boxKeyBrokenReason', 'Self.boxKeyRefusedReason']) assert.ok(line.includes(code), code);
  });

  it('clear_after_sealed, key_locked and sealed_required have words where a refusal is read', () => {
    const friendly = section(iosModel(), 'private func friendlyReason', '\n    }\n');
    for (const code of ['Seal.clearAfterSealed', 'Seal.keyLocked', '"sealed_required"']) assert.ok(friendly.includes(code), code);
  });
});
