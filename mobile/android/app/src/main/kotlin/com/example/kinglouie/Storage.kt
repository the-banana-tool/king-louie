package com.example.kinglouie

import android.content.Context
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.example.kinglouie.protocol.AppMode
import com.example.kinglouie.protocol.Jcs
import com.example.kinglouie.protocol.JsonText
import com.example.kinglouie.protocol.NodePin
import com.example.kinglouie.protocol.PairingRequest
import com.example.kinglouie.protocol.arr
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.jsonString
import com.example.kinglouie.protocol.obj
import com.example.kinglouie.protocol.str
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// What the app keeps between runs, and the store items AppModel holds
// (split out of AppModel.kt; android-slim review S8).

/** A message meant for the owner as it stands (already worded and escaped). */
class OwnerMessage(message: String) : Exception(message)

/**
 * What the app keeps (mobile/PRIVACY.md): relay pin, node pins, mode, push
 * token, and the read key's set-up (android-slim §8.7). The keys live in the
 * Keystore.
 */
class Storage(context: Context) {
    private val prefs = context.getSharedPreferences("kl.state", Context.MODE_PRIVATE)

    /** A phone left in the old demo mode reads as WELCOME: the demo is gone (android-slim §6.5). */
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

    /**
     * The front door this phone's relay is (fleet stage 4): set only when GET
     * /v1/frontdoor names a node pinned from a code, with that key
     * (FrontDoor.identify).
     */
    var frontDoorId: String?
        get() = prefs.getString("frontDoorId", null)
        set(v) = prefs.edit().putString("frontDoorId", v).apply()
    var nodes: List<NodePin>
        get() = prefs.getString("nodes", null)?.let { text ->
            runCatching {
                JsonText.parse(text).arr()!!.map { NodePin(it["id"].str()!!, it["name"].str()!!, it["key"].str()!!) }
            }.getOrNull()
        } ?: emptyList()
        set(v) = prefs.edit().putString("nodes", Jcs.serialize(JsonArray(v.map {
            JsonObject(mapOf("id" to jsonString(it.id), "name" to jsonString(it.name), "key" to jsonString(it.key)))
        }))).apply()

    /**
     * The nodes this phone has opened a sealed message from, by node id
     * (R-SP-15). Only a signature-verified open adds one (AppModel.noteSeal);
     * Reset clears it with the rest, and nothing else takes one away. A one-way
     * mark, so it is on disk before anything goes on (commit, not apply).
     */
    var sealedSeen: Set<String>
        get() = prefs.getString("sealedSeen", null)?.let { text ->
            runCatching { JsonText.parse(text).arr()!!.map { it.str()!! }.toSet() }.getOrNull()
        } ?: emptySet()
        set(v) {
            prefs.edit().putString("sealedSeen", Jcs.serialize(JsonArray(v.sorted().map { jsonString(it) }))).commit()
        }

    /** The signed `kl.device.read_key` statement (an envelope, JSON), kept until it expires to re-post it (§8.7). */
    var readKeyStatement: String?
        get() = prefs.getString("readKeyStatement", null)
        set(v) = prefs.edit().putString("readKeyStatement", v).apply()

    /** What each node answered to that statement, by node id, in this app's words (AppModel.RK_*). */
    var readKeyNodes: Map<String, String>
        get() = prefs.getString("readKeyNodes", null)?.let { text ->
            runCatching { JsonText.parse(text).obj()!!.mapValues { it.value.str()!! } }.getOrNull()
        } ?: emptyMap()
        set(v) = prefs.edit().putString("readKeyNodes", Jcs.serialize(JsonObject(v.mapValues { jsonString(it.value) }))).apply()

    /** The relay answered `unknown_read_key`: the read key must be set up (again) before the loop runs. */
    var readKeyUnknown: Boolean
        get() = prefs.getBoolean("readKeyUnknown", false)
        set(v) = prefs.edit().putBoolean("readKeyUnknown", v).apply()

    /** The signed `kl.device.box_key` statement, kept until it expires to re-post it (R-SP-10). */
    var boxKeyStatement: String?
        get() = prefs.getString("boxKeyStatement", null)
        set(v) = prefs.edit().putString("boxKeyStatement", v).apply()

    /** What each node answered to that statement, by node id, in this app's words (BoxKeyNodes). */
    var boxKeyNodes: Map<String, String>
        get() = prefs.getString("boxKeyNodes", null)?.let { text ->
            runCatching { JsonText.parse(text).obj()!!.mapValues { it.value.str()!! } }.getOrNull()
        } ?: emptyMap()
        set(v) = prefs.edit().putString("boxKeyNodes", Jcs.serialize(JsonObject(v.mapValues { jsonString(it.value) }))).apply()

    /** A statement of this box key went to every node, or every pinned node enrolled with it (BoxKeyNodes.sent). */
    var boxKeySent: Boolean
        get() = prefs.getBoolean("boxKeySent", false)
        set(v) = prefs.edit().putBoolean("boxKeySent", v).apply()

    /** This phone's Keystore would not make a box key. */
    var boxKeyRefused: Boolean
        get() = prefs.getBoolean("boxKeyRefused", false)
        set(v) = prefs.edit().putBoolean("boxKeyRefused", v).apply()

    /** The pairing state, to put back when a pairing does not finish. */
    data class Snapshot(val mode: AppMode, val relayUrl: String?, val relaySpki: String?, val nodes: List<NodePin>, val frontDoorId: String?)

    fun snapshot() = Snapshot(mode, relayUrl, relaySpki, nodes, frontDoorId)

    fun restore(s: Snapshot) {
        mode = s.mode
        relayUrl = s.relayUrl
        relaySpki = s.relaySpki
        nodes = s.nodes
        frontDoorId = s.frontDoorId
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
    initialStatus: String?,
    /** A sealed request: what it opened to, which `message` also is and the response is built from. Null for a clear one. */
    val opened: JsonObject? = null
) {
    var status by mutableStateOf(initialStatus)

    /** When `status` was last set (elapsedRealtime ms): a decided row's place in the list. */
    var statusAtMs by mutableStateOf(if (initialStatus != null) SystemClock.elapsedRealtime() else 0L)

    /** An approve or deny for this item is being signed or sent. */
    var deciding by mutableStateOf(false)

    /** From receipt, on the monotonic clock. */
    val timeLeftMs: Long get() = (expiresInMs - (SystemClock.elapsedRealtime() - receivedAtMs)).coerceAtLeast(0)
}

/**
 * A message a pinned node signed that this phone cannot read or may not answer
 * (R-SP-6, R-SP-15): its verified clear facts and why. Kept apart from the stores
 * a press or a detail reads, so no decision can reach it. [ref] is unique across
 * kinds: the kind's prefix and its own id.
 */
data class UnreadableItem(val ref: String, val nodeId: String, val nodeName: String, val label: String, val reason: String, val expiresAtMs: Long?)

/** A node pairing waiting on the front door, with when this phone first saw it (its time left counts from there). */
data class PairingItem(val request: PairingRequest, val receivedAtMs: Long) {
    val timeLeftMs: Long get() = (request.expiresInMs - (SystemClock.elapsedRealtime() - receivedAtMs)).coerceAtLeast(0)
}

