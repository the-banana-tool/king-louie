package com.example.kinglouie

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.kinglouie.protocol.AppMode
import com.example.kinglouie.protocol.Display
import com.example.kinglouie.protocol.Leases
import java.text.DateFormat
import java.util.Date

// Fleet stage 5 §3.10 on this phone (owner rulings R-F5-1, R-F5-5, R-F5-6):
// nothing on these screens runs by itself. The model is called only from a
// button the owner taps, and every text shown comes from a message a pinned
// node signed, escaped. tests/mobile-lease-apps.test.js reads this file.

private val LIMIT_TEXT = mapOf(
    "no_lock_detect" to "This computer cannot detect a locked screen.",
    "no_human_yield" to "This computer cannot detect your own typing, so it will not pause for you."
)
private val WARNING = Color(0xFFB26A00)

// Revised 2026-10-24 (agent-driven demo takes): the host's own words for what
// a take may do. Each is chosen by a signed field, never taken from a string
// the request sent.
private const val UNATTENDED_LINE = "Unattended: no check-ins; runs until it ends or you stop it"
private const val BROWSER_TRUE_LINE = "drive the browser on these sites (no scripts, no network changes, no uploads)"
private const val CREDENTIALS_LINE = "credentials from the vault"

/**
 * What a banner row calls an unattended take, as its node signed it ([AppModel.unattendedTake]): its name and
 * the time it ends. Null for any other lease, whose row keeps its usual title. The Stop beside it is the same.
 */
private fun takeTitle(take: Pair<String, Long>?): String? =
    take?.let { "Unattended take: " + Display.escape(it.first) + ", ends " + DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it.second)) }

/** Lease requests in the Pending tab. Nothing is fetched until the owner taps (R-F5-1, R-F5-6). */
@Composable
fun LeaseRequests(model: AppModel, open: (AppModel.LeaseRequestItem) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Computer use", fontWeight = FontWeight.Bold)
        if (model.leaseNotice) Text("A computer-use request arrived. Tap the button below to load it.", color = WARNING)
        if (model.mode == AppMode.LIVE) {
            OutlinedButton({ model.refreshLeases() }, enabled = !model.isLoadingLeases) { Text(if (model.isLoadingLeases) "Checking…" else "Check for computer-use requests") }
        }
        // R-F5-20, and the fourth security review's finding 2: what this phone knows of each
        // paired computer, said as what it is. Not asked yet (nothing has been checked, which
        // is not "nothing is running"); checked, with the time and what the computer listed;
        // or no signed answer the last time the owner tapped. Nothing here asks by itself
        // (R-F5-1, R-F5-5).
        if (model.mode == AppMode.LIVE) {
            for (pin in model.nodes) {
                when (val check = model.leaseChecks[pin.id]) {
                    null -> Text(Leases.notCheckedYet(pin.name))
                    is AppModel.LeaseNodeCheck.Confirmed ->
                        Text(Leases.checked(pin.name, DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(check.atMs)), check.running, check.waiting))
                    is AppModel.LeaseNodeCheck.Unconfirmed -> Text(Leases.couldNotConfirm(pin.name), color = WARNING, fontWeight = FontWeight.Bold)
                }
            }
            if (model.nodes.any { model.leaseChecks[it.id] == null }) Text(Leases.NOT_CHECKED_YET_DETAIL + " Tap the button above to ask.")
            if (model.nodes.any { model.leaseChecks[it.id] is AppModel.LeaseNodeCheck.Unconfirmed }) Text(Leases.COULD_NOT_CONFIRM_DETAIL + " Tap the button above to ask again.", color = WARNING)
        }
        for (item in model.leaseRequests) {
            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Text(Display.escape(item.nodeName), fontWeight = FontWeight.Bold)
                if (item.request.isTake) Text("Take: ${Display.escape(item.request.name ?: "")}")
                else Text(if (item.request.isResume) "Resume computer use" else "Computer use: ${item.request.apps.joinToString(", ") { Display.escape(it.name) }}")
                Text("Job ${Display.escape(item.request.jobId)} · ${Display.escape(item.request.originClient)}")
                item.unconfirmed?.let { Text(it, color = WARNING) }
                OutlinedButton({ open(item) }) { Text("Review") }
            }
        }
    }
}

