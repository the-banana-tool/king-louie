package com.example.kinglouie

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

// Shared pieces of the screens. Layout only: nothing here calls the model,
// so every action stays in the screen that names it.

/** The height of a decision button: big enough to hit with a thumb on the move. */
val DecisionHeight = 56.dp

/** A screen's heading. */
@Composable
fun ScreenTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.padding(top = 8.dp, bottom = 4.dp), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
}

/** A heading inside a screen. */
@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.padding(top = 12.dp, bottom = 2.dp), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
}

/** Secondary text that must still be read: onSurfaceVariant, never a grey on grey. */
@Composable
fun Secondary(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** What an empty list means and what to do about it. */
@Composable
fun EmptyState(text: String, modifier: Modifier = Modifier) {
    Surface(modifier.fillMaxWidth().padding(vertical = 8.dp), shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Text(text, Modifier.padding(16.dp), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
    }
}

/** A sub-screen's top row: back, and what this screen is. */
@Composable
fun BackBar(title: String, onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
        Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 1)
    }
}

/** A list card. */
@Composable
fun ItemCard(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    val color = MaterialTheme.colorScheme.surfaceContainer
    if (onClick != null) {
        Surface(onClick = onClick, modifier = modifier.fillMaxWidth(), shape = shape, color = color, tonalElevation = 1.dp) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { content() }
        }
    } else {
        Surface(modifier = modifier.fillMaxWidth(), shape = shape, color = color, tonalElevation = 1.dp) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { content() }
        }
    }
}

/** Time left, or a request's status, as a pill; red in the last minute. */
@Composable
fun TimePill(text: String, urgent: Boolean) {
    val bg = if (urgent) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer
    val fg = if (urgent) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSecondaryContainer
    Surface(shape = RoundedCornerShape(50), color = bg) {
        Text(text, Modifier.padding(horizontal = 12.dp, vertical = 4.dp), color = fg, style = MaterialTheme.typography.labelLarge)
    }
}

/** Online or offline, as a dot and the word (the colour is never the only sign). */
@Composable
fun OnlineDot(online: Boolean?) {
    val status = statusColors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(10.dp).background(if (online == true) status.online else status.offline, CircleShape))
        Text(
            when (online) { true -> "online"; false -> "offline"; null -> "not checked" },
            style = MaterialTheme.typography.bodyMedium,
            color = if (online == true) status.online else MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

/** Approve: filled, in the primary colour. */
@Composable
fun RowScope.ApproveButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    Button(onClick, Modifier.weight(1f).height(DecisionHeight), enabled = enabled) { Text(label, style = MaterialTheme.typography.labelLarge) }
}

/** Deny: outlined in the error colour, so it never looks like Approve. */
@Composable
fun RowScope.DenyButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    OutlinedButton(
        onClick, Modifier.weight(1f).height(DecisionHeight), enabled = enabled,
        colors = denyColors(), border = denyBorder(enabled)
    ) { Text(label, style = MaterialTheme.typography.labelLarge) }
}

@Composable
fun denyColors() = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)

@Composable
fun denyBorder(enabled: Boolean) = BorderStroke(2.dp, if (enabled) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f))

/** A filled red button (Stop, Revoke): red container, its own on-colour. */
@Composable
fun stopColors() = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError)

/** The decision buttons at the bottom of a detail screen, full width, above the navigation bar. */
@Composable
fun DecisionBar(content: @Composable RowScope.() -> Unit) {
    Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainerHigh, tonalElevation = 3.dp) {
        Row(Modifier.fillMaxWidth().padding(PaddingValues(horizontal = 16.dp, vertical = 12.dp)), horizontalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}

/** Monospace text on a tinted block: ids, commands, parameters. */
@Composable
fun CodeBlock(text: String, modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.onSurface) {
    Surface(modifier.fillMaxWidth().heightIn(min = 0.dp), shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceContainerHighest) {
        Text(text, Modifier.padding(horizontal = 10.dp, vertical = 8.dp), style = MonoStyle, color = color)
    }
}
