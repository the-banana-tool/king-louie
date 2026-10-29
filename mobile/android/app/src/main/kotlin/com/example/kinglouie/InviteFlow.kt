package com.example.kinglouie

import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.example.kinglouie.protocol.B64Url
import com.example.kinglouie.protocol.Messages
import com.example.kinglouie.protocol.NodePin
import com.example.kinglouie.protocol.ProtocolException
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.jsonString
import com.example.kinglouie.protocol.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/** A base64url token of exactly [bytes] bytes: a code id, a code, an invite id or secret. */
internal fun isToken(text: String?, bytes: Int): Boolean =
    text != null && runCatching { B64Url.decode(text).size == bytes }.getOrDefault(false)

/**
 * Add another phone (android-slim §6.4, C-14), phone A's side; split out of
 * AppModel.kt (review S8). An invite with the relay and node pins (its
 * request is the device key's, one fingerprint), its QR while it is open,
 * then its claim polled every [POLL_MS] with the read key until it comes, the
 * invite lapses or the flow is left, and the claimed device for the owner to
 * compare. Nothing here signs: AppModel signs the new phone's enrollment
 * once the owner confirmed (confirmInvited). [onProblem] is the banner.
 */
class InviteFlow(private val scope: CoroutineScope, private val onProblem: (String) -> Unit) {
    /** The invite's QR code while it is open. */
    var qr by mutableStateOf<String?>(null)
        private set

    /** The claimed device, checked, for the owner to compare. */
    var claim by mutableStateOf<JsonObject?>(null)
        private set

    /** Phone A's open invite: its id, the secret in its QR code, and when it lapses (elapsedRealtime ms). */
    private data class OpenInvite(val id: String, val secret: String, val untilMs: Long)

    private var open: OpenInvite? = null

    /** Polls the open invite's claim (C-14). */
    private var poll: Job? = null

    /**
     * Opens an invite on [api] naming the pinned relay and [nodes]; the claim
     * is then polled. A claim by [ownDeviceId] (this phone) is refused.
     * Throws what the relay answered; nothing is left open then.
     */
    suspend fun start(api: RelayApi, relayUrl: String, relaySpki: String, nodes: List<NodePin>, ownDeviceId: String?) {
        cancel()
        try {
            val inviteId = api.createInvite()["invite_id"].str()?.takeIf { isToken(it, 16) }
                ?: throw OwnerMessage("The relay did not return an invite.")
            val secret = Messages.randomNonce()
            qr = Messages.encodeQr(JsonObject(mapOf(
                "t" to jsonString("kl.invite"),
                "relay" to jsonString(relayUrl),
                "relay_spki" to jsonString(relaySpki),
                "invite_id" to jsonString(inviteId),
                "secret" to jsonString(secret),
                "nodes" to JsonArray(nodes.map { JsonObject(mapOf("id" to jsonString(it.id), "name" to jsonString(it.name), "key" to jsonString(it.key))) })
            )))
            // The invite lives 10 minutes on the relay.
            val invite = OpenInvite(inviteId, secret, SystemClock.elapsedRealtime() + 10 * 60 * 1000L)
            open = invite
            poll = scope.launch { pollClaim(api, invite, ownDeviceId) }
        } catch (e: Exception) {
            qr = null
            throw e
        }
    }

    /** Leaves Add another phone: the poll stops and the invite is forgotten here (it lapses on the relay). */
    fun cancel() {
        poll?.cancel()
        poll = null
        open = null
        qr = null
        claim = null
    }

    /** The claimed device, once: the owner confirmed it. */
    fun take(): JsonObject? = claim.also { claim = null }

    /** The claim, every POLL_MS with the read key, until it comes, the invite lapses or the flow is left. */
    private suspend fun pollClaim(api: RelayApi, invite: OpenInvite, ownDeviceId: String?) {
        while (open === invite) {
            delay(POLL_MS)
            if (open !== invite) return
            if (SystemClock.elapsedRealtime() > invite.untilMs) {
                open = null
                qr = null
                onProblem("Nobody used the invite within 10 minutes. Start a new one.")
                return
            }
            val claimed = try {
                api.inviteClaim(invite.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: RelayException) {
                if (e.code == "rate_limited" || e.status == 401) delay((e.retryAfter ?: AppModel.BUSY_WAIT_S).coerceAtLeast(1) * 1000L)
                continue
            } catch (e: Exception) {
                continue
            }
            if (claimed == null || claimed is JsonNull) continue
            open = null
            qr = null
            val device = verifiedClaim(claimed, invite.secret, ownDeviceId)
            if (device == null) {
                onProblem("The invite was claimed by something that did not scan it. Nothing was enrolled.")
                return
            }
            claim = device
            return
        }
    }

    /**
     * The claimed device, exactly as a valid enrollment would carry it
     * (Messages.device rebuilds and checks it), with a mac only the scanner of
     * this invite could make.
     */
    private fun verifiedClaim(claim: JsonElement, secret: String, ownDeviceId: String?): JsonObject? {
        val device = claim["device"] ?: return null
        val id = device["device_id"].str() ?: return null
        val name = device["name"].str() ?: return null
        val platform = device["platform"].str()?.takeIf { it == "ios" || it == "android" } ?: return null
        val x = device["public_key"]["x"].str() ?: return null
        val y = device["public_key"]["y"].str() ?: return null
        // A phone from this change claims with its read key too (§8.2); it is bound by the same mac.
        val readJwk = device["read_key"]?.takeIf { it !is JsonNull }?.let { rk ->
            Messages.jwk(rk["x"].str() ?: return null, rk["y"].str() ?: return null)
        }
        val rebuilt = try {
            Messages.device(id, name, platform, x, y, readJwk)
        } catch (e: ProtocolException) {
            return null
        }
        if (rebuilt != device || id == ownDeviceId) return null
        return if (claim["mac"].str() == Messages.inviteMac(secret, rebuilt)) rebuilt else null
    }

    companion object {
        /** The claim is polled this often with the read key (C-14). */
        const val POLL_MS = 3_000L
    }
}
