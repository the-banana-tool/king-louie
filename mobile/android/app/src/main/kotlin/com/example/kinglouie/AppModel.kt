package com.example.kinglouie

import android.content.Context
import android.os.Build
import android.os.SystemClock
import androidx.biometric.BiometricPrompt
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.fragment.app.FragmentActivity
import com.example.kinglouie.protocol.AppMode
import com.example.kinglouie.protocol.ApprovalStatus
import com.example.kinglouie.protocol.AuditSlice
import com.example.kinglouie.protocol.B64Url
import com.example.kinglouie.protocol.DemoFleet
import com.example.kinglouie.protocol.Digest
import com.example.kinglouie.protocol.Display
import com.example.kinglouie.protocol.Envelope
import com.example.kinglouie.protocol.Hex
import com.example.kinglouie.protocol.Identifiers
import com.example.kinglouie.protocol.Jcs
import com.example.kinglouie.protocol.JsonText
import com.example.kinglouie.protocol.Messages
import com.example.kinglouie.protocol.NodePin
import com.example.kinglouie.protocol.ProtocolException
import com.example.kinglouie.protocol.QuestionItem
import com.example.kinglouie.protocol.Questions
import com.example.kinglouie.protocol.RelayClientFactory
import com.example.kinglouie.protocol.ResponseOutcome
import com.example.kinglouie.protocol.Timestamps
import com.example.kinglouie.protocol.arr
import com.example.kinglouie.protocol.bool
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.int
import com.example.kinglouie.protocol.jsonNumber
import com.example.kinglouie.protocol.jsonString
import com.example.kinglouie.protocol.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.net.URI
import java.security.GeneralSecurityException
import java.security.ProviderException

/** A message meant for the owner as it stands (already worded and escaped). */
class OwnerMessage(message: String) : Exception(message)

/** What the app keeps (mobile/PRIVACY.md): relay pin, node pins, mode, push token. The key lives in the Keystore. */
class Storage(context: Context) {
    private val prefs = context.getSharedPreferences("kl.state", Context.MODE_PRIVATE)

    var mode: AppMode
        get() = runCatching { AppMode.valueOf(prefs.getString("mode", null) ?: AppMode.WELCOME.name) }.getOrDefault(AppMode.WELCOME)
        set(v) = prefs.edit().putString("mode", v.name).apply()
    var relayUrl: String?
        get() = prefs.getString("relayUrl", null)
        set(v) = prefs.edit().putString("relayUrl", v).apply()
    var relaySpki: String?
        get() = prefs.getString("relaySpki", null)
        set(v) = prefs.edit().putString("relaySpki", v).apply()
    var pushToken: String?
        get() = prefs.getString("pushToken", null)
        set(v) = prefs.edit().putString("pushToken", v).apply()

    /** The push token the relay last accepted from this phone. */
    var pushTokenSent: String?
        get() = prefs.getString("pushTokenSent", null)
        set(v) = prefs.edit().putString("pushTokenSent", v).apply()
    var nodes: List<NodePin>
        get() = prefs.getString("nodes", null)?.let { text ->
            runCatching {
                JsonText.parse(text).arr()!!.map { NodePin(it["id"].str()!!, it["name"].str()!!, it["key"].str()!!) }
            }.getOrNull()
        } ?: emptyList()
        set(v) = prefs.edit().putString("nodes", Jcs.serialize(JsonArray(v.map {
            JsonObject(mapOf("id" to jsonString(it.id), "name" to jsonString(it.name), "key" to jsonString(it.key)))
        }))).apply()

    /** The pairing state, to put back when a pairing does not finish. */
    data class Snapshot(val mode: AppMode, val relayUrl: String?, val relaySpki: String?, val nodes: List<NodePin>)

    fun snapshot() = Snapshot(mode, relayUrl, relaySpki, nodes)

    fun restore(s: Snapshot) {
        mode = s.mode
        relayUrl = s.relayUrl
        relaySpki = s.relaySpki
        nodes = s.nodes
    }

    fun clear() = prefs.edit().clear().apply()
}

class PendingItem(
    val id: String,
    val message: JsonElement,
    val display: JsonElement,
    val fullText: Map<String, String>,
    val receivedAtMs: Long,
    val expiresInMs: Long,
    initialStatus: String?
) {
    var status by mutableStateOf(initialStatus)

    /** An approve or deny for this item is being signed or sent. */
    var deciding by mutableStateOf(false)

    /** From receipt, on the monotonic clock. */
    val timeLeftMs: Long get() = (expiresInMs - (SystemClock.elapsedRealtime() - receivedAtMs)).coerceAtLeast(0)
}

class AppModel(context: Context) {
    private val storage = Storage(context)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var key: DeviceKey? = runCatching { DeviceKey.load() }.getOrNull()
    private var demo: DemoFleet? = null
    private var client: RelayApi? = null
    private var pollJob: Job? = null

    /** A pairing is under way; no check starts under it. */
    private var pairing = false

    /** No check before this (elapsedRealtime ms): the relay asked this phone to wait. */
    private var notBeforeMs = 0L

    /** Requests already reported as refused (bounded), so each is reported once. */
    private val warnedPayloads = HashSet<String>()
    var activity: FragmentActivity? = null

    var mode by mutableStateOf(storage.mode)
        private set
    var banner by mutableStateOf<String?>(null)

