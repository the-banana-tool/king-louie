package com.example.kinglouie

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.kinglouie.protocol.AppMode
import com.example.kinglouie.protocol.Display
import com.example.kinglouie.protocol.Identifiers
import com.example.kinglouie.protocol.arr
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.int
import com.example.kinglouie.protocol.obj
import com.example.kinglouie.protocol.str
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonElement

/** Text the relay (not a pinned node) supplied, escaped like any display text. */
private fun relayText(value: JsonElement?): String = Display.escape(value.str() ?: "")

@Composable
fun Root(model: AppModel) {
    MaterialTheme {
        model.banner?.let { text ->
            AlertDialog(onDismissRequest = { model.banner = null }, confirmButton = { TextButton({ model.banner = null }) { Text("OK") } }, text = { Text(text) })
        }
        if (model.mode == AppMode.WELCOME) Welcome(model) else Main(model)
    }
}

@Composable
fun ScanOrPaste(model: AppModel, onDone: () -> Unit) {
    var pasted by remember { mutableStateOf("") }
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        QrScanner(Modifier.fillMaxWidth().height(320.dp)) { code -> onDone(); model.scanned(code) }
        OutlinedTextField(pasted, { pasted = it }, label = { Text("Or paste a kl1: code") }, modifier = Modifier.fillMaxWidth())
        Button(onClick = { onDone(); model.scanned(pasted) }, enabled = pasted.isNotBlank()) { Text("Use pasted code") }
        TextButton(onDone) { Text("Cancel") }
    }
}

@Composable
fun Welcome(model: AppModel) {
    var scanning by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("King Louie", style = MaterialTheme.typography.headlineLarge)
        Text("Approve what your machines want to do, with your fingerprint or face.")
        if (scanning) ScanOrPaste(model) { scanning = false } else {
            Button({ scanning = true }) { Text("Scan pairing code") }
            OutlinedButton({ model.startDemo() }) { Text("Try demo") }
        }
    }
}

@Composable
fun Main(model: AppModel) {
    var tab by remember { mutableStateOf(0) }
    val tabs = listOf("Pending", "Questions", "History", "Nodes", "Devices", "Settings")
    Scaffold(bottomBar = {
        NavigationBar {
            tabs.forEachIndexed { i, label -> NavigationBarItem(selected = tab == i, onClick = { tab = i }, icon = {}, label = { Text(label) }) }
        }
    }) { padding ->
        Column(Modifier.padding(padding)) {
            if (model.mode == AppMode.DEMO) {
                Text("Demo — nothing here reaches a real machine", Modifier.fillMaxWidth().background(Color.Yellow).padding(6.dp), fontWeight = FontWeight.Bold)
            }
            model.fingerprintToCompare?.let { Text("This phone: $it — check the other screen shows the same.", Modifier.padding(6.dp), fontFamily = FontFamily.Monospace) }
            when (tab) {
                0 -> Pending(model)
                1 -> Questions(model)
                2 -> History(model)
                3 -> Nodes(model)
                4 -> Devices(model)
                else -> Settings(model)
            }
        }
    }
}

fun formatLeft(ms: Long): String = "%d:%02d".format(ms / 60000, (ms / 1000) % 60)

@Composable
fun ticker(): Long {
    var now by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now += 1 } }
    return now
}

@Composable
fun Pending(model: AppModel) {
    var open by remember { mutableStateOf<String?>(null) }
    ticker()
    val item = model.pending.firstOrNull { it.id == open }
    if (item != null) {
        Detail(model, item) { open = null }
        return
    }
    Column(Modifier.padding(12.dp)) {
        if (model.mode == AppMode.LIVE) {
            Button({ model.checkNow() }, enabled = !model.isPolling) { Text(if (model.isPolling) "Checking…" else "Check for requests") }
        }
        model.pollProblem?.let { Text(it, Modifier.padding(top = 8.dp), color = Color.Gray) }
        if (model.pending.isEmpty()) Text("Nothing is waiting for you.", Modifier.padding(top = 12.dp))
        LazyColumn {
            items(model.pending, key = { it.id }) { p ->
                Column(Modifier.fillMaxWidth().clickable { open = p.id }.padding(vertical = 8.dp)) {
                    Text(p.display["node"]["name"].str() ?: "", fontWeight = FontWeight.Bold)
                    Text(p.display["summary"].str() ?: "", maxLines = 2)
                    Row { Text(p.display["origin"]["client"].str() ?: ""); Text("   " + (p.status ?: formatLeft(p.timeLeftMs))) }
                }
                HorizontalDivider()
            }
        }
    }
}

