@file:OptIn(ExperimentalSerializationApi::class)

package com.example.kinglouie.protocol

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonUnquotedLiteral
import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.text.Normalizer
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Anything a phone refuses: the message is `malformed` for approval-v1. */
class ProtocolException(message: String) : Exception(message)

/**
 * A strict RFC 8259 parser over UTF-8 bytes. Numbers keep the text received
 * (JsonPrimitive.content), which the display and JCS re-serialization use.
 * Refused: invalid UTF-8 (overlong forms, encoded surrogates), lone
 * surrogates, trailing data, raw control characters in strings, nesting
 * deeper than 512, duplicate keys, and two keys in one object that are equal
 * under Unicode normalization (approval-v1 §5: iOS cannot keep both, so
 * Android refuses them too and the two apps agree).
 */
object JsonText {
    const val MAX_DEPTH = 512

    fun parse(text: String): JsonElement = parse(text.toByteArray(Charsets.UTF_8))

    fun parse(bytes: ByteArray): JsonElement {
        val text = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
        } catch (e: CharacterCodingException) {
            throw ProtocolException("invalid UTF-8")
        }
        val parser = Parser(text)
        parser.skipWhitespace()
        val value = parser.value(0)
        parser.skipWhitespace()
        if (parser.i != text.length) throw ProtocolException("trailing data")
        return value
    }

    private class Parser(val s: String) {
        var i = 0

        fun skipWhitespace() {
            while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++
        }

        private fun expect(literal: String) {
            if (!s.startsWith(literal, i)) throw ProtocolException("expected $literal")
            i += literal.length
        }

        fun value(depth: Int): JsonElement {
            if (i >= s.length) throw ProtocolException("unexpected end")
            return when (s[i]) {
                '{' -> obj(depth + 1)
                '[' -> array(depth + 1)
                '"' -> JsonPrimitive(string())
                't' -> { expect("true"); JsonPrimitive(true) }
                'f' -> { expect("false"); JsonPrimitive(false) }
                'n' -> { expect("null"); JsonNull }
                else -> JsonUnquotedLiteral(number())
            }
        }

        private fun obj(depth: Int): JsonObject {
            if (depth > MAX_DEPTH) throw ProtocolException("nested too deeply")
            i++
            val out = LinkedHashMap<String, JsonElement>()
            val normalized = HashSet<String>()
            skipWhitespace()
            if (i < s.length && s[i] == '}') { i++; return JsonObject(out) }
            while (true) {
                skipWhitespace()
                if (i >= s.length || s[i] != '"') throw ProtocolException("expected a key")
                val key = string()
                // NFC(a) == NFC(b) exactly when a and b are canonically
                // equivalent, so this refuses exact duplicates too.
                if (!normalized.add(Normalizer.normalize(key, Normalizer.Form.NFC))) {
                    throw ProtocolException("duplicate key")
                }
                skipWhitespace()
                expect(":")
                skipWhitespace()
                out[key] = value(depth)
                skipWhitespace()
                if (i >= s.length) throw ProtocolException("unterminated object")
                when (s[i]) {
                    ',' -> i++
                    '}' -> { i++; return JsonObject(out) }
                    else -> throw ProtocolException("expected , or }")
                }
            }
        }

        private fun array(depth: Int): JsonArray {
            if (depth > MAX_DEPTH) throw ProtocolException("nested too deeply")
            i++
            val out = ArrayList<JsonElement>()
            skipWhitespace()
            if (i < s.length && s[i] == ']') { i++; return JsonArray(out) }
            while (true) {
                skipWhitespace()
                out.add(value(depth))
                skipWhitespace()
                if (i >= s.length) throw ProtocolException("unterminated array")
                when (s[i]) {
                    ',' -> i++
                    ']' -> { i++; return JsonArray(out) }
                    else -> throw ProtocolException("expected , or ]")
                }
            }
        }

        /** Exactly four hex digits (no sign). */
        private fun hex4(): Int {
            if (i + 4 > s.length) throw ProtocolException("bad \\u escape")
            var v = 0
            for (k in 0 until 4) {
                val d = Character.digit(s[i + k], 16)
                if (d < 0 || s[i + k].code > 0x7F) throw ProtocolException("bad \\u escape")
                v = (v shl 4) or d
            }
            i += 4
            return v
        }

        fun string(): String {
            i++
            val out = StringBuilder()
            while (true) {
                if (i >= s.length) throw ProtocolException("unterminated string")
                val c = s[i]
                when {
                    c == '"' -> { i++; return out.toString() }
                    c.code < 0x20 -> throw ProtocolException("control character in string")
                    c != '\\' -> { out.append(c); i++ }
                    else -> {
                        i++
                        if (i >= s.length) throw ProtocolException("bad escape")
                        val e = s[i++]
                        when (e) {
                            '"' -> out.append('"')
                            '\\' -> out.append('\\')
                            '/' -> out.append('/')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000C')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'u' -> {
                                val high = hex4()
                                when (high) {
                                    in 0xD800..0xDBFF -> {
                                        if (i + 2 > s.length || s[i] != '\\' || s[i + 1] != 'u') throw ProtocolException("lone surrogate")
                                        i += 2
                                        val low = hex4()
                                        if (low !in 0xDC00..0xDFFF) throw ProtocolException("lone surrogate")
                                        out.append(high.toChar()).append(low.toChar())
                                    }
                                    in 0xDC00..0xDFFF -> throw ProtocolException("lone surrogate")
                                    else -> out.append(high.toChar())
                                }
                            }
                            else -> throw ProtocolException("bad escape")
                        }
                    }
                }
            }
        }

        private fun isDigit(k: Int) = k < s.length && s[k] in '0'..'9'

        fun number(): String {
            val start = i
            if (i < s.length && s[i] == '-') i++
            if (!isDigit(i)) throw ProtocolException("bad number")
            if (s[i] == '0') i++ else while (isDigit(i)) i++
            if (i < s.length && s[i] == '.') {
                i++
                if (!isDigit(i)) throw ProtocolException("bad fraction")
                while (isDigit(i)) i++
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                if (!isDigit(i)) throw ProtocolException("bad exponent")
                while (isDigit(i)) i++
            }
            return s.substring(start, i)
        }
    }
}