    /** Why "Check for requests" did not get through; shown quietly on the Pending screen. */
    var pollProblem by mutableStateOf<String?>(null)
        private set
    var isPolling by mutableStateOf(false)
        private set
    var fingerprintToCompare by mutableStateOf<String?>(null)
    var inviteQr by mutableStateOf<String?>(null)
    var inviteClaim by mutableStateOf<JsonElement?>(null)
    var history by mutableStateOf<Pair<String, List<JsonElement>>?>(null)
    val pending = mutableStateListOf<PendingItem>()
    val devices = mutableStateListOf<JsonElement>()
    val online = mutableStateMapOf<String, Boolean>()
    val nodes: List<NodePin> get() = storage.nodes
    val relayUrl: String? get() = storage.relayUrl
    val relaySpki: String? get() = storage.relaySpki
    val deviceId: String? get() = if (mode == AppMode.DEMO) demo?.deviceId else key?.deviceId

    init {
        if (mode == AppMode.DEMO) startDemo()
        if (mode == AppMode.LIVE) connect()
    }

    /**
     * The only place a network client is made. RelayClientFactory hands one
     * out in live mode only, so demo (and welcome) never has one; without a
     * key there is nothing to sign requests with, so no client either.
     */
    private fun connect() {
        client = null
        val k = key ?: return
        val url = storage.relayUrl ?: return
        val pin = storage.relaySpki ?: return
        val factory = RelayClientFactory {
            RelayApi(url, pin, k.deviceId) { data -> sign(k, data, "Check your relay", "Signs this phone's request to the relay") }
        }
        client = factory.client(mode)
    }

    private fun changeMode(m: AppMode) {
        mode = m
        storage.mode = m
    }

    /**
     * One biometric prompt at a time, app-wide: prompts on one activity share
     * its BiometricViewModel, so a second live prompt would take over the
     * first one's callback and leave it waiting forever.
     */
    private val signLock = Mutex()

    private suspend fun sign(k: DeviceKey, data: ByteArray, title: String, description: String? = null): ByteArray = signLock.withLock {
        val a = activity ?: throw OwnerMessage("Open King Louie to sign.")
        k.sign(a, data, title, description)
    }

    private suspend fun signEnvelope(k: DeviceKey, message: JsonObject, title: String, description: String? = null): Envelope {
        val bytes = Jcs.bytes(message)
        return Envelope("ES256", k.deviceId, B64Url.encode(bytes), B64Url.encode(sign(k, bytes, title, description)))
    }

    // ---- Questions (cases stage 4) ----
    // No presence pings from this phone (ruling T19-presence): every
    // device-signed relay request is a biometric prompt here, so the node sees
    // it as not in the foreground and the reach ladder moves on. Questions
    // load only when the owner taps Refresh, like "Check for requests".

    val questions = mutableStateListOf<QuestionItem>()

    /** Tokens whose answer is being signed or sent. */
    val answering = mutableStateListOf<String>()
    var isLoadingQuestions by mutableStateOf(false)
        private set
    private val answeredTokens = HashSet<String>()

    /**
     * One look at the relay's questions. Only a node-signed `kl.question.ask`
     * from a pinned node (kid, node_id and signature all that node's) is shown.
     */
    fun refreshQuestions() {
        if (pairing || mode != AppMode.LIVE || isLoadingQuestions) return
        val api = client ?: run {
            banner = "This phone is not paired with a relay."
            return
        }
        isLoadingQuestions = true
        scope.launch {
            try {
                val pins = storage.nodes
                val items = api.questions().mapNotNull { entry -> verifiedQuestion(entry, pins) }
                    .distinctBy { it.token }
                    .filter { it.token !in answeredTokens }
                questions.clear()
                questions.addAll(items)
            } catch (e: Exception) {
                fail(e)
            } finally {
                isLoadingQuestions = false
            }
        }
    }

    private fun verifiedQuestion(entry: JsonElement, pins: List<NodePin>): QuestionItem? {
        val envelope = try {
            Envelope.fromJson(entry["envelope"] ?: return null)
        } catch (e: ProtocolException) {
            return null
        }
        val pin = pins.firstOrNull { it.id == envelope.kid } ?: return null
        if (!envelope.verifyEd25519(pin.key)) return null
        val message = try {
            envelope.message()
        } catch (e: ProtocolException) {
            return null
        }
        val item = QuestionItem.from(message, pin.name) ?: return null
        // Signed by the node it names, and listed under that node.
        if (item.nodeId != pin.id) return null
        entry["node_id"].str()?.let { if (it != pin.id) return null }
        return item
    }

    /**
     * A fresh biometric signature over this one answer; the node verifies it
     * (R44). `signed_at` comes from the relay-corrected clock (the node allows
     * ±300 s), and the prompt shows the question escaped (node text is
     * untrusted in a prompt).
     */
    fun answer(item: QuestionItem, optionId: String?, text: String?) {
        if (mode != AppMode.LIVE || item.token in answering) return
        if (text != null && text.length > MAX_ANSWER_CHARS) {
            banner = "An answer can be at most $MAX_ANSWER_CHARS characters. Shorten it and send again."
            return
        }
        val k = key ?: return
        val api = client ?: return
        answering.add(item.token)
        scope.launch {
            try {
                val message = Questions.answer(item, optionId, text, k.deviceId, Messages.randomNonce(), Timestamps.string(api.now()))
                val choice = optionId?.let { id -> item.options.firstOrNull { it.id == id }?.label } ?: text ?: ""
                val description = "${promptText(item.caseTitle, 40)}: ${promptText(item.text, 80)} → ${promptText(choice, 40)}"
                val envelope = signEnvelope(k, message, "Answer a question", description)
                val result = api.answerQuestion(item.token, envelope)
                // The node's own words (escaped) when it sent any.
                val ack = result["ack"].str()?.let { Display.escape(it) }
                if (result["ok"].bool() == true) {
                    answeredTokens.add(item.token)
                    questions.removeAll { it.token == item.token }
                    banner = ack ?: "Answer recorded."
                } else {
                    banner = ack ?: "Not recorded: ${friendlyReason(result["error"].str() ?: result["outcome"].str())}"
                }
            } catch (e: Exception) {
                fail(e)
            } finally {
                answering.remove(item.token)
            }
        }
    }

