package com.example.kinglouie

import android.graphics.Bitmap
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.kinglouie.protocol.AppMode
import com.example.kinglouie.protocol.Display
import com.example.kinglouie.protocol.FrontDoor
import com.example.kinglouie.protocol.Identifiers
import com.example.kinglouie.protocol.arr
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.int
import com.example.kinglouie.protocol.obj
import com.example.kinglouie.protocol.str
import com.example.kinglouie.push.Push
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonElement

/** Text the relay (not a pinned node) supplied, escaped like any display text. */
private fun relayText(value: JsonElement?): String = Display.escape(value.str() ?: "")

@Composable
fun Root(model: AppModel) {
    // KingLouieTheme (MainActivity) supplies the colours; the Surface paints the background under every screen.
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        model.banner?.let { text ->
            AlertDialog(onDismissRequest = { model.banner = null }, confirmButton = { TextButton({ model.banner = null }) { Text("OK") } }, text = { Text(text) })
        }
        if (model.mode == AppMode.WELCOME) Welcome(model) else Main(model)
    }
}

@Composable
fun ScanOrPaste(model: AppModel, onDone: () -> Unit) {
    var pasted by remember { mutableStateOf("") }
    Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        QrScanner(Modifier.fillMaxWidth().height(320.dp)) { code -> onDone(); model.scanned(code) }
        OutlinedTextField(pasted, { pasted = it }, label = { Text("Or paste a kl1: code") }, modifier = Modifier.fillMaxWidth())
        Button({ onDone(); model.scanned(pasted) }, Modifier.fillMaxWidth().height(DecisionHeight), enabled = pasted.isNotBlank()) { Text("Use pasted code") }
        OutlinedButton(onDone, Modifier.fillMaxWidth()) { Text("Cancel") }
    }
}

@Composable
fun Welcome(model: AppModel) {
    var scanning by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text("King Louie", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
        Text("Approve what your machines want to do, with your fingerprint or face.", style = MaterialTheme.typography.titleMedium)
        if (scanning) ScanOrPaste(model) { scanning = false } else {
            Button({ scanning = true }, Modifier.fillMaxWidth().height(DecisionHeight)) { Text("Scan pairing code") }
            OutlinedButton({ model.startDemo() }, Modifier.fillMaxWidth().height(DecisionHeight)) { Text("Try demo") }
        }
    }
}

/** The four places a person approving on the move needs; Approvals is always one tap away. */
private enum class Tab(val label: String, val icon: ImageVector) {
    APPROVALS("Approvals", Icons.Filled.CheckCircle),
    QUESTIONS("Questions", Icons.Filled.Email),
    NODES("Nodes", Icons.AutoMirrored.Filled.List),
    DEVICES("Devices", Icons.Filled.Phone),
    SETTINGS("Settings", Icons.Filled.Settings)
}

