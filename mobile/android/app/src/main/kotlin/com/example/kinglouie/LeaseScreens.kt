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

// Fleet stage 5 §3.10 on this phone (owner rulings R-F5-1, R-F5-5, R-F5-6):
// nothing on these screens runs by itself. The model is called only from a
// button the owner taps, and every text shown comes from a message a pinned
// node signed, escaped. tests/mobile-lease-apps.test.js reads this file.

private val LIMIT_TEXT = mapOf(
    "no_lock_detect" to "This computer cannot detect a locked screen.",
    "no_human_yield" to "This computer cannot detect your own typing, so it will not pause for you."
)
private val WARNING = Color(0xFFB26A00)

/** Lease requests in the Pending tab. Nothing is fetched until the owner taps (R-F5-1, R-F5-6). */
@Composable
fun LeaseRequests(model: AppModel, open: (AppModel.LeaseRequestItem) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Computer use", fontWeight = FontWeight.Bold)
        if (model.leaseNotice) Text("A computer-use request arrived. Tap the button below to load it.", color = WARNING)
        if (model.mode == AppMode.LIVE) {
            OutlinedButton({ model.refreshLeases() }, enabled = !model.isLoadingLeases) { Text(if (model.isLoadingLeases) "Checking…" else "Check for computer-use requests") }
        }
        for (item in model.leaseRequests) {
            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Text(Display.escape(item.nodeName), fontWeight = FontWeight.Bold)
                Text(if (item.request.isResume) "Resume computer use" else "Computer use: ${item.request.apps.joinToString(", ") { Display.escape(it.name) }}")
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
    LazyColumn(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            TextButton(back) { Text("Back") }
            Text(Display.escape(item.nodeName), fontWeight = FontWeight.Bold)
            Text("Job ${Display.escape(item.request.jobId)} · asked by ${Display.escape(item.request.originClient)}")
            Text("Agent's reason (unverified)", fontWeight = FontWeight.Bold)
            Text(Display.escape(item.request.reason))
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
            if (item.request.isResume) {
                Text("The ${item.request.maxMinutes} min that were left; a resume never extends the lease.")
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedButton({ if (minutes > 1) minutes -= 1 }) { Text("−") }
                    Text("  $minutes min  ")
                    OutlinedButton({ if (minutes < item.request.maxMinutes) minutes += 1 }) { Text("+") }
                }
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
            live.reason?.takeIf { live.state != "active" }?.let { Text("Reason: ${Display.escape(it)}") }
            Button({ model.killSwitch() }, Modifier.fillMaxWidth(), enabled = !live.busy && live.state != "ended",
                colors = ButtonDefaults.buttonColors(containerColor = Color.Red)) { Text(if (live.busy) "Working…" else "Stop now") }
            if (model.mode == AppMode.LIVE) {
                OutlinedButton({ model.refreshLiveLease() }, enabled = !live.busy) { Text("Refresh") }
                Text("Stop asks for your fingerprint twice, Refresh three times. Nothing is sent until you tap.")
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

/** "Lease active on <node>" with the kill switch, above every tab. */
@Composable
fun LeaseBanner(model: AppModel, open: () -> Unit) {
    val live = model.liveLease ?: return
    if (live.state == "ended") return
    Row(Modifier.fillMaxWidth().background(Color(0x22FF0000)).padding(8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        OutlinedButton(open) { Text("Lease active on ${Display.escape(live.nodeName)}") }
        Button({ model.killSwitch() }, enabled = !live.busy, colors = ButtonDefaults.buttonColors(containerColor = Color.Red)) { Text("Stop") }
    }
}
