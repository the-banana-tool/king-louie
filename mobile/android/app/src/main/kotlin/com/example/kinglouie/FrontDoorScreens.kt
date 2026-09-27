package com.example.kinglouie

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.kinglouie.protocol.AppMode
import com.example.kinglouie.protocol.AuditStatus
import com.example.kinglouie.protocol.FrontDoor
import com.example.kinglouie.protocol.Jcs
import com.example.kinglouie.protocol.ScopeChoice
import com.example.kinglouie.protocol.arr
import com.example.kinglouie.protocol.bool
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.str
import kotlinx.serialization.json.JsonElement

/**
 * Front-door or client text as shown: capped and escaped by the core
 * (FrontDoor.shownText). Compose's Text shows it as plain text: never markup,
 * and never a link that opens by itself.
 */
private fun fdText(value: JsonElement?, max: Int = FrontDoor.SHOWN_TEXT_MAX): String = FrontDoor.shownText(value.str(), max)

/**
 * Fleet stage 4 §3.15. Each list is fetched when the owner taps: on this phone
 * every device-signed request is a biometric prompt (Deviation 30).
 */
@Composable
fun FrontDoor(model: AppModel) {
    var screen by remember { mutableStateOf("menu") }
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (model.frontDoorId == null) {
            Text("This phone is not paired with a front door.")
            OutlinedButton({ model.refreshFrontDoor() }, enabled = model.mode == AppMode.LIVE) { Text("Check again") }
            return@Column
        }
        if (screen != "menu") TextButton({ screen = "menu"; model.cancelGrant() }) { Text("Back") }
        when (screen) {
            "connect" -> ConnectClient(model)
            "clients" -> Clients(model)
            "pairings" -> Pairings(model)
            "nodes" -> FrontDoorNodes(model)
            "alerts" -> Alerts(model)
            else -> {
                Button({ screen = "connect" }) { Text("Connect a client") }
                OutlinedButton({ screen = "clients"; model.refreshClients() }) { Text("Connected clients") }
                OutlinedButton({ screen = "pairings"; model.refreshPairings() }) { Text("Nodes waiting for you") }
                OutlinedButton({ screen = "nodes"; model.refreshFrontDoorNodes() }) { Text("Nodes") }
                OutlinedButton({ screen = "alerts"; model.refreshAlerts() }) { Text("Alerts") }
            }
        }
    }
}

@Composable
fun ConnectClient(model: AppModel) {
    var code by remember { mutableStateOf("") }
    var enabled by remember { mutableStateOf(setOf<String>()) }
    var limits by remember { mutableStateOf(mapOf<String, Set<String>>()) }
    val request = model.grantRequest
    // A new request starts from what the front door preselected (only scopes it requested), with no machine limits.
    LaunchedEffect(request) {
        enabled = request?.preselected?.toSet() ?: emptySet()
        limits = emptyMap()
        if (request == null) code = ""
    }
    if (request == null) {
        Text("The code the client's browser shows", fontWeight = FontWeight.Bold)
        OutlinedTextField(code, { code = it.take(16) }, label = { Text("XXX-XXX") }, singleLine = true)
        Button({ model.findGrant(code) }, enabled = code.isNotBlank() && model.mode == AppMode.LIVE) { Text("Find the request") }
        return
    }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item {
            Text("${FrontDoor.shownText(request.clientName)} (self-declared)", fontWeight = FontWeight.Bold)
            Text("Client host: ${FrontDoor.shownText(request.clientHost)}")
            Text("Returns to: ${FrontDoor.shownText(request.redirectHost)}")
            HorizontalDivider(Modifier.padding(vertical = 6.dp))
        }
        // Only the scopes this client asked for.
        items(request.requestedScopes) { scope ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(scope in enabled, { on -> enabled = if (on) enabled + scope else enabled - scope })
                Text(FrontDoor.shownText(scope), fontFamily = FontFamily.Monospace)
            }
            if (scope in enabled && scope != "fleet:unsafe") {
                model.machineChoices.forEach { (name, limitable) ->
                    Row(Modifier.padding(start = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                        val chosen = limits[scope].orEmpty()
                        Checkbox(name in chosen, { on -> limits = limits + (scope to (if (on) chosen + name else chosen - name)) }, enabled = limitable)
                        Text("Only ${FrontDoor.shownText(name)}", color = if (limitable) Color.Unspecified else Color.Gray)
                    }
                }
            }
        }
        item {
            Text("With no machine chosen, the client may use every machine. Unsafe actions still need your phone each time.")
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 8.dp)) {
                // Exactly the scopes switched on, in the order requested, each with its machine limit.
                val scopes = request.requestedScopes.filter { it in enabled }
                    .map { s -> ScopeChoice(s, if (s == "fleet:unsafe") null else limits[s]?.takeIf { it.isNotEmpty() }?.toList()) }
                Button({ model.decideGrant(request, scopes, true) }, enabled = enabled.isNotEmpty() && !model.frontDoorBusy) { Text("Approve") }
                OutlinedButton({ model.decideGrant(request, emptyList(), false) }, enabled = !model.frontDoorBusy) { Text("Deny") }
            }
        }
    }
}

