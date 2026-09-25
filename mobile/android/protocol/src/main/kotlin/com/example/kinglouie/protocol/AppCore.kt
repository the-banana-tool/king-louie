package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.time.Instant
import java.util.UUID

enum class AppMode { WELCOME, DEMO, LIVE }

/** The only way the app obtains a network client. Demo mode never gets one: the factory refuses, and `built` proves it in tests. */
class RelayClientFactory<C>(private val make: () -> C) {
    var built = 0
        private set

    fun client(mode: AppMode): C? {
        if (mode != AppMode.LIVE) return null
        built += 1
        return make()
    }
}

/** Three pretend nodes with in-app keys and a software phone key, shown under a "Demo" banner. Nothing here touches the network. */
class DemoFleet(names: List<String> = listOf("gpu-box", "laptop", "web-01")) {
    private class Node(val pin: NodePin, val keys: KeyPair)

    private val nodes: List<Node> = names.map { name ->
        val keys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val spki = keys.public.encoded
        val raw = spki.copyOfRange(spki.size - 32, spki.size)
        Node(NodePin(Identifiers.nodeId(raw), name, Hex.encode(spki)), keys)
    }

    private val deviceKeys: KeyPair = KeyPairGenerator.getInstance("EC").run {
        initialize(ECGenParameterSpec("secp256r1"))
        generateKeyPair()
    }

    val pins: List<NodePin> get() = nodes.map { it.pin }

    val deviceId: String
        get() {
            val pub = deviceKeys.public as ECPublicKey
            return Identifiers.deviceId(byteArrayOf(0x04) + P256.coordinate(pub.w.affineX) + P256.coordinate(pub.w.affineY))
        }

    /** A node-signed request, as a real node would send it. */
    fun request(index: Int, command: String, now: Instant = Instant.now()): Envelope {
        val node = nodes[index]
        val action = JsonObject(
            mapOf(
                "kind" to jsonString("tool"),
                "name" to jsonString("Bash"),
                "params" to JsonObject(mapOf("command" to jsonString(command))),
                "cwd" to jsonString("/srv/site"),
                "summary" to jsonString(summary("Bash($command)"))
            )
        )
        val message = JsonObject(
            mapOf(
                "v" to jsonNumber("1"),
                "type" to jsonString("kl.approval.request"),
                "request_id" to jsonString(UUID.randomUUID().toString()),
                "node_id" to jsonString(node.pin.id),
                "node_name" to jsonString(node.pin.name),
                "action" to action,
                "action_hash" to jsonString(Digest.sha256B64url(Jcs.bytes(action))),
                "origin" to JsonObject(mapOf("client" to jsonString("demo"), "session" to JsonNull, "job_id" to JsonNull)),
                "created_at" to jsonString(Timestamps.string(now)),
                "expires_at" to jsonString(Timestamps.string(now.plusSeconds(300))),
                "nonce" to jsonString(Messages.randomNonce())
            )
        )
        return Envelope.seal(message, node.pin.id, "Ed25519") { bytes ->
            Signature.getInstance("Ed25519").run { initSign(node.keys.private); update(bytes); sign() }
        }
    }

    /** The demo software key signs demo answers (raw r||s); it is dropped with the fleet when the owner leaves demo. */
    fun sign(bytes: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
        initSign(deviceKeys.private)
        update(bytes)
        P1363.fromDer(sign())
    }

    companion object {
        /** A summary is at most 300 code points, cut with "…" (the node's cutSummary). */
        fun summary(text: String): String {
            val cps = text.codePoints().toArray()
            return if (cps.size > 300) String(cps, 0, 299) + "…" else text
        }
    }
}
