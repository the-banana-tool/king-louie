package com.example.kinglouie.push

import android.app.Activity

/** The `nopush` flavor: no push service at all; the owner checks from the app. */
object Push {
    const val ENABLED = false
    const val EXTRA_REQUEST_ID = "kl.rid"

    @Suppress("UNUSED_PARAMETER")
    fun register(activity: Activity, onToken: (String) -> Unit) = Unit
}
