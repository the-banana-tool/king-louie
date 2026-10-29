package com.example.kinglouie

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.example.kinglouie.protocol.Display
import com.example.kinglouie.protocol.Hex
import com.example.kinglouie.protocol.Identifiers
import com.example.kinglouie.protocol.NodePin
import com.example.kinglouie.protocol.Timestamps
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.int
import com.example.kinglouie.protocol.str
import kotlinx.serialization.json.JsonElement
import java.net.URI

// The Scanner's codes (android-slim §6.1); split out of AppModel.kt (review
// S8). What a scanned code may pin, and the Get a code tab's state. AppModel
// does the pairing itself.

/** `relay` must be an https origin and `relay_spki` a `sha256/` pin of 32 bytes. */
internal fun relayPin(payload: JsonElement): Pair<String, String> {
    val text = payload["relay"].str()
    val spki = payload["relay_spki"].str()
    val uri = text?.let { runCatching { URI(it) }.getOrNull() }
    val ok = uri != null && uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrEmpty() &&
        (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") && uri.rawQuery == null && uri.rawUserInfo == null && uri.rawFragment == null &&
        spki != null && spki.startsWith("sha256/") && isToken(spki.removePrefix("sha256/"), 32)
    if (!ok) throw OwnerMessage("This code does not name a relay this app can pin.")
    return text to spki
}

/** A node pin from a pairing or invite code (never from the relay's node list). Its id must be the one its Ed25519 key derives. */
internal fun nodePin(node: JsonElement?): NodePin {
    val id = node["id"].str()
    val name = node["name"].str()
    val keyHex = node["key"].str()
    val spki = keyHex?.let { runCatching { Hex.decode(it) }.getOrNull() }
    val ok = id != null && name != null && spki != null && spki.size == 44 &&
        Hex.encode(spki.copyOfRange(0, 12)) == Identifiers.ED25519_SPKI_PREFIX &&
        Identifiers.nodeId(spki.copyOfRange(12, 44)) == id
    if (!ok) throw OwnerMessage("This code carries a node key that does not match its id.")
    return NodePin(id, name, keyHex)
}

/** A pairing code on the Scanner's Get a code tab, and when it expires on this phone's clock (epoch ms; null when the relay did not say). */
data class PairingCodeShown(val code: String, val nodeName: String, val expiresAtMs: Long?)

/**
 * Get a code (§6.1): `POST /v1/pairing-codes`, one fingerprint (device-key
 * transport, §8.4). The code is shown with its expiry; the relay URL the
 * node pairs with is the pinned one.
 */
class PairingCodeFlow {
    var shown by mutableStateOf<PairingCodeShown?>(null)
        private set
    var busy by mutableStateOf(false)
        private set

    /** Asks [api] for a code for [nodeName]; throws what the relay answered (nothing is shown then). */
    suspend fun get(api: RelayApi, nodeName: String) {
        if (busy) return
        busy = true
        shown = null
        try {
            val reply = api.pairingCode(nodeName)
            val code = reply["code"].str() ?: throw OwnerMessage("The relay did not return a pairing code.")
            val offset = api.now().toEpochMilli() - System.currentTimeMillis()
            val expires = reply["expires_at"].str()?.let { Timestamps.epochMillis(it) }?.let { it - offset }
                ?: reply["expires_in_ms"].int()?.let { System.currentTimeMillis() + it }
            shown = PairingCodeShown(Display.escape(code), Display.escape(nodeName), expires)
        } finally {
            busy = false
        }
    }

    fun clear() {
        shown = null
    }
}