    /** At most `max` code points, then escaped (never cut through an escape). */
    private fun promptText(text: String, max: Int): String {
        val cps = text.codePoints().toArray()
        val cut = if (cps.size <= max) text else String(cps, 0, max - 1) + "…"
        return Display.escape(cut)
    }

    // Errors

    private fun friendlyReason(reason: String?): String = when (reason) {
        null, "" -> "no reason given"
        "action_changed" -> "the action changed before it ran"
        "expired" -> "too late — request expired"
        else -> Display.escape(reason)
    }

    /** The words the owner sees. Never a key, signature or code; relay text is escaped like any display text. */
    private fun describe(e: Throwable): String = when (e) {
        is KeyInvalidatedException -> DeviceKey.INVALIDATED_MESSAGE
        is KeyUnavailableException -> e.message ?: ""
        is OwnerMessage -> e.message ?: ""
        is ProtocolException -> "Refused as malformed: ${Display.escape(e.message ?: "")}."
        is BiometricException -> when (e.code) {
            BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON, BiometricPrompt.ERROR_CANCELED -> "Cancelled."
            BiometricPrompt.ERROR_NO_BIOMETRICS -> "Set up a fingerprint or face unlock first: every approval is signed with it."
            BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "Biometric unlock is locked. Unlock the phone with its PIN, then try again."
            else -> Display.escape(e.message ?: "The fingerprint prompt failed.")
        }
        is RelayException -> when (e.code) {
            "clock_skew" -> "The relay says this phone's clock is wrong. Check the date and time in Settings."
            "rate_limited" -> e.retryAfter?.let { "The relay is busy. Try again in $it s." } ?: "The relay is busy. Try again shortly."
            "code_closed" -> "This pairing code was already used or is closed. Run enroll-device on the node for a new one."
            "unknown_code" -> "This code is unknown or already closed. Run enroll-device on the node for a new one."
            "already_claimed" -> "This code was already used."
            "unknown_invite" -> "This invite is used, expired or unknown. Ask the other phone for a new one."
            "node_offline" -> "The node is offline."
            "gone" -> "Too late — this request has expired."
            "unknown_device" -> "The relay does not know this phone yet."
            "pin_mismatch", "malformed", "network", "redirect", "poll_busy" -> e.message ?: e.code
            else -> if (e.message.isNullOrEmpty() || e.message == e.code) "The relay refused the request (${Display.escape(e.code)})." else Display.escape(e.message!!)
        }
        else -> Display.escape(e.message ?: e.javaClass.simpleName)
    }

    private fun fail(e: Throwable) {
        if (e is CancellationException) return
        if (e is KeyInvalidatedException) {
            dropInvalidKey()
            return
        }
        banner = describe(e)
    }

    /**
     * The Keystore key is confirmed gone (KeyInvalidatedException: the
     * enrolled biometrics changed, or its entry is missing). Forget it, so the
     * next pairing or invite makes a new one. Nothing else deletes a key.
     */
    private fun dropInvalidKey() {
        pollJob?.cancel()
        runCatching { DeviceKey.delete() }
        key = null
        client = null
        banner = DeviceKey.INVALIDATED_MESSAGE
        pollProblem = DeviceKey.INVALIDATED_MESSAGE
    }

    /**
     * The key for a pairing or invite: the existing one unless Android
     * confirms it is invalidated (KeyInvalidatedException), and only then a
     * new one. A transient error, KeyUnavailableException included,
     * propagates and leaves the existing key alone.
     */
    private fun ensureKey(): DeviceKey {
        // A load that failed at startup is tried again.
        if (key == null) key = DeviceKey.load()
        val existing = key
        if (existing != null) {
            try {
                existing.checkUsable()
                return existing
            } catch (e: KeyInvalidatedException) {
                // Confirmed invalidated: the one case where the alias is replaced.
                runCatching { DeviceKey.delete() }
                key = null
                client = null
                return DeviceKey.create().also { key = it }
            }
        }
        // load() gives null on a transient Keystore2 error too; create() runs
        // only once the Keystore confirms there is no key at all.
        DeviceKey.requireAbsent()
        return DeviceKey.create().also { key = it }
    }

    // Demo

