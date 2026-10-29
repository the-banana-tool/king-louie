package com.example.kinglouie

import android.content.Intent
import android.provider.Settings
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.kinglouie.protocol.AppMode
import com.example.kinglouie.protocol.Display
import com.example.kinglouie.protocol.FrontDoor
import com.example.kinglouie.protocol.Identifiers
import com.example.kinglouie.protocol.arr
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.str
import kotlinx.serialization.json.JsonElement

// Settings, the gear (android-slim §6.4): nodes, the relay, phones and this
// phone, on one scrolling screen. Its lists are read with the read key when
// it opens (no "Show" tap, R-AN-6). Every change it can make is the owner's
// tap, and every one that is signed asks for a fingerprint once.

/** Text the relay (not a pinned node) supplied, escaped like any display text. */
private fun relayText(value: JsonElement?): String = Display.escape(value.str() ?: "")

/** The gear's Notifications row (push spec §7.3). */
private fun notificationsText(row: AppModel.NotificationsRow): String = when (row) {
    AppModel.NotificationsRow.ON -> "Notifications: on"
    AppModel.NotificationsRow.OFF_IN_ANDROID -> "Notifications: off in Android settings"
    AppModel.NotificationsRow.NO_PUSH_BUILD -> "Notifications: this build has no push"
    AppModel.NotificationsRow.NO_RELAY_CREDENTIAL -> "Notifications: the relay has no push credential"
    AppModel.NotificationsRow.NOT_REGISTERED -> "Notifications: not registered yet"
    AppModel.NotificationsRow.NOT_ASKED -> "Notifications: the relay could not be asked"
}

/** Front-door text, capped and escaped by the core. */
private fun fdText(value: JsonElement?, max: Int = FrontDoor.SHOWN_TEXT_MAX): String = FrontDoor.shownText(value.str(), max)

