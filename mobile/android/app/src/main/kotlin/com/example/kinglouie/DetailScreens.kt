package com.example.kinglouie

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
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.kinglouie.protocol.Display
import com.example.kinglouie.protocol.FrontDoor
import com.example.kinglouie.protocol.GrantRequest
import com.example.kinglouie.protocol.Jcs
import com.example.kinglouie.protocol.QuestionItem
import com.example.kinglouie.protocol.ScopeChoice
import com.example.kinglouie.protocol.arr
import com.example.kinglouie.protocol.bool
import com.example.kinglouie.protocol.get
import com.example.kinglouie.protocol.int
import com.example.kinglouie.protocol.obj
import com.example.kinglouie.protocol.str
import kotlinx.serialization.json.JsonElement

// The detail of each Approval kind but the lease ones (those are in
// LeaseScreens.kt), pushed over the list (android-slim §6.3). The decision is
// at the bottom where a thumb reaches it, after everything it decides. Every
// string shown is a pinned node's, escaped (Display.escape), or the front
// door's, capped and escaped (FrontDoor.shownText): Compose shows it as plain
// text, never markup or a link.

/** Front-door or client text as shown: capped and escaped by the core. */
private fun fdText(value: JsonElement?, max: Int = FrontDoor.SHOWN_TEXT_MAX): String = FrontDoor.shownText(value.str(), max)

/** Who asked, labelled as the front door's report when there is one. */
private fun originLine(model: AppModel, display: JsonElement): String {
    val shown = display["origin"].obj()?.let { o -> listOf("client", "session", "job_id", "deviceId").mapNotNull { o[it].str() }.joinToString(" · ") { FrontDoor.shownText(it) } } ?: ""
    // On a front door, origin.client is the client's self-declared name as the front door reports it.
    return (if (model.frontDoorId == null) "Asked by: " else "Client (reported by front door): ") + shown
}