@Composable
fun Main(model: AppModel) {
    var tab by remember { mutableStateOf(0) }
    // Fleet stage 5: the lease request being reviewed, and whether the live lease is on screen.
    var leaseItem by remember { mutableStateOf<AppModel.LeaseRequestItem?>(null) }
    var showLive by remember { mutableStateOf(false) }
    // A lease push: show where the request will be listed. The model fetched nothing.
    LaunchedEffect(model.leasePushes) {
        if (model.leasePushes > 0) {
            tab = 0
            leaseItem = null
            showLive = false
        }
    }
    // Back leaves a lease screen, then goes to Approvals; the sub-screens below handle their own Back first.
    BackHandler(enabled = leaseItem != null || showLive || tab != 0) {
        if (leaseItem != null || showLive) {
            leaseItem = null
            showLive = false
        } else {
            tab = 0
        }
    }
    val tabs = Tab.entries
    Scaffold(bottomBar = {
        NavigationBar {
            tabs.forEachIndexed { i, t ->
                val count = when (t) {
                    Tab.APPROVALS -> model.pending.count { it.status == null } + model.leaseRequests.size
                    Tab.QUESTIONS -> model.questions.size
                    else -> 0
                }
                // A tab also leaves a lease screen; a lease that is still running keeps its banner.
                NavigationBarItem(
                    selected = tab == i,
                    onClick = { tab = i; leaseItem = null; showLive = false },
                    icon = {
                        if (count > 0) BadgedBox(badge = { Badge { Text("$count") } }) { Icon(t.icon, contentDescription = null) }
                        else Icon(t.icon, contentDescription = null)
                    },
                    label = { Text(t.label, maxLines = 1) }
                )
            }
        }
    }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (model.mode == AppMode.DEMO) {
                val status = statusColors
                Text(
                    "Demo — nothing here reaches a real machine",
                    Modifier.fillMaxWidth().background(status.demoContainer).padding(horizontal = 16.dp, vertical = 8.dp),
                    color = status.onDemoContainer, fontWeight = FontWeight.Bold
                )
            }
            LeaseBanner(model) { leaseItem = null; showLive = true }
            model.fingerprintToCompare?.let {
                Text("This phone: $it — check the other screen shows the same.", Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MonoStyle)
            }
            val item = leaseItem
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when {
                    item != null -> LeaseRequestScreen(model, item, back = { leaseItem = null }, done = { leaseItem = null; showLive = model.liveLease != null })
                    showLive && model.liveLease != null -> LiveLeaseScreen(model) { showLive = false }
                    else -> when (tabs[tab]) {
                        Tab.APPROVALS -> Pending(model) { leaseItem = it }
                        Tab.QUESTIONS -> Questions(model)
                        Tab.NODES -> Nodes(model)
                        Tab.DEVICES -> Devices(model)
                        Tab.SETTINGS -> Settings(model)
                    }
                }
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

/** Who asked, labelled as the front door's report when there is one. */
private fun originLine(model: AppModel, display: JsonElement): String {
    val shown = display["origin"].obj()?.let { o -> listOf("client", "session", "job_id", "deviceId").mapNotNull { o[it].str() }.joinToString(" · ") { FrontDoor.shownText(it) } } ?: ""
    // On a front door, origin.client is the client's self-declared name as the front door reports it.
    return (if (model.frontDoorId == null) "Asked by: " else "Client (reported by front door): ") + shown
}

@Composable
fun Pending(model: AppModel, openLease: (AppModel.LeaseRequestItem) -> Unit = {}) {
    var open by remember { mutableStateOf<String?>(null) }
    ticker()
    val item = model.pending.firstOrNull { it.id == open }
    if (item != null) {
        BackHandler { open = null }
        Detail(model, item) { open = null }
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { ScreenTitle("Approvals") }
        if (model.mode == AppMode.LIVE) {
            item {
                Button({ model.checkNow() }, Modifier.fillMaxWidth().height(DecisionHeight), enabled = !model.isPolling) {
                    Text(if (model.isPolling) "Checking…" else "Check for requests")
                }
            }
        }
        model.pollProblem?.let { problem -> item { Text(problem, color = statusColors.warning) } }
        if (model.pending.isEmpty()) {
            item {
                EmptyState(
                    if (Push.ENABLED) "Nothing waiting. A notification tells you when a machine asks."
                    else "Nothing waiting. Approvals appear here while the app is open."
                )
            }
        }
        // Undecided requests first; decided ones stay below with their status until they leave the list.
        items(model.pending.sortedBy { it.status != null }, key = { it.id }) { p -> PendingCard(model, p) { open = p.id } }
        // Fleet stage 5: computer-use requests, loaded only by their own button.
        item { LeaseRequests(model, openLease) }
    }
}

/** One request at a glance: node, summary, who asked, time left, and the two decisions. */
@Composable
private fun PendingCard(model: AppModel, p: PendingItem, onOpen: () -> Unit) {
    val left = p.timeLeftMs
    ItemCard(onClick = onOpen) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(p.display["node"]["name"].str() ?: "", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            TimePill(p.status ?: formatLeft(left), urgent = p.status == null && left < 60_000)
        }
        Text(p.display["summary"].str() ?: "", style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
        val origin = FrontDoor.pendingOriginText(p.display)
        if (origin.isNotEmpty()) Secondary((if (model.frontDoorId == null) "Asked by: " else "Client (reported by front door): ") + origin, Modifier.padding(top = 2.dp))
        Text("Tap for every parameter", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
        if (p.status == null) {
            val canDecide = left > 0 && !p.deciding
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                ApproveButton("Approve", canDecide) { model.decide(p, true) }
                DenyButton("Deny", canDecide) { model.decide(p, false) }
            }
        }
    }
}

/** Every parameter, command-like values whole or head + tail, hidden characters as ‹U+XXXX›. */
@Composable
fun Detail(model: AppModel, item: PendingItem, onBack: () -> Unit) {
    ticker()
    var expanded by remember { mutableStateOf(setOf<String>()) }
    val left = item.timeLeftMs
    Column(Modifier.fillMaxSize()) {
        BackBar("Approval", onBack)
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(item.display["node"]["name"].str() ?: "", Modifier.weight(1f), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    TimePill("Time left: ${formatLeft(left)}", urgent = left < 60_000)
                }
                Text(item.display["node"]["id"].str() ?: "", style = MonoStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(item.display["summary"].str() ?: "", Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.titleMedium)
                Text("Kind: ${item.display["kind"].str()}   Name: ${item.display["name"].str()}")
                item.display["cwd"].str()?.let { Text("Directory: $it") }
                Text(originLine(model, item.display))
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                SectionTitle("Parameters")
            }
            items(item.display["items"].arr().orEmpty()) { entry: JsonElement ->
                val path = entry["path"].str() ?: ""
                val hidden = entry["hidden"].int() ?: 0
                Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(path, style = MonoStyle, color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.SemiBold)
                    SelectionContainer {
                        if (hidden > 0 && path in expanded) CodeBlock(item.fullText[path] ?: "")
                        else CodeBlock(entry["text"].str() ?: "")
                    }
                    if (hidden > 0 && path !in expanded) {
                        TextButton({ expanded = expanded + path }) { Text("$hidden characters hidden — Show all") }
                        CodeBlock(entry["tail"].str() ?: "")
                    }
                }
            }
            item {
                val status = item.status
                if (status != null) Text("Status: $status", Modifier.padding(top = 12.dp), style = MaterialTheme.typography.titleMedium)
                // The node-signed status on demand: one tap, one signed fetch.
                if (model.mode == AppMode.LIVE) OutlinedButton({ model.openPushed(item.id) }, Modifier.fillMaxWidth().padding(top = 8.dp)) { Text("Refresh status") }
            }
        }
        // The decision, where a thumb reaches it: full width at the bottom, after every parameter above.
        if (item.status == null) {
            val canDecide = left > 0 && !item.deciding
            DecisionBar {
                ApproveButton("Approve", canDecide) { model.decide(item, true) }
                DenyButton("Deny", canDecide) { model.decide(item, false) }
            }
        }
    }
}