/** Every parameter, command-like values whole or head + tail, hidden characters as ‹U+XXXX›. */
@Composable
fun Detail(model: AppModel, item: PendingItem, onBack: () -> Unit) {
    ticker()
    var expanded by remember { mutableStateOf(setOf<String>()) }
    LazyColumn(Modifier.padding(12.dp)) {
        item {
            TextButton(onBack) { Text("Back") }
            Text(item.display["node"]["name"].str() ?: "", style = MaterialTheme.typography.titleLarge)
            Text(item.display["node"]["id"].str() ?: "", fontFamily = FontFamily.Monospace)
            Text(item.display["summary"].str() ?: "", Modifier.padding(vertical = 8.dp))
            Text("Kind: ${item.display["kind"].str()}   Name: ${item.display["name"].str()}")
            item.display["cwd"].str()?.let { Text("Directory: $it") }
            Text("Asked by: " + (item.display["origin"].obj()?.let { o -> listOf("client", "session", "job_id", "deviceId").mapNotNull { o[it].str() }.joinToString(" · ") } ?: ""))
            Text("Time left: ${formatLeft(item.timeLeftMs)}")
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
        }
        items(item.display["items"].arr().orEmpty()) { entry: JsonElement ->
            val path = entry["path"].str() ?: ""
            val hidden = entry["hidden"].int() ?: 0
            Column(Modifier.padding(vertical = 4.dp)) {
                Text(path, fontFamily = FontFamily.Monospace, color = Color.Gray)
                SelectionContainer {
                    if (hidden > 0 && path in expanded) Text(item.fullText[path] ?: "", fontFamily = FontFamily.Monospace)
                    else Text(entry["text"].str() ?: "", fontFamily = FontFamily.Monospace)
                }
                if (hidden > 0 && path !in expanded) {
                    TextButton({ expanded = expanded + path }) { Text("$hidden characters hidden — Show all") }
                    Text(entry["tail"].str() ?: "", fontFamily = FontFamily.Monospace)
                }
            }
        }
        item {
            val status = item.status
            if (status != null) Text("Status: $status", Modifier.padding(top = 12.dp))
            else Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 12.dp)) {
                val open = item.timeLeftMs > 0 && !item.deciding
                Button({ model.decide(item, true) }, enabled = open) { Text("Approve") }
                OutlinedButton({ model.decide(item, false) }, enabled = open) { Text("Deny") }
            }
            // The node-signed status on demand: one tap, one signed fetch.
            if (model.mode == AppMode.LIVE) TextButton({ model.openPushed(item.id) }) { Text("Refresh status") }
        }
    }
}

@Composable
fun History(model: AppModel) {
    Column(Modifier.padding(12.dp)) {
        model.nodes.forEach { n -> TextButton({ model.loadHistory(n.id) }) { Text(Display.escape(n.name)) } }
        model.history?.let { (asOf, entries) ->
            Text("As of ${Display.escape(asOf)}", fontWeight = FontWeight.Bold)
            LazyColumn {
                items(entries) { e ->
                    Text("#${e["seq"].int()} ${relayText(e["kind"])} · ${relayText(e["at"])} · ${relayText(e["writer"])}", Modifier.padding(vertical = 4.dp))
                }
            }
        }
    }
}

