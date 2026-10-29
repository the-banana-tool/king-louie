package com.example.kinglouie.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.time.Instant
import java.util.Base64
import java.util.UUID

/** WELCOME until a pairing finishes, then LIVE. The demo mode is gone (android-slim §6.5, C-17). */
enum class AppMode { WELCOME, LIVE }

/** The only way the app obtains a network client: only in live mode (the factory refuses otherwise, and `built` proves it in tests). */
class RelayClientFactory<C>(private val make: () -> C) {
    var built = 0
        private set

    fun client(mode: AppMode): C? {
        if (mode != AppMode.LIVE) return null
        built += 1
        return make()
    }
}
