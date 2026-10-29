package com.example.kinglouie.push

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.example.kinglouie.KingLouieApplication
import com.example.kinglouie.MainActivity
import com.example.kinglouie.R
import com.example.kinglouie.protocol.PushText
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * The `fcm` flavor: FCM data messages { k, rid, n, c? } become a local
 * notification whose words the phone builds (push spec §7.2, PushText).
 * No action buttons (R-PU-4): a tap opens the app, which fetches with the
 * read key and shows only what a pinned node signed.
 */
object Push {
    const val ENABLED = true
    const val EXTRA_REQUEST_ID = "kl.rid"
    const val EXTRA_KIND = "kl.k"
    const val EXTRA_COUNT = "kl.c"

    /** Every notification has this id; its tag tells them apart (one per tag). */
    const val NOTIFICATION_ID = 1

    private const val PREFS = "kl.push"
    private const val COUNT_KEY = "approvals_count"

    fun register(activity: Activity, onToken: (String) -> Unit) = token(onToken)

    /**
     * Asks FCM for this app's token (no Activity needed: after Reset this
     * phone deleted the stored one, the next enrollment asks again).
     * Without the owner's own google-services.json there is no Firebase app
     * to ask; the app then works as the nopush flavor does.
     */
    fun token(onToken: (String) -> Unit) {
        val messaging = try {
            FirebaseMessaging.getInstance()
        } catch (e: IllegalStateException) {
            return
        }
        messaging.token.addOnSuccessListener { onToken(it) }
    }

    /** Whether this build can receive a push at all: a Firebase app exists (push spec §7.3, the gear's row). */
    fun available(context: Context): Boolean = FirebaseApp.getApps(context).isNotEmpty()

    /**
     * The running count of Approval pushes since the app was last in front
     * (C-6), [items] more. Kept in preferences: a push can start the process.
     */
    @Synchronized
    fun addToCount(context: Context, items: Int): Int {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val count = (prefs.getInt(COUNT_KEY, 0) + items).coerceAtMost(9_999)
        prefs.edit().putInt(COUNT_KEY, count).apply()
        return count
    }

    /** The app came to the front: the running count starts again. */
    @Synchronized
    fun appInFront(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt(COUNT_KEY, 0).apply()
    }

    /** A signed status of [leaseId] that is not `suspended` was applied: its "Session paused" notification goes. */
    fun leaseNotSuspended(context: Context, leaseId: String) {
        context.getSystemService(NotificationManager::class.java)?.cancel(PushText.tag("session_paused", leaseId), NOTIFICATION_ID)
    }
}

class KlMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        (application as KingLouieApplication).model.registerPushToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val rid = message.data["rid"] ?: return
        val kind = message.data["k"] ?: "approval"
        // A newer relay's kind is ignored, never shown as something else.
        if (kind !in PushText.KINDS) return
        // A coalesced push (c above 1) of any kind is the Approvals notification with its running count.
        val items = PushText.itemsIn(message.data["c"])
        val tag = PushText.tag(kind, rid, items) ?: return
        val node = PushText.nodeName(message.data["n"])
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(PushText.APPROVALS_CHANNEL, "Approvals", NotificationManager.IMPORTANCE_HIGH))
        manager.createNotificationChannel(NotificationChannel(PushText.SESSIONS_CHANNEL, "Sessions", NotificationManager.IMPORTANCE_DEFAULT))
        val approvals = PushText.joinsApprovals(kind, items)
        val count = if (approvals) Push.addToCount(this, items) else 1
        val text = if (approvals) PushText.approvalText(kind, node, count) else PushText.otherText(kind, node)
        val open = PendingIntent.getActivity(
            this, tag.hashCode(),
            Intent(this, MainActivity::class.java)
                .putExtra(Push.EXTRA_REQUEST_ID, rid)
                .putExtra(Push.EXTRA_KIND, kind)
                .putExtra(Push.EXTRA_COUNT, count)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = Notification.Builder(this, PushText.channel(kind, items))
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle("King Louie")
            .setContentText(text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        // One per tag: a new Approvals push replaces the last one.
        manager.notify(tag, Push.NOTIFICATION_ID, notification)
        // In front, the list is fetched at once (android-slim §9); in the background this does nothing.
        (application as KingLouieApplication).model.onNotificationArrived()
    }
}
