package com.example.kinglouie

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.kinglouie.protocol.AppMode
import com.example.kinglouie.protocol.Display
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter

// The Scanner (android-slim §6.1): Scan a code (the camera and one text
// field; AppModel.scanned decides what a code is and applies its own checks)
// and Get a code (a pairing code for a new node). An unpaired phone opens
// here (C-10).

@Composable
fun ScannerScreen(model: AppModel, back: () -> Unit) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    Column(Modifier.fillMaxSize()) {
        BackBar("Scanner", back)
        PrimaryTabRow(selectedTabIndex = tab, containerColor = KlTokens.bgSidebar, contentColor = KlTokens.accent) {
            for ((i, label) in listOf("Scan a code", "Get a code").withIndex()) {
                Tab(
                    selected = tab == i, onClick = { tab = i },
                    modifier = Modifier.background(if (tab == i) KlTokens.accentSurface else Color.Transparent),
                    selectedContentColor = KlTokens.accent, unselectedContentColor = KlTokens.textSecondary,
                    text = { Text(label, style = MaterialTheme.typography.labelLarge) }
                )
            }
        }
        if (tab == 0) ScanTab(model, back) else GetCodeTab(model)
    }
}

/** The camera and "Or type a code": a `kl1:` code, or on a front door a client's six-character code (C-13). */
@Composable
private fun ScanTab(model: AppModel, done: () -> Unit) {
    var typed by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        QrScanner(Modifier.fillMaxWidth().height(320.dp)) { code -> done(); model.scanned(code) }
        Secondary("A node's code (from enroll-device), another phone's invite, or a relay re-pin.")
        OutlinedTextField(typed, { typed = it }, label = { Text("Or type a code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Button({ done(); model.scanned(typed) }, Modifier.fillMaxWidth().height(DecisionHeight), enabled = typed.isNotBlank(),
            shape = RoundedCornerShape(KlTokens.radiusMd), colors = approveColors()) { Text("Use this code", style = MaterialTheme.typography.labelLarge) }
        if (model.acceptsClientCode) Secondary("A client's code connects it through your front door.")
    }
}

/** A pairing code for a new node (one fingerprint), shown large with its expiry and what to run on the node. */
@Composable
private fun GetCodeTab(model: AppModel) {
    ticker()
    var name by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (model.mode != AppMode.LIVE) {
            EmptyState("Pair this phone first: scan a node's code on Scan a code.")
            return@Column
        }
        OutlinedTextField(name, { name = it }, label = { Text("Node name, e.g. gpu-box") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Button({ model.getPairingCode(name.trim()) }, Modifier.fillMaxWidth().height(DecisionHeight), enabled = name.isNotBlank() && !model.pairingCodeBusy,
            shape = RoundedCornerShape(KlTokens.radiusMd), colors = approveColors()) { Text("Get code", style = MaterialTheme.typography.labelLarge) }
        Secondary("Get code asks for your fingerprint once.")
        model.pairingCode?.let { shown ->
            val relay = Display.escape(model.relayUrl ?: "")
            Text("On the node, run `king-louie-service pair $relay` and type this code.")
            SelectionContainer { Text(shown.code, style = MonoStyle.copy(fontSize = 34.sp, lineHeight = 42.sp), color = KlTokens.textPrimary) }
            shown.expiresAtMs?.let { at ->
                val left = at - System.currentTimeMillis()
                if (left > 0) Secondary("For ${shown.nodeName}. Expires in ${formatLeft(left)}.")
                else Text("This code has expired. Get a new one.", color = statusColors.warning)
            }
        }
    }
}

/** A QR code, black on white (the one place the app draws colours that are not tokens). */
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
