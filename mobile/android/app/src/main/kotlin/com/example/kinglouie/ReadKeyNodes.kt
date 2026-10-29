package com.example.kinglouie

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.example.kinglouie.protocol.Envelope
import com.example.kinglouie.protocol.Jcs
import com.example.kinglouie.protocol.JsonText
import com.example.kinglouie.protocol.Timestamps
import com.example.kinglouie.protocol.arr
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.str
import kotlinx.serialization.json.JsonElement

/**
 * The read key's set-up as each pinned node knows it (android-slim §8.7;
 * split out of AppModel.kt, review S8): the signed `kl.device.read_key`
 * statement kept to re-post it, each node's answer to it, and whether the
 * relay said it does not know the read key. Kept in [Storage]. Nothing here
 * holds or uses a key: AppModel signs and sends, and tells this what came
 * back.
 */
class ReadKeyNodes(private val storage: Storage) {
    private val nodes = mutableStateMapOf<String, String>().apply { putAll(storage.readKeyNodes) }

    /** The relay answered `unknown_read_key`: the read key must be set up (again) before the loop runs. */
    var unknown by mutableStateOf(storage.readKeyUnknown)
        private set

    fun markUnknown(value: Boolean) {
        unknown = value
        storage.readKeyUnknown = value
    }

    /** No statement was ever needed: the phone enrolled with its read key, so every node holds it. */
    val noneSent: Boolean get() = nodes.isEmpty()

    /** A node's answer, in this app's words ([IN_USE], [WAITING], [OFFLINE], [REJECTED]); null when it gave none. */
    operator fun get(nodeId: String): String? = nodes[nodeId]

    /** A node was offline when the statement went: it is sent to it again. */
    val anyOffline: Boolean get() = nodes.values.any { it == OFFLINE }

    /** Keeps a statement for re-posting (until it expires). */
    fun keep(envelope: Envelope) {
        storage.readKeyStatement = Jcs.serialize(envelope.json)
    }

    /** The statement kept for re-posting, while it has not expired at [relayNowMs]; an expired one is forgotten. */
    fun kept(relayNowMs: Long): Envelope? {
        val text = storage.readKeyStatement ?: return null
        val envelope = runCatching { Envelope.fromJson(JsonText.parse(text)) }.getOrNull()
        val expires = envelope?.let { runCatching { it.message() }.getOrNull() }?.get("expires_at").str()?.let { Timestamps.epochMillis(it) }
        if (envelope == null || expires == null || expires <= relayNowMs) {
            storage.readKeyStatement = null
            return null
        }
        return envelope
    }

    /**
     * Each node's answer to a statement. A first post replaces every answer.
     * A re-post goes to every node again (the relay forwards it to all), so
     * only the nodes that were offline take the new answer. `applied`: the
     * node's record holds this read key, so it is in use there. `duplicate`
     * is a node that has the statement staged, waiting for `device apply`; on
     * a first post it can only come from a node from before `applied`, whose
     * record already held the key.
     */
    fun noteReply(reply: JsonElement?, firstPost: Boolean) {
        if (firstPost) nodes.clear()
        for (n in reply["nodes"].arr().orEmpty()) {
            val id = n["node_id"].str() ?: continue
            val before = nodes[id]
            if (!firstPost && before != null && before != OFFLINE) continue
            nodes[id] = when (n["state"].str()) {
                "read-key-pending-apply" -> WAITING
                "applied" -> IN_USE
                "duplicate" -> if (firstPost) IN_USE else WAITING
                "rejected" -> REJECTED
                else -> OFFLINE
            }
        }
        save()
    }

    /** What a node's answer to a watch showed of its read key (only once a statement was needed). */
    fun set(nodeId: String, state: String) {
        if (nodes.isEmpty() || nodes[nodeId] == state) return
        nodes[nodeId] = state
        save()
    }

    /** A node's pin was removed. */
    fun remove(nodeId: String) {
        if (nodes.remove(nodeId) != null) save()
    }

    /** A new device key enrolls with its own read key: no set-up is pending. */
    fun forget() {
        markUnknown(false)
        nodes.clear()
        storage.readKeyNodes = emptyMap()
        storage.readKeyStatement = null
    }

    /** Reset: what is in memory (the caller clears Storage). */
    fun clearInMemory() {
        nodes.clear()
        unknown = false
    }

    private fun save() {
        storage.readKeyNodes = nodes.toMap()
    }

    companion object {
        // A node's answer to the read-key statement, as kept (Storage.readKeyNodes).
        const val IN_USE = "in_use"
        const val WAITING = "waiting"
        const val OFFLINE = "offline"
        const val REJECTED = "rejected"
    }
}
