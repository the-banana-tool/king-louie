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
import com.example.kinglouie.protocol.ApprovalList
import com.example.kinglouie.protocol.ApprovalStatus
import com.example.kinglouie.protocol.B64Url
import com.example.kinglouie.protocol.Digest
import com.example.kinglouie.protocol.Display
import com.example.kinglouie.protocol.Envelope
import com.example.kinglouie.protocol.FrontDoor
import com.example.kinglouie.protocol.FrontDoorReply
import com.example.kinglouie.protocol.GrantRequest
import com.example.kinglouie.protocol.Identifiers
import com.example.kinglouie.protocol.Jcs
import com.example.kinglouie.protocol.LeaseAction
import com.example.kinglouie.protocol.LeaseRequest
import com.example.kinglouie.protocol.LeaseStatus
import com.example.kinglouie.protocol.Leases
import com.example.kinglouie.protocol.ListingCheck
import com.example.kinglouie.protocol.Messages
import com.example.kinglouie.protocol.NodePin
import com.example.kinglouie.protocol.PairingRequest
import com.example.kinglouie.protocol.PhoneKey
import com.example.kinglouie.protocol.PushText
import com.example.kinglouie.protocol.ProtocolException
import com.example.kinglouie.protocol.QuestionItem
import com.example.kinglouie.protocol.Questions
import com.example.kinglouie.protocol.RelayClientFactory
import com.example.kinglouie.protocol.RepinTarget
import com.example.kinglouie.protocol.ResponseOutcome
import com.example.kinglouie.protocol.ScopeChoice
import com.example.kinglouie.protocol.SendOutcome
import com.example.kinglouie.protocol.Timestamps
import com.example.kinglouie.protocol.arr
import com.example.kinglouie.protocol.bool
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.int
import com.example.kinglouie.protocol.obj
import com.example.kinglouie.protocol.str
import com.example.kinglouie.push.Push
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.text.DateFormat
import java.time.Instant
import java.util.Date

class AppModel(context: Context) {
    private val appContext: Context = context.applicationContext
    private val storage = Storage(context)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var key: DeviceKey? = runCatching { DeviceKey.load() }.getOrNull()

    /** The read key (android-slim §8.1), or null for a phone enrolled before it. Made and deleted with `key`. */
    private var readKey by mutableStateOf(runCatching { ReadKey.load() }.getOrNull())
    private var client: RelayApi? = null

    /** A pairing is under way; the loop does not run under it. */
    private var pairing = false

    /** Requests already reported as refused (bounded), so each is reported once. */
    private val warnedPayloads = HashSet<String>()
    var activity: FragmentActivity? = null

    var mode by mutableStateOf(storage.mode)
        private set
    var banner by mutableStateOf<String?>(null)

    /** Why the loop is not getting through, at most one line above the list (§6.2). */
    var pollProblem by mutableStateOf<String?>(null)
        private set
    var fingerprintToCompare by mutableStateOf<String?>(null)
    var frontDoorId by mutableStateOf(storage.frontDoorId)
        private set

    /** Add another phone (§6.4, InviteFlow.kt): the invite's QR while it is open, then the claimed device to compare. */
    private val invite = InviteFlow(scope) { banner = it }
    val inviteQr: String? get() = invite.qr
    val inviteClaim: JsonElement? get() = invite.claim

    /** A client connection this phone claimed by its code (C-13), with the code the grant message needs. */
    var grantRequest by mutableStateOf<GrantRequest?>(null)
        private set
    private var grantCode: String? = null

    /** When `grantRequest` arrived (elapsedRealtime ms); its expiry counts from here. */
    private var grantReceivedAtMs = 0L

    /** A front-door decision or action (client, pairing, revoke, remove, acknowledge) is being signed or sent. */
    var frontDoorBusy by mutableStateOf(false)
        private set

    // ---- The stores (android-slim §10): one per kind, each replaced whole by its fetch ----
    // Declared here, above `init`, so everything `init` reaches exists.

    /** Tool approvals (`GET /v1/approvals`), verified by `receive`. */
    val pending = mutableStateListOf<PendingItem>()

    /** Questions (`GET /v1/questions`), verified by `verifiedQuestion`. */
    val questions = mutableStateListOf<QuestionItem>()

    /** Lease requests (`GET /v1/leases`), verified by `verifiedLeaseRequest`. */
    val leaseRequests = mutableStateListOf<LeaseRequestItem>()

    /**
     * Leases a pinned node listed as running (or pending, by the rules of
     * notePendingListed) that are not the one on the live screen (owner
     * ruling R-F5-18).
     */
    val runningLeases = mutableStateListOf<RunningLease>()

    /**
     * What this phone knows about computer use on each pinned node, by node
     * id (owner ruling R-F5-20; fourth security review, finding 2): nothing
     * asked yet (no entry); a listing the node signed for this phone's own
     * request, accepted at a time by this phone's clock; or a request that
     * brought no listing this phone could accept. Written only by
     * refreshLeases, which the loop calls.
     */
    val leaseChecks = mutableStateMapOf<String, LeaseNodeCheck>()

    /** Node pairings waiting on the front door (`GET /v1/pairings/pending`), checked by the core. */
    val pairings = mutableStateListOf<PairingItem>()

    /** Front-door alerts (`GET /v1/alerts?since=0`). */
    val alerts = mutableStateListOf<JsonElement>()

    // Settings (§6.4), read with the read key when the screen opens.
    val clients = mutableStateListOf<JsonElement>()
    val frontDoorNodes = mutableStateListOf<JsonElement>()
    val devices = mutableStateListOf<JsonElement>()
    val online = mutableStateMapOf<String, Boolean>()

    val nodes: List<NodePin> get() = storage.nodes
    val relayUrl: String? get() = storage.relayUrl
    val relaySpki: String? get() = storage.relaySpki
    val deviceId: String? get() = key?.deviceId

    /** This phone's device key, as people compare it: `d-abcd efgh …`. */
    val deviceFingerprint: String? get() = key?.deviceId?.let { "d-" + Identifiers.fingerprintGroups(it) }

    /** Its read key's: `r-abcd efgh ijkl mnop` (§8.1); null without one. */
    val readKeyFingerprint: String? get() = readKey?.fingerprint

    init {
        if (mode == AppMode.LIVE) connect()
    }

    /**
     * The only place a network client is made. RelayClientFactory hands one
     * out in live mode only; without a key there is nothing to sign requests
     * with, so no client either. A new client restarts the loop on it.
     */
    private fun connect() {
        stopLoop(sayAway = false)
        client = null
        val k = key ?: return
        val url = storage.relayUrl ?: return
        val pin = storage.relaySpki ?: return
        val factory = RelayClientFactory {
            RelayApi(url, pin, k.deviceId, { data -> sign(k, data, "Check your relay", "Signs this phone's request to the relay") }, readSigner())
        }
        client = factory.client(mode)
        startLoop()
    }

