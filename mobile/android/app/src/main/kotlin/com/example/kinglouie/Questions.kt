package com.example.kinglouie

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.kinglouie.protocol.Display

/**
 * Cases stage 4: questions from the nodes, each answered with a fresh
 * biometric signature the node verifies. Loaded only when the owner taps
 * Refresh: every relay request is a fingerprint prompt on this phone.
 */
@Composable
fun Questions(model: AppModel) {
    val drafts = remember { mutableStateMapOf<String, String>() }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { ScreenTitle("Questions") }
        if (model.questions.isEmpty()) {
            item { EmptyState("No open questions.") }
        }
        items(model.questions, key = { it.token }) { item ->
            val busy = item.token in model.answering
            ItemCard {
                Secondary("${Display.escape(item.caseTitle)} · ${Display.escape(item.nodeName)}")
                Text(
                    Display.escape(item.text), style = MaterialTheme.typography.bodyLarge,
                    fontWeight = if (item.urgency == "high") FontWeight.Bold else FontWeight.Normal
                )
                if (item.kind == "briefing") {
                    Button({ model.answer(item, null, "ok") }, Modifier.fillMaxWidth().height(DecisionHeight), enabled = !busy) { Text("Got it") }
                } else {
                    item.options.forEach { option ->
                        OutlinedButton({ model.answer(item, option.id, null) }, Modifier.fillMaxWidth(), enabled = !busy) { Text(Display.escape(option.label)) }
                    }
                    val draft = drafts[item.token] ?: ""
                    val tooLong = draft.trim().length > AppModel.MAX_ANSWER_CHARS
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            draft, { drafts[item.token] = it }, label = { Text("Answer…") }, modifier = Modifier.weight(1f),
                            isError = tooLong,
                            supportingText = if (tooLong) ({ Text("At most ${AppModel.MAX_ANSWER_CHARS} characters.") }) else null
                        )
                        Button({ model.answer(item, null, draft.trim()) }, enabled = !busy && draft.isNotBlank() && !tooLong) { Text("Send") }
                    }
                }
            }
        }
    }
}
