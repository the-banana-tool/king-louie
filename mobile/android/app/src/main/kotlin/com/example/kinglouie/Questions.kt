package com.example.kinglouie

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.kinglouie.protocol.AppMode
import com.example.kinglouie.protocol.Display

/**
 * Cases stage 4: questions from the nodes, each answered with a fresh
 * biometric signature the node verifies. Loaded only when the owner taps
 * Refresh: every relay request is a fingerprint prompt on this phone.
 */
@Composable
fun Questions(model: AppModel) {
    val drafts = remember { mutableStateMapOf<String, String>() }
    Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (model.mode == AppMode.LIVE) {
            Button({ model.refreshQuestions() }, enabled = !model.isLoadingQuestions) {
                Text(if (model.isLoadingQuestions) "Checking…" else "Check for questions")
            }
        }
        if (model.questions.isEmpty()) Text("No open questions.")
        LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(model.questions, key = { it.token }) { item ->
                val busy = item.token in model.answering
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("${Display.escape(item.caseTitle)} · ${Display.escape(item.nodeName)}", style = MaterialTheme.typography.labelSmall)
                    Text(Display.escape(item.text), fontWeight = if (item.urgency == "high") FontWeight.Bold else FontWeight.Normal)
                    if (item.kind == "briefing") {
                        OutlinedButton({ model.answer(item, null, "ok") }, enabled = !busy) { Text("Got it") }
                    } else {
                        item.options.forEach { option ->
                            OutlinedButton({ model.answer(item, option.id, null) }, enabled = !busy) { Text(Display.escape(option.label)) }
                        }
                        val draft = drafts[item.token] ?: ""
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(draft, { drafts[item.token] = it }, label = { Text("Answer…") }, modifier = Modifier.weight(1f))
                            Button({ model.answer(item, null, draft.trim()) }, enabled = !busy && draft.isNotBlank()) { Text("Send") }
                        }
                    }
                }
                HorizontalDivider(Modifier.padding(top = 8.dp))
            }
        }
    }
}