@Composable
fun Clients(model: AppModel) {
    if (model.clients.isEmpty()) Text("No client is connected.")
    LazyColumn {
        items(model.clients) { g ->
            val name = g["client_name"].str() ?: ""
            val grantId = g["grant_id"].str()
            Column(Modifier.padding(vertical = 6.dp)) {
                Text("${FrontDoor.shownText(name)} (self-declared)", fontWeight = FontWeight.Bold)
                Text(fdText(g["client_host"]))
                Text(g["scopes"].arr().orEmpty().take(FrontDoor.SHOWN_TEXT_MAX).joinToString(", ") { fdText(it, 64) }, fontFamily = FontFamily.Monospace)
                Text("Last used ${fdText(g["last_used_at"], 40).ifEmpty { "never" }}", color = Color.Gray)
                if (grantId != null) TextButton({ model.revokeClient(grantId, name) }, enabled = !model.frontDoorBusy) { Text("Revoke") }
            }
            HorizontalDivider()
        }
    }
}

@Composable
fun Pairings(model: AppModel) {
    OutlinedButton({ model.refreshPairings() }) { Text("Check for nodes") }
    if (model.pairings.isEmpty()) Text("No node is waiting. Give the node its code, then run pair on it.")
    LazyColumn {
        items(model.pairings, key = { it.pairingId }) { p ->
            Column(Modifier.padding(vertical = 6.dp)) {
                // The core checked the name's alphabet and that the id derives from the key.
                Text("${FrontDoor.shownText(p.nodeName)} (${p.profile})", fontWeight = FontWeight.Bold)
                Text(p.fingerprint, fontFamily = FontFamily.Monospace)
                Text("Check the node's console shows the same fingerprint.")
                p.replaces?.let { Text("Replaces ${FrontDoor.nodeFingerprint(it)}", color = Color(0xFFE65100)) }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button({ model.decidePairing(p, true) }, enabled = !model.frontDoorBusy) { Text("Approve") }
                    OutlinedButton({ model.decidePairing(p, false) }, enabled = !model.frontDoorBusy) { Text("Deny") }
                }
            }
            HorizontalDivider()
        }
    }
}

@Composable
fun FrontDoorNodes(model: AppModel) {
    OutlinedButton({ model.refreshFrontDoorNodes() }) { Text("Refresh") }
    if (model.frontDoorNodes.isEmpty()) Text("No node is enrolled with this front door.")
    LazyColumn {
        items(model.frontDoorNodes) { n ->
            val id = n["node_id"].str() ?: ""
            val name = n["node_name"].str() ?: ""
            Column(Modifier.padding(vertical = 6.dp)) {
                Text("${FrontDoor.shownText(name, 64)}  ${if (n["online"].bool() == true) "online" else "offline"}", fontWeight = FontWeight.Bold)
                Text(FrontDoor.shownText(FrontDoor.nodeFingerprint(id), 64), fontFamily = FontFamily.Monospace)
                Text("${fdText(n["profile"], 32)} · confirmed at the ${fdText(n["source"], 32)} · audit ${fdText(n["audit"], 32)}")
                if (n["source"].str() == "phone" && id.isNotEmpty()) TextButton({ model.removeNode(id, name) }, enabled = !model.frontDoorBusy) { Text("Remove") }
            }
            HorizontalDivider()
        }
    }
}

@Composable
fun Alerts(model: AppModel) {
    OutlinedButton({ model.refreshAlerts() }) { Text("Refresh") }
    if (model.alerts.isEmpty()) Text("No alerts.")
    LazyColumn {
        items(model.alerts.reversed()) { a ->
            val id = a["id"].str()
            Column(Modifier.padding(vertical = 6.dp)) {
                Text(fdText(a["kind"], 64), fontWeight = FontWeight.Bold)
                Text(fdText(a["subject"]), fontFamily = FontFamily.Monospace)
                Text(FrontDoor.shownText(a["detail"]?.let { Jcs.serialize(it) }, 400), fontFamily = FontFamily.Monospace)
                Text(fdText(a["at"], 40), color = Color.Gray)
                if (a["acked"].bool() != true && id != null) TextButton({ model.ackAlert(id) }, enabled = !model.frontDoorBusy) { Text("Acknowledge") }
            }
            HorizontalDivider()
        }
    }
}

/** A break reason code in words; codes this app does not know are shown as they are, never as a clean history. */
fun auditBreakWords(reason: String?): String = when (reason) {
    "fork" -> "the node's history forked from what the front door holds"
    "withheld_entries" -> "the node withheld entries"
    "oversize_entry" -> "an entry too large to check"
    null -> "a reason this app cannot read"
    else -> "reason $reason"
}

/** The front door's gap and break records for one node's history ("reported by front door"). */
@Composable
fun FrontDoorAudit(status: AuditStatus) {
    if (!status.broken && status.gapCount == 0) return
    Text("Reported by front door", fontWeight = FontWeight.Bold)
    status.breaks.forEach { b -> Text("Break at #${b.seq ?: "?"}: ${auditBreakWords(b.reason)}", color = Color.Red) }
    if (status.gapCount > 0) Text("${status.gapCount} gap(s) in the front door's copy of this history")
}