    /** The read key's signer for RelayApi's read routes: no prompt, off the main thread. Null without a read key. */
    private fun readSigner(): (suspend (ByteArray) -> ByteArray)? {
        val rk = readKey ?: return null
        return { data -> withContext(Dispatchers.IO) { rk.sign(data) } }
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

    /**
     * The read key signs a `kl.lease.watch` and nothing else (android-slim
     * §8.5): no prompt. The envelope names the device, as the device key's
     * would (`kid` is the device id, `alg` ES256).
     */
    private suspend fun signRead(message: JsonObject): Envelope {
        if (message["type"].str() != "kl.lease.watch") throw OwnerMessage("Only a watch is signed without your fingerprint.")
        val rk = readKey ?: throw ReadKeyMissingException()
        val id = key?.deviceId ?: throw ReadKeyMissingException()
        val bytes = Jcs.bytes(message)
        val signature = withContext(Dispatchers.IO) { rk.sign(bytes) }
        return Envelope("ES256", id, B64Url.encode(bytes), B64Url.encode(signature))
    }

    // ---- The read key: set-up for a phone enrolled before it (android-slim §8.7) ----

    /** What a node knows of this phone's read key, for Settings (§6.4). */
    enum class ReadKeyNodeState { IN_USE, WAITING_FOR_APPLY, NOT_SENT }

    /** The set-up row (§8.7): signing or sending the statement. */
    var readKeySetupBusy by mutableStateOf(false)
        private set

    /** Each node's answer to the statement, the statement kept to re-post it, and whether the relay knows the read key (ReadKeyNodes.kt). */
    private val readKeyNodes = ReadKeyNodes(storage)

    /** A read key the relay knows: the loop may run (§9). */
    private val readKeyKnown: Boolean get() = readKey != null && !readKeyNodes.unknown

    /** Whether the Approvals list shows the set-up row (`READ_KEY_SETUP_TITLE`) until it is done. */
    val readKeySetupNeeded: Boolean get() = mode == AppMode.LIVE && key != null && !readKeyKnown

    /** Settings' line for one pinned node (§6.4). */
    fun readKeyState(nodeId: String): ReadKeyNodeState = when {
        !readKeyKnown -> ReadKeyNodeState.NOT_SENT
        // No statement was ever needed: the phone enrolled with its read key, so every node holds it.
        readKeyNodes.noneSent -> ReadKeyNodeState.IN_USE
        else -> when (readKeyNodes[nodeId]) {
            ReadKeyNodes.IN_USE -> ReadKeyNodeState.IN_USE
            ReadKeyNodes.WAITING -> ReadKeyNodeState.WAITING_FOR_APPLY
            else -> ReadKeyNodeState.NOT_SENT
        }
    }

    /**
     * The set-up row's tap: make the read key (or keep the one the relay does
     * not know yet), sign a `kl.device.read_key` with the device key (one
     * fingerprint) and post it with device-key transport (the second). A relay
     * from before the read key answers 404: the app says to upgrade it and
     * does not fall back to checking with fingerprints (C-19).
     */
    fun setUpReadKey() {
        if (readKeySetupBusy || mode != AppMode.LIVE || pairing) return
        val k = key ?: return
        val api = client ?: return
        readKeySetupBusy = true
        scope.launch {
            try {
                val rk = readKey ?: withContext(Dispatchers.IO) { ReadKey.create() }
                val envelope = signReadKeyStatement(k, rk, api)
                val reply = postReadKey(api, envelope, PhoneKey.DEVICE)
                readKey = rk
                readKeyNodes.keep(envelope)
                readKeyNodes.noteReply(reply, firstPost = true)
                readKeyNodes.markUnknown(false)
                // RelayApi now carries the read key's signer, and the loop starts on it.
                connect()
            } catch (e: Exception) {
                fail(e)
            } finally {
                readKeySetupBusy = false
            }
        }
    }

    /**
     * Settings' Send again, past the statement's seven days or after a node
     * refused it: a new statement (one fingerprint), posted with the read key,
     * which the relay already knows.
     */
    fun sendReadKeyAgain() {
        if (!readKeyKnown) return setUpReadKey()
        if (readKeySetupBusy) return
        val k = key ?: return
        val rk = readKey ?: return
        val api = client ?: return
        readKeySetupBusy = true
        scope.launch {
            try {
                val envelope = signReadKeyStatement(k, rk, api)
                val reply = postReadKey(api, envelope, PhoneKey.READ)
                readKeyNodes.keep(envelope)
                readKeyNodes.noteReply(reply, firstPost = true)
            } catch (e: Exception) {
                fail(e)
            } finally {
                readKeySetupBusy = false
            }
        }
    }

    private suspend fun signReadKeyStatement(k: DeviceKey, rk: ReadKey, api: RelayApi): Envelope {
        val now = api.now()
        val message = Messages.readKeyStatement(k.deviceId, rk.jwk, Timestamps.string(now), Timestamps.string(now.plusMillis(READ_KEY_STATEMENT_MS)), Messages.randomNonce())
        return signEnvelope(k, message, "Check without your fingerprint", "Adds this phone's read key ${rk.fingerprint}")
    }

    private suspend fun postReadKey(api: RelayApi, envelope: Envelope, transport: PhoneKey): JsonElement? = try {
        api.readKey(envelope, transport)
    } catch (e: RelayException) {
        if (e.status == 404) throw OwnerMessage(OLDER_RELAY)
        throw e
    }

    /** At each loop start: the kept statement again, with the read key, when a node was offline (§8.7). No prompt. */
    private suspend fun repostReadKeyStatement(api: RelayApi) {
        if (!readKeyNodes.anyOffline) return
        val envelope = readKeyNodes.kept(api.now().toEpochMilli()) ?: return
        readKeyNodes.noteReply(api.readKey(envelope, PhoneKey.READ), firstPost = false)
    }

    // ---- ForegroundLoop (android-slim §9) ----
    // One loop, started on ProcessLifecycleOwner's ON_START (onForeground,
    // KingLouieApplication) and cancelled on ON_STOP (onBackground), only in
    // live mode, with a read key the relay knows, and no pairing under way.
    // It reads with the read key alone: nothing in it signs with the device
    // key or makes a decision (owner ruling R-AN-6; R-F5-5 stands for every
    // decision). Every wait is a delay in its own coroutine.
    // tests/mobile-lease-apps.test.js reads this section up to its end marker.

    /** The app is in the foreground (ProcessLifecycleOwner between ON_START and ON_STOP). */
    private var foreground = false
    private var loop: ForegroundLoop? = null

    /** When the other kinds were last fetched (elapsedRealtime ms): at most once every REST_EVERY_MS. */
    private var lastRestAtMs = 0L
    private val restLock = Mutex()

    /** Pull to refresh is fetching. */
    var isRefreshing by mutableStateOf(false)
        private set

    /** ON_START. The Approvals notification's running count starts again (push spec §7.2). */
    fun onForeground() {
        foreground = true
        Push.appInFront(appContext)
        startLoop()
        startLiveLoop()
    }

    /** ON_STOP: the loop stops, with one best-effort "not in front" (C-8), and so do the live view's watches. */
    fun onBackground() {
        foreground = false
        stopLoop(sayAway = true)
        stopLiveLoop()
    }

    private fun startLoop() {
        if (!foreground || pairing || mode != AppMode.LIVE || loop != null || !readKeyKnown) return
        val api = client ?: return
        loop = ForegroundLoop(api).also { it.start() }
    }

    private fun stopLoop(sayAway: Boolean) {
        loop?.stop(sayAway)
        loop = null
    }

    /** Reading with the read key is possible now (the loop's conditions, less the foreground). */
    private fun readyToRead(): Boolean = mode == AppMode.LIVE && !pairing && readKeyKnown && client != null

    private inner class ForegroundLoop(private val api: RelayApi) {
        private var job: Job? = null
        private var repinTried = false

        fun start() {
            job = scope.launch {
                try {
                    run()
                } finally {
                    if (loop === this@ForegroundLoop) loop = null
                }
            }
        }

        fun stop(sayAway: Boolean) {
            job?.cancel()
            // Best effort, once: nothing waits for it and nothing sends it again.
            if (sayAway) scope.launch {
                try {
                    api.presence(false)
                } catch (e: Exception) {
                    // The node lets presence lapse after 120 s anyway.
                }
            }
        }

        private suspend fun run() = coroutineScope {
            // Presence (C-8): at the start and every 60 s while the loop runs.
            val presence = launch {
                while (isActive) {
                    try {
                        api.presence(true)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // A missed ping only lets presence lapse; the next one comes in 60 s.
                    }
                    delay(PRESENCE_EVERY_MS)
                }
            }
            try {
                try {
                    // §8.7: a statement a node did not get (it was offline) goes again, with no prompt.
                    repostReadKeyStatement(api)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Tried again at the next loop start; Settings shows each node's state.
                }
                sendPushToken()
                while (isActive) {
                    try {
                        // 1. The approvals long poll: the wake signal.
                        val items = api.approvals(LONG_POLL_S)
                        fingerprintToCompare = null
                        takeApprovals(items)
                        // 2. The other kinds, at most once every 5 s.
                        fetchRest(api)
                        pollProblem = null
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        pruneExpired()
                        if (!waitAfter(e)) break
                    }
                }
            } finally {
                presence.cancel()
            }
        }

        /** After an error: wait as §9 says and go on (true), or stop with the problem shown (false). */
        private suspend fun waitAfter(e: Exception): Boolean {
            when (e) {
                is ReadKeyMissingException -> {
                    // The Keystore no longer has it: the set-up row makes a new one.
                    readKey = null
                    return false
                }
                is ReadKeyUnavailableException -> {
                    pollProblem = e.message
                    delay(ERROR_WAIT_MS)
                    return true
                }
                is KeyInvalidatedException -> {
                    dropInvalidKey()
                    return false
                }
                is RelayException -> {
                    if (e.code == "unknown_read_key") {
                        // The relay does not know this read key: the set-up row of §8.7.
                        readKeyNodes.markUnknown(true)
                        pollProblem = null
                        return false
                    }
                    if (e.code == "pin_mismatch") {
                        // Only a front door's signed re-pin, checked against the key pinned from a
                        // code, moves the pin (once); connect() then runs a new loop on it.
                        if (!repinTried) {
                            repinTried = true
                            if (tryRepin()) return false
                        }
                        banner = describe(e)
                        pollProblem = describe(e)
                        return false
                    }
                    val seconds = e.retryAfter?.coerceAtLeast(1)
                        ?: if (e.status == 401 || e.code == "rate_limited") BUSY_WAIT_S else ERROR_WAIT_S
                    pollProblem = if (e.code == "network") "Can't reach the relay. Trying again in $seconds s."
                    else "${describe(e).trimEnd('.')}. Trying again in $seconds s."
                    delay(seconds * 1000L)
                    return true
                }
                else -> {
                    pollProblem = "${describe(e).trimEnd('.')}. Trying again in ${ERROR_WAIT_S} s."
                    delay(ERROR_WAIT_MS)
                    return true
                }
            }
        }
    }

    /**
     * The approvals store, replaced by what the relay lists: each item through
     * `receive` (the node's signature, approval-v1 §5); an undecided item the
     * relay no longer lists was decided elsewhere or ran out, and leaves. A
     * decided one stays until a minute past its expiry (pruneExpired).
     */
    private fun takeApprovals(items: List<JsonElement>) {
        val pins = storage.nodes
        val listed = items.mapNotNull { receive(it, pins) }.toSet()
        pending.removeAll { it.status == null && !it.deciding && it.id !in listed }
        pruneExpired()
    }

    /**
     * Step 2 of §9: questions, leases (with a fresh nonce) and, on a front
     * door, pairings and alerts; at most once every 5 s, whoever asks. One
     * kind failing leaves that kind as it was; a failure about this phone or
     * the relay as a whole goes to the caller.
     */
    private suspend fun fetchRest(api: RelayApi) = restLock.withLock {
        val now = SystemClock.elapsedRealtime()
        if (lastRestAtMs != 0L && now - lastRestAtMs < REST_EVERY_MS) return@withLock
        lastRestAtMs = now
        each { fetchQuestions(api) }
        each { refreshLeases(api) }
        if (frontDoorId != null) {
            each { fetchPairings(api) }
            each { fetchAlerts(api) }
        }
    }

    private suspend fun each(fetch: suspend () -> Unit) {
        try {
            fetch()
        } catch (e: RelayException) {
            if (e.status == 401 || e.code in setOf("rate_limited", "pin_mismatch", "network")) throw e
        } catch (e: ProtocolException) {
            // A reply this app refuses as malformed: that kind stays as it was.
        }
    }

    /**
     * A notification arrived (the push service's thread): while the app is in
     * front, step 2 at once, as for a tapped one (§9; the 5 s rule applies).
     * In the background nothing runs: the notification is what the owner sees.
     */
    fun onNotificationArrived() {
        scope.launch { if (foreground) refresh() }
    }

    /** Pull to refresh, a notification while in front, and the return from a decision: step 2 at once (the 5 s rule still applies). */
    fun refresh() {
        if (isRefreshing || !readyToRead()) return
        val api = client ?: return
        isRefreshing = true
        scope.launch {
            try {
                fetchRest(api)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                pollProblem = describe(e)
            } finally {
                isRefreshing = false
            }
        }
    }

    // ---- ForegroundLoop: end ----

    // ---- The Approvals list (android-slim §7, §10, §13) ----

    /** The detail on screen over the list: one kind and its id. */
    sealed class Selection {
        data class Tool(val requestId: String) : Selection()
        data class Question(val token: String) : Selection()
        data class LeaseRequest(val requestId: String) : Selection()
        data class RunningLease(val leaseId: String) : Selection()
        data class Client(val grantId: String) : Selection()
        data class Pairing(val pairingId: String) : Selection()
        data class Alert(val id: String) : Selection()
    }

    /** The detail on screen, or null for the list. */
    var selected by mutableStateOf<Selection?>(null)
        private set

    /** One line above the list after a notification whose item is gone (§13), or a session its node no longer has (C-18). */
    var listNotice by mutableStateOf<String?>(null)
        private set

    /** Row ids whose summary did not fit when drawn (Compose's hasVisualOverflow): Review in place of Approve (C-12). */
    private val overflowing = mutableStateMapOf<String, Boolean>()

    /** Questions answered on this phone, and alerts it acknowledged: decided rows until their store no longer lists them. */
    private val questionDecided = mutableStateMapOf<String, ApprovalList.Decided>()
    private val alertDecided = mutableStateMapOf<String, ApprovalList.Decided>()

    /**
     * Lease requests, a client connection and node pairings this phone
     * decided and the node or front door confirmed (§7.2): each a decided row
     * at the bottom until a minute past its expiry (DECIDED_KEEP_MS), as a
     * decided tool approval is. Kept apart from their stores, so a detail
     * whose item was decided closes itself.
     */
    private val leaseDecided = mutableStateMapOf<String, Pair<LeaseRequestItem, ApprovalList.Decided>>()

    private data class DecidedClient(val request: GrantRequest, val code: String, val receivedAtMs: Long, val decided: ApprovalList.Decided)

    private var clientDecided by mutableStateOf<DecidedClient?>(null)
    private val pairingDecided = mutableStateMapOf<String, Pair<PairingItem, ApprovalList.Decided>>()

    private fun leaseRequestKept(item: LeaseRequestItem, relayNowMs: Long): Boolean =
        relayNowMs <= (Timestamps.epochMillis(item.request.expiresAt) ?: 0L) + DECIDED_KEEP_MS

    private fun clientKept(c: DecidedClient, elapsedMs: Long): Boolean = elapsedMs - c.receivedAtMs <= c.request.expiresInMs + DECIDED_KEEP_MS

    private fun pairingKept(p: PairingItem, elapsedMs: Long): Boolean = elapsedMs - p.receivedAtMs <= p.request.expiresInMs + DECIDED_KEEP_MS

    fun reportOverflow(rowId: String, overflow: Boolean) {
        if (overflowing[rowId] != overflow) overflowing[rowId] = overflow
    }

    fun dismissListNotice() {
        listNotice = null
    }

    /**
     * The one list (§7): every store, as it stands, through ApprovalList.build
     * (the order, the host-built strings and the buttons are its).
     */
    fun approvalList(): ApprovalList.Result {
        val relayNow = client?.now()?.toEpochMilli() ?: System.currentTimeMillis()
        val elapsed = SystemClock.elapsedRealtime()
        fun decidedTool(p: PendingItem): ApprovalList.Decided? =
            p.status?.takeIf { it != RETRY_OFFLINE && it != RETRY_BUSY }?.let { ApprovalList.Decided(it, p.statusAtMs) }
        val grant = grantRequest
        val input = ApprovalList.Input(
            toolApprovals = pending.map { p ->
                ApprovalList.ToolApproval(p.id, p.display, p.timeLeftMs, sending = p.deciding || p.status == RETRY_OFFLINE || p.status == RETRY_BUSY, decided = decidedTool(p))
            },
            questions = questions.map { ApprovalList.Question(it, sending = it.token in answering, decided = questionDecided[it.token]) },
            leaseRequests = leaseRequests.map { item ->
                val left = (Timestamps.epochMillis(item.request.expiresAt) ?: 0L) - relayNow
                ApprovalList.LeaseRequestItem(item.request, item.nodeName, left, sending = item.request.requestId in decidingLease, unconfirmed = item.unconfirmed)
            } + leaseDecided.values.filter { (item, _) -> leaseRequestKept(item, relayNow) }.map { (item, d) ->
                ApprovalList.LeaseRequestItem(item.request, item.nodeName, (Timestamps.epochMillis(item.request.expiresAt) ?: 0L) - relayNow, decided = d)
            },
            clientConnections = (if (grant != null && grantCode != null) {
                listOf(ApprovalList.ClientConnection(grant, grantCode!!, (grant.expiresInMs - (elapsed - grantReceivedAtMs)).coerceAtLeast(0), sending = frontDoorBusy))
            } else emptyList()) + listOfNotNull(clientDecided?.takeIf { clientKept(it, elapsed) }?.let { c ->
                ApprovalList.ClientConnection(c.request, c.code, (c.request.expiresInMs - (elapsed - c.receivedAtMs)).coerceAtLeast(0), decided = c.decided)
            }),
            nodePairings = pairings.filter { it.request.pairingId !in pairingDecided }.map { ApprovalList.NodePairing(it.request, it.timeLeftMs, sending = frontDoorBusy) } +
                pairingDecided.values.filter { (item, _) -> pairingKept(item, elapsed) }.map { (item, d) -> ApprovalList.NodePairing(item.request, item.timeLeftMs, decided = d) },
            alerts = alerts.map { a -> ApprovalList.Alert(a, sending = frontDoorBusy, decided = a["id"].str()?.let { alertDecided[it] }) },
            runningLeases = runningLeaseRows(),
            nodes = storage.nodes,
            nodeChecks = leaseChecks.mapValues { (_, c) ->
                when (c) {
                    is LeaseNodeCheck.Confirmed -> ApprovalList.NodeCheck.Confirmed(c.atMs, c.running, c.waiting)
                    is LeaseNodeCheck.Unconfirmed -> ApprovalList.NodeCheck.Unconfirmed
                }
            },
            thisDevice = deviceId,
            relayNowMs = relayNow,
            frontDoorName = frontDoorId?.let { id -> storage.nodes.firstOrNull { it.id == id }?.name } ?: "front door",
            overflowing = overflowing.filterValues { it }.keys,
            pushOn = Push.ENABLED && storage.pushTokenSent != null,
            formatTime = { DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it)) },
            formatDateTime = { DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(it)) }
        )
        return ApprovalList.build(input)
    }

    /**
     * The running and pending leases, each from the status its node signed
     * (verified again against the pin), with what this phone has seen since
     * from signed views (the state, the time left). The lease on the live
     * screen first; an ended one has no row (C-18; ApprovalList drops it).
     */
    private fun runningLeaseRows(): List<ApprovalList.RunningLease> {
        val rows = ArrayList<ApprovalList.RunningLease>()
        val live = liveLease
        if (live != null) {
            val signed = live.lastStatus?.let { signedStatus(live.nodeId, it) }
            val status = (signed ?: LeaseStatus(live.leaseId, live.nodeId, live.appliedSeq, live.state, live.locked, live.reason, null)).copy(
                state = live.state, locked = live.locked, reason = live.reason,
                expiresAt = live.expiresAtMs?.let { Timestamps.string(Instant.ofEpochMilli(it)) } ?: signed?.expiresAt,
                grantedByDevice = live.grantedByDevice, grantedByName = live.grantedByName
            )
            rows.add(ApprovalList.RunningLease(status, live.nodeName, signedGrant = live.leaseId in signedLeaseGrants, sending = live.busy, unconfirmed = live.unconfirmed))
        }
        for (lease in runningLeases) {
            if (lease.leaseId == live?.leaseId) continue
            val status = lease.status?.let { signedStatus(lease.nodeId, it) } ?: continue
            rows.add(ApprovalList.RunningLease(status.copy(state = lease.state, reason = lease.reason), lease.nodeName, signedGrant = lease.leaseId in signedLeaseGrants))
        }
        return rows
    }

    private fun signedStatus(nodeId: String, envelope: Envelope): LeaseStatus? {
        val pin = storage.nodes.firstOrNull { it.id == nodeId } ?: return null
        return Leases.verifiedMessage(envelope, pin)?.let { LeaseStatus.from(it) }
    }

    /** A row tapped anywhere but its buttons, or its Review or Open: its detail. */
    fun open(row: ApprovalList.Row) {
        listNotice = null
        selected = when (row.kind) {
            ApprovalList.Kind.TOOL_APPROVAL -> Selection.Tool(row.ref)
            ApprovalList.Kind.QUESTION -> Selection.Question(row.ref)
            ApprovalList.Kind.LEASE_REQUEST -> Selection.LeaseRequest(row.ref)
            ApprovalList.Kind.CLIENT_CONNECTION -> Selection.Client(row.ref)
            ApprovalList.Kind.NODE_PAIRING -> Selection.Pairing(row.ref)
            ApprovalList.Kind.ALERT -> Selection.Alert(row.ref)
            ApprovalList.Kind.RUNNING_LEASE -> {
                if (liveLease?.leaseId != row.ref) runningLeases.firstOrNull { it.leaseId == row.ref }?.let { openRunningLease(it) }
                followLiveView()
                if (liveLease?.leaseId == row.ref) Selection.RunningLease(row.ref) else null
            }
            ApprovalList.Kind.NODE_CHECK -> null
        }
    }

    /**
     * Back to the list. A lease that is over is forgotten with its detail; a
     * running one keeps its row. The other kinds are fetched at once (the 5 s
     * rule applies), so a decision just made shows.
     */
    fun closeDetail() {
        if (selected is Selection.RunningLease && liveLease?.state == "ended") closeLiveLease()
        selected = null
        refresh()
    }

    /**
     * A row's own button (§7.2): the same decision the detail sends, with the
     * row's defaults (every requested app and `max_minutes` for a lease; the
     * front door's preselected scopes and no machine limits for a client).
     */
    fun press(row: ApprovalList.Row, button: ApprovalList.Button) {
        if (button == ApprovalList.Button.OPEN || button == ApprovalList.Button.REVIEW) return open(row)
        val yes = button == ApprovalList.Button.APPROVE
        when (row.kind) {
            ApprovalList.Kind.TOOL_APPROVAL -> if (yes || button == ApprovalList.Button.DENY) pending.firstOrNull { it.id == row.ref }?.let { decide(it, yes) }
            ApprovalList.Kind.LEASE_REQUEST -> leaseRequests.firstOrNull { it.request.requestId == row.ref }?.let { item ->
                if (yes) decideLease(item, item.request.apps.map { it.id }.toSet(), item.request.maxMinutes, grant = true)
                else if (button == ApprovalList.Button.DENY) decideLease(item, emptySet(), 1, grant = false)
            }
            ApprovalList.Kind.CLIENT_CONNECTION -> grantRequest?.takeIf { it.grantId == row.ref }?.let { request ->
                if (yes) decideGrant(request, request.preselected.map { ScopeChoice(it, null) }, true)
                else if (button == ApprovalList.Button.DENY) decideGrant(request, emptyList(), false)
            }
            ApprovalList.Kind.NODE_PAIRING -> pairings.firstOrNull { it.request.pairingId == row.ref }?.let {
                if (yes || button == ApprovalList.Button.DENY) decidePairing(it.request, yes)
            }
            ApprovalList.Kind.QUESTION -> if (button == ApprovalList.Button.GOT_IT) {
                questions.firstOrNull { it.token == row.ref && it.kind == "briefing" }?.let { answer(it, null, "ok") }
            }
            ApprovalList.Kind.ALERT -> if (button == ApprovalList.Button.ACKNOWLEDGE) ackAlert(row.ref)
            ApprovalList.Kind.RUNNING_LEASE -> if (button == ApprovalList.Button.STOP) {
                if (liveLease?.leaseId == row.ref) killSwitch() else runningLeases.firstOrNull { it.leaseId == row.ref }?.let { stopRunningLease(it) }
            }
            ApprovalList.Kind.NODE_CHECK -> Unit
        }
    }

    // What each detail shows, from its store (null once it left the store).
    val selectedPending: PendingItem? get() = (selected as? Selection.Tool)?.let { s -> pending.firstOrNull { it.id == s.requestId } }
    val selectedQuestion: QuestionItem? get() = (selected as? Selection.Question)?.let { s -> questions.firstOrNull { it.token == s.token } }
    val selectedLeaseRequest: LeaseRequestItem? get() = (selected as? Selection.LeaseRequest)?.let { s -> leaseRequests.firstOrNull { it.request.requestId == s.requestId } }
    val selectedClient: GrantRequest? get() = (selected as? Selection.Client)?.let { s -> grantRequest?.takeIf { it.grantId == s.grantId } }
    val selectedPairing: PairingItem? get() = (selected as? Selection.Pairing)?.let { s -> pairings.firstOrNull { it.request.pairingId == s.pairingId } }
    val selectedAlert: JsonElement? get() = (selected as? Selection.Alert)?.let { s -> alerts.firstOrNull { it["id"].str() == s.id } }

    /** The running lease's detail is the live view (§7.6): `liveLease`, while it is the one selected. */
    val selectedLiveLease: LiveLease? get() = (selected as? Selection.RunningLease)?.let { s -> liveLease?.takeIf { it.leaseId == s.leaseId } }

    // ---- Questions (cases stage 4) ----
    // Presence now comes from the foreground loop (C-8; ruling T19-presence no
    // longer holds for Android), and the list is fetched by the loop with the
    // read key.

    /** Tokens whose answer is being signed or sent. */
    val answering = mutableStateListOf<String>()
    private val answeredTokens = HashSet<String>()

    /**
     * The questions store, replaced whole. Only a node-signed
     * `kl.question.ask` from a pinned node (kid, node_id and signature all
     * that node's) is shown; one answered here is not shown again.
     */
    private suspend fun fetchQuestions(api: RelayApi) {
        val pins = storage.nodes
        val items = api.questions().mapNotNull { entry -> verifiedQuestion(entry, pins) }
            .distinctBy { it.token }
            .filter { it.token !in answeredTokens }
        questions.clear()
        questions.addAll(items)
        questionDecided.keys.retainAll(items.map { it.token }.toSet())
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
     * untrusted in a prompt). The request that carries it goes with the read
     * key: the answer itself is the device key's (§8.4).
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
                    // A decided row until the next fetch, which no longer lists it.
                    questionDecided[item.token] = ApprovalList.Decided(ack ?: "Answer recorded.", SystemClock.elapsedRealtime())
                    if ((selected as? Selection.Question)?.token == item.token) selected = null
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

    // ---- Leases (fleet stage 5) ----
    // Owner ruling R-F5-5 (2026-10-12) stands: each decision below (Allow,
    // Deny, Stop) is signed once with the device key, sent once, and shown as
    // not confirmed when no answer came. What changed (android-slim, R-AN-6,
    // R-AN-9; R-F5-1 and R-F5-6 no longer hold for Android): the list is
    // fetched by the foreground loop (refreshLeases), and the running lease's
    // detail updates by itself through the live view loop below, whose watch
    // is signed with the read key. tests/mobile-lease-apps.test.js reads this
    // section up to its end marker, so keep both markers.

    data class LeaseRequestItem(val request: LeaseRequest, val nodeName: String, val status: LeaseStatus?, val unconfirmed: String? = null)

    data class LiveLease(
        val nodeId: String, val nodeName: String, val leaseId: String, val state: String = "pending", val locked: Boolean = false,
        val reason: String? = null, val expiresAtMs: Long? = null, val frame: ByteArray? = null, val frameAtMs: Long? = null,
        val frameDropped: Boolean = false, val actions: List<LeaseAction> = emptyList(), val lastSeq: Int = 0,
        /** The newest node seq (statuses and views share it) already applied to this lease (R-F5-16); lastSeq is the relay's mailbox position. */
        val appliedSeq: Int = 0,
        /** The contact token of the newest status or view applied (R-F5-15): the next watch echoes it. */
        val contactToken: String? = null,
        /** When that token was applied, on this phone's running clock (SystemClock.elapsedRealtime). */
        val contactTokenAtMs: Long? = null,
        /** Who granted the lease, as its node signed it (R-F5-18); null until a status said. */
        val grantedByDevice: String? = null,
        val grantedByName: String? = null,
        /** The newest status applied, as the node signed it. */
        val lastStatus: Envelope? = null,
        /** A Stop, or the fingerprint watch, is being signed or sent. */
        val busy: Boolean = false,
        /** The last Stop, or fingerprint watch, got no answer; shown until the next tap. */
        val unconfirmed: String? = null,
        /** The node refused this phone's read-key watch (it does not know the read key yet, §8.7): the view offers the fingerprint watch. */
        val readKeyRefused: Boolean = false
    )

    /**
     * A lease this phone knows to be running from a status its node signed
     * (owner ruling R-F5-18): one another phone granted, or one this phone
     * granted before it was restarted. Enough for the banner and for Stop.
     * `status` is that signed status, so following the lease starts from it.
     */
    data class RunningLease(
        val nodeId: String, val nodeName: String, val leaseId: String, val state: String, val reason: String?, val appliedSeq: Int,
        val grantedByDevice: String?, val grantedByName: String?, val status: Envelope?
    )

    /** One pinned node's entry in `leaseChecks`; a node without one has not been asked yet. */
    sealed class LeaseNodeCheck {
        /** A listing this phone accepted at [atMs] (System.currentTimeMillis): [running] live leases, [waiting] requests not yet answered. */
        data class Confirmed(val atMs: Long, val running: Int, val waiting: Int) : LeaseNodeCheck()

        /** The last request brought no listing this phone could accept. */
        object Unconfirmed : LeaseNodeCheck()
    }

    /** What one send came to: the node's answer, or why there is none. */
    private class LeaseReply(val outcome: SendOutcome, val json: JsonElement?, val problem: String?)

    var liveLease by mutableStateOf<LiveLease?>(null)
        private set

    /** Request ids whose decision is being signed or sent. */
    val decidingLease = mutableStateListOf<String>()
    private val decidedLeaseRequests = HashSet<String>()

    /**
     * Leases this phone has signed a grant for, by lease id, with when the
     * request that grant answers expires (epoch ms; fourth security review,
     * finding 3). Kept from the signature on, whatever the relay then
     * answered: a relay can say 503 and deliver the grant later. In memory
     * only: a phone that was restarted in between no longer knows. It decides
     * only what a pending lease's row says and how long it stays, never
     * whether there is one (fifth security review, finding 1:
     * notePendingListed).
     */
    private val signedLeaseGrants = HashMap<String, Long>()

    /** The entries of the last list request, for a notification that names a lease (§13). */
    private var lastLeaseEntries: List<JsonElement> = emptyList()

    /**
     * One list request, with the read key, called by the foreground loop
     * (§10; it was the "Check" button's). The same answer lists what is
     * running (R-F5-18): for each lease a status its node signed for this
     * listing, with no request beside it. A request that fails leaves every
     * node "could not confirm" and goes to the caller.
     */
    private suspend fun refreshLeases(api: RelayApi) {
        try {
            val pins = storage.nodes
            // R-F5-20: a nonce chosen for this one request. Each node signs its listing
            // over it, so an answer to an earlier request cannot be played again and no
            // entry can be left out unseen. Still one request, now with the read key.
            val nonce = Messages.randomNonce()
            val listed = api.leases(nonce)
            lastLeaseEntries = listed
            val items = listed.mapNotNull { entry -> verifiedLeaseRequest(entry, pins, api) }.distinctBy { it.request.requestId }
            leaseRequests.clear()
            leaseRequests.addAll(items)
            for (entry in listed) noteListedLease(entry, pins)
            // R-F5-20: per pinned node, a listing it signed for this request and this
            // phone, complete, or no answer. This phone cannot tell a node that is off,
            // slow or older from a relay that kept its answer back: all "could not confirm".
            // An accepted listing is "confirmed", with the time this phone accepted it and
            // what the node listed; nothing else is.
            val checkedAt = System.currentTimeMillis()
            for (pin in pins) {
                val check = Leases.checkListing(listed, pin, nonce, deviceId ?: "")
                leaseChecks[pin.id] = if (check.accepted) {
                    val named = Leases.listedStatuses(check, pin)
                    dropMayStartRows(pin, named.map { it.leaseId }.toSet(), api)
                    notePendingListed(check, pin, items.map { it.request.leaseId }.toSet())
                    LeaseNodeCheck.Confirmed(checkedAt, named.count { Leases.isLive(it.state) }, named.count { it.state == "pending" })
                } else {
                    LeaseNodeCheck.Unconfirmed
                }
            }
        } catch (e: Exception) {
            // No reply at all: nothing was confirmed with any node.
            for (pin in storage.nodes) leaseChecks[pin.id] = LeaseNodeCheck.Unconfirmed
            throw e
        }
    }

    /**
     * A request is listed only when a pinned node signed it (kid, node_id and
     * signature all that node's), its lease hash is intact, it has not
     * expired on the relay-corrected clock, and no status that node signed
     * about this lease says it ended.
     */
    private fun verifiedLeaseRequest(entry: JsonElement, pins: List<NodePin>, api: RelayApi): LeaseRequestItem? {
        val envelope = try {
            Envelope.fromJson(entry["envelope"] ?: return null)
        } catch (e: ProtocolException) {
            return null
        }
        val pin = pins.firstOrNull { it.id == envelope.kid } ?: return null
        val request = Leases.verifiedMessage(envelope, pin)?.let { LeaseRequest.from(it) } ?: return null
        if (request.requestId in decidedLeaseRequests) return null
        if ((Timestamps.epochMillis(request.expiresAt) ?: 0L) <= api.now().toEpochMilli()) return null
        // Listed under the node that signed it.
        entry["node_id"].str()?.let { if (it != pin.id) return null }
        val status = entry["status"]?.takeIf { it !is JsonNull }?.let { runCatching { Envelope.fromJson(it) }.getOrNull() }
            ?.let { Leases.verifiedMessage(it, pin) }?.let { LeaseStatus.from(it) }?.takeIf { it.leaseId == request.leaseId }
        if (status?.state == "ended") return null
        return LeaseRequestItem(request, pin.name, status)
    }

    /** Whether a listed entry carries no request: a running (or lately ended) lease, by its status alone. */
    private fun isStatusOnly(entry: JsonElement): Boolean = entry["envelope"].let { it == null || it is JsonNull }

    /**
     * One listed status (R-F5-18), only when the pinned node it is listed
     * under signed it. It updates the lease on the live screen through
     * applyLease, or the list of running leases: newer than what is known (by
     * the node's seq), kept while the lease runs, dropped once the node says
     * it ended. Nothing here is taken on the relay's word.
     */
    private fun noteListedLease(entry: JsonElement, pins: List<NodePin>) {
        if (!isStatusOnly(entry)) return
        val pin = pins.firstOrNull { it.id == entry["node_id"].str() } ?: return
        val signed = entry["status"]?.takeIf { it !is JsonNull }?.let { runCatching { Envelope.fromJson(it) }.getOrNull() } ?: return
        val status = Leases.verifiedMessage(signed, pin)?.let { LeaseStatus.from(it) } ?: return
        val live = liveLease
        if (live != null && live.leaseId == status.leaseId) {
            liveLease = applyLease(signed, pin, live, deviceId ?: "")
            return
        }
        val known = runningLeases.indexOfFirst { it.leaseId == status.leaseId }
        if (!Leases.acceptsStatus(status, if (known >= 0) runningLeases[known].appliedSeq else 0)) return
        statusApplied(status)
        // A row that is there stays while its node still signs "pending", whoever signed a
        // grant (fifth security review, finding 1): a newer status without a listing must
        // not take it down.
        if (known >= 0 && status.state == "pending") {
            runningLeases[known] = RunningLease(pin.id, pin.name, status.leaseId, status.state, status.reason, status.seq, status.grantedByDevice, status.grantedByName, signed)
            return
        }
        if (known >= 0) runningLeases.removeAt(known)
        // Finding 3: a lease still waiting for an answer gets a row too when this phone
        // signed a grant for it ("May still start").
        if (!Leases.isLive(status.state) && !Leases.mayStillStart(status.state, status.leaseId in signedLeaseGrants)) {
            if (status.state == "ended") signedLeaseGrants.remove(status.leaseId)
            return
        }
        runningLeases.add(RunningLease(pin.id, pin.name, status.leaseId, status.state, status.reason, status.seq, status.grantedByDevice, status.grantedByName, signed))
    }

    /**
     * After a listing [pin] signed was accepted: a banner row, with the Stop
     * every row has, for each lease it names as pending (fifth security
     * review, finding 1). Not from memory: after a restart this phone no
     * longer knows what it signed, and another phone never did, while the
     * relay can still deliver a grant it held back. What this phone
     * remembers only chooses the words (pendingLeaseTitle). A request that
     * is on screen with its Allow and Deny, unanswered by this phone, is
     * that request and gets no second row. Only statuses of a listing that
     * passed are read, each verified again. Nothing is signed or sent here
     * (R-F5-5); it runs inside refreshLeases.
     */
    private fun notePendingListed(check: ListingCheck, pin: NodePin, shownAsRequest: Set<String>) {
        if (!check.accepted) return
        for (signed in check.statuses) {
            val status = Leases.verifiedMessage(signed, pin)?.let { LeaseStatus.from(it) } ?: continue
            if (!Leases.listedPendingGetsRow(status.state, status.leaseId in shownAsRequest, status.leaseId in signedLeaseGrants)) continue
            // The lease on the live screen has its row; so has one already listed.
            if (liveLease?.leaseId == status.leaseId) continue
            if (runningLeases.any { it.leaseId == status.leaseId }) continue
            if (!Leases.acceptsStatus(status, 0)) continue
            runningLeases.add(RunningLease(pin.id, pin.name, status.leaseId, status.state, status.reason, status.seq, status.grantedByDevice, status.grantedByName, signed))
        }
    }

    /** What a pending lease's row is called: "May still start" only for a grant this phone remembers signing. */
    fun pendingLeaseTitle(leaseId: String, nodeName: String): String = Leases.pendingTitle(nodeName, leaseId in signedLeaseGrants)

    /** Under that row: which of the two this phone knows. */
    fun pendingLeaseDetail(leaseId: String): String = Leases.pendingDetail(leaseId in signedLeaseGrants)

    /**
     * Revised 2026-10-24: an unattended take's name and when it ends (epoch
     * ms), from a lease's signed status, verified again against the pinned
     * node; null for any other lease, and for one not running yet.
     */
    fun unattendedTake(lease: RunningLease): Pair<String, Long>? = unattendedTake(lease.nodeId, lease.leaseId, lease.state, lease.status)

    fun unattendedTake(lease: LiveLease): Pair<String, Long>? = unattendedTake(lease.nodeId, lease.leaseId, lease.state, lease.lastStatus)

    private fun unattendedTake(nodeId: String, leaseId: String, state: String, signed: Envelope?): Pair<String, Long>? {
        if (state == "pending" || signed == null) return null
        val pin = storage.nodes.firstOrNull { it.id == nodeId } ?: return null
        val status = Leases.verifiedMessage(signed, pin)?.let { LeaseStatus.from(it) } ?: return null
        if (status.leaseId != leaseId || !status.unattended) return null
        val name = status.name ?: return null
        val ends = status.expiresAt?.let { Timestamps.epochMillis(it) } ?: return null
        return name to ends
    }

    /**
     * After a listing [pin] signed was accepted: the "May still start" rows
     * of that node the listing does not name (finding 3). Such a row goes
     * only once the request its grant answered has expired, on this phone's
     * clock and on the relay-corrected one (so a relay that pushes the clock
     * forward gains nothing). A pending row for a lease this phone remembers
     * no grant for has no such time: it goes as soon as a listing that
     * passed no longer names the lease. A row the listing names is handled
     * by its signed status (noteListedLease). Nothing is signed or sent here
     * (R-F5-5): Stop is the owner's tap.
     */
    private fun dropMayStartRows(pin: NodePin, named: Set<String>, api: RelayApi) {
        val relayNowMs = api.now().toEpochMilli()
        fun gone(leaseId: String): Boolean {
            if (leaseId in named) return false
            val expires = signedLeaseGrants[leaseId]
            val expired = expires == null || (expires < System.currentTimeMillis() && expires < relayNowMs)
            return !Leases.keepsMayStart(null, expired)
        }
        val dropped = runningLeases.filter { it.nodeId == pin.id && it.state == "pending" && gone(it.leaseId) }.map { it.leaseId }.toMutableSet()
        // The same lease when it is the one on the live screen (the owner is on Pending when this runs).
        val live = liveLease
        if (live != null && live.nodeId == pin.id && live.state == "pending" && !live.busy && gone(live.leaseId)) {
            dropped.add(live.leaseId)
            closeLiveLease()
        }
        runningLeases.removeAll { it.leaseId in dropped }
        signedLeaseGrants.keys.removeAll(dropped)
    }

    /** One send, never repeated (R-F5-5): the node's answer, or why there is none. */
    private suspend fun sendLease(api: RelayApi, action: String, leaseId: String, envelope: Envelope): LeaseReply = try {
        val json = api.leaseDecision(action, leaseId, envelope)
        val outcome = Leases.sendOutcome(json)
        LeaseReply(outcome, json, if (outcome is SendOutcome.Unconfirmed) "the answer could not be read" else null)
    } catch (e: RelayException) {
        LeaseReply(SendOutcome.Unconfirmed, null, describe(e).trimEnd('.'))
    }

    private fun markLeaseUnconfirmed(requestId: String, text: String?) {
        val i = leaseRequests.indexOfFirst { it.request.requestId == requestId }
        if (i >= 0) leaseRequests[i] = leaseRequests[i].copy(unconfirmed = text)
    }

    /** Allow or Deny: one signature over the decision, carried by a read-key request (one prompt, §8.4). */
    fun decideLease(item: LeaseRequestItem, apps: Set<String>, minutes: Int, grant: Boolean) {
        val id = item.request.requestId
        val k = key ?: return
        val api = client ?: return
        if (id in decidingLease) return
        decidingLease.add(id)
        markLeaseUnconfirmed(id, null)
        scope.launch {
            try {
                val signedAt = Timestamps.string(api.now())
                val envelope = if (grant) {
                    val names = item.request.apps.filter { it.id in apps }.joinToString(", ") { promptText(it.name, 30) }
                    signEnvelope(k, Leases.grant(item.request, apps.toList(), minutes, k.deviceId, signedAt), "Allow computer use",
                        "$names on ${promptText(item.nodeName, 30)} for $minutes min")
                } else {
                    signEnvelope(k, Leases.deny(item.request, k.deviceId, signedAt), "Deny computer use", promptText(item.nodeName, 30))
                }
                // Signed: from here on the lease may start, whatever the relay answers.
                if (grant) signedLeaseGrants[item.request.leaseId] = Timestamps.epochMillis(item.request.expiresAt) ?: Long.MAX_VALUE
                val sent = sendLease(api, "grant", item.request.leaseId, envelope)
                when (val outcome = sent.outcome) {
                    is SendOutcome.Unconfirmed ->
                        markLeaseUnconfirmed(id, "Not confirmed: ${sent.problem}. Tap again, or wait for the list to show what the node did.")
                    is SendOutcome.Rejected -> banner = "Node rejected: ${friendlyReason(outcome.reason)}"
                    is SendOutcome.Confirmed -> {
                        decidedLeaseRequests.add(id)
                        // A decided row until a minute past the request's expiry (§7.2).
                        leaseDecided[id] = item.copy(unconfirmed = null) to ApprovalList.Decided(if (grant) "Allowed" else "Denied", SystemClock.elapsedRealtime())
                        leaseRequests.removeAll { it.request.requestId == id }
                        if (grant && outcome.state == "active") {
                            openLiveLease(item.request.nodeId, item.request.leaseId, outcome.state)
                            // The node's answer carries the status it signed for it, and with that the
                            // first contact token: the live view's first watch can echo it (R-F5-15).
                            val opened = liveLease
                            val pin = storage.nodes.firstOrNull { it.id == item.request.nodeId }
                            if (opened != null && pin != null && opened.leaseId == item.request.leaseId) liveLease = applyReplyStatus(sent.json, pin, opened, k.deviceId)
                        }
                    }
                }
            } catch (e: Exception) {
                // A prompt was cancelled or the key failed: the decision was not sent.
                fail(e)
            } finally {
                decidingLease.remove(id)
            }
        }
    }

    /**
     * A banner row's lease becomes the one on the live screen, starting from
     * the status its node signed (R-F5-18). Nothing is fetched or sent. The
     * lease that was there keeps its banner row while it runs.
     */
    private fun followRunningLease(lease: RunningLease) {
        val pin = storage.nodes.firstOrNull { it.id == lease.nodeId } ?: return
        val old = liveLease
        if (old != null && old.leaseId == lease.leaseId) return
        // A pending lease keeps its row too, once its node has signed a status for it.
        if (old != null && (Leases.isLive(old.state) || (old.state == "pending" && old.lastStatus != null))) {
            runningLeases.removeAll { it.leaseId == old.leaseId }
            runningLeases.add(RunningLease(old.nodeId, old.nodeName, old.leaseId, old.state, old.reason, old.appliedSeq, old.grantedByDevice, old.grantedByName, old.lastStatus))
        }
        runningLeases.removeAll { it.leaseId == lease.leaseId }
        val opened = LiveLease(lease.nodeId, pin.name, lease.leaseId)
        liveLease = if (lease.status != null) applyLease(lease.status, pin, opened, deviceId ?: "") else opened
    }

    /** The live screen of a lease, from its row. It fetches nothing itself: the live view's loop does, while it is on screen. */
    fun openRunningLease(lease: RunningLease) {
        followRunningLease(lease)
    }

    /**
     * Stop, from a row, for a lease this phone is not following
     * (R-F5-18): it becomes the one on the live screen, and then "Stop now"
     * as always: one signed revoke, sent one time, one prompt. Any enrolled
     * phone may stop a lease.
     */
    fun stopRunningLease(lease: RunningLease) {
        followRunningLease(lease)
        if (liveLease?.leaseId == lease.leaseId) killSwitch()
    }

    /** Opens the live screen with what is already known. It fetches nothing itself: the live view's loop does, while it is on screen. */
    fun openLiveLease(nodeId: String, leaseId: String, state: String = "pending") {
        val pin = storage.nodes.firstOrNull { it.id == nodeId } ?: return
        liveLease = LiveLease(nodeId, pin.name, leaseId, state = state)
    }

    // ---- Live view loop (android-slim §7.6) ----
    // The running lease's detail updates by itself while it is on screen and
    // the app is in the foreground: it long-polls the lease's views and sends
    // a kl.lease.watch every WATCH_EVERY_MS, signed with the read key (signRead),
    // echoing the newest contact token it applied, plus one early watch when a
    // fresher token arrives within the 20 s (iOS's rule). Leaving the view or
    // the app going to the background stops both. Every status and view goes
    // through applyLease. Nothing here signs with the device key or decides:
    // the fingerprint watch is watchWithFingerprint, called only from its button.

    /** The live view is composed (LeaseScreens.kt's one DisposableEffect says so). */
    private var liveViewVisible = false
    private var liveLoopJob: Job? = null

    /** The live view came on screen. */
    fun liveViewShown() {
        liveViewVisible = true
        startLiveLoop()
    }

    /** The live view left the screen: its watches and polls stop. */
    fun liveViewHidden() {
        liveViewVisible = false
        stopLiveLoop()
    }

    private fun stopLiveLoop() {
        liveLoopJob?.cancel()
        liveLoopJob = null
    }

    /** Another lease came onto the live view (from a row or a notification): the loop follows it. */
    private fun followLiveView() {
        if (!liveViewVisible) return
        stopLiveLoop()
        startLiveLoop()
    }

    private fun startLiveLoop() {
        if (!liveViewVisible || !foreground || liveLoopJob?.isActive == true || !readKeyKnown) return
        val api = client ?: return
        val leaseId = liveLease?.leaseId ?: return
        val deviceId = key?.deviceId ?: return
        liveLoopJob = scope.launch {
            var lastWatchAtMs = 0L
            var lastWatchToken: String? = null
            var earlyUsed = false
            while (true) {
                val live = liveLease?.takeIf { it.leaseId == leaseId } ?: break
                if (live.state == "ended") break
                val pin = storage.nodes.firstOrNull { it.id == live.nodeId } ?: break
                try {
                    var cursor = live.lastSeq
                    val since = SystemClock.elapsedRealtime() - lastWatchAtMs
                    val early = Leases.isPausedForContact(live.state, live.reason) && !earlyUsed &&
                        live.contactToken != null && live.contactToken != lastWatchToken
                    if (!live.readKeyRefused && (lastWatchAtMs == 0L || since >= WATCH_EVERY_MS || early)) {
                        earlyUsed = lastWatchAtMs != 0L && since < WATCH_EVERY_MS
                        // R-F5-15: a watch is contact only when it echoes a token the node issued a short
                        // while ago; with an old one (or none) the node is asked for a status signed now first.
                        if (Leases.tokenIsStale(live.contactTokenAtMs, SystemClock.elapsedRealtime())) {
                            for (entry in api.leases()) {
                                if (!isStatusOnly(entry) || entry["node_id"].str() != pin.id) continue
                                val signed = entry["status"]?.takeIf { it !is JsonNull }?.let { runCatching { Envelope.fromJson(it) }.getOrNull() } ?: continue
                                updateLive(leaseId) { applyLease(signed, pin, it, deviceId) }
                            }
                        }
                        val current = liveLease?.takeIf { it.leaseId == leaseId } ?: break
                        val watch = Leases.watch(current.nodeId, current.leaseId, deviceId, current.contactToken, Messages.randomNonce(), Timestamps.string(api.now()))
                        val sent = sendLease(api, "watch", leaseId, signRead(watch))
                        lastWatchAtMs = SystemClock.elapsedRealtime()
                        lastWatchToken = current.contactToken
                        when (val outcome = sent.outcome) {
                            is SendOutcome.Confirmed -> {
                                // The reply is the relay's word: only its node-signed status is applied.
                                cursor = Leases.cursorAfterWatch(current.lastSeq, sent.json)
                                updateLive(leaseId) { applyReplyStatus(sent.json, pin, it, deviceId) }
                                readKeyNodes.set(pin.id, ReadKeyNodes.IN_USE)
                            }
                            is SendOutcome.Rejected -> if (outcome.reason == "bad_signature") {
                                // §8.7: this node does not know the read key yet. The view offers the
                                // fingerprint watch; no more read-key watches go to it from this view.
                                updateLive(leaseId) { it.copy(readKeyRefused = true) }
                                if (readKeyNodes[pin.id] == ReadKeyNodes.IN_USE) readKeyNodes.set(pin.id, ReadKeyNodes.WAITING)
                            }
                            is SendOutcome.Unconfirmed -> Unit
                        }
                    }
                    val waitS = if (liveLease?.readKeyRefused == true) LONG_POLL_S
                    else ((WATCH_EVERY_MS - (SystemClock.elapsedRealtime() - lastWatchAtMs)) / 1000).toInt().coerceIn(1, LONG_POLL_S)
                    val entries = api.leaseViews(leaseId, cursor, waitS)
                    var seq = cursor
                    for (entry in entries) {
                        seq = maxOf(seq, entry["seq"].int() ?: seq)
                        val raw = entry["envelope"] ?: continue
                        val envelope = try {
                            Envelope.fromJson(raw)
                        } catch (e: ProtocolException) {
                            continue
                        }
                        updateLive(leaseId) { applyLease(envelope, pin, it, deviceId) }
                    }
                    updateLive(leaseId) { it.copy(lastSeq = maxOf(it.lastSeq, seq)) }
                    // Nothing new and no wait left: a breath before the next poll.
                    if (entries.isEmpty()) delay(LIVE_IDLE_MS)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: RelayException) {
                    if (e.code == "unknown_read_key") {
                        readKeyNodes.markUnknown(true)
                        break
                    }
                    delay((e.retryAfter ?: if (e.status == 401 || e.code == "rate_limited") BUSY_WAIT_S else ERROR_WAIT_S).coerceAtLeast(1) * 1000L)
                } catch (e: ReadKeyMissingException) {
                    readKey = null
                    break
                } catch (e: Exception) {
                    // A locked phone (the read key refuses then) or a reply this app refuses: wait, then go on.
                    delay(ERROR_WAIT_MS)
                }
            }
        }
    }

    // ---- Live view loop: end ----

    /** A change to the lease on the live screen, only while it is still [leaseId]. */
    private inline fun updateLive(leaseId: String, change: (LiveLease) -> LiveLease) {
        val live = liveLease
        if (live != null && live.leaseId == leaseId) liveLease = change(live)
    }

    /**
     * "Keep it going with your fingerprint" (§7.6): when a node refused the
     * read-key watch because it does not know the read key yet, one watch
     * signed with the device key, sent once (one prompt; the request that
     * carries it goes with the read key). Called only from its button;
     * nothing repeats it by itself.
     */
    fun watchWithFingerprint() {
        val live = liveLease ?: return
        if (live.busy || live.state == "ended") return
        val k = key ?: return
        val api = client ?: return
        val pin = storage.nodes.firstOrNull { it.id == live.nodeId } ?: return
        liveLease = live.copy(busy = true, unconfirmed = null)
        scope.launch {
            var unconfirmed: String? = null
            try {
                val watch = Leases.watch(live.nodeId, live.leaseId, k.deviceId, live.contactToken, Messages.randomNonce(), Timestamps.string(api.now()))
                val sent = sendLease(api, "watch", live.leaseId, signEnvelope(k, watch, "Keep computer use going", promptText(live.nodeName, 30)))
                when (val outcome = sent.outcome) {
                    is SendOutcome.Unconfirmed -> unconfirmed = "Not confirmed: ${sent.problem}. Tap again."
                    is SendOutcome.Rejected -> unconfirmed = "The node refused the watch: ${friendlyReason(outcome.reason)}."
                    is SendOutcome.Confirmed -> updateLive(live.leaseId) { applyReplyStatus(sent.json, pin, it, k.deviceId) }
                }
            } catch (e: Exception) {
                // A prompt was cancelled or the key failed: the watch was not sent.
                fail(e)
            } finally {
                updateLive(live.leaseId) { it.copy(busy = false, unconfirmed = unconfirmed) }
            }
        }
    }

    /** What the live view says when a node refused the read-key watch (§7.6, §8.7). */
    fun readKeyRefusedText(live: LiveLease): String =
        "${Display.escape(live.nodeName)} does not know this phone's read key yet: run `king-louie-service device apply` there."

    /**
     * One received envelope onto the live lease. Only a status or a view the
     * pinned node signed, about this lease, changes anything; and (R-F5-16)
     * only one whose node seq is newer than the newest already applied, and
     * a view only when it is addressed to this device.
     */
    private fun applyLease(envelope: Envelope, pin: NodePin, live: LiveLease, deviceId: String): LiveLease {
        val status = Leases.verifiedMessage(envelope, pin)?.let { LeaseStatus.from(it) }
        if (status != null) {
            if (status.leaseId != live.leaseId || !Leases.acceptsStatus(status, live.appliedSeq)) return live
            statusApplied(status)
            return live.copy(
                appliedSeq = status.seq, state = status.state, locked = status.locked, reason = status.reason,
                expiresAtMs = status.expiresAt?.let { Timestamps.epochMillis(it) }, contactToken = status.contactToken ?: live.contactToken,
                contactTokenAtMs = if (status.contactToken != null) SystemClock.elapsedRealtime() else live.contactTokenAtMs,
                grantedByDevice = status.grantedByDevice ?: live.grantedByDevice, grantedByName = if (status.grantedByDevice != null) status.grantedByName else live.grantedByName,
                lastStatus = envelope
            )
        }
        val check = Leases.verifyView(envelope, pin)
        val view = check.view?.takeIf { check.accepted && it.leaseId == live.leaseId } ?: return live
        if (!Leases.acceptsView(view, live.appliedSeq, deviceId)) return live
        val now = System.currentTimeMillis()
        return live.copy(
            appliedSeq = view.seq, state = view.state, locked = view.locked, expiresAtMs = now + view.remainingS * 1000L,
            frameDropped = view.frameDropped, frame = view.frame ?: live.frame, frameAtMs = if (view.frame != null) now else live.frameAtMs,
            actions = Leases.mergedActions(live.actions, view.actions), contactToken = view.contactToken ?: live.contactToken,
            contactTokenAtMs = if (view.contactToken != null) SystemClock.elapsedRealtime() else live.contactTokenAtMs
        )
    }

    /**
     * A signed status of a lease was applied (applyLease, noteListedLease):
     * unless it says `suspended`, that lease's "Session paused" notification
     * has said its piece and goes (push spec §7.2).
     */
    private fun statusApplied(status: LeaseStatus) {
        if (status.state != "suspended") Push.leaseNotSuspended(appContext, status.leaseId)
    }

    /**
     * The status a node's answer may carry: the node signed it for that very
     * answer (R-F5-15). It goes through applyLease like any other, so it
     * counts only when the pinned node signed it, about this lease, with a
     * newer seq. Everything else in an answer is the relay's word.
     */
    private fun applyReplyStatus(reply: JsonElement?, pin: NodePin, live: LiveLease, deviceId: String): LiveLease {
        val signed = reply["status"]?.takeIf { it !is JsonNull }?.let { runCatching { Envelope.fromJson(it) }.getOrNull() } ?: return live
        return applyLease(signed, pin, live, deviceId)
    }

    /** Forgets the lease on this screen (the node's lease is not touched). */
    fun closeLiveLease() {
        liveLease = null
    }

    /**
     * "Stop now" (R-F5-5): one signed revoke, sent one time. One prompt on
     * this phone: the revoke (its request goes with the read key). Whatever
     * comes back is the relay's word, which the node did not sign: it never
     * ends the lease on this screen. The screen says the stop was sent and
     * is not yet confirmed by the computer (or that no answer came), Stop
     * stays enabled, and only a status or view the pinned node signed, read
     * by applyLease from the live view's loop, shows the lease as ended. Nothing
     * is sent again by itself; a second revoke for a lease that already
     * ended is acknowledged by the node.
     */
    fun killSwitch() {
        val live = liveLease ?: return
        if (live.busy || live.state == "ended") return
        val k = key ?: return
        val api = client ?: return
        liveLease = live.copy(busy = true, unconfirmed = null)
        scope.launch {
            var next = live.copy(unconfirmed = null)
            try {
                val message = Leases.revoke(live.nodeId, live.leaseId, "kill_switch", k.deviceId, Messages.randomNonce(), Timestamps.string(api.now()))
                val sent = sendLease(api, "revoke", live.leaseId, signEnvelope(k, message, "Stop computer use now", promptText(live.nodeName, 30)))
                next = next.copy(unconfirmed = Leases.stopNotice(sent.outcome, sent.problem))
                // The answer may carry the status the node signed for it. Only that, verified by
                // applyLease, can show the lease as ended here; then there is nothing left to confirm.
                val pin = storage.nodes.firstOrNull { it.id == live.nodeId }
                if (pin != null) next = applyReplyStatus(sent.json, pin, next, k.deviceId)
                if (next.state == "ended") next = next.copy(unconfirmed = null)
            } catch (e: Exception) {
                // A prompt was cancelled or the key failed: the stop was not sent.
                next = next.copy(unconfirmed = "The stop was not sent. Tap Stop now again.")
                fail(e)
            } finally {
                if (liveLease?.leaseId == next.leaseId) liveLease = next.copy(busy = false)
            }
        }
    }

    // ---- Leases: end ----

    // Errors

    /** The words the owner sees. Never a key, signature or code; relay text is escaped like any display text. */
    private fun describe(e: Throwable): String = when (e) {
        is KeyInvalidatedException -> DeviceKey.INVALIDATED_MESSAGE
        is KeyUnavailableException -> e.message ?: ""
        is ReadKeyUnavailableException -> e.message ?: ""
        is ReadKeyMissingException -> "This phone has no read key yet. Set it up from the list."
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
            "unknown_read_key" -> "The relay does not know this phone's read key. Set it up again from the list."
            RelayApi.READ_KEY_NOT_SET_UP -> e.message ?: e.code
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
        stopLoop(sayAway = false)
        stopLiveLoop()
        runCatching { DeviceKey.delete() }
        key = null
        readKey = null
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
                readKey = null
                client = null
                return DeviceKey.create().also { key = it; readKey = runCatching { ReadKey.load() }.getOrNull(); readKeyNodes.forget() }
            }
        }
        // load() gives null on a transient Keystore2 error too; create() runs
        // only once the Keystore confirms there is no key at all.
        DeviceKey.requireAbsent()
        return DeviceKey.create().also { key = it; readKey = runCatching { ReadKey.load() }.getOrNull(); readKeyNodes.forget() }
    }


    // Scanning and pins

    /** Whether the Scanner's field takes a client's six-character code (§6.1): only with a front door. */
    val acceptsClientCode: Boolean get() = frontDoorId != null

    /**
     * The Scanner's camera and its one text field (§6.1): a `kl1:` code
     * (`kl.pair`, `kl.invite`, `kl.relay`), or, on a front door, the code a
     * client's browser shows, which claims that request for this phone (one
     * fingerprint) and puts it in the list as a client connection (C-13).
     */
    fun scanned(text: String) = scope.launch {
        try {
            val trimmed = text.trim()
            if (!trimmed.startsWith("kl1:")) {
                when {
                    FrontDoor.normalizeUserCode(trimmed) == null -> banner = SCAN_FIELD_ACCEPTS
                    frontDoorId == null -> banner = "A client's code needs a front door, and this phone is not paired with one."
                    else -> findGrant(trimmed)
                }
                return@launch
            }
            val payload = Messages.decodeQr(trimmed)
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

    private fun pinNode(pin: NodePin) {
        storage.nodes = storage.nodes.filter { it.id != pin.id } + pin
    }

    private fun deviceJson(k: DeviceKey): JsonObject {
        val name = Build.MODEL.orEmpty().trim().take(64).ifEmpty { "Android phone" }
        return try {
            Messages.device(k.deviceId, name, "android", k.x, k.y, readKey?.jwk)
        } catch (e: ProtocolException) {
            Messages.device(k.deviceId, "Android phone", "android", k.x, k.y, readKey?.jwk)
        }
    }

    /** Switches to the pins of a pairing or invite code, remembering what was there for `restore`. */
    private fun beginPairing(relay: Pair<String, String>, pins: List<NodePin>): Storage.Snapshot {
        val before = storage.snapshot()
        stopLoop(sayAway = false)
        // A different relay is learned again (refreshFrontDoorNow) once the pairing finishes.
        if (storage.relayUrl != relay.first) setFrontDoor(null)
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
        frontDoorId = before.frontDoorId
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
                    // The enrollment carried the read key (§8.2): this node holds it.
                    if (readKey != null) readKeyNodes.set(pin.id, ReadKeyNodes.IN_USE)
                    banner = "Enrolled. This phone now approves for ${Display.escape(pin.name)}."
                    sendPushToken()
                    refreshFrontDoorNow()
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
            startLoop()
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
    private fun receive(item: JsonElement, pins: List<NodePin>): String? {
        val envJson = item["envelope"] ?: return null
        val view = Display.view(envJson, pins)
        val display = view.display
        if (!view.shown || display == null) {
            when (view.reason) {
                "bad_node_signature" -> warnOnce(envJson["payload"].str(), "Node key changed — pair again.", asBanner = true)
                "malformed" -> warnOnce(envJson["payload"].str(), "A request was refused as malformed and is not shown.", asBanner = false)
            }
            return null
        }
        val envelope = try {
            Envelope.fromJson(envJson)
        } catch (e: ProtocolException) {
            return null
        }
        val message = try {
            envelope.message()
        } catch (e: ProtocolException) {
            return null
        }
        val id = message["request_id"].str() ?: return null
        val pin = pins.firstOrNull { it.id == envelope.kid } ?: return null
        val status = verifiedStatus(item["status"], id, pin)
        val existing = pending.indexOfFirst { it.id == id }
        if (existing >= 0) {
            if (status != null && pending[existing].status != status) setStatus(id, status)
            return id
        }
        // A request lives at most 300 s (approval-v1 §3.1); a relay cannot stretch it.
        val expiresInMs = (item["expires_in_ms"].int() ?: 0).coerceAtMost(MAX_EXPIRES_IN_MS).toLong()
        // Already over when it arrived: nothing to decide.
        if (expiresInMs <= 0) return null
        val full = Display.build(message, collapse = false)["items"].arr().orEmpty().associate { (it["path"].str() ?: "") to (it["text"].str() ?: "") }
        pending.add(PendingItem(id, message, display, full, SystemClock.elapsedRealtime(), expiresInMs, status))
        return id
    }

    /** Drops what is over: undecided requests at zero, and decided rows of every kind a minute after they ran out. */
    private fun pruneExpired() {
        val now = SystemClock.elapsedRealtime()
        pending.removeAll { it.timeLeftMs == 0L && (it.status == null || now - it.receivedAtMs > it.expiresInMs + DECIDED_KEEP_MS) }
        val relayNow = client?.now()?.toEpochMilli() ?: System.currentTimeMillis()
        leaseDecided.keys.removeAll { id -> leaseDecided[id]?.let { !leaseRequestKept(it.first, relayNow) } ?: true }
        if (clientDecided?.let { clientKept(it, now) } == false) clientDecided = null
        pairingDecided.keys.removeAll { id -> pairingDecided[id]?.let { !pairingKept(it.first, now) } ?: true }
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
        if (i >= 0) {
            pending[i].status = status
            pending[i].statusAtMs = SystemClock.elapsedRealtime()
        }
    }

    /** After an error that ends the retries, the request is undecided again. */
    private fun clearRetrying(id: String) {
        val i = pending.indexOfFirst { it.id == id }
        if (i >= 0 && pending[i].status in setOf(RETRY_OFFLINE, RETRY_BUSY)) pending[i].status = null
    }

    // ---- Settings (android-slim §6.4) and the Scanner's Get a code (§6.1) ----

    /** One pinned node as Settings shows it. */
    data class SettingsNode(
        val pin: NodePin,
        /** `kl-…` in groups, for people to compare. */
        val fingerprint: String,
        /** From `GET /v1/nodes`; null until Settings read it. */
        val online: Boolean?,
        val readKey: ReadKeyNodeState,
        /** A node the phone added to the front door (`source: phone`): it also has Remove from front door. */
        val removableFromFrontDoor: Boolean
    )

    /** Settings is reading its lists. */
    var settingsLoading by mutableStateOf(false)
        private set

    fun settingsNodes(): List<SettingsNode> = storage.nodes.map { pin ->
        val onFrontDoor = frontDoorId != null && frontDoorNodes.any { it["node_id"].str() == pin.id && it["source"].str() == "phone" }
        SettingsNode(pin, FrontDoor.nodeFingerprint(pin.id), online[pin.id], readKeyState(pin.id), onFrontDoor && pin.id != frontDoorId)
    }

    /**
     * Settings opens: its lists, read with the read key (no prompt; no "Show
     * devices" tap, R-AN-6): the nodes' online state, the other phones, and on
     * a front door its connected clients and what it says it is.
     */
    fun refreshSettings() {
        if (settingsLoading || !readyToRead()) return
        val api = client ?: return
        settingsLoading = true
        scope.launch {
            try {
                each {
                    val list = api.nodes()
                    for (n in list) n["node_id"].str()?.let { online[it] = n["online"].bool() == true }
                    frontDoorNodes.clear()
                    frontDoorNodes.addAll(list)
                }
                each { fetchDevices(api) }
                each { refreshFrontDoorNow() }
                if (frontDoorId != null) each {
                    val list = api.clients()
                    clients.clear()
                    clients.addAll(list)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                settingsLoading = false
            }
        }
    }

    private suspend fun fetchDevices(api: RelayApi) {
        val list = api.devices()
        devices.clear()
        devices.addAll(list)
    }

    /**
     * Remove (C-15): forgets the node's pin on this phone after the owner
     * confirmed it. Nothing is sent: the node still counts this phone as an
     * approver until its administrator revokes it.
     */
    fun forgetNode(nodeId: String) {
        storage.nodes = storage.nodes.filter { it.id != nodeId }
        leaseChecks.remove(nodeId)
        runningLeases.removeAll { it.nodeId == nodeId }
        if (liveLease?.nodeId == nodeId) closeLiveLease()
        leaseRequests.removeAll { it.request.nodeId == nodeId }
        questions.removeAll { it.nodeId == nodeId }
        online.remove(nodeId)
        readKeyNodes.remove(nodeId)
        if (frontDoorId == nodeId) setFrontDoor(null)
    }

    /** Get a code (§6.1, ScannerCodes.kt): the code on screen and whether one is being asked for. */
    private val pairingCodes = PairingCodeFlow()
    val pairingCode: PairingCodeShown? get() = pairingCodes.shown
    val pairingCodeBusy: Boolean get() = pairingCodes.busy

    /** Get code: one fingerprint (device-key transport, §8.4). */
    fun getPairingCode(nodeName: String) {
        val api = client ?: return
        scope.launch {
            try {
                pairingCodes.get(api, nodeName)
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    fun clearPairingCode() = pairingCodes.clear()

    /**
     * Phone A, Add another phone (InviteFlow.kt): an invite with the relay
     * and node pins (one fingerprint, device-key transport), then its claim is
     * polled with the read key while the invite is open and until it expires
     * (C-14). The owner still compares the two screens and confirms.
     */
    fun startInvite() = scope.launch {
        val api = client ?: return@launch
        if (!readKeyKnown) {
            banner = "Set up checking without your fingerprint first (the first row of the list)."
            return@launch
        }
        try {
            invite.start(api, storage.relayUrl ?: "", storage.relaySpki ?: "", storage.nodes, key?.deviceId)
        } catch (e: Exception) {
            fail(e)
        }
    }

    /** Leaves Add another phone: the poll stops and the invite is forgotten here (it lapses on the relay). */
    fun cancelInvite() = invite.cancel()

    /** Phone A, after both screens show the same id: sign B's enrollment. */
    fun confirmInvited() = scope.launch {
        val device = invite.take() ?: return@launch
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
     * Phone B: claim phone A's invite. The relay knows this phone only once
     * phone A added it; until then the loop waits out each refusal.
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
            pollProblem = "When the other phone has added this one, requests appear here."
            banner = "Check that the other phone shows the same id, then confirm there."
        } finally {
            pairing = false
            startLoop()
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
            fetchDevices(api)
        } catch (e: Exception) {
            fail(e)
        }
    }

    // Front door (fleet stage 4). Its lists are read with the read key: pairings
    // and alerts by the foreground loop, clients and nodes when Settings opens.
    // Each decision is still one device-key signature (§8.4).

    private fun setFrontDoor(id: String?) {
        frontDoorId = id
        storage.frontDoorId = id
    }

    /**
     * Sets the front door only when GET /v1/frontdoor names a node this phone
     * pinned from a code, with that same key (FrontDoor.identify); nothing
     * else the reply says is trusted. An F3 relay answers 404.
     */
    private suspend fun refreshFrontDoorNow() {
        val api = client ?: return
        // A read; without a read key the relay is asked again once it is set up (Settings reads it).
        if (readKey == null) return
        try {
            setFrontDoor(FrontDoor.identify(api.frontDoorInfo(), storage.nodes))
        } catch (e: RelayException) {
            if (e.status == 404) setFrontDoor(null) else fail(e)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            fail(e)
        }
    }

    /**
     * Stage 4 §3.3.1: after a pin failure on a front door, exactly one
     * unauthenticated GET /v1/repin, to the certificate just seen. The pin
     * moves only when FrontDoor.verifyRepin passes: signed by the front-door
     * key pinned from a code, naming the certificate just seen and the current
     * pin. Anything else leaves the pin as it is.
     */
    private suspend fun tryRepin(): Boolean {
        val api = client ?: return false
        val fd = frontDoorId ?: return false
        val pin = storage.nodes.firstOrNull { it.id == fd } ?: return false
        val seen = api.takeRefusedSpki() ?: return false
        val url = storage.relayUrl ?: return false
        val current = storage.relaySpki ?: return false
        val probed = RepinTarget(url, current, fd)
        val envelope = try {
            RelayApi(url, seen, null, null).repinEnvelope()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        } ?: return false
        val check = FrontDoor.verifyRepin(envelope, fd, pin.key, seen, current)
        val newSpki = check.newSpki
        if (!check.ok || newSpki == null) return false
        // The probe took time: a reset, a new pairing or another re-pin since then wins.
        if (!currentCoroutineContext().isActive || mode != AppMode.LIVE || !FrontDoor.repinStillApplies(probed, currentRepinTarget())) return false
        storage.relaySpki = newSpki
        connect()
        banner = "The front door changed its certificate key. Its signed re-pin checked out, so this phone now pins the new key."
        return true
    }

    /** The relay and front door the phone has now; null without one. */
    private fun currentRepinTarget(): RepinTarget? {
        val url = storage.relayUrl ?: return null
        val spki = storage.relaySpki ?: return null
        val fd = frontDoorId ?: return null
        return RepinTarget(url, spki, fd)
    }

    /** The typed code, as the grant carries it; the request is claimed for this phone. */
    fun findGrant(code: String) = scope.launch {
        cancelGrant()
        val api = client ?: return@launch
        if (frontDoorId == null) return@launch
        val normalized = FrontDoor.normalizeUserCode(code)
        if (normalized == null) {
            banner = "The code is six letters and digits, like Q7K-M2X."
            return@launch
        }
        try {
            val reply = api.pendingGrant(normalized) ?: throw OwnerMessage("The front door sent a reply this app cannot read.")
            grantRequest = GrantRequest(reply)
            grantCode = normalized
            grantReceivedAtMs = SystemClock.elapsedRealtime()
        } catch (e: RelayException) {
            if (e.code == "no_such_request") banner = "No connection request with that code." else fail(e)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun cancelGrant() {
        grantRequest = null
        grantCode = null
        grantReceivedAtMs = 0L
    }

    private fun grantExpired(request: GrantRequest): Boolean =
        grantReceivedAtMs == 0L || SystemClock.elapsedRealtime() - grantReceivedAtMs >= request.expiresInMs

    /**
     * Approve: an explicit tap, then a biometric prompt over exactly the
     * scopes chosen from those requested. Deny: an empty scope list. A denial
     * never depends on the prompt: if it cannot be signed, nothing is granted
     * and the request lapses on its own.
     */
    fun decideGrant(request: GrantRequest, scopes: List<ScopeChoice>, approve: Boolean) {
        if (frontDoorBusy) return
        frontDoorBusy = true
        scope.launch {
            try {
                decideGrantNow(request, scopes, approve)
            } finally {
                frontDoorBusy = false
            }
        }
    }

    private suspend fun decideGrantNow(request: GrantRequest, scopes: List<ScopeChoice>, approve: Boolean) {
        val api = client ?: return
        val k = key ?: return
        val fd = frontDoorId ?: return
        val code = grantCode ?: return
        if (grantRequest !== request) return
        val name = FrontDoor.shownText(request.clientName)
        if (grantExpired(request)) {
            cancelGrant()
            banner = "This connection request expired. Start again in the client."
            return
        }
        val envelope = try {
            val message = request.message(fd, code, if (approve) scopes else emptyList(), if (approve) "approve" else "deny",
                Messages.randomNonce(), k.deviceId, Timestamps.string(api.now()))
            signEnvelope(k, message, if (approve) "Connect a client" else "Refuse a client", if (approve) "Let $name use your fleet" else "Refuse $name")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (!approve && e !is KeyInvalidatedException) {
                cancelGrant()
                banner = "$name was not connected. The refusal was not signed (${describe(e)}), so the request stays open until it expires; nothing was granted."
                return
            }
            fail(e)
            return
        }
        try {
            val reply = api.grantDecision(request.grantId, envelope)
            if (reply.confirms(if (approve) "approved" else "denied")) {
                // A decided row until a minute past the request's expiry (§7.2).
                clientDecided = DecidedClient(request, code, grantReceivedAtMs, ApprovalList.Decided(if (approve) "Connected" else "Refused", SystemClock.elapsedRealtime()))
                cancelGrant()
                if (selected is Selection.Client) selected = null
                banner = if (approve) "$name is connected. Go back to its window." else "Refused. $name was not connected."
                return
            }
            if (reply is FrontDoorReply.Refused && (reply.status == 410 || reply.status == 404)) cancelGrant()
            banner = frontDoorUnconfirmed(reply)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            fail(e)
        }
    }

    /**
     * One signed front-door action at a time (revoke, remove, acknowledge),
     * shared with the decision flows through `frontDoorBusy`, so a second
     * tap while one is out does nothing.
     */
    private fun frontDoorAction(block: suspend () -> Unit) {
        if (frontDoorBusy) return
        frontDoorBusy = true
        scope.launch {
            try {
                block()
            } finally {
                frontDoorBusy = false
            }
        }
    }

    /** Revocation is challenge-bound: a fresh `revoke` challenge, then the signature. */
    fun revokeClient(grantId: String, name: String) = frontDoorAction {
        val api = client ?: return@frontDoorAction
        val k = key ?: return@frontDoorAction
        val fd = frontDoorId ?: return@frontDoorAction
        try {
            val challenge = api.challenge(FrontDoor.PURPOSE_REVOKE)
            val message = FrontDoor.clientRevoke(fd, grantId, challenge.challenge, k.deviceId, Timestamps.string(api.now()))
            val reply = api.revokeClient(grantId, signEnvelope(k, message, "Disconnect a client", "Disconnect ${FrontDoor.shownText(name)}"))
            if (reply.succeeded) {
                clients.removeAll { it["grant_id"].str() == grantId }
            } else {
                banner = frontDoorUnconfirmed(reply)
            }
        } catch (e: Exception) {
            fail(e)
        }
    }

    /**
     * The pairings store, replaced whole: nodes waiting for this phone; an
     * entry the core cannot verify (its id does not derive from its key, say)
     * is dropped. A pairing keeps the time this phone first saw it.
     */
    private suspend fun fetchPairings(api: RelayApi) {
        val list = api.pendingPairings().mapNotNull { runCatching { PairingRequest(it) }.getOrNull() }
        val now = SystemClock.elapsedRealtime()
        val next = list.map { p -> pairings.firstOrNull { it.request.pairingId == p.pairingId }?.copy(request = p) ?: PairingItem(p, now) }
        pairings.clear()
        pairings.addAll(next)
    }

    /** The alerts store, replaced whole; one this phone acknowledged keeps its decided row until it leaves. */
    private suspend fun fetchAlerts(api: RelayApi) {
        val list = api.alerts("0")
        alerts.clear()
        alerts.addAll(list)
        alertDecided.keys.retainAll(list.mapNotNull { it["id"].str() }.toSet())
    }

    /**
     * Approve: a biometric prompt naming the node and its fingerprint. A
     * denial that cannot be signed adds nothing. `save_failed` sends the same
     * envelope again, at most twice more (each a request, so a prompt).
     */
    fun decidePairing(pairing: PairingRequest, approve: Boolean) {
        if (frontDoorBusy) return
        frontDoorBusy = true
        scope.launch {
            try {
                decidePairingNow(pairing, approve)
            } finally {
                frontDoorBusy = false
            }
        }
    }

    private suspend fun decidePairingNow(pairing: PairingRequest, approve: Boolean) {
        val api = client ?: return
        val k = key ?: return
        val fd = frontDoorId ?: return
        val name = FrontDoor.shownText(pairing.nodeName)
        val envelope = try {
            val message = pairing.message(fd, if (approve) "approve" else "deny", Messages.randomNonce(), k.deviceId, Timestamps.string(api.now()))
            signEnvelope(k, message, if (approve) "Add a node" else "Refuse a node", if (approve) "Add $name (${pairing.fingerprint})" else "Refuse $name")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (!approve && e !is KeyInvalidatedException) {
                banner = "$name was not added. The refusal was not signed (${describe(e)}), so it stays waiting until its code expires."
                return
            }
            fail(e)
            return
        }
        try {
            var reply = api.pairingDecision(pairing.pairingId, envelope)
            var attempts = 1
            while (reply.retryable && attempts < 3) {
                delay(((reply as? FrontDoorReply.Refused)?.retryAfterSeconds ?: 1).coerceIn(1, 10) * 1000L)
                reply = api.pairingDecision(pairing.pairingId, envelope)
                attempts++
            }
            if (reply.confirms(if (approve) "enrolled" else "denied")) {
                // A decided row until a minute past the pairing's expiry (§7.2).
                pairingDecided[pairing.pairingId] = (pairings.firstOrNull { it.request.pairingId == pairing.pairingId } ?: PairingItem(pairing, SystemClock.elapsedRealtime())) to
                    ApprovalList.Decided(if (approve) "Enrolled" else "Refused", SystemClock.elapsedRealtime())
                pairings.removeAll { it.request.pairingId == pairing.pairingId }
                if ((selected as? Selection.Pairing)?.pairingId == pairing.pairingId) selected = null
                banner = if (approve) "$name is enrolled. It links when its pair command finishes." else "Refused. $name was not added."
                return
            }
            banner = frontDoorUnconfirmed(reply)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            fail(e)
        }
    }

    /** Removal is challenge-bound: a fresh `remove` challenge, then the signature. */
    fun removeNode(nodeId: String, name: String) = frontDoorAction {
        val api = client ?: return@frontDoorAction
        val k = key ?: return@frontDoorAction
        val fd = frontDoorId ?: return@frontDoorAction
        try {
            val challenge = api.challenge(FrontDoor.PURPOSE_REMOVE)
            val message = FrontDoor.nodeRemove(fd, nodeId, challenge.challenge, k.deviceId, Timestamps.string(api.now()))
            val reply = api.removeNode(nodeId, signEnvelope(k, message, "Remove a node", "Remove ${FrontDoor.shownText(name)} from your fleet"))
            if (reply.succeeded) {
                frontDoorNodes.removeAll { it["node_id"].str() == nodeId }
            } else if (reply.retryable) {
                // In effect but not saved: removing again (a new challenge) saves it.
                banner = "The node is removed but the front door could not save that. Tap Remove again."
            } else {
                banner = frontDoorUnconfirmed(reply)
            }
        } catch (e: Exception) {
            fail(e)
        }
    }

    fun ackAlert(id: String) = frontDoorAction {
        val api = client ?: return@frontDoorAction
        if (frontDoorId == null) return@frontDoorAction
        try {
            api.ackAlert(id)
            val i = alerts.indexOfFirst { it["id"].str() == id }
            // The front door answered 204: a decided row until the next fetch, and acknowledged in the store.
            alertDecided[id] = ApprovalList.Decided("Acknowledged", SystemClock.elapsedRealtime())
            if (i >= 0) alerts[i] = JsonObject(alerts[i].obj().orEmpty() + ("acked" to JsonPrimitive(true)))
            if ((selected as? Selection.Alert)?.id == id) selected = null
        } catch (e: Exception) {
            fail(e)
        }
    }

    /**
     * A tapped notification (§13, R-AN-9): it carries a kind and an id and
     * nothing else. The app fetches with the read key (no fingerprint) and
     * opens that item's detail; when the item is gone it opens the list with
     * NO_LONGER_WAITING. A count above 1, a test or an unknown kind opens
     * the list (push spec §7.2). Without a read key the relay knows, nothing
     * is fetched: the list (and its set-up row) opens.
     */
    fun openPushed(kind: String, id: String, count: Int = 1) {
        listNotice = null
        selected = null
        if (PushText.opensList(kind, count)) return
        if (!readyToRead()) return
        val api = client ?: return
        scope.launch {
            try {
                val found: Selection? = when (kind) {
                    "approval" -> {
                        // A request id is a lowercase UUID; anything else is not ours to fetch.
                        if (id.length != 36 || !id.all { it in "0123456789abcdef-" }) null
                        else api.approval(id)?.let { receive(it, storage.nodes) }
                            ?.takeIf { rid -> pending.any { it.id == rid && it.status == null } }?.let { Selection.Tool(it) }
                    }
                    "question" -> {
                        fetchQuestions(api)
                        questions.firstOrNull { it.token == id }?.let { Selection.Question(it.token) }
                    }
                    "lease", "session_paused", "session_ended" -> pushedLease(api, kind, id)
                    "pairing" -> {
                        fetchPairings(api)
                        pairings.firstOrNull { it.request.pairingId == id }?.let { Selection.Pairing(id) }
                    }
                    "alert" -> {
                        fetchAlerts(api)
                        alerts.firstOrNull { it["id"].str() == id && it["acked"].bool() != true }?.let { Selection.Alert(id) }
                    }
                    // The list: opensList took these above; named so every kind has its line.
                    "test" -> return@launch
                    else -> return@launch
                }
                if (found is Selection.RunningLease) followLiveView()
                if (found != null) selected = found else if (listNotice == null) listNotice = NO_LONGER_WAITING
            } catch (e: CancellationException) {
                throw e
            } catch (e: RelayException) {
                if (e.status == 404) listNotice = NO_LONGER_WAITING else pollProblem = describe(e)
            } catch (e: Exception) {
                pollProblem = describe(e)
            }
        }
    }

    /**
     * `lease`: the request whose request_id is the id, else the running lease
     * whose lease_id is. `session_paused` and `session_ended` (spec 3's kinds;
     * the id is the lease_id): that lease's live view; ended, its signed ended
     * status and reason; gone from a listing that passed, "<node> no longer
     * has this session; it is not running" (C-18).
     */
    private suspend fun pushedLease(api: RelayApi, kind: String, id: String): Selection? {
        val knownNode = liveLease?.takeIf { it.leaseId == id }?.let { it.nodeId to it.nodeName }
            ?: runningLeases.firstOrNull { it.leaseId == id }?.let { it.nodeId to it.nodeName }
        refreshLeases(api)
        if (kind == "lease") leaseRequests.firstOrNull { it.request.requestId == id }?.let { return Selection.LeaseRequest(id) }
        if (liveLease?.leaseId == id) return Selection.RunningLease(id)
        runningLeases.firstOrNull { it.leaseId == id }?.let { lease ->
            openRunningLease(lease)
            return if (liveLease?.leaseId == id) Selection.RunningLease(id) else null
        }
        // An ended lease has no row, but its detail opens from the notification with the status its node signed.
        for (entry in lastLeaseEntries) {
            if (!isStatusOnly(entry)) continue
            val pin = storage.nodes.firstOrNull { it.id == entry["node_id"].str() } ?: continue
            val signed = entry["status"]?.takeIf { it !is JsonNull }?.let { runCatching { Envelope.fromJson(it) }.getOrNull() } ?: continue
            val status = Leases.verifiedMessage(signed, pin)?.let { LeaseStatus.from(it) } ?: continue
            if (status.leaseId != id) continue
            liveLease = applyLease(signed, pin, LiveLease(pin.id, pin.name, id), deviceId ?: "")
            return Selection.RunningLease(id)
        }
        if (kind != "lease" && knownNode != null && leaseChecks[knownNode.first] is LeaseNodeCheck.Confirmed) {
            listNotice = "${Display.escape(knownNode.second)} no longer has this session; it is not running."
        }
        return null
    }

    /** Nodes the phone pinned, and whether a grant can limit to each (Deviation 18). */
    val machineChoices: List<Pair<String, Boolean>>
        get() = storage.nodes.filter { it.id != frontDoorId }.map { it.name to FrontDoor.isMachineName(it.name) }

    // Push

    /**
     * Keeps the token, and sends it at once when the read key can carry it
     * (spec 3 R5: re-sent when FCM rotates it, with no prompt); otherwise the
     * loop sends it when it starts.
     */
    fun registerPushToken(token: String) {
        storage.pushToken = token
        if (readyToRead()) scope.launch { sendPushToken() }
    }

    /** Registers the push token once per token, on the read key (§8.4). */
    private suspend fun sendPushToken() {
        val token = storage.pushToken ?: return
        if (mode != AppMode.LIVE || token == storage.pushTokenSent || !readKeyKnown) return
        val api = client ?: return
        try {
            api.pushToken(token)
            storage.pushTokenSent = token
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Tried again when the loop next starts.
        }
    }

    /** Reset this phone (after its confirm dialog): deletes both keys and every pin. */
    fun reset() {
        stopLoop(sayAway = false)
        stopLiveLoop()
        cancelInvite()
        runCatching { DeviceKey.delete() }
        key = null
        readKey = null
        client = null
        pending.clear()
        devices.clear()
        online.clear()
        questions.clear()
        questionDecided.clear()
        answeredTokens.clear()
        closeLiveLease()
        runningLeases.clear()
        leaseChecks.clear()
        signedLeaseGrants.clear()
        lastLeaseEntries = emptyList()
        leaseRequests.clear()
        decidedLeaseRequests.clear()
        leaseDecided.clear()
        decidingLease.clear()
        clientDecided = null
        pairingDecided.clear()
        grantRequest = null
        grantCode = null
        grantReceivedAtMs = 0L
        frontDoorBusy = false
        clients.clear()
        pairings.clear()
        frontDoorNodes.clear()
        alerts.clear()
        alertDecided.clear()
        overflowing.clear()
        selected = null
        listNotice = null
        pairingCodes.clear()
        frontDoorId = null
        fingerprintToCompare = null
        pollProblem = null
        readKeyNodes.clearInMemory()
        lastRestAtMs = 0L
        storage.clear()
        changeMode(AppMode.WELCOME)
    }

    companion object {
        const val MAX_EXPIRES_IN_MS = 300_000

        /** A decided row stays this long past its item's expiry (§7.2). */
        const val DECIDED_KEEP_MS = 60_000L

        /** The node refuses a longer free-text answer (UTF-16 units, as JS and Kotlin count). */
        const val MAX_ANSWER_CHARS = 2000
        const val RETRY_OFFLINE = "node offline — retrying"
        const val RETRY_BUSY = "relay busy — retrying"

        // The foreground loop (§9).
        const val LONG_POLL_S = 25
        const val REST_EVERY_MS = 5_000L
        const val PRESENCE_EVERY_MS = 60_000L
        const val ERROR_WAIT_S = 5
        const val ERROR_WAIT_MS = ERROR_WAIT_S * 1000L
        const val BUSY_WAIT_S = 15

        // The live view (§7.6): a watch every 20 s; a poll that brought nothing waits a second before the next.
        const val WATCH_EVERY_MS = 20_000L
        const val LIVE_IDLE_MS = 1_000L

        /** A `kl.device.read_key` lives at most seven days (approval-v1, READ_KEY_MAX_MS). */
        const val READ_KEY_STATEMENT_MS = 7L * 24 * 60 * 60 * 1000

        /** The set-up row (§8.7). */
        const val READ_KEY_SETUP_TITLE = "Check for requests without your fingerprint. Set up once: two fingerprints."

        /** Settings (§6.4) before the read key is set up: its lists are read with the read key. */
        const val SETTINGS_READ_KEY_LINE = "Set up the read key to see nodes and phones."

        /** C-19: no fingerprint fallback for a relay from before the read key. */
        const val OLDER_RELAY = "This relay is older than this app. Upgrade it, then try again."

        /** §13: a tapped notification whose item is gone. */
        const val NO_LONGER_WAITING = "That request is no longer waiting."

        /** §6.1: what the Scanner's text field takes. */
        const val SCAN_FIELD_ACCEPTS = "Type a code that starts with kl1: (from a node, another phone or a relay), or a client's six-character code like Q7K-M2X."

        /** §7.6: the live view's line for a lease this phone granted, and the fallback button. */
        const val KEEP_OPEN_LINE = "Keep this open to keep it going. Closing it pauses clicks and typing after about two minutes."
        const val FINGERPRINT_WATCH_BUTTON = "Keep it going with your fingerprint"
    }
}
