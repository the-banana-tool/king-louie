package com.example.kinglouie

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.example.kinglouie.protocol.AppMode
import com.example.kinglouie.protocol.ApprovalList
import kotlinx.coroutines.delay

// The app's four screens (android-slim §6, C-10): Approvals is the root, with
// the Scanner and Settings one tap away in its top bar and the detail of a
// row pushed over it. There is no bottom bar. Back from any other screen
// returns to Approvals. tests/mobile-android-slim.test.js reads this file.

/** Where the app is, besides a detail (which is the model's `selected`). */
private enum class Screen { APPROVALS, SCANNER, SETTINGS }

@Composable
fun Root(model: AppModel) {
    // C-10: a phone that is not paired opens on the Scanner.
    var screen by remember { mutableStateOf(if (model.mode == AppMode.WELCOME) Screen.SCANNER else Screen.APPROVALS) }
    // The bars are drawn edge to edge (target SDK 37): bgSidebarHdr behind them, every screen inside their insets (§11.2).
    Box(Modifier.fillMaxSize().background(KlTokens.bgSidebarHdr)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding(), color = MaterialTheme.colorScheme.background) {
            model.banner?.let { text ->
                AlertDialog(onDismissRequest = { model.banner = null }, confirmButton = { TextButton({ model.banner = null }) { Text("OK") } }, text = { Text(text) })
            }
            BackHandler(enabled = screen != Screen.APPROVALS) { screen = Screen.APPROVALS }
            when (screen) {
                Screen.SCANNER -> ScannerScreen(model) { screen = Screen.APPROVALS }
                Screen.SETTINGS -> SettingsScreen(model, back = { screen = Screen.APPROVALS }, openScanner = { screen = Screen.SCANNER })
                Screen.APPROVALS -> ApprovalsOrDetail(model, openScanner = { screen = Screen.SCANNER }, openSettings = { screen = Screen.SETTINGS })
            }
        }
    }
}

/** The list, or the detail of the row the model has selected (§6.3). */
@Composable
private fun ApprovalsOrDetail(model: AppModel, openScanner: () -> Unit, openSettings: () -> Unit) {
    BackHandler(enabled = model.selected != null) { model.closeDetail() }
    val back = { model.closeDetail() }
    when (model.selected) {
        null -> ApprovalsScreen(model, openScanner, openSettings)
        is AppModel.Selection.Tool -> model.selectedPending?.let { ToolApprovalDetail(model, it, back) } ?: GoneDetail(model)
        is AppModel.Selection.Question -> model.selectedQuestion?.let { QuestionDetail(model, it, back) } ?: GoneDetail(model)
        is AppModel.Selection.LeaseRequest -> model.selectedLeaseRequest?.let { LeaseRequestScreen(model, it, back) } ?: GoneDetail(model)
        is AppModel.Selection.RunningLease -> model.selectedLiveLease?.let { LiveLeaseScreen(model, back) } ?: GoneDetail(model)
        is AppModel.Selection.Client -> model.selectedClient?.let { ClientConnectionDetail(model, it, back) } ?: GoneDetail(model)
        is AppModel.Selection.Pairing -> model.selectedPairing?.let { PairingDetail(model, it, back) } ?: GoneDetail(model)
        is AppModel.Selection.Alert -> model.selectedAlert?.let { AlertDetail(model, it, back) } ?: GoneDetail(model)
    }
}

/** A detail whose item left its store (decided, expired, answered elsewhere): back to the list, which shows what is left. */
@Composable
private fun GoneDetail(model: AppModel) {
    LaunchedEffect(Unit) { model.closeDetail() }
}

fun formatLeft(ms: Long): String = "%d:%02d".format(ms / 60000, (ms / 1000) % 60)

/** Recomposes the caller once a second, for the times left. */
@Composable
fun ticker(): Long {
    var now by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now += 1 } }
    return now
}

/** The root: one list of every Approval and every running lease (§6.2, §7). It is fetched by the model's loop; pull fetches at once. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ApprovalsScreen(model: AppModel, openScanner: () -> Unit, openSettings: () -> Unit) {
    ticker()
    val list = model.approvalList()
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().background(KlTokens.bgSidebar).padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("Approvals", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, color = KlTokens.textPrimary)
            IconButton(openScanner) { Icon(painterResource(R.drawable.ic_scan), contentDescription = "Scanner", tint = KlTokens.textPrimary) }
            IconButton(openSettings) { Icon(Icons.Filled.Settings, contentDescription = "Settings", tint = KlTokens.textPrimary) }
        }
        PullToRefreshBox(isRefreshing = model.isRefreshing, onRefresh = { model.refresh() }, modifier = Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // A phone joining by invite: its id, to compare with the other phone's screen (§6.4).
                model.fingerprintToCompare?.let { item { Text("This phone: $it — check the other screen shows the same.", style = MonoStyle) } }
                // The read key's set-up (§8.7), first until it is done.
                if (model.readKeySetupNeeded) {
                    item {
                        Button({ model.setUpReadKey() }, Modifier.fillMaxWidth().height(DecisionHeight), enabled = !model.readKeySetupBusy,
                            shape = RoundedCornerShape(KlTokens.radiusMd), colors = approveColors()) {
                            Text(AppModel.READ_KEY_SETUP_TITLE, style = MaterialTheme.typography.labelLarge)
                        }
                    }
                }
                // At most one line about why the loop is not getting through (§6.2).
                model.pollProblem?.let { problem -> item { Text(problem, color = statusColors.warning) } }
                // A notification whose item is gone (§13), or a session its node no longer has (C-18).
                model.listNotice?.let { notice ->
                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(notice, Modifier.weight(1f), color = KlTokens.textSecondary)
                            TextButton({ model.dismissListNotice() }) { Text("OK") }
                        }
                    }
                }
                items(list.rows, key = { it.id }) { row -> ApprovalRow(model, row) }
                list.empty?.let { empty ->
                    item {
                        EmptyState(listOfNotNull(empty.title, empty.line).joinToString("\n"))
                        if (empty.toScanner) {
                            Button(openScanner, Modifier.fillMaxWidth().height(DecisionHeight), shape = RoundedCornerShape(KlTokens.radiusMd), colors = approveColors()) {
                                Text("Open the Scanner", style = MaterialTheme.typography.labelLarge)
                            }
                        }
                    }
                }
                // What each node signed it has running, so an empty list never reads as "nothing is running" unless a node said so (§7.5).
                for (line in list.footer) item { Secondary(line) }
            }
        }
    }
}

/**
 * One row (§7.2): the node, the kind, one host-built line and the time. The
 * strings and the buttons are ApprovalList's; a button goes to the model as
 * that row's button (`press`), the rest of the row opens its detail. The
 * summary is one line: one that does not fit says so, and the row then
 * offers Review in place of Approve (C-12).
 */