/**
 * RFC 8785 serialization: keys sorted by UTF-16 code units (Kotlin's String
 * order), no whitespace, strings escaped as ECMAScript's JSON.stringify does,
 * numbers written as received. `esNumber` says whether a received lexeme is
 * the ECMAScript form, which the canonical-bytes check on envelopes uses.
 */
object Jcs {
    fun serialize(value: JsonElement): String = StringBuilder().also { write(value, it) }.toString()

    fun bytes(value: JsonElement): ByteArray = serialize(value).toByteArray(Charsets.UTF_8)

    /** Throws on a lone surrogate, as the node's canonicalize does: it has no UTF-8 form. */
    fun escape(s: String): String {
        val out = StringBuilder("\"")
        var k = 0
        while (k < s.length) {
            val ch = s[k]
            when {
                ch == '"' -> out.append("\\\"")
                ch == '\\' -> out.append("\\\\")
                ch == '\b' -> out.append("\\b")
                ch.code == 0x0C -> out.append("\\f")
                ch == '\n' -> out.append("\\n")
                ch == '\r' -> out.append("\\r")
                ch == '\t' -> out.append("\\t")
                ch.code < 0x20 -> out.append("\\u").append(Integer.toHexString(ch.code).padStart(4, '0'))
                Character.isHighSurrogate(ch) -> {
                    if (k + 1 >= s.length || !Character.isLowSurrogate(s[k + 1])) throw ProtocolException("lone surrogate")
                    out.append(ch).append(s[k + 1])
                    k++
                }
                Character.isLowSurrogate(ch) -> throw ProtocolException("lone surrogate")
                else -> out.append(ch)
            }
            k++
        }
        return out.append('"').toString()
    }

