package com.example.kinglouie

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.kinglouie.protocol.Display
import com.example.kinglouie.protocol.Leases
import java.text.DateFormat
import java.util.Date

// Fleet stage 5 §3.10 on this phone. The list is fetched by the model's
// foreground loop, and the live view updates by itself while it is on screen
// (android-slim §7.6: its one DisposableEffect starts and stops it). Every
// decision is still the owner's tap (R-F5-5), and every text shown comes from
// a message a pinned node signed, escaped. tests/mobile-lease-apps.test.js
// reads this file.

private val LIMIT_TEXT = mapOf(
    "no_lock_detect" to "This computer cannot detect a locked screen.",
    "no_human_yield" to "This computer cannot detect your own typing, so it will not pause for you."
)

// Revised 2026-10-24 (agent-driven demo takes): the host's own words for what
// a take may do. Each is chosen by a signed field, never taken from a string
// the request sent.
private const val UNATTENDED_LINE = "Unattended: no check-ins; runs until it ends or you stop it"
private const val BROWSER_TRUE_LINE = "drive the browser on these sites (no scripts, no network changes, no uploads)"
private const val CREDENTIALS_LINE = "credentials from the vault"

/**
 * What the live view calls an unattended take, as its node signed it ([AppModel.unattendedTake]): its name and
 * the time it ends (the list's row says the same, built by ApprovalList). Null for any other lease.
 */
private fun takeTitle(take: Pair<String, Long>?): String? =
    take?.let { "Unattended take: " + Display.escape(it.first) + ", ends " + DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it.second)) }