/** Exactly what the node signed: who asks, the agent's reason (unverified), each app with its path, and for how long. */
@Composable
fun LeaseRequestScreen(model: AppModel, item: AppModel.LeaseRequestItem, back: () -> Unit, done: () -> Unit) {
    var chosen by remember { mutableStateOf(item.request.apps.map { it.id }.toSet()) }
    var minutes by remember { mutableStateOf(item.request.maxMinutes) }
    val deciding = item.request.requestId in model.decidingLease
    val take = item.request.isTake
    LazyColumn(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            TextButton(back) { Text("Back") }
            if (take) {
                // A take, in this order: its name, unattended, how long, the sites and what it may do there,
                // the apps, the reason (then who asks).
                Text(Display.escape(item.request.name ?: ""), fontWeight = FontWeight.Bold)
                if (item.request.unattended) Text(UNATTENDED_LINE, color = WARNING)
                LeaseMinutes(item, minutes) { minutes = it }
                Text("Sites", fontWeight = FontWeight.Bold)
                for (site in item.request.sites) Text(Display.escape(site), fontFamily = FontFamily.Monospace)
                Text(item.request.browserActions?.joinToString(", ") { Display.escape(it) } ?: BROWSER_TRUE_LINE)
                if (item.request.credentials) Text(CREDENTIALS_LINE)
            } else {
                Text(Display.escape(item.nodeName), fontWeight = FontWeight.Bold)
                Text("Job ${Display.escape(item.request.jobId)} · asked by ${Display.escape(item.request.originClient)}")
                Text("Agent's reason (unverified)", fontWeight = FontWeight.Bold)
                Text(Display.escape(item.request.reason))
            }
            Text("Apps it may control", fontWeight = FontWeight.Bold)
        }
        items(item.request.apps) { app ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text(Display.escape(app.name))
                    Text(Display.escape(app.path), fontFamily = FontFamily.Monospace)
                    if (app.processes.isNotEmpty()) Text(app.processes.joinToString(", ") { Display.escape(it) }, fontFamily = FontFamily.Monospace)
                }
                Switch(checked = app.id in chosen, enabled = !item.request.isResume, onCheckedChange = { on -> chosen = if (on) chosen + app.id else chosen - app.id })
            }
        }
        item {
            if (take) {
                Text("Agent's reason (unverified)", fontWeight = FontWeight.Bold)
                Text(Display.escape(item.request.reason))
                Text(Display.escape(item.nodeName), fontWeight = FontWeight.Bold)
                Text("Job ${Display.escape(item.request.jobId)} · asked by ${Display.escape(item.request.originClient)}")
            } else {
                LeaseMinutes(item, minutes) { minutes = it }
            }
            for (limit in item.request.limits) Text(LIMIT_TEXT[limit] ?: Display.escape(limit), color = WARNING)
            item.unconfirmed?.let { Text(it, color = WARNING) }
            Text("Allow and Deny each ask for your fingerprint twice: once for the decision, once to send it.")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button({ model.decideLease(item, chosen, minutes, grant = true); done() }, enabled = chosen.isNotEmpty() && !deciding) { Text("Allow") }
                OutlinedButton({ model.decideLease(item, emptySet(), 1, grant = false); done() }, enabled = !deciding) { Text("Deny") }
            }
        }
    }
}

/** For how long: up to the request's own max_minutes, or the minutes a resume has left. */
@Composable
private fun LeaseMinutes(item: AppModel.LeaseRequestItem, minutes: Int, set: (Int) -> Unit) {
    if (item.request.isResume) {
        Text("The ${item.request.maxMinutes} min that were left; a resume never extends the lease.")
    } else {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton({ if (minutes > 1) set(minutes - 1) }) { Text("−") }
            Text("  $minutes min  ")
            OutlinedButton({ if (minutes < item.request.maxMinutes) set(minutes + 1) }) { Text("+") }
        }
    }
}

