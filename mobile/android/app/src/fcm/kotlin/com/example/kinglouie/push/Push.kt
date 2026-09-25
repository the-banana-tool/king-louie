package com.example.kinglouie.push

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import com.example.kinglouie.KingLouieApplication
import com.example.kinglouie.MainActivity
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** The `fcm` flavor: FCM data messages { rid, n, k } become a generic local notification. */
object Push {
    const val ENABLED = true
    const val EXTRA_REQUEST_ID = "kl.rid"
    const val CHANNEL = "approvals"

    fun register(activity: Activity, onToken: (String) -> Unit) {
        // Without the owner's own google-services.json there is no Firebase
        // app to ask; the app then works as the nopush flavor does.
        val messaging = try {
            FirebaseMessaging.getInstance()
        } catch (e: IllegalStateException) {
            return
        }
        messaging.token.addOnSuccessListener { onToken(it) }
    }
}

class KlMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        (application as KingLouieApplication).model.registerPushToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val rid = message.data["rid"] ?: return
        val kind = message.data["k"] ?: "approval"
        if (kind != "approval") return
        // The relay sanitizes the node name; the text stays generic anyway.
        val node = message.data["n"].orEmpty().filter { it.isLetterOrDigit() || it in "._-" }.take(64)
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(Push.CHANNEL, "Approvals", NotificationManager.IMPORTANCE_HIGH))
        val open = PendingIntent.getActivity(
            this, rid.hashCode(),
            Intent(this, MainActivity::class.java).putExtra(Push.EXTRA_REQUEST_ID, rid).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = android.app.Notification.Builder(this, Push.CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle("King Louie")
            .setContentText(if (node.isEmpty()) "Approval needed" else "Approval needed on $node")
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        manager.notify(rid.hashCode(), notification)
    }
}