@Composable
private fun ApprovalRow(model: AppModel, row: ApprovalList.Row) {
    val tint = when {
        row.kind == ApprovalList.Kind.RUNNING_LEASE -> KlTokens.errorBg.compositeOver(KlTokens.bgElevated)
        row.warning -> KlTokens.warningBg.compositeOver(KlTokens.bgSurface)
        row.status != null && row.status!!.startsWith("approved", ignoreCase = true) -> KlTokens.successBg.compositeOver(KlTokens.bgSurface)
        else -> KlTokens.bgSurface
    }
    val textColor = if (row.warning) statusColors.warning else KlTokens.textPrimary
    // A node's "Could not confirm" or "Not checked yet" has no detail.
    if (row.kind == ApprovalList.Kind.NODE_CHECK) ItemCard(color = tint) { RowBody(model, row, textColor) }
    else ItemCard(onClick = { model.open(row) }, color = tint) { RowBody(model, row, textColor) }
}

@Composable
private fun RowBody(model: AppModel, row: ApprovalList.Row, textColor: Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f)) {
            Text(row.nodeName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(row.label, style = MaterialTheme.typography.bodySmall, color = KlTokens.accent)
        }
        row.timeLeftMs?.let { left -> if (row.status == null) TimePill(formatLeft(left), urgent = left < 60_000) }
        row.at?.let { Secondary(it) }
    }
    Text(
        row.summary, style = MaterialTheme.typography.bodyLarge, color = textColor, fontWeight = if (row.highUrgency) FontWeight.Bold else FontWeight.Normal,
        maxLines = 1, overflow = TextOverflow.Ellipsis,
        onTextLayout = { model.reportOverflow(row.id, it.hasVisualOverflow) }
    )
    row.secondLine?.let { Text(it, style = if (row.secondLineMonospace) MonoStyle else MaterialTheme.typography.bodyMedium) }
    row.detail?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = if (row.warning) statusColors.warning else KlTokens.textSecondary) }
    row.status?.let { Text(it, style = MaterialTheme.typography.titleSmall, color = KlTokens.textSecondary) }
    // R-F5-5: an unanswered send says so; the buttons stay enabled.
    row.notConfirmed?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = statusColors.warning) }
    if (row.buttons.isNotEmpty()) {
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            for (button in row.buttons) RowButton(row, button) { model.press(row, button) }
        }
    }
}

/** A row's button, in the words of its kind. Open is never disabled: the detail can always be read. */
@Composable
private fun RowScope.RowButton(row: ApprovalList.Row, button: ApprovalList.Button, onClick: () -> Unit) {
    val enabled = row.enabled || button == ApprovalList.Button.OPEN || button == ApprovalList.Button.REVIEW
    val shape = RoundedCornerShape(KlTokens.radiusMd)
    val modifier = Modifier.weight(1f).height(DecisionHeight)
    when (button) {
        ApprovalList.Button.APPROVE -> ApproveButton(if (row.kind == ApprovalList.Kind.LEASE_REQUEST) "Allow" else "Approve", enabled, onClick)
        ApprovalList.Button.GOT_IT -> ApproveButton("Got it", enabled, onClick)
        ApprovalList.Button.DENY -> DenyButton("Deny", enabled, onClick)
        ApprovalList.Button.STOP -> Button(onClick, modifier, enabled = enabled, shape = shape, colors = stopColors()) { Text("Stop", style = MaterialTheme.typography.labelLarge) }
        ApprovalList.Button.REVIEW -> OutlinedButton(onClick, modifier, enabled = enabled, shape = shape, colors = ButtonDefaults.outlinedButtonColors(contentColor = KlTokens.accent)) {
            Text("Review", style = MaterialTheme.typography.labelLarge)
        }
        ApprovalList.Button.OPEN -> OutlinedButton(onClick, modifier, enabled = enabled, shape = shape) { Text("Open", style = MaterialTheme.typography.labelLarge) }
        ApprovalList.Button.ACKNOWLEDGE -> OutlinedButton(onClick, modifier, enabled = enabled, shape = shape) { Text("Acknowledge", style = MaterialTheme.typography.labelLarge) }
    }
}
