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
import androidx.compose.material3.HorizontalDivider
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
    Text(text, modifier.padding(top = 8.dp, bottom = 4.dp), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, color = KlTokens.textPrimary)
}

/** A heading inside a screen. */
@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.padding(top = 12.dp, bottom = 2.dp), style = MaterialTheme.typography.titleMedium, color = KlTokens.accent)
}

/** Secondary text that must still be read: textSecondary, never textMuted. */
@Composable
fun Secondary(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, style = MaterialTheme.typography.bodyMedium, color = KlTokens.textSecondary)
}

/** What an empty list means and what to do about it: the info tint, the large radius. */
@Composable
fun EmptyState(text: String, modifier: Modifier = Modifier) {
    Surface(
        modifier.fillMaxWidth().padding(vertical = 8.dp), shape = RoundedCornerShape(KlTokens.radiusLg),
        color = KlTokens.infoBg, border = BorderStroke(1.dp, KlTokens.borderSubtle)
    ) {
        Text(text, Modifier.padding(16.dp), style = MaterialTheme.typography.bodyLarge, color = KlTokens.textPrimary)
    }
}

/** A sub-screen's top bar on bgSidebar: back, and what this screen is. */
@Composable
fun BackBar(title: String, onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth().background(KlTokens.bgSidebar).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = KlTokens.textPrimary) }
        Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 1, color = KlTokens.textPrimary)
    }
}

/** A list row: bgSurface (or a tint over it), the large radius, a subtle border. */
@Composable
fun ItemCard(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, color: Color = KlTokens.bgSurface, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(KlTokens.radiusLg)
    val border = BorderStroke(1.dp, KlTokens.borderSubtle)
    if (onClick != null) {
        Surface(onClick = onClick, modifier = modifier.fillMaxWidth(), shape = shape, color = color, contentColor = KlTokens.textPrimary, border = border) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { content() }
        }
    } else {
        Surface(modifier = modifier.fillMaxWidth(), shape = shape, color = color, contentColor = KlTokens.textPrimary, border = border) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { content() }
        }
    }
}

/** Time left, or a request's status, as a pill; red in the last minute. */
@Composable
fun TimePill(text: String, urgent: Boolean) {
    val bg = if (urgent) KlTokens.errorBg else KlTokens.bgOverlay
    val fg = if (urgent) KlTokens.error else KlTokens.textSecondary
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
            color = if (online == true) status.online else KlTokens.textSecondary
        )
    }
}

/** Approve: filled in the accent, bgBase text, the medium radius. */
@Composable
fun RowScope.ApproveButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    Button(
        onClick, Modifier.weight(1f).height(DecisionHeight), enabled = enabled,
        shape = RoundedCornerShape(KlTokens.radiusMd), colors = approveColors()
    ) { Text(label, style = MaterialTheme.typography.labelLarge) }
}

@Composable
fun approveColors() = ButtonDefaults.buttonColors(
    containerColor = KlTokens.accent,
    contentColor = KlTokens.bgBase,
    disabledContainerColor = KlTokens.accentDim,
    disabledContentColor = KlTokens.textMuted // disabled
)

/** Deny: outlined in the error colour, so it never looks like Approve. */
@Composable
fun RowScope.DenyButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    OutlinedButton(
        onClick, Modifier.weight(1f).height(DecisionHeight), enabled = enabled,
        shape = RoundedCornerShape(KlTokens.radiusMd), colors = denyColors(), border = denyBorder(enabled)
    ) { Text(label, style = MaterialTheme.typography.labelLarge) }
}

@Composable
fun denyColors() = ButtonDefaults.outlinedButtonColors(
    contentColor = KlTokens.error,
    disabledContentColor = KlTokens.textMuted // disabled
)

@Composable
fun denyBorder(enabled: Boolean) = BorderStroke(2.dp, if (enabled) KlTokens.error else KlTokens.textFaint)

/** A filled red button (Stop, Revoke): the error fill, bgBase text. */
@Composable
fun stopColors() = ButtonDefaults.buttonColors(
    containerColor = KlTokens.error,
    contentColor = KlTokens.bgBase,
    disabledContainerColor = KlTokens.accentDim,
    disabledContentColor = KlTokens.textMuted // disabled
)

/** The decision buttons at the bottom of a detail screen, full width, above the navigation bar, on bgElevated. */
@Composable
fun DecisionBar(content: @Composable RowScope.() -> Unit) {
    Surface(Modifier.fillMaxWidth(), color = KlTokens.bgElevated, contentColor = KlTokens.textPrimary) {
        Column {
            HorizontalDivider(color = KlTokens.borderSubtle)
            Row(Modifier.fillMaxWidth().padding(PaddingValues(horizontal = 16.dp, vertical = 12.dp)), horizontalArrangement = Arrangement.spacedBy(12.dp), content = content)
        }
    }
}

/** Monospace text on bgOverlay with the small radius: ids, commands, parameters. */
@Composable
fun CodeBlock(text: String, modifier: Modifier = Modifier, color: Color = KlTokens.textPrimary) {
    Surface(modifier.fillMaxWidth().heightIn(min = 0.dp), shape = RoundedCornerShape(KlTokens.radiusSm), color = KlTokens.bgOverlay) {
        Text(text, Modifier.padding(horizontal = 10.dp, vertical = 8.dp), style = MonoStyle, color = color)
    }
}
