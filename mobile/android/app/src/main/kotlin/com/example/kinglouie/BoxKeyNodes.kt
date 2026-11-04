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
 * The box key as each pinned node knows it (sealed phones plan, R-SP-10; as
 * ReadKeyNodes is for the read key): the signed `kl.device.box_key` statement
 * kept to re-post it, each node's answer to it, whether any node has been told
 * of this key, and whether this phone's Keystore refused one. Kept in [Storage].
 * Nothing here holds or uses a key: AppModel signs and sends, and tells this what
 * came back.
 */
class BoxKeyNodes(private val storage: Storage) {
    private val nodes = mutableStateMapOf<String, String>().apply { putAll(storage.boxKeyNodes) }

    /**
     * A statement of this box key went to every node, or every pinned node enrolled
     * with it. A key made and told to nobody, or to a new node only, still needs the
     * set-up. So [noneSent] with this set means every node holds it.
     */
    var sent by mutableStateOf(storage.boxKeySent)
        private set

    fun markSent() {
        sent = true
        storage.boxKeySent = true
    }

    /** This phone's Keystore would not make the key: it enrolled without one. */
    var refused by mutableStateOf(storage.boxKeyRefused)
        private set

    fun markRefused(value: Boolean) {
        refused = value
        storage.boxKeyRefused = value
    }

    /** No statement was ever needed: the phone enrolled with its box key, so every node holds it. */
    val noneSent: Boolean get() = nodes.isEmpty()

    /** A node's answer, in this app's words ([IN_USE], [WAITING], [OFFLINE], [REJECTED]); null when it gave none. */
    operator fun get(nodeId: String): String? = nodes[nodeId]

    /** A node was offline when the statement went: it is sent to it again. */
    val anyOffline: Boolean get() = nodes.values.any { it == OFFLINE }

    /** Keeps a statement for re-posting (until it expires). */
    fun keep(envelope: Envelope) {
        storage.boxKeyStatement = Jcs.serialize(envelope.json)
    }

    /** The statement kept for re-posting, while it has not expired at [relayNowMs]; an expired one is forgotten. */
    fun kept(relayNowMs: Long): Envelope? {
        val text = storage.boxKeyStatement ?: return null
        val envelope = runCatching { Envelope.fromJson(JsonText.parse(text)) }.getOrNull()
        val expires = envelope?.let { runCatching { it.message() }.getOrNull() }?.get("expires_at").str()?.let { Timestamps.epochMillis(it) }
        if (envelope == null || expires == null || expires <= relayNowMs) {
            storage.boxKeyStatement = null
            return null
        }
        return envelope
    }

    /**
     * Each node's answer to a statement. A first post replaces every answer. A
     * re-post goes to every node again (the relay forwards it to all), so only
     * the nodes that were offline take the new answer. `applied`: the node's
     * record holds this box key. `duplicate`: it has the statement staged, waiting
     * for `device apply`. The relay words anything else (no answer, a node from
     * before the box key) `offline`.
     */
    fun noteReply(reply: JsonElement?, firstPost: Boolean) {
        if (firstPost) nodes.clear()
        for (n in reply["nodes"].arr().orEmpty()) {
            val id = n["node_id"].str() ?: continue
            val before = nodes[id]
            if (!firstPost && before != null && before != OFFLINE) continue
            nodes[id] = when (n["state"].str()) {
                "box-key-pending-apply", "duplicate" -> WAITING
                "applied" -> IN_USE
                "rejected" -> REJECTED
                else -> OFFLINE
            }
        }
        save()
    }

    /** What an enrollment showed of its box key (only once a statement was needed). */
    fun set(nodeId: String, state: String) {
        if (nodes.isEmpty() || nodes[nodeId] == state) return
        nodes[nodeId] = state
        save()
    }

    /** A node's pin was removed. */
    fun remove(nodeId: String) {
        if (nodes.remove(nodeId) != null) save()
    }

    /** A new device key enrolls with its own box key: no set-up is pending. */
    fun forget() {
        sent = false
        refused = false
        storage.boxKeySent = false
        storage.boxKeyRefused = false
        nodes.clear()
        storage.boxKeyNodes = emptyMap()
        storage.boxKeyStatement = null
    }

    /** Reset: what is in memory (the caller clears Storage). */
    fun clearInMemory() {
        nodes.clear()
        sent = false
        refused = false
    }

    private fun save() {
        storage.boxKeyNodes = nodes.toMap()
    }

    companion object {
        // A node's answer to the box-key statement, as kept (Storage.boxKeyNodes).
        const val IN_USE = "in_use"
        const val WAITING = "waiting"
        const val OFFLINE = "offline"
        const val REJECTED = "rejected"
    }
}
