package com.example.kinglouie.push

import android.app.Activity
import android.content.Context

/** The `nopush` flavor: no push service at all; the owner checks from the app. The hooks the main code calls do nothing. */
object Push {
    const val ENABLED = false
    const val EXTRA_REQUEST_ID = "kl.rid"
    const val EXTRA_KIND = "kl.k"
    const val EXTRA_COUNT = "kl.c"

    @Suppress("UNUSED_PARAMETER")
    fun register(activity: Activity, onToken: (String) -> Unit) = Unit

    @Suppress("UNUSED_PARAMETER")
    fun token(onToken: (String) -> Unit) = Unit

    /** This build has no push (push spec §7.3, the gear's row). */
    @Suppress("UNUSED_PARAMETER")
    fun available(context: Context): Boolean = false

    @Suppress("UNUSED_PARAMETER")
    fun appInFront(context: Context) = Unit

    @Suppress("UNUSED_PARAMETER")
    fun leaseNotSuspended(context: Context, leaseId: String) = Unit
}