/** The lease as the last Refresh left it. It does not update by itself (R-F5-1). */
@Composable
fun LiveLeaseScreen(model: AppModel, close: () -> Unit) {
    val live = model.liveLease ?: return
    LazyColumn(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Text(Display.escape(live.nodeName), fontWeight = FontWeight.Bold)
            Text(if (live.locked) "locked" else Display.escape(live.state))
            live.expiresAtMs?.takeIf { live.state != "ended" }?.let { Text(formatLeft(maxOf(0L, it - System.currentTimeMillis()))) }
            val bitmap = live.frame?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            if (bitmap != null) Image(bitmap.asImageBitmap(), contentDescription = "The leased app's window", modifier = Modifier.fillMaxWidth())
            else Text("No frame loaded. Tap Refresh.")
            live.frameAtMs?.let { Text("Frame from ${formatLeft(maxOf(0L, System.currentTimeMillis() - it))} ago. This screen does not update by itself.") }
            if (live.frameDropped) Text("Frame dropped (too large)", color = WARNING)
            if (live.noFrame) Text("No frame arrived in ${Leases.REFRESH_WAIT_S} s. The leased app may not be in front. Tap Refresh to try again.", color = WARNING)
            live.unconfirmed?.let { Text(it, color = Color.Red, fontWeight = FontWeight.Bold) }
            // R-F5-18: a lease this phone did not grant says who did. Only that phone keeps it going.
            val grantedByOther = Leases.grantedByOther(live.grantedByDevice, live.grantedByName, model.deviceId)
            grantedByOther?.let { Text(it) }
            // R-F5-15: the node pauses input when the phone that granted the lease has not been in
            // touch. This screen sends nothing by itself (R-F5-1), so it says what the owner has to do.
            if (Leases.isPausedForContact(live.state, live.reason)) {
                if (grantedByOther == null) Text("Paused: tap Refresh to let it continue.", color = Color.Red, fontWeight = FontWeight.Bold)
                else Text("Paused: the phone that granted it has not been in touch. You can still stop it here.", color = Color.Red, fontWeight = FontWeight.Bold)
            } else if (live.state == "active" && grantedByOther == null) {
                Text("The computer pauses clicks and typing when this phone has not refreshed for about two minutes. Tap Refresh to keep it going.", color = WARNING)
            }
            live.reason?.takeIf { live.state != "active" }?.let { Text("Reason: ${Display.escape(it)}") }
            Button({ model.killSwitch() }, Modifier.fillMaxWidth(), enabled = !live.busy && live.state != "ended",
                colors = ButtonDefaults.buttonColors(containerColor = Color.Red)) { Text(if (live.busy) "Working…" else "Stop now") }
            if (model.mode == AppMode.LIVE) {
                OutlinedButton({ model.refreshLiveLease() }, enabled = !live.busy) { Text("Refresh") }
                Text("Stop asks for your fingerprint twice, Refresh three times (four when the last was over a minute ago). Nothing is sent until you tap.")
            }
            // Leaving the screen forgets only a lease that is over. One that is
            // still running keeps its banner, and so its Stop button, on every tab.
            if (live.state == "ended") OutlinedButton({ model.closeLiveLease(); close() }) { Text("Close") }
            else OutlinedButton(close) { Text("Back") }
            Text("Actions", fontWeight = FontWeight.Bold)
        }
        items(live.actions) { a -> Text("${Display.escape(a.summary)} · ${Display.escape(a.result)}") }
    }
}

/**
 * One row with the kill switch, above every tab, for every lease this phone
 * knows to be running (R-F5-18): the one on the live screen, and those a
 * pinned node listed with a signed status the last time the owner tapped
 * "Check for computer-use requests" (granted by another phone, or by this
 * one before a restart). A row of a lease another phone granted says who
 * granted it. Nothing here runs by itself.
 */
@Composable
fun LeaseBanner(model: AppModel, open: () -> Unit) {
    val live = model.liveLease?.takeIf { it.state != "ended" }
    Column {
        if (live != null) {
            Row(Modifier.fillMaxWidth().background(Color(0x22FF0000)).padding(8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    // A lease that is not running yet and may still start says so, in the words for what this phone
                    // knows of it: a grant it remembers signing, or only that its node says a request is waiting.
                    OutlinedButton(open) { Text(takeTitle(model.unattendedTake(live)) ?: if (live.state == "pending") model.pendingLeaseTitle(live.leaseId, live.nodeName) else "Lease ${if (live.state == "suspended") "paused" else "active"} on ${Display.escape(live.nodeName)}") }
                    if (live.state == "pending") Text(model.pendingLeaseDetail(live.leaseId))
                    Leases.grantedByOther(live.grantedByDevice, live.grantedByName, model.deviceId)?.let { Text(it) }
                }
                Button({ model.killSwitch() }, enabled = !live.busy, colors = ButtonDefaults.buttonColors(containerColor = Color.Red)) { Text("Stop") }
            }
        }
        for (lease in model.runningLeases) {
            // (The lease on the live screen has its row above.)
            if (lease.leaseId != live?.leaseId) {
                Row(Modifier.fillMaxWidth().background(Color(0x22FF0000)).padding(8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) {
                        OutlinedButton({ model.openRunningLease(lease); open() }) { Text(takeTitle(model.unattendedTake(lease)) ?: if (lease.state == "pending") model.pendingLeaseTitle(lease.leaseId, lease.nodeName) else "Lease ${if (lease.state == "suspended") "paused" else "active"} on ${Display.escape(lease.nodeName)}") }
                        if (lease.state == "pending") Text(model.pendingLeaseDetail(lease.leaseId))
                        Leases.grantedByOther(lease.grantedByDevice, lease.grantedByName, model.deviceId)?.let { Text(it) }
                    }
                    Button({ model.stopRunningLease(lease) }, colors = ButtonDefaults.buttonColors(containerColor = Color.Red)) { Text("Stop") }
                }
            }
        }
    }
}