@Composable
fun SettingsScreen(model: AppModel, back: () -> Unit, openScanner: () -> Unit) {
    // Read when it opens, and again once the read key is set up.
    LaunchedEffect(model.readKeySetupNeeded) { model.refreshSettings() }
    var forget by remember { mutableStateOf<AppModel.SettingsNode?>(null) }
    var resetAsked by remember { mutableStateOf(false) }
    val live = model.mode == AppMode.LIVE
    val context = LocalContext.current

    // Remove (C-15): forgets the pin on this phone and sends nothing.
    forget?.let { n ->
        val name = Display.escape(n.pin.name)
        AlertDialog(
            onDismissRequest = { forget = null },
            title = { Text("Remove $name?") },
            text = { Text("This phone forgets $name and stops showing its requests. Nothing is sent: $name still counts this phone as an approver until its administrator revokes it.") },
            confirmButton = { TextButton({ forget = null; model.forgetNode(n.pin.id) }) { Text("Remove", color = KlTokens.error) } },
            dismissButton = { TextButton({ forget = null }) { Text("Cancel") } }
        )
    }
    if (resetAsked) {
        AlertDialog(
            onDismissRequest = { resetAsked = false },
            title = { Text("Reset this phone?") },
            text = { Text("This deletes both of this phone's keys and every pin. To approve again, pair it again. The nodes still list it as an approver until their administrators revoke it.") },
            confirmButton = { TextButton({ resetAsked = false; model.reset(); openScanner() }) { Text("Reset", color = KlTokens.error) } },
            dismissButton = { TextButton({ resetAsked = false }) { Text("Cancel") } }
        )
    }

    Column(Modifier.fillMaxSize()) {
        BackBar("Settings", back)
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            // Without the read key the lists are not read (no fingerprint fallback, C-19): the set-up
            // line, and below it what this phone knows itself (pins, fingerprints, Reset).
            if (model.readKeySetupNeeded) {
                item {
                    ItemCard {
                        Text(AppModel.SETTINGS_READ_KEY_LINE, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Button({ model.setUpReadKey() }, Modifier.fillMaxWidth().height(DecisionHeight).padding(top = 4.dp), enabled = !model.readKeySetupBusy,
                            shape = RoundedCornerShape(KlTokens.radiusMd), colors = approveColors()) {
                            Text(AppModel.READ_KEY_SETUP_TITLE, style = MaterialTheme.typography.labelLarge)
                        }
                    }
                }
            }
            // ---- Nodes ----
            item { SectionTitle("Nodes") }
            val nodes = model.settingsNodes()
            if (nodes.isEmpty()) item { EmptyState("No node is paired yet. Scan a node's code on the Scanner.") }
            items(nodes, key = { it.pin.id }) { n ->
                ItemCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(Display.escape(n.pin.name), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        OnlineDot(n.online)
                    }
                    Text(n.fingerprint, style = MonoStyle)
                    when (n.readKey) {
                        AppModel.ReadKeyNodeState.IN_USE -> Secondary("Read key: read key in use")
                        AppModel.ReadKeyNodeState.WAITING_FOR_APPLY -> Text("Read key: waiting for `device apply` on the node", color = statusColors.warning)
                        AppModel.ReadKeyNodeState.NOT_SENT -> {
                            Text("Read key: not sent yet", color = statusColors.warning)
                            if (live) TextButton({ model.sendReadKeyAgain() }, enabled = !model.readKeySetupBusy) { Text("Send again") }
                        }
                    }
                    Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton({ forget = n }, shape = RoundedCornerShape(KlTokens.radiusMd)) { Text("Remove") }
                        if (n.removableFromFrontDoor) {
                            OutlinedButton({ model.removeNode(n.pin.id, n.pin.name) }, enabled = !model.frontDoorBusy, shape = RoundedCornerShape(KlTokens.radiusMd),
                                colors = denyColors(), border = denyBorder(!model.frontDoorBusy)) { Text("Remove from front door") }
                        }
                    }
                }
            }

            // ---- Relay, and the front door's connected clients ----
            item {
                SectionTitle("Relay")
                Text(model.relayUrl?.let { Display.escape(it) } ?: "Not paired")
                model.relaySpki?.let { CodeBlock(it) }
                OutlinedButton(openScanner, Modifier.fillMaxWidth().padding(top = 4.dp), shape = RoundedCornerShape(KlTokens.radiusMd)) { Text("Re-pin: scan a relay code") }
            }
            model.frontDoorId?.let { fd ->
                item {
                    Text("Front door ${FrontDoor.nodeFingerprint(fd)}", style = MonoStyle)
                    SectionTitle("Connected clients")
                    if (model.clients.isEmpty()) Secondary("No client is connected.")
                }
                items(model.clients) { g ->
                    val name = g["client_name"].str() ?: ""
                    val grantId = g["grant_id"].str()
                    ItemCard {
                        Text("${FrontDoor.shownText(name)} (self-declared)", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Text(fdText(g["client_host"]))
                        Text(g["scopes"].arr().orEmpty().take(FrontDoor.SHOWN_TEXT_MAX).joinToString(", ") { fdText(it, 64) }, style = MonoStyle)
                        Secondary("Last used ${fdText(g["last_used_at"], 40).ifEmpty { "never" }}")
                        if (grantId != null) {
                            OutlinedButton({ model.revokeClient(grantId, name) }, enabled = !model.frontDoorBusy, shape = RoundedCornerShape(KlTokens.radiusMd),
                                colors = denyColors(), border = denyBorder(!model.frontDoorBusy)) { Text("Revoke") }
                        }
                    }
                }
            }

            // ---- Phones ----
            item {
                SectionTitle("Phones")
                ItemCard {
                    Text("This phone", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text(model.deviceFingerprint ?: "No key yet", style = MonoStyle)
                    Text(model.readKeyFingerprint?.let { "Read key $it" } ?: "No read key yet", style = MonoStyle, color = KlTokens.textSecondary)
                }
            }
            val others = model.devices.filter { it["device_id"].str() != model.deviceId }
            items(others) { d ->
                val id = d["device_id"].str() ?: ""
                val name = relayText(d["name"])
                ItemCard {
                    Text("$name (${relayText(d["platform"])})", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text("d-" + Identifiers.fingerprintGroups(Display.escape(id)), style = MonoStyle)
                    d["nodes"].arr().orEmpty().forEach { n -> Secondary("${relayText(n["node_id"])}: ${relayText(n["state"])}") }
                    if (id.isNotEmpty() && live) {
                        OutlinedButton({ model.revoke(id, name) }, shape = RoundedCornerShape(KlTokens.radiusMd), colors = denyColors(), border = denyBorder(true)) { Text("Revoke") }
                    }
                }
            }
            // Add another phone (C-14): the claim is polled with the read key while the QR is on screen; the owner compares the two screens.
            item {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    val claim = model.inviteClaim
                    val qr = model.inviteQr
                    if (qr == null && claim == null) {
                        Button({ model.startInvite() }, Modifier.fillMaxWidth().height(DecisionHeight), enabled = live,
                            shape = RoundedCornerShape(KlTokens.radiusMd), colors = approveColors()) { Text("Add another phone", style = MaterialTheme.typography.labelLarge) }
                    }
                    qr?.let {
                        QrImage(it)
                        Text("Scan this with the new phone. Its id appears here when it has.")
                        TextButton({ model.cancelInvite() }) { Text("Cancel") }
                    }
                    claim?.let { device ->
                        Text("New phone ${relayText(device["name"])}:", fontWeight = FontWeight.Bold)
                        CodeBlock("d-" + Identifiers.fingerprintGroups(device["device_id"].str() ?: ""))
                        Text("Check the new phone shows the same id.")
                        Button({ model.confirmInvited() }, Modifier.fillMaxWidth().height(DecisionHeight),
                            shape = RoundedCornerShape(KlTokens.radiusMd), colors = approveColors()) { Text("It shows the same — add it", style = MaterialTheme.typography.labelLarge) }
                        TextButton({ model.cancelInvite() }) { Text("Cancel") }
                    }
                }
            }

            // ---- This phone ----
            item {
                SectionTitle("This phone")
                model.notifications?.let { row ->
                    Text(notificationsText(row), Modifier.padding(bottom = 4.dp))
                    if (row == AppModel.NotificationsRow.OFF_IN_ANDROID) {
                        OutlinedButton({
                            context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                        }, Modifier.fillMaxWidth().padding(bottom = 8.dp), shape = RoundedCornerShape(KlTokens.radiusMd)) { Text("Open notification settings") }
                    }
                }
                OutlinedButton({ resetAsked = true }, Modifier.fillMaxWidth(), shape = RoundedCornerShape(KlTokens.radiusMd), colors = denyColors(), border = denyBorder(true)) {
                    Text("Reset this phone")
                }
                Secondary("No analytics. The relay sees every action you are asked to approve, and when this app is open. See PRIVACY.md.", Modifier.padding(top = 8.dp))
            }
        }
    }
}