    /**
     * Also runs from Application.onCreate when the app was left in demo. The
     * demo fleet needs Ed25519 in java.security; without it the app goes back
     * to Welcome (saved, so a restart does not try again) instead of crashing.
     */
    fun startDemo() {
        client = null
        pending.clear()
        try {
            val fleet = DemoFleet()
            val requests = listOf("nvidia-smi --gpu-reset", "rm -rf ~/Downloads/old", "systemctl restart site").mapIndexed { i, command -> fleet.request(i, command) }
            demo = fleet
            changeMode(AppMode.DEMO)
            requests.forEach { receive(JsonObject(mapOf("envelope" to it.json, "expires_in_ms" to jsonNumber("300000"), "status" to JsonNull)), fleet.pins) }
        } catch (e: Exception) {
            if (e !is GeneralSecurityException && e !is ProviderException && e !is ProtocolException) throw e
            demo = null
            pending.clear()
            changeMode(AppMode.WELCOME)
            banner = "The demo needs Ed25519 signatures, which this phone does not provide."
        }
    }

    /** Leaving demo drops the fleet and its software key; the Keystore key is made at the first real pairing. */
    fun leaveDemo() {
        demo = null
        pending.clear()
        val token = storage.pushToken
        storage.clear()
        storage.pushToken = token
        changeMode(AppMode.WELCOME)
    }

    // Scanning and pins

    fun scanned(text: String) = scope.launch {
        try {
            val payload = Messages.decodeQr(text.trim())
            if (pairing) {
                banner = "A pairing is already under way. Wait for it to finish."
                return@launch
            }
            when (payload["t"].str()) {
                "kl.pair" -> pairAtConsole(payload)
                "kl.invite" -> claimInvite(payload)
                "kl.relay" -> repin(payload)
                else -> banner = "That is not a King Louie code."
            }
        } catch (e: Exception) {
            fail(e)
        }
    }

    private fun isToken(text: String?, bytes: Int): Boolean =
        text != null && runCatching { B64Url.decode(text).size == bytes }.getOrDefault(false)

