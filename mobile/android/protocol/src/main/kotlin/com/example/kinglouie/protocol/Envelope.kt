package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECFieldFp
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.X509EncodedKeySpec

/**
 * A signed envelope: { alg, kid, payload, sig }. Signatures cover the payload
 * bytes as received; the phone never re-serializes to verify.
 */
data class Envelope(val alg: String, val kid: String, val payload: String, val sig: String) {
    /** An opened envelope: the message and the exact bytes that were signed. */
    class Opened(val message: JsonObject, val bytes: ByteArray)

    val json: JsonObject
        get() = JsonObject(mapOf("alg" to jsonString(alg), "kid" to jsonString(kid), "payload" to jsonString(payload), "sig" to jsonString(sig)))

    fun payloadBytes(): ByteArray = B64Url.decode(payload)

    /**
     * Opens the envelope the way a node does (`open` in
     * src/approvals/envelope.js): `payload` and `sig` are strict base64url, the
     * payload is UTF-8 JSON, an object, and exactly its own canonical (JCS)
     * bytes with ECMAScript-form numbers. Anything else throws (`malformed`).
     */
    fun open(): Opened {
        val bytes = payloadBytes()
        B64Url.decode(sig)
        val message = try {
            JsonText.parse(bytes)
        } catch (e: ProtocolException) {
            throw ProtocolException("payload is not JSON: ${e.message}")
        }
        if (message !is JsonObject) throw ProtocolException("payload is not an object")
        val canonical = try {
            Jcs.numbersAreCanonical(message) && Jcs.bytes(message).contentEquals(bytes)
        } catch (e: ProtocolException) {
            false
        }
        if (!canonical) throw ProtocolException("payload is not canonical")
        return Opened(message, bytes)
    }

    /** The payload message, opened strictly (see `open()`). */
    fun message(): JsonObject = open().message

    /** Node signature over the received bytes, against a pinned DER SPKI key. */
    fun verifyEd25519(spkiHex: String): Boolean = try {
        val spki = Hex.decode(spkiHex)
        if (alg != "Ed25519" || spki.size != 44 || Hex.encode(spki.copyOfRange(0, 12)) != Identifiers.ED25519_SPKI_PREFIX) {
            false
        } else {
            val signature = B64Url.decode(sig)
            val bytes = payloadBytes()
            if (signature.size != 64) false else {
                val key = KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(spki))
                Signature.getInstance("Ed25519").run {
                    initVerify(key)
                    update(bytes)
                    verify(signature)
                }
            }
        }
    } catch (e: Exception) {
        false
    }

    /** Phone signature (P-256, raw r||s, never DER) against a device JWK's x and y, which must be a point on the curve. */
    fun verifyEs256(x: String, y: String): Boolean = try {
        val raw = B64Url.decode(sig)
        if (alg != "ES256" || raw.size != 64) false else {
            val key = P256.publicKey(x, y)
            val bytes = payloadBytes()
            Signature.getInstance("SHA256withECDSA").run {
                initVerify(key)
                update(bytes)
                verify(P1363.toDer(raw))
            }
        }
    } catch (e: Exception) {
        false
    }

    companion object {
        /** Exactly the four members, each a non-empty string. */
        fun fromJson(json: JsonElement): Envelope {
            val o = json.obj() ?: throw ProtocolException("not an envelope")
            if (o.size != 4) throw ProtocolException("not an envelope")
            fun member(k: String) = o[k].str()?.takeIf { it.isNotEmpty() } ?: throw ProtocolException("not an envelope: $k")
            return Envelope(member("alg"), member("kid"), member("payload"), member("sig"))
        }

        /** Canonical bytes of `message`, signed by `sign` (raw r||s for ES256). */
        fun seal(message: JsonElement, kid: String, alg: String = "ES256", sign: (ByteArray) -> ByteArray): Envelope {
            val bytes = Jcs.bytes(message)
            return Envelope(alg, kid, B64Url.encode(bytes), B64Url.encode(sign(bytes)))
        }
    }
}

object P256 {
    val params: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").run {
            init(ECGenParameterSpec("secp256r1"))
            getParameterSpec(ECParameterSpec::class.java)
        }
    }

    /** (x, y) is an affine point on P-256: both below p and y² = x³ + ax + b (mod p). */
    fun isOnCurve(x: ByteArray, y: ByteArray): Boolean {
        val curve = params.curve
        val p = (curve.field as ECFieldFp).p
        val xi = BigInteger(1, x)
        val yi = BigInteger(1, y)
        if (xi >= p || yi >= p) return false
        val left = yi.multiply(yi).mod(p)
        val right = xi.multiply(xi).multiply(xi).add(curve.a.multiply(xi)).add(curve.b).mod(p)
        return left == right
    }

    /** The public key of a device JWK's x and y (32 bytes each, on the curve). */
    fun publicKey(x: String, y: String): PublicKey {
        val xb = B64Url.decode(x)
        val yb = B64Url.decode(y)
        if (xb.size != 32 || yb.size != 32) throw ProtocolException("P-256 coordinates are 32 bytes")
        if (!isOnCurve(xb, yb)) throw ProtocolException("not a point on P-256")
        val point = ECPoint(BigInteger(1, xb), BigInteger(1, yb))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, params))
    }

    /** The 32-byte big-endian form of a key coordinate. */
    fun coordinate(v: BigInteger): ByteArray {
        val b = v.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }
}

/** IEEE P1363 (raw r||s) ⇄ DER; java.security's SHA256withECDSA speaks DER. */
object P1363 {
    fun toDer(raw: ByteArray): ByteArray {
        if (raw.size != 64) throw ProtocolException("P-256 signatures are 64 bytes")
        fun integer(part: ByteArray): ByteArray {
            var start = 0
            while (start < part.size - 1 && part[start] == 0.toByte() && (part[start + 1].toInt() and 0xff) < 0x80) start++
            var bytes = part.copyOfRange(start, part.size)
            if ((bytes[0].toInt() and 0xff) >= 0x80) bytes = byteArrayOf(0) + bytes
            return byteArrayOf(0x02, bytes.size.toByte()) + bytes
        }
        val body = integer(raw.copyOfRange(0, 32)) + integer(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    /** SEQUENCE { INTEGER r, INTEGER s } with short-form lengths (P-256 never needs more) and nothing after it. */
    fun fromDer(der: ByteArray): ByteArray {
        if (der.size < 8 || der[0] != 0x30.toByte() || (der[1].toInt() and 0xff) != der.size - 2) {
            throw ProtocolException("not a DER signature")
        }
        var i = 2
        fun read(): ByteArray {
            if (i + 2 > der.size || der[i] != 0x02.toByte()) throw ProtocolException("expected INTEGER")
            val len = der[i + 1].toInt() and 0xff
            if (len < 1 || len >= 0x80 || i + 2 + len > der.size) throw ProtocolException("bad INTEGER length")
            var value = der.copyOfRange(i + 2, i + 2 + len)
            i += 2 + len
            while (value.size > 32 && value[0] == 0.toByte()) value = value.copyOfRange(1, value.size)
            if (value.size > 32) throw ProtocolException("integer too long")
            return ByteArray(32 - value.size) + value
        }
        val r = read()
        val s = read()
        if (i != der.size) throw ProtocolException("trailing data")
        return r + s
    }
}