    /**
     * The ECMAScript Number::toString form of a JSON number lexeme (what
     * JSON.stringify and so RFC 8785 write), or null when it is not finite.
     * A received number is canonical exactly when this returns the lexeme.
     */
    fun esNumber(lexeme: String): String? {
        val d = lexeme.toDoubleOrNull() ?: return null
        if (!d.isFinite()) return null
        if (d == 0.0) return "0"
        val (digits, n) = shortestDigits(Math.abs(d))
        val k = digits.length
        val body = when {
            n in k..21 -> digits + "0".repeat(n - k)
            n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
            n in -5..0 -> "0." + "0".repeat(-n) + digits
            else -> {
                val e = n - 1
                digits.substring(0, 1) + (if (k > 1) "." + digits.substring(1) else "") + "e" + (if (e < 0) "-" else "+") + Math.abs(e)
            }
        }
        return (if (d < 0) "-" else "") + body
    }

    /**
     * ECMAScript's digits s and exponent n for a positive finite double: the
     * fewest digits k with s × 10^(n−k) == d, the closer candidate when two
     * have that length (the even one on a tie). JDK 17's Double.toString is
     * not always shortest, so this searches with exact BigDecimal arithmetic.
     */
    private fun shortestDigits(d: Double): Pair<String, Int> {
        val exact = BigDecimal(d)
        for (p in 1..17) {
            val down = exact.round(MathContext(p, RoundingMode.DOWN))
            val up = exact.round(MathContext(p, RoundingMode.UP))
            val candidates = listOf(down, up).distinct().filter { it.toDouble() == d }
            if (candidates.isEmpty()) continue
            val pick = if (candidates.size == 1) candidates[0] else {
                val dd = exact.subtract(down).abs()
                val du = up.subtract(exact).abs()
                when {
                    dd < du -> down
                    du < dd -> up
                    else -> if (down.unscaledValue().testBit(0)) up else down
                }
            }
            val plain = pick.stripTrailingZeros()
            val digits = plain.unscaledValue().toString()
            // value = digits × 10^(−scale) = digits × 10^(n − k)
            val n = digits.length - plain.scale()
            return digits to n
        }
        throw IllegalStateException("no round-trip digits for $d")
    }

    /** Every number inside `value` is written in its ECMAScript form. */
    fun numbersAreCanonical(value: JsonElement): Boolean = when (value) {
        is JsonNull -> true
        is JsonPrimitive -> !value.isNumber() || esNumber(value.content) == value.content
        is JsonArray -> value.all { numbersAreCanonical(it) }
        is JsonObject -> value.values.all { numbersAreCanonical(it) }
    }

    private fun write(value: JsonElement, out: StringBuilder) {
        when (value) {
            is JsonNull -> out.append("null")
            is JsonPrimitive -> if (value.isString) out.append(escape(value.content)) else out.append(value.content)
            is JsonArray -> {
                out.append('[')
                value.forEachIndexed { i, v -> if (i > 0) out.append(','); write(v, out) }
                out.append(']')
            }
            is JsonObject -> {
                out.append('{')
                value.keys.sorted().forEachIndexed { i, k ->
                    if (i > 0) out.append(',')
                    out.append(escape(k)).append(':')
                    write(value.getValue(k), out)
                }
                out.append('}')
            }
        }
    }
}

object B64Url {
    private val encoder = Base64.getUrlEncoder().withoutPadding()

    fun encode(bytes: ByteArray): String = encoder.encodeToString(bytes)

    fun isAlphabet(c: Char): Boolean = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '-' || c == '_'