/** Exactly what the node signed: who asks, the agent's reason (unverified), each app with its path, and for how long. */
@Composable
fun LeaseRequestScreen(model: AppModel, item: AppModel.LeaseRequestItem, back: () -> Unit) {
    var chosen by remember { mutableStateOf(item.request.apps.map { it.id }.toSet()) }
    var minutes by remember { mutableStateOf(item.request.maxMinutes) }
    val deciding = item.request.requestId in model.decidingLease
    val take = item.request.isTake
    val warning = statusColors.warning
    Column(Modifier.fillMaxSize()) {
        BackBar(if (take) "Take request" else "Computer use", back)
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                if (take) {
                    // A take, in this order: its name, unattended, how long, the sites and what it may do there,
                    // the apps, the reason (then who asks).
                    Text(Display.escape(item.request.name ?: ""), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    if (item.request.unattended) Text(UNATTENDED_LINE, color = warning, fontWeight = FontWeight.Bold)
                    LeaseMinutes(item, minutes) { minutes = it }
                    SectionTitle("Sites")
                    for (site in item.request.sites) Text(Display.escape(site), style = MonoStyle)
                    Text(item.request.browserActions?.let { "Browser actions: " + it.joinToString(", ") { a -> Display.escape(a) } } ?: BROWSER_TRUE_LINE)
                    if (item.request.credentials) Text(CREDENTIALS_LINE, fontWeight = FontWeight.Bold)
                } else {
                    Text(Display.escape(item.nodeName), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text("Job ${Display.escape(item.request.jobId)} · asked by ${Display.escape(item.request.originClient)}")
                    SectionTitle("Agent's reason (unverified)")
                    Text(Display.escape(item.request.reason))
                }
                SectionTitle("Apps it may control")
            }
            items(item.request.apps) { app ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(Display.escape(app.name), fontWeight = FontWeight.SemiBold)
                        Text(Display.escape(app.path), style = MonoStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (app.processes.isNotEmpty()) Text(app.processes.joinToString(", ") { Display.escape(it) }, style = MonoStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    // A take's first app is its browser: it stays on, so a grant never leaves the take's browser out.
                    val takeBrowser = item.request.isTake && app.id == item.request.apps.firstOrNull()?.id
                    Switch(checked = app.id in chosen, enabled = !item.request.isResume && !takeBrowser, onCheckedChange = { on -> chosen = if (on) chosen + app.id else chosen - app.id })
                }
            }
            item {
                if (take) {
                    SectionTitle("Agent's reason (unverified)")
                    Text(Display.escape(item.request.reason))
                    Text(Display.escape(item.nodeName), Modifier.padding(top = 8.dp), fontWeight = FontWeight.Bold)
                    Text("Job ${Display.escape(item.request.jobId)} · asked by ${Display.escape(item.request.originClient)}")
                } else {
                    LeaseMinutes(item, minutes) { minutes = it }
                }
                for (limit in item.request.limits) Text(LIMIT_TEXT[limit] ?: Display.escape(limit), color = warning)
                item.unconfirmed?.let { Text(it, color = warning, fontWeight = FontWeight.Bold) }
                Secondary("Allow and Deny each ask for your fingerprint once.", Modifier.padding(top = 8.dp))
            }
        }
        // The decision, where a thumb reaches it: full width at the bottom, after everything the node signed above.
        DecisionBar {
            Button({ model.decideLease(item, chosen, minutes, grant = true) }, Modifier.weight(1f).height(DecisionHeight), enabled = chosen.isNotEmpty() && !deciding) { Text("Allow", style = MaterialTheme.typography.labelLarge) }
            OutlinedButton({ model.decideLease(item, emptySet(), 1, grant = false) }, Modifier.weight(1f).height(DecisionHeight), enabled = !deciding,
                colors = denyColors(), border = denyBorder(!deciding)) { Text("Deny", style = MaterialTheme.typography.labelLarge) }
        }
    }
}

/** For how long: up to the request's own max_minutes, or the minutes a resume has left. */
@Composable
private fun LeaseMinutes(item: AppModel.LeaseRequestItem, minutes: Int, set: (Int) -> Unit) {
    if (item.request.isResume) {
        Text("The ${item.request.maxMinutes} min that were left; a resume never extends the lease.")
    } else {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton({ if (minutes > 1) set(minutes - 1) }) { Text("−", style = MaterialTheme.typography.titleLarge) }
            Text("$minutes min", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            OutlinedButton({ if (minutes < item.request.maxMinutes) set(minutes + 1) }) { Text("+", style = MaterialTheme.typography.titleLarge) }
        }
    }
}

/** The running lease's detail: it updates by itself while it is on screen (android-slim §7.6). */
@Composable
fun LiveLeaseScreen(model: AppModel, close: () -> Unit) {
    // The live view's loop: started when this is composed, stopped when it leaves (and with the app's lifecycle, in the model).
    DisposableEffect(Unit) {
        model.liveViewShown()
        onDispose { model.liveViewHidden() }
    }
    ticker()
    val live = model.liveLease ?: return
    val warning = statusColors.warning
    val alarm = MaterialTheme.colorScheme.error
    Column(Modifier.fillMaxSize()) {
        BackBar(takeTitle(model.unattendedTake(live)) ?: "Computer use", close)
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Text(Display.escape(live.nodeName), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(if (live.locked) "locked" else Display.escape(live.state), style = MaterialTheme.typography.titleMedium)
                live.expiresAtMs?.takeIf { live.state != "ended" }?.let { Text("Time left: " + formatLeft(maxOf(0L, it - System.currentTimeMillis())), style = MaterialTheme.typography.titleMedium) }
                // Stop first, full width: the one thing that must be found at once.
                Button({ model.killSwitch() }, Modifier.fillMaxWidth(), enabled = !live.busy && live.state != "ended",
                    colors = stopColors()) { Text(if (live.busy) "Working…" else "Stop now", Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.titleMedium) }
                val bitmap = live.frame?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
                if (bitmap != null) Image(bitmap.asImageBitmap(), contentDescription = "The leased app's window", modifier = Modifier.fillMaxWidth())
                else Text("No frame yet.")
                live.frameAtMs?.let { Secondary("Frame from ${formatLeft(maxOf(0L, System.currentTimeMillis() - it))} ago.") }
                if (live.frameDropped) Text("Frame dropped (too large)", color = warning)
                if (live.readKeyRefused) {
                    Text(model.readKeyRefusedText(live), color = warning)
                    OutlinedButton({ model.watchWithFingerprint() }, Modifier.fillMaxWidth(), enabled = !live.busy) { Text(AppModel.FINGERPRINT_WATCH_BUTTON) }
                }
                live.unconfirmed?.let { Text(it, color = alarm, fontWeight = FontWeight.Bold) }
                // R-F5-18: a lease this phone did not grant says who did. Only that phone keeps it going.
                val grantedByOther = Leases.grantedByOther(live.grantedByDevice, live.grantedByName, model.deviceId)
                grantedByOther?.let { Text(it) }
                // R-F5-15: the node pauses input when the phone that granted the lease has not been in
                // touch. While this view is open its watches are that touch (§7.6).
                if (Leases.isPausedForContact(live.state, live.reason)) {
                    if (grantedByOther == null) Text("Paused: open to let it continue", color = alarm, fontWeight = FontWeight.Bold)
                    else Text("Paused: the phone that granted it has not been in touch. You can still stop it here.", color = alarm, fontWeight = FontWeight.Bold)
                } else if (live.state == "active" && grantedByOther == null) {
                    Text(AppModel.KEEP_OPEN_LINE, color = warning)
                }
                live.reason?.takeIf { live.state != "active" }?.let { Text("Reason: ${Display.escape(it)}") }
                Secondary("Stop asks for your fingerprint once.")
                // Leaving the view forgets only a lease that is over (C-18). One that is
                // still running keeps its row in the list, and so its Stop.
                if (live.state == "ended") OutlinedButton({ model.closeLiveLease(); close() }, Modifier.fillMaxWidth()) { Text("Close") }
                SectionTitle("Actions")
            }
            items(live.actions) { a -> Text("${Display.escape(a.summary)} · ${Display.escape(a.result)}", style = MaterialTheme.typography.bodyMedium) }
        }
    }
}