    /** `relay` must be an https origin and `relay_spki` a `sha256/` pin of 32 bytes. */
    private fun relayPin(payload: JsonElement): Pair<String, String> {
        val text = payload["relay"].str()
        val spki = payload["relay_spki"].str()
        val uri = text?.let { runCatching { URI(it) }.getOrNull() }
        val ok = uri != null && uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrEmpty() &&
            (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") && uri.rawQuery == null && uri.rawUserInfo == null && uri.rawFragment == null &&
            spki != null && spki.startsWith("sha256/") && isToken(spki.removePrefix("sha256/"), 32)
        if (!ok) throw OwnerMessage("This code does not name a relay this app can pin.")
        return text!! to spki!!
    }

    /** A node pin from a pairing or invite code (never from the relay's node list). Its id must be the one its Ed25519 key derives. */
    private fun nodePin(node: JsonElement?): NodePin {
        val id = node["id"].str()
        val name = node["name"].str()
        val keyHex = node["key"].str()
        val spki = keyHex?.let { runCatching { Hex.decode(it) }.getOrNull() }
        val ok = id != null && name != null && spki != null && spki.size == 44 &&
            Hex.encode(spki.copyOfRange(0, 12)) == Identifiers.ED25519_SPKI_PREFIX &&
            Identifiers.nodeId(spki.copyOfRange(12, 44)) == id
        if (!ok) throw OwnerMessage("This code carries a node key that does not match its id.")
        return NodePin(id!!, name!!, keyHex!!)
    }

    private fun pinNode(pin: NodePin) {
        storage.nodes = storage.nodes.filter { it.id != pin.id } + pin
    }

    private fun deviceJson(k: DeviceKey): JsonObject {
        val name = Build.MODEL.orEmpty().trim().take(64).ifEmpty { "Android phone" }
        return try {
            Messages.device(k.deviceId, name, "android", k.x, k.y)
        } catch (e: ProtocolException) {
            Messages.device(k.deviceId, "Android phone", "android", k.x, k.y)
        }
    }

    /** Switches to the pins of a pairing or invite code, remembering what was there (demo included) for `restore`. */
    private fun beginPairing(relay: Pair<String, String>, pins: List<NodePin>): Storage.Snapshot {
        val before = storage.snapshot()
        if (mode == AppMode.DEMO) leaveDemo()
        pollJob?.cancel()
        storage.relayUrl = relay.first
        storage.relaySpki = relay.second
        pins.forEach { pinNode(it) }
        changeMode(AppMode.LIVE)
        connect()
        return before
    }

    /** Puts back the pins and mode from before a pairing that did not finish. */
    private fun restore(before: Storage.Snapshot) {
        fingerprintToCompare = null
        storage.restore(before)
        if (before.mode == AppMode.DEMO) {
            startDemo()
            return
        }
        mode = before.mode
        connect()
    }

    // Console enrollment

    /**
     * Console enrollment (spec §3.10): the phone signs its own enrollment with
     * the key it enrolls and proves it scanned the code with code_mac. Its
     * timestamps come from the relay's clock, which the node's is close to.
     */
    private suspend fun pairAtConsole(payload: JsonElement) {
        val codeId = payload["code_id"].str()?.takeIf { isToken(it, 16) } ?: throw OwnerMessage("This pairing code is incomplete.")
        val code = payload["code"].str()?.takeIf { isToken(it, 32) } ?: throw OwnerMessage("This pairing code is incomplete.")
        val relay = relayPin(payload)
        val pin = nodePin(payload["node"])
        val k = ensureKey()
        val device = deviceJson(k)
        pairing = true
        try {
            val before = beginPairing(relay, listOf(pin))
            val api = client ?: run {
                restore(before)
                throw OwnerMessage("Could not reach the relay named in this code.")
            }
            val result = try {
                val now = api.syncClock()
                val message = Messages.consoleEnroll(device, codeId, code, Timestamps.string(now), Timestamps.string(now.plusSeconds(600)), Messages.randomNonce())
                val envelope = signEnvelope(k, message, "Enroll this phone", "Approver for ${Display.escape(pin.name)}")
                fingerprintToCompare = "d-" + Identifiers.fingerprintGroups(k.deviceId)
                try {
                    api.consoleEnroll(codeId, envelope)
                } catch (e: RelayException) {
                    if (e.code == "already_claimed") throw OwnerMessage("Another phone already used this pairing code. Run enroll-device on the node for a new one.")
                    throw e
                }
                consoleResult(api, codeId)
            } catch (e: Exception) {
                restore(before)
                throw e
            }
            fingerprintToCompare = null
            when (result) {
                "done" -> {
                    banner = "Enrolled. This phone now approves for ${Display.escape(pin.name)}."
                    sendPushToken()
                }
                "refused" -> {
                    restore(before)
                    banner = "The node did not enroll this phone."
                }
                else -> {
                    restore(before)
                    banner = "The pairing code expired before the node answered. Run enroll-device again."
                }
            }
        } finally {
            pairing = false
        }
    }

    /**
     * Waits for the node's answer. The status route is unauthenticated, so it
     * counts against the relay's 10-per-minute per-IP budget: ask every 8 s
     * and wait out a 429's retry_after.
     */
    private suspend fun consoleResult(api: RelayApi, codeId: String): String {
        val deadline = SystemClock.elapsedRealtime() + 11 * 60 * 1000L
        while (SystemClock.elapsedRealtime() < deadline) {
            delay(8000)
            try {
                val s = api.consoleEnrollState(codeId)
                if (s != "waiting") return s
            } catch (e: RelayException) {
                when (e.code) {
                    "rate_limited" -> delay((e.retryAfter ?: 10).coerceAtLeast(1) * 1000L)
                    // The relay dropped the code: it closed long enough ago.
                    "unknown_code" -> return "expired"
                    else -> throw e
                }
            }
        }
        return "expired"
    }

    private fun repin(payload: JsonElement) {
        if (mode != AppMode.LIVE) {
            banner = "Pair this phone with a node first; the pairing code pins the relay."
            return
        }
        val relay = relayPin(payload)
        pollJob?.cancel()
        storage.relayUrl = relay.first
        storage.relaySpki = relay.second
        connect()
        pollProblem = null
        banner = "Relay pinned again."
    }

    // Approvals

    /** A status counts only when the pinned node signed a valid kl.approval.status for this request. */
    private fun verifiedStatus(json: JsonElement?, requestId: String, pin: NodePin): String? {
        if (json == null || json is JsonNull) return null
        val status = ApprovalStatus.verify(json, requestId, pin) ?: return null
        return if (!status.reason.isNullOrEmpty()) "${status.state}: ${friendlyReason(status.reason)}" else status.state
    }

    private fun warnOnce(payload: String?, text: String, asBanner: Boolean) {
        val p = payload ?: return
        if (p in warnedPayloads) return
        if (warnedPayloads.size >= 64) warnedPayloads.clear()
        warnedPayloads.add(p)
        if (asBanner) banner = text else pollProblem = text
    }

    /**
     * Shows a request only when the core says so (shape, pin, node
     * signature); everything displayed comes from its display model.
     */
    private fun receive(item: JsonElement, pins: List<NodePin>) {
        val envJson = item["envelope"] ?: return
        val view = Display.view(envJson, pins)
        val display = view.display
        if (!view.shown || display == null) {
            when (view.reason) {
                "bad_node_signature" -> warnOnce(envJson["payload"].str(), "Node key changed — pair again.", asBanner = true)
                "malformed" -> warnOnce(envJson["payload"].str(), "A request was refused as malformed and is not shown.", asBanner = false)
            }
            return
        }
        val envelope = try {
            Envelope.fromJson(envJson)
        } catch (e: ProtocolException) {
            return
        }
        val message = try {
            envelope.message()
        } catch (e: ProtocolException) {
            return
        }
        val id = message["request_id"].str() ?: return
        val pin = pins.firstOrNull { it.id == envelope.kid } ?: return
        val status = verifiedStatus(item["status"], id, pin)
        val existing = pending.indexOfFirst { it.id == id }
        if (existing >= 0) {
            if (status != null) pending[existing].status = status
            return
        }
        // A request lives at most 300 s (approval-v1 §3.1); a relay cannot stretch it.
        val expiresInMs = (item["expires_in_ms"].int() ?: 0).coerceAtMost(MAX_EXPIRES_IN_MS).toLong()
        // Already over when it arrived: nothing to decide.
        if (expiresInMs <= 0) return
        val full = Display.build(message, collapse = false)["items"].arr().orEmpty().associate { (it["path"].str() ?: "") to (it["text"].str() ?: "") }
        pending.add(PendingItem(id, message, display, full, SystemClock.elapsedRealtime(), expiresInMs, status))
    }

    /** Drops what is over: undecided requests at zero, and decided ones a minute after they ran out. */
    private fun pruneExpired() {
        val now = SystemClock.elapsedRealtime()
        pending.removeAll { it.timeLeftMs == 0L && (it.status == null || now - it.receivedAtMs > it.expiresInMs + 60_000) }
    }

    /**
     * "Check for requests": one long poll (up to 25 s). The approval key needs
     * a biometric prompt for every signature, API requests included (spec
     * §3.14 key parameters), so the app checks when the owner asks rather
     * than continuously. One check at a time; a 429 is waited out, not retried.
     */
    fun checkNow() {
        if (pairing || mode != AppMode.LIVE) return
        val api = client ?: run {
            pollProblem = if (key == null) "This phone has no approval key. Scan a pairing code from a node console." else "This phone is not paired with a relay."
            return
        }
        if (pollJob?.isActive == true) return
        val waitMs = notBeforeMs - SystemClock.elapsedRealtime()
        if (waitMs > 0) {
            pollProblem = "The relay is busy. Try again in ${(waitMs + 999) / 1000} s."
            return
        }
        pollProblem = null
        // Set inside the job, so a job cancelled before it starts never leaves "Checking…" behind.
        pollJob = scope.launch {
            isPolling = true
            try {
                val items = api.approvals(25)
                fingerprintToCompare = null
                items.forEach { receive(it, storage.nodes) }
                pruneExpired()
                sendPushToken()
            } catch (e: CancellationException) {
                throw e
            } catch (e: KeyInvalidatedException) {
                dropInvalidKey()
            } catch (e: KeyUnavailableException) {
                banner = describe(e)
                pollProblem = describe(e)
            } catch (e: RelayException) {
                pruneExpired()
                // A request that fails device auth counts against the relay's
                // per-IP budget, so an unknown device backs off too.
                if (e.code == "rate_limited" || e.status == 401) notBeforeMs = SystemClock.elapsedRealtime() + (e.retryAfter ?: 15).coerceAtLeast(1) * 1000L
                if (e.code == "pin_mismatch") banner = describe(e)
                pollProblem = describe(e)
            } catch (e: Exception) {
                pollProblem = describe(e)
            } finally {
                isPolling = false
            }
        }
    }

    /** Approve or deny: a fresh biometric signature over the response, and only for an action whose hash the node signed. */
    fun decide(item: PendingItem, approve: Boolean) {
        if (item.deciding) return
        item.deciding = true
        scope.launch {
            try {
                decideNow(item, approve)
            } finally {
                item.deciding = false
            }
        }
    }

    private suspend fun decideNow(item: PendingItem, approve: Boolean) {
        if (item.timeLeftMs == 0L) {
            setStatus(item.id, "expired")
            banner = "Too late — this request has expired."
            return
        }
        val action = item.message["action"]
        if (action == null || item.message["action_hash"].str() != Digest.sha256B64url(Jcs.bytes(action))) {
            banner = "This request's action does not match its signed hash. Nothing was signed."
            return
        }
        try {
            val fleet = demo
            if (mode == AppMode.DEMO && fleet != null) {
                val response = Messages.response(item.message, if (approve) "approve" else "deny", fleet.deviceId, Timestamps.string(java.time.Instant.now()))
                Envelope.seal(response, fleet.deviceId) { fleet.sign(it) }
                setStatus(item.id, if (approve) "approved (demo)" else "denied (demo)")
                return
            }
            val k = key
            val api = client
            if (k == null || api == null) {
                banner = "This phone is not paired with a relay."
                return
            }
            val response = Messages.response(item.message, if (approve) "approve" else "deny", k.deviceId, Timestamps.string(api.now()))
            val summary = item.display["summary"].str() ?: "this action"
            val envelope = signEnvelope(k, response, if (approve) "Approve" else "Deny", summary)
            // The prompt takes time; never send once the request has run out.
            if (item.timeLeftMs == 0L) {
                setStatus(item.id, "expired")
                banner = "Too late — this request has expired."
                return
            }
            val reply = sendResponse(api, item, envelope) ?: return
            // Only accepted: true with delivered: true is a verdict the node applied; null is never approval.
            when (val outcome = ResponseOutcome.from(reply)) {
                is ResponseOutcome.Accepted -> setStatus(item.id, if (approve) "approved" else "denied")
                is ResponseOutcome.Refused -> setStatus(item.id, "refused: ${friendlyReason(outcome.reason)}")
                is ResponseOutcome.Forwarded -> setStatus(item.id, "sent to ${item.display["node"]["name"].str() ?: "the node"}")
                is ResponseOutcome.NotDelivered -> setStatus(item.id, "not delivered")
            }
        } catch (e: RelayException) {
            if (e.code == "gone") setStatus(item.id, "expired") else {
                clearRetrying(item.id)
                fail(e)
            }
        } catch (e: Exception) {
            clearRetrying(item.id)
            fail(e)
        }
    }

    /**
     * Sends the signed response, retrying while the node is offline (or the
     * relay asks to wait, for its retry_after) and the request still has time
     * left. null once it ran out.
     */
    private suspend fun sendResponse(api: RelayApi, item: PendingItem, envelope: Envelope): JsonElement? {
        while (true) {
            try {
                return api.respond(item.id, envelope) ?: JsonNull
            } catch (e: RelayException) {
                if (e.code != "node_offline" && e.code != "rate_limited") throw e
                if (item.timeLeftMs == 0L) {
                    setStatus(item.id, "expired")
                    return null
                }
                setStatus(item.id, if (e.code == "node_offline") RETRY_OFFLINE else RETRY_BUSY)
                delay((e.retryAfter ?: 3).coerceAtLeast(1) * 1000L)
            }
        }
    }

    private fun setStatus(id: String, status: String) {
        val i = pending.indexOfFirst { it.id == id }
        if (i >= 0) pending[i].status = status
    }

    /** After an error that ends the retries, the request is undecided again. */
    private fun clearRetrying(id: String) {
        val i = pending.indexOfFirst { it.id == id }
        if (i >= 0 && pending[i].status in setOf(RETRY_OFFLINE, RETRY_BUSY)) pending[i].status = null
    }

    // History, nodes, devices

    fun loadHistory(nodeId: String) = scope.launch {
        val pin = storage.nodes.firstOrNull { it.id == nodeId } ?: return@launch
        try {
            val envelope = client?.history(nodeId, 50, null) ?: return@launch
            val result = AuditSlice.verify(envelope, pin.key)
            if (!result.ok) {
                banner = "History from ${Display.escape(pin.name)} did not verify (${Display.escape(result.reason ?: "unknown")})."
                return@launch
            }
            // Signed by the pinned key, and about the node that was asked for.
            val slice = Envelope.fromJson(envelope).message()
            if (slice["node_id"].str() != pin.id) {
                banner = "History from ${Display.escape(pin.name)} is about a different node."
                return@launch
            }
            history = (slice["created_at"].str() ?: "") to result.entries.reversed()
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun refreshNodes() = scope.launch {
        try {
            client?.nodes()?.forEach { n -> n["node_id"].str()?.let { online[it] = n["online"].bool() == true } }
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun pairingCode(name: String, onCode: (String) -> Unit) = scope.launch {
        try {
            client?.pairingCode(name)?.get("code").str()?.let { onCode(Display.escape(it)) }
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun refreshDevices() = scope.launch {
        try {
            val list = client?.devices() ?: return@launch
            devices.clear()
            devices.addAll(list)
        } catch (e: Exception) {
            fail(e)
        }
    }

    /** Phone A's open invite: its id, the secret in its QR code, and when it lapses (elapsedRealtime ms). */
    private data class OpenInvite(val id: String, val secret: String, val untilMs: Long)

    private var openInvite: OpenInvite? = null

    /** Phone A: show an invite with the relay and node pins. */
    fun startInvite() = scope.launch {
        val api = client ?: return@launch
        try {
            val inviteId = api.createInvite()["invite_id"].str()?.takeIf { isToken(it, 16) }
                ?: throw OwnerMessage("The relay did not return an invite.")
            val secret = Messages.randomNonce()
            inviteClaim = null
            inviteQr = Messages.encodeQr(JsonObject(mapOf(
                "t" to jsonString("kl.invite"),
                "relay" to jsonString(storage.relayUrl ?: ""),
                "relay_spki" to jsonString(storage.relaySpki ?: ""),
                "invite_id" to jsonString(inviteId),
                "secret" to jsonString(secret),
                "nodes" to JsonArray(storage.nodes.map { JsonObject(mapOf("id" to jsonString(it.id), "name" to jsonString(it.name), "key" to jsonString(it.key))) })
            )))
            // The invite lives 10 minutes on the relay.
            openInvite = OpenInvite(inviteId, secret, SystemClock.elapsedRealtime() + 10 * 60 * 1000L)
        } catch (e: Exception) {
            inviteQr = null
            fail(e)
        }
    }

    /**
     * Phone A, when the owner taps after the new phone scanned the invite:
     * one look at the claim. Each look is a device-signed request, which on
     * this phone is a biometric prompt, so it is never polled on a timer.
     */
    fun checkInvite() = scope.launch {
        val invite = openInvite ?: return@launch
        val api = client ?: return@launch
        if (SystemClock.elapsedRealtime() > invite.untilMs) {
            openInvite = null
            inviteQr = null
            banner = "Nobody used the invite within 10 minutes. Start a new one."
            return@launch
        }
        try {
            val claim = api.inviteClaim(invite.id)
            if (claim == null || claim is JsonNull) {
                banner = "The new phone has not scanned the invite yet."
                return@launch
            }
            openInvite = null
            inviteQr = null
            val device = verifiedClaim(claim, invite.secret)
            if (device == null) {
                banner = "The invite was claimed by something that did not scan it. Nothing was enrolled."
                return@launch
            }
            inviteClaim = device
        } catch (e: Exception) {
            fail(e)
        }
    }

    /**
     * The claimed device, exactly as a valid enrollment would carry it
     * (Messages.device rebuilds and checks it), with a mac only the scanner of
     * this invite could make.
     */
    private fun verifiedClaim(claim: JsonElement, secret: String): JsonObject? {
        val device = claim["device"] ?: return null
        val id = device["device_id"].str() ?: return null
        val name = device["name"].str() ?: return null
        val platform = device["platform"].str()?.takeIf { it == "ios" || it == "android" } ?: return null
        val x = device["public_key"]["x"].str() ?: return null
        val y = device["public_key"]["y"].str() ?: return null
        val rebuilt = try {
            Messages.device(id, name, platform, x, y)
        } catch (e: ProtocolException) {
            return null
        }
        if (rebuilt != device || id == key?.deviceId) return null
        return if (claim["mac"].str() == Messages.inviteMac(secret, rebuilt)) rebuilt else null
    }

    /** Phone A, after both screens show the same id: sign B's enrollment. */
    fun confirmInvited() = scope.launch {
        val device = inviteClaim ?: return@launch
        inviteClaim = null
        val k = key ?: return@launch
        val api = client ?: return@launch
        try {
            val now = api.now()
            val message = Messages.signedEnroll(device, k.deviceId, Timestamps.string(now), Timestamps.string(now.plusSeconds(600)), Messages.randomNonce())
            val name = Display.escape(device["name"].str() ?: "the new phone")
            val result = api.enrollDevice(signEnvelope(k, message, "Add an approver", "Add $name as an approver"))
            val lines = result["nodes"].arr().orEmpty().map { n ->
                val id = n["node_id"].str() ?: ""
                val label = storage.nodes.firstOrNull { it.id == id }?.let { Display.escape(it.name) } ?: Display.escape(id)
                "$label: ${Display.escape(n["state"].str() ?: "unknown")}"
            }
            banner = "Sent to ${lines.size} node(s)" + (if (lines.isEmpty()) "." else " — " + lines.joinToString(", ") + ".") +
                " An administrator applies it on each node with `device apply`."
        } catch (e: Exception) {
            fail(e)
        }
    }

    /**
     * Phone B: claim phone A's invite. It does not check for requests until
     * the owner taps: the relay knows this phone only once phone A added it.
     */
    private suspend fun claimInvite(payload: JsonElement) {
        val inviteId = payload["invite_id"].str()?.takeIf { isToken(it, 16) } ?: throw OwnerMessage("This invite is incomplete.")
        val secret = payload["secret"].str()?.takeIf { isToken(it, 32) } ?: throw OwnerMessage("This invite is incomplete.")
        val nodeList = payload["nodes"].arr()?.takeIf { it.isNotEmpty() } ?: throw OwnerMessage("This invite is incomplete.")
        val relay = relayPin(payload)
        val pins = nodeList.map { nodePin(it) }
        val k = ensureKey()
        val device = deviceJson(k)
        val mac = Messages.inviteMac(secret, device)
        pairing = true
        try {
            val before = beginPairing(relay, pins)
            val api = client ?: run {
                restore(before)
                throw OwnerMessage("Could not reach the relay named in this invite.")
            }
            try {
                api.claimInvite(inviteId, device, mac)
            } catch (e: Exception) {
                restore(before)
                // A 404 here is about the invite (used, expired or unknown), never a console code.
                if (e is RelayException && (e.status == 404 || e.code in setOf("already_claimed", "unknown_invite"))) {
                    throw OwnerMessage("This invite is used, expired or unknown. Ask the other phone for a new one.")
                }
                throw e
            }
            fingerprintToCompare = "d-" + Identifiers.fingerprintGroups(k.deviceId)
            pollProblem = "When the other phone has added this one, tap “Check for requests”."
            banner = "Check that the other phone shows the same id, then confirm there."
        } finally {
            pairing = false
        }
    }

    fun revoke(target: String, name: String) = scope.launch {
        val k = key ?: return@launch
        val api = client ?: return@launch
        try {
            val now = api.now()
            val message = Messages.revoke(target, k.deviceId, "revoked from a phone", Timestamps.string(now), Timestamps.string(now.plusSeconds(3600)), Messages.randomNonce())
            val label = name.ifEmpty { "d-" + Identifiers.fingerprintGroups(target) }
            api.revokeDevice(signEnvelope(k, message, "Revoke a device", "Revoke ${Display.escape(label)} on every node"))
            refreshDevices()
        } catch (e: Exception) {
            fail(e)
        }
    }

    // Push

    /**
     * Keeps the token only. It is sent after a check that got through or a
     * pairing that finished (sendPushToken), never at startup: each send is a
     * signed request, a fingerprint prompt on this phone.
     */
    fun registerPushToken(token: String) {
        storage.pushToken = token
    }

    /**
     * Registers the push token once per token, after the relay knows this
     * phone (a pairing that finished, or a check that got through). Each
     * registration is a signed request, so it is not repeated.
     */
    private suspend fun sendPushToken() {
        val token = storage.pushToken ?: return
        if (mode != AppMode.LIVE || token == storage.pushTokenSent) return
        val api = client ?: return
        try {
            api.pushToken(token)
            storage.pushTokenSent = token
        } catch (e: Exception) {
            fail(e)
        }
    }

    /** A push carries only { kind, id }: fetch the envelope and verify it. */
    fun openPushed(requestId: String) = scope.launch {
        // A request id is a lowercase UUID; anything else is not ours to fetch.
        if (requestId.length != 36 || !requestId.all { it in "0123456789abcdef-" }) return@launch
        try {
            client?.approval(requestId)?.let { receive(it, storage.nodes) }
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun reset() {
        pollJob?.cancel()
        runCatching { DeviceKey.delete() }
        key = null
        client = null
        demo = null
        pending.clear()
        devices.clear()
        online.clear()
        questions.clear()
        answeredTokens.clear()
        history = null
        inviteQr = null
        inviteClaim = null
        openInvite = null
        fingerprintToCompare = null
        pollProblem = null
        storage.clear()
        changeMode(AppMode.WELCOME)
    }

    companion object {
        const val MAX_EXPIRES_IN_MS = 300_000

        /** The node refuses a longer free-text answer (UTF-16 units, as JS and Kotlin count). */
        const val MAX_ANSWER_CHARS = 2000
        const val RETRY_OFFLINE = "node offline — retrying"
        const val RETRY_BUSY = "relay busy — retrying"
    }
}