    /** Strict: the base64url alphabet, no padding, and the one canonical encoding of the bytes. */
    fun decode(text: String): ByteArray {
        if (!text.all { isAlphabet(it) } || text.length % 4 == 1) throw ProtocolException("not base64url")
        val bytes = try {
            Base64.getUrlDecoder().decode(text)
        } catch (e: IllegalArgumentException) {
            throw ProtocolException("not base64url")
        }
        if (encode(bytes) != text) throw ProtocolException("non-canonical base64url")
        return bytes
    }
}

object Hex {
    private const val DIGITS = "0123456789abcdef"

    fun encode(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) out.append(DIGITS[(b.toInt() shr 4) and 15]).append(DIGITS[b.toInt() and 15])
        return out.toString()
    }

    private fun nibble(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        in 'A'..'F' -> c - 'A' + 10
        else -> throw ProtocolException("bad hex")
    }

    /** Strict: an even number of hex digits and nothing else. */
    fun decode(text: String): ByteArray {
        if (text.length % 2 != 0) throw ProtocolException("odd hex")
        return ByteArray(text.length / 2) { ((nibble(text[it * 2]) shl 4) or nibble(text[it * 2 + 1])).toByte() }
    }
}

object Digest {
    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
    fun sha256B64url(bytes: ByteArray): String = B64Url.encode(sha256(bytes))
    fun sha256Hex(bytes: ByteArray): String = Hex.encode(sha256(bytes))

    /** HMAC-SHA256 keyed with the raw bytes of a base64url secret (a console `code` or an invite `secret`). */
    fun hmacB64url(keyB64url: String, message: ByteArray): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(B64Url.decode(keyB64url), "HmacSHA256"))
        return B64Url.encode(mac.doFinal(message))
    }
}

/** Ids and the four-letter groups people compare on two screens. */
object Identifiers {
    private const val ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
    const val ED25519_SPKI_PREFIX = "302a300506032b6570032100"

    /** Lowercase RFC 4648 base32 without padding. */
    fun base32(bytes: ByteArray): String {
        var bits = 0
        var value = 0
        val out = StringBuilder()
        for (b in bytes) {
            value = (value shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                out.append(ALPHABET[(value shr (bits - 5)) and 31])
                bits -= 5
            }
            value = value and ((1 shl bits) - 1)
        }
        if (bits > 0) out.append(ALPHABET[(value shl (5 - bits)) and 31])
        return out.toString()
    }

    /** prefix + base32(sha256(raw))[0..16] */
    fun deviceId(raw: ByteArray, prefix: String = "d-"): String = prefix + base32(Digest.sha256(raw)).take(16)

    /** d- + base32(sha256(0x04 || x || y))[0..16]. The coordinates must be 32 bytes each and a point on P-256 (§2). */
    fun deviceId(x: String, y: String): String {
        val xb = B64Url.decode(x)
        val yb = B64Url.decode(y)
        if (xb.size != 32 || yb.size != 32) throw ProtocolException("P-256 coordinates are 32 bytes")
        if (!P256.isOnCurve(xb, yb)) throw ProtocolException("not a point on P-256")
        return deviceId(byteArrayOf(0x04) + xb + yb)
    }

    fun nodeId(ed25519Raw: ByteArray): String = deviceId(ed25519Raw, "kl-")

    /** 'd-abcdefghijklmnop' → 'abcd efgh ijkl mnop': everything after the first '-' (the whole id when there is none). */
    fun fingerprintGroups(id: String): String {
        val cps = id.substring(id.indexOf('-') + 1).codePoints().toArray()
        return (cps.indices step 4).joinToString(" ") { String(cps, it, minOf(4, cps.size - it)) }
    }
}

object Timestamps {
    private val format = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    /** RFC 3339 UTC with milliseconds, e.g. 2026-09-23T18:04:31.201Z. */
    fun string(instant: Instant): String = format.format(instant)

    /** The moment of a valid approval-v1 timestamp (fractions of 1–3 digits); throws for anything `isValid` refuses. */
    fun parse(text: String): Instant = Instant.ofEpochMilli(epochMillis(text) ?: throw ProtocolException("not an approval-v1 timestamp"))