@Composable
fun History(model: AppModel) {
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (model.mode == AppMode.DEMO) EmptyState("The demo has no history. On a paired phone, tap a node here to load what it did.")
        else if (model.nodes.isEmpty()) EmptyState("History comes from your paired nodes. None is paired on this phone.")
        model.nodes.forEach { n -> OutlinedButton({ model.loadHistory(n.id) }, Modifier.fillMaxWidth()) { Text(Display.escape(n.name)) } }
        model.history?.let { (asOf, entries) ->
            model.historyStatus?.let { FrontDoorAudit(it) }
            model.historyStatusNote?.let { Secondary("Reported by front door: $it") }
            Text("As of ${Display.escape(asOf)}", fontWeight = FontWeight.Bold)
            LazyColumn {
                items(entries) { e ->
                    // Lease and GUI entries (fleet stage 5) are labelled; the kind itself is still shown.
                    val kind = e["kind"].str() ?: ""
                    val label = if (kind.startsWith("lease.") || kind.startsWith("gui.")) "Computer use · " else ""
                    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                        Text("#${e["seq"].int()} $label${relayText(e["kind"])}", fontWeight = FontWeight.SemiBold)
                        Secondary("${relayText(e["at"])} · ${relayText(e["writer"])}")
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
fun Nodes(model: AppModel) {
    var name by remember { mutableStateOf("") }
    var code by remember { mutableStateOf<String?>(null) }
    var showHistory by remember { mutableStateOf(false) }
    if (showHistory) {
        BackHandler { showHistory = false }
        Column(Modifier.fillMaxSize()) {
            BackBar("History") { showHistory = false }
            History(model)
        }
        return
    }
    // Demo nodes are the demo fleet's; nothing is pinned in demo mode.
    val demo = model.mode == AppMode.DEMO
    val nodes = if (demo) model.demoNodes else model.nodes
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        ScreenTitle("Nodes")
        // Each relay request is a biometric prompt on this phone, so it is asked for, never automatic.
        if (model.mode == AppMode.LIVE) OutlinedButton({ model.refreshNodes() }, Modifier.fillMaxWidth()) { Text("Refresh online state") }
        if (nodes.isEmpty()) EmptyState("No node is paired yet. Get a pairing code below and give it to the node.")
        nodes.forEach { n ->
            ItemCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(Display.escape(n.name), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    if (demo) Secondary("demo") else OnlineDot(model.online[n.id])
                }
                Text(FrontDoor.nodeFingerprint(n.id), style = MonoStyle)
            }
        }
        OutlinedButton({ showHistory = true }, Modifier.fillMaxWidth()) { Text("History") }
        SectionTitle("Pairing code for a new node")
        OutlinedTextField(name, { name = it }, label = { Text("Node name, e.g. gpu-box") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        Button({ model.pairingCode(name) { code = it } }, Modifier.fillMaxWidth(), enabled = name.isNotBlank() && model.mode == AppMode.LIVE) { Text("Get code") }
        code?.let { SelectionContainer { CodeBlock(it) } }
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
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            ScreenTitle("Devices")
            model.deviceId?.let {
                ItemCard {
                    Text("This phone", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text("d-" + Identifiers.fingerprintGroups(it), style = MonoStyle)
                }
            }
        }
        // Each relay request is a biometric prompt on this phone, so it is asked for, never automatic.
        if (model.mode == AppMode.LIVE) item { OutlinedButton({ model.refreshDevices() }, Modifier.fillMaxWidth()) { Text("Show devices") } }
        if (model.devices.isEmpty()) {
            item { EmptyState(if (model.mode == AppMode.LIVE) "Tap Show devices to list the other phones that approve for your nodes." else "The demo has no other phones.") }
        }
        items(model.devices) { d ->
            val id = d["device_id"].str() ?: ""
            val name = relayText(d["name"])
            ItemCard {
                Text("$name (${relayText(d["platform"])})", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text("d-" + Identifiers.fingerprintGroups(Display.escape(id)), style = MonoStyle)
                d["nodes"].arr().orEmpty().forEach { n -> Secondary("${relayText(n["node_id"])}: ${relayText(n["state"])}") }
                if (id.isNotEmpty() && id != model.deviceId && model.mode == AppMode.LIVE) {
                    OutlinedButton({ model.revoke(id, name) }, colors = denyColors(), border = denyBorder(true)) { Text("Revoke") }
                }
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Button({ model.startInvite() }, Modifier.fillMaxWidth().height(DecisionHeight), enabled = model.mode == AppMode.LIVE) { Text("Add a device") }
                model.inviteQr?.let {
                    QrImage(it)
                    Text("Scan this with the new phone, then tap below.")
                    OutlinedButton({ model.checkInvite() }, Modifier.fillMaxWidth()) { Text("The new phone has scanned it") }
                }
                model.inviteClaim?.let { device ->
                    Text("New phone ${relayText(device["name"])}: d-${Identifiers.fingerprintGroups(device["device_id"].str() ?: "")}", style = MonoStyle)
                    Button({ model.confirmInvited() }, Modifier.fillMaxWidth().height(DecisionHeight)) { Text("It shows the same — add it") }
                    TextButton({ model.inviteClaim = null }) { Text("Cancel") }
                }
            }
        }
    }
}

@Composable
fun Settings(model: AppModel) {
    var scanning by remember { mutableStateOf(false) }
    var frontDoor by remember { mutableStateOf(false) }
    if (frontDoor) {
        BackHandler { frontDoor = false; model.cancelGrant() }
        Column(Modifier.fillMaxSize()) {
            BackBar("Front door") { frontDoor = false; model.cancelGrant() }
            FrontDoor(model)
        }
        return
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        ScreenTitle("Settings")
        SectionTitle("Relay")
        Text(model.relayUrl?.let { Display.escape(it) } ?: "not paired")
        model.relaySpki?.let { CodeBlock(it) }
        if (scanning) ScanOrPaste(model) { scanning = false } else OutlinedButton({ scanning = true }, Modifier.fillMaxWidth()) { Text("Re-pin the relay (scan a relay code)") }
        SectionTitle("Front door")
        model.frontDoorId?.let { Text("Front door ${FrontDoor.nodeFingerprint(it)}", style = MonoStyle) }
        OutlinedButton({ frontDoor = true }, Modifier.fillMaxWidth()) { Text("Front door: clients, nodes, alerts") }
        SectionTitle("This phone")
        if (model.mode == AppMode.DEMO) Button({ model.leaveDemo() }, Modifier.fillMaxWidth()) { Text("Leave demo") }
        OutlinedButton({ model.reset() }, Modifier.fillMaxWidth(), colors = denyColors(), border = denyBorder(true)) { Text("Reset this phone") }
        Secondary("No analytics. The relay sees every action you are asked to approve; see PRIVACY.md.", Modifier.padding(top = 8.dp))
    }
}