/** A tool approval: every parameter, command-like values whole or head + tail, hidden characters as ‹U+XXXX› (approval-v1 §5). */
@Composable
fun ToolApprovalDetail(model: AppModel, item: PendingItem, onBack: () -> Unit) {
    ticker()
    var expanded by remember { mutableStateOf(setOf<String>()) }
    val left = item.timeLeftMs
    Column(Modifier.fillMaxSize()) {
        BackBar(when (item.display["kind"].str()) { "runbook" -> "Runbook"; "envelope" -> "Envelope"; else -> "Tool approval" }, onBack)
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(item.display["node"]["name"].str() ?: "", Modifier.weight(1f), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    TimePill("Time left: ${formatLeft(left)}", urgent = left < 60_000)
                }
                Text(item.display["node"]["id"].str() ?: "", style = MonoStyle, color = KlTokens.textSecondary)
                Text(item.display["summary"].str() ?: "", Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.titleMedium)
                Text("Kind: ${item.display["kind"].str()}   Name: ${item.display["name"].str()}")
                item.display["cwd"].str()?.let { Text("Directory: $it") }
                Text(originLine(model, item.display))
                HorizontalDivider(Modifier.padding(vertical = 8.dp), color = KlTokens.borderSubtle)
                SectionTitle("Parameters")
            }
            items(item.display["items"].arr().orEmpty()) { entry: JsonElement ->
                val path = entry["path"].str() ?: ""
                val hidden = entry["hidden"].int() ?: 0
                Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(path, style = MonoStyle, color = KlTokens.textSecondary, fontWeight = FontWeight.SemiBold)
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
                else Secondary("Approve and Deny each ask for your fingerprint once.", Modifier.padding(top = 12.dp))
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

/** A case question, one per screen: the options as buttons, or a text answer with Send; a briefing's one answer. */
@Composable
fun QuestionDetail(model: AppModel, item: QuestionItem, onBack: () -> Unit) {
    var draft by remember(item.token) { mutableStateOf("") }
    val busy = item.token in model.answering
    val tooLong = draft.trim().length > AppModel.MAX_ANSWER_CHARS
    Column(Modifier.fillMaxSize()) {
        BackBar("Question", onBack)
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Text(Display.escape(item.caseTitle), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Secondary(Display.escape(item.nodeName))
                if (item.urgency == "high") Text("Urgent", color = KlTokens.error, fontWeight = FontWeight.Bold)
                Text(Display.escape(item.text), Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodyLarge)
            }
            if (item.kind != "briefing") {
                items(item.options) { option ->
                    OutlinedButton({ model.answer(item, option.id, null) }, Modifier.fillMaxWidth().height(DecisionHeight), enabled = !busy,
                        shape = RoundedCornerShape(KlTokens.radiusMd)) { Text(Display.escape(option.label)) }
                }
                item {
                    OutlinedTextField(
                        draft, { draft = it }, label = { Text("Answer…") }, modifier = Modifier.fillMaxWidth(),
                        isError = tooLong,
                        supportingText = if (tooLong) ({ Text("At most ${AppModel.MAX_ANSWER_CHARS} characters.") }) else null
                    )
                }
            }
            item { Secondary("An answer asks for your fingerprint once.") }
        }
        DecisionBar {
            if (item.kind == "briefing") ApproveButton("Got it", !busy) { model.answer(item, null, "ok") }
            else ApproveButton("Send", !busy && draft.isNotBlank() && !tooLong) { model.answer(item, null, draft.trim()) }
        }
    }
}

/**
 * A client asking to connect through the front door, claimed by its code on
 * the Scanner (C-13): the scopes it asked for, each with its machine limits.
 * Approve signs exactly the scopes switched on.
 */
@Composable
fun ClientConnectionDetail(model: AppModel, request: GrantRequest, onBack: () -> Unit) {
    var enabled by remember(request.grantId) { mutableStateOf(request.preselected.toSet()) }
    var limits by remember(request.grantId) { mutableStateOf(mapOf<String, Set<String>>()) }
    Column(Modifier.fillMaxSize()) {
        BackBar("Client connection", onBack)
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            item {
                Text("${FrontDoor.shownText(request.clientName)} (self-declared)", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text("Client host: ${FrontDoor.shownText(request.clientHost)}")
                Text("Returns to: ${FrontDoor.shownText(request.redirectHost)}")
                HorizontalDivider(Modifier.padding(vertical = 6.dp), color = KlTokens.borderSubtle)
                SectionTitle("Scopes it asked for")
            }
            // Only the scopes this client asked for.
            items(request.requestedScopes) { scope ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(scope in enabled, { on -> enabled = if (on) enabled + scope else enabled - scope })
                    Text(FrontDoor.shownText(scope), style = MonoStyle)
                }
                if (scope in enabled && scope != "fleet:unsafe") {
                    model.machineChoices.forEach { (name, limitable) ->
                        Row(Modifier.padding(start = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                            val chosen = limits[scope].orEmpty()
                            Checkbox(name in chosen, { on -> limits = limits + (scope to (if (on) chosen + name else chosen - name)) }, enabled = limitable)
                            Text("Only ${FrontDoor.shownText(name)}", color = if (limitable) KlTokens.textPrimary else KlTokens.textSecondary)
                        }
                    }
                }
            }
            item {
                Text("With no machine chosen, the client may use every machine. Unsafe actions still need your phone each time.", Modifier.padding(top = 8.dp))
                Secondary("Approve and Deny each ask for your fingerprint once.", Modifier.padding(top = 8.dp))
            }
        }
        DecisionBar {
            // Exactly the scopes switched on, in the order requested, each with its machine limit.
            val scopes = request.requestedScopes.filter { it in enabled }
                .map { s -> ScopeChoice(s, if (s == "fleet:unsafe") null else limits[s]?.takeIf { it.isNotEmpty() }?.toList()) }
            ApproveButton("Approve", enabled.isNotEmpty() && !model.frontDoorBusy) { model.decideGrant(request, scopes, true) }
            DenyButton("Deny", !model.frontDoorBusy) { model.decideGrant(request, emptyList(), false) }
        }
    }
}

/** A node waiting to join the front door: its name, profile and fingerprint, to compare with the node's console. */
@Composable
fun PairingDetail(model: AppModel, item: PairingItem, onBack: () -> Unit) {
    ticker()
    val p = item.request
    val left = item.timeLeftMs
    Column(Modifier.fillMaxSize()) {
        BackBar("Node pairing", onBack)
        Column(Modifier.weight(1f).fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            // The core checked the name's alphabet and that the id derives from the key.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("${FrontDoor.shownText(p.nodeName)} (${FrontDoor.shownText(p.profile, 32)})", Modifier.weight(1f), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                TimePill(formatLeft(left), urgent = left < 60_000)
            }
            SelectionContainer { CodeBlock(p.fingerprint) }
            Text("Check the node's console shows the same fingerprint.")
            p.replaces?.let { Text("Replaces ${FrontDoor.nodeFingerprint(it)}", color = statusColors.warning, fontWeight = FontWeight.Bold) }
            Secondary("Approve and Deny each ask for your fingerprint once.")
        }
        DecisionBar {
            ApproveButton("Approve", left > 0 && !model.frontDoorBusy) { model.decidePairing(p, true) }
            DenyButton("Deny", left > 0 && !model.frontDoorBusy) { model.decidePairing(p, false) }
        }
    }
}

/** A front-door alert (R-AN-3): what it is, the detail as monospace JSON, when, and Acknowledge. */
@Composable
fun AlertDetail(model: AppModel, alert: JsonElement, onBack: () -> Unit) {
    val id = alert["id"].str()
    Column(Modifier.fillMaxSize()) {
        BackBar("Alert", onBack)
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Text(fdText(alert["kind"], 64), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(fdText(alert["subject"]), style = MonoStyle)
                Secondary(fdText(alert["at"], 40))
                // An audit break (docs/fleet/front-door.md, doctor) names its reason; in words where this app knows it.
                alert["detail"]["reason"].str()?.let { Text("Break: " + auditBreakWords(FrontDoor.shownText(it, 64)), color = statusColors.warning) }
                SectionTitle("Detail")
                SelectionContainer { CodeBlock(FrontDoor.shownText(alert["detail"]?.let { Jcs.serialize(it) }, 400)) }
                Secondary("Acknowledge asks for your fingerprint once.", Modifier.padding(top = 8.dp))
            }
        }
        if (alert["acked"].bool() != true && id != null) {
            DecisionBar {
                Button({ model.ackAlert(id) }, Modifier.weight(1f).height(DecisionHeight), enabled = !model.frontDoorBusy,
                    shape = RoundedCornerShape(KlTokens.radiusMd), colors = approveColors()) { Text("Acknowledge", style = MaterialTheme.typography.labelLarge) }
            }
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