    /** Milliseconds since 1970 of a valid approval-v1 timestamp (the node's Date.parse), or null. */
    fun epochMillis(text: String): Long? {
        if (!isValid(text)) return null
        fun num(from: Int, count: Int): Long {
            var v = 0L
            for (k in from until from + count) v = v * 10 + (text[k] - '0')
            return v
        }
        var y = num(0, 4)
        val mo = num(5, 2)
        val d = num(8, 2)
        // Days from civil (proleptic Gregorian), H. Hinnant's algorithm.
        if (mo <= 2) y -= 1
        val era = (if (y >= 0) y else y - 399) / 400
        val yoe = y - era * 400
        val doy = (153 * (mo + (if (mo > 2) -3 else 9)) + 2) / 5 + d - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        val days = era * 146097 + doe - 719468
        var ms = (((days * 24 + num(11, 2)) * 60 + num(14, 2)) * 60 + num(17, 2)) * 1000
        if (text.length > 20) {
            val digits = text.length - 21
            var frac = num(20, digits)
            repeat(3 - digits) { frac *= 10 }
            ms += frac
        }
        return ms
    }

    /**
     * `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$` and a real calendar
     * moment, judged the way the node does (a round trip through Date.UTC).
     * Date.UTC maps years 0–99 to 1900–1999, so the node refuses them, and so
     * does this.
     */
    fun isValid(text: String): Boolean {
        fun digits(from: Int, count: Int): Int? {
            if (from + count > text.length) return null
            var v = 0
            for (k in from until from + count) {
                val c = text[k]
                if (c !in '0'..'9') return null
                v = v * 10 + (c - '0')
            }
            return v
        }
        if (text.length !in 20..24) return false
        val year = digits(0, 4) ?: return false
        val month = digits(5, 2) ?: return false
        val day = digits(8, 2) ?: return false
        val hour = digits(11, 2) ?: return false
        val minute = digits(14, 2) ?: return false
        val second = digits(17, 2) ?: return false
        if (text[4] != '-' || text[7] != '-' || text[10] != 'T' || text[13] != ':' || text[16] != ':' || text[text.length - 1] != 'Z') return false
        if (text.length > 20) {
            // ".d", ".dd" or ".ddd" between the seconds and the Z.
            if (text.length < 22 || text[19] != '.' || digits(20, text.length - 21) == null) return false
        }
        if (year < 100 || month !in 1..12 || hour > 23 || minute > 59 || second > 59) return false
        val leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        val days = intArrayOf(31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[month - 1]
        return day in 1..days
    }
}

// JSON helpers over kotlinx.serialization's tree.

fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
fun JsonElement?.obj(): JsonObject? = this as? JsonObject
fun JsonElement?.arr(): JsonArray? = this as? JsonArray
fun JsonElement?.int(): Int? = takeIf { it.isNumber() }?.let { (it as JsonPrimitive).content.toIntOrNull() }
fun JsonElement?.bool(): Boolean? = (this as? JsonPrimitive)?.takeIf { !it.isString && this !is JsonNull }?.content?.toBooleanStrictOrNull()
fun JsonElement?.isNull(): Boolean = this is JsonNull

/** A JSON number (not a string, boolean or null). */
fun JsonElement?.isNumber(): Boolean {
    val p = this as? JsonPrimitive ?: return false
    return p !is JsonNull && !p.isString && p.content != "true" && p.content != "false"
}

operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)
fun jsonString(s: String): JsonPrimitive = JsonPrimitive(s)

/** A JSON number written exactly as `text` (a valid JSON number lexeme). */
fun jsonNumber(text: String): JsonPrimitive {
    val parsed = JsonText.parse(text)
    if (!parsed.isNumber()) throw ProtocolException("not a JSON number: $text")
    return parsed as JsonPrimitive
}