@Composable
fun Nodes(model: AppModel) {
    var name by remember { mutableStateOf("") }
    var code by remember { mutableStateOf<String?>(null) }
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // Each relay request is a biometric prompt on this phone, so it is asked for, never automatic.
        if (model.mode == AppMode.LIVE) OutlinedButton({ model.refreshNodes() }) { Text("Refresh online state") }
        model.nodes.forEach { n ->
            Text("${Display.escape(n.name)}  ${if (model.online[n.id] == true) "online" else "offline"}", fontWeight = FontWeight.Bold)
            Text(Identifiers.fingerprintGroups(n.id), fontFamily = FontFamily.Monospace)
        }
        Text("Pairing code for a new node", fontWeight = FontWeight.Bold)
        OutlinedTextField(name, { name = it }, label = { Text("Node name, e.g. gpu-box") })
        Button({ model.pairingCode(name) { code = it } }, enabled = name.isNotBlank() && model.mode == AppMode.LIVE) { Text("Get code") }
        code?.let { SelectionContainer { Text(it, fontFamily = FontFamily.Monospace) } }
    }
}

@Composable
fun QrImage(text: String) {
    val matrix = remember(text) { QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 600, 600) }
    val bitmap = remember(matrix) {
        Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.RGB_565).also { b ->
            for (x in 0 until matrix.width) for (y in 0 until matrix.height) b.setPixel(x, y, if (matrix[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
        }
    }
    Image(bitmap.asImageBitmap(), contentDescription = "Invite code", modifier = Modifier.fillMaxWidth().height(280.dp))
}

@Composable
fun Devices(model: AppModel) {
    LazyColumn(Modifier.padding(12.dp)) {
        item {
            model.deviceId?.let { Text("This phone: d-" + Identifiers.fingerprintGroups(it), fontFamily = FontFamily.Monospace) }
            // Each relay request is a biometric prompt on this phone, so it is asked for, never automatic.
            if (model.mode == AppMode.LIVE) OutlinedButton({ model.refreshDevices() }) { Text("Show devices") }
        }
        items(model.devices) { d ->
            val id = d["device_id"].str() ?: ""
            val name = relayText(d["name"])
            Column(Modifier.padding(vertical = 6.dp)) {
                Text("$name (${relayText(d["platform"])})")
                Text("d-" + Identifiers.fingerprintGroups(Display.escape(id)), fontFamily = FontFamily.Monospace)
                d["nodes"].arr().orEmpty().forEach { n -> Text("${relayText(n["node_id"])}: ${relayText(n["state"])}") }
                if (id.isNotEmpty() && id != model.deviceId && model.mode == AppMode.LIVE) TextButton({ model.revoke(id, name) }) { Text("Revoke") }
            }
        }
        item {
            Button({ model.startInvite() }, enabled = model.mode == AppMode.LIVE) { Text("Add a device") }
            model.inviteQr?.let {
                QrImage(it)
                Text("Scan this with the new phone, then tap below.")
                OutlinedButton({ model.checkInvite() }) { Text("The new phone has scanned it") }
            }
            model.inviteClaim?.let { device ->
                Text("New phone ${relayText(device["name"])}: d-${Identifiers.fingerprintGroups(device["device_id"].str() ?: "")}", fontFamily = FontFamily.Monospace)
                Button({ model.confirmInvited() }) { Text("It shows the same — add it") }
                TextButton({ model.inviteClaim = null }) { Text("Cancel") }
            }
        }
    }
}

@Composable
fun Settings(model: AppModel) {
    var scanning by remember { mutableStateOf(false) }
    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Relay: ${model.relayUrl?.let { Display.escape(it) } ?: "not paired"}")
        Text(model.relaySpki ?: "", fontFamily = FontFamily.Monospace)
        if (scanning) ScanOrPaste(model) { scanning = false } else OutlinedButton({ scanning = true }) { Text("Re-pin the relay (scan a relay code)") }
        if (model.mode == AppMode.DEMO) Button({ model.leaveDemo() }) { Text("Leave demo") }
        OutlinedButton({ model.reset() }) { Text("Reset this phone") }
        Text("No analytics. The relay sees every action you are asked to approve; see PRIVACY.md.")
    }
}
