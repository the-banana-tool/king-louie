package com.example.kinglouie

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// The app's one colour scheme: dark, built from the desktop's tokens
// (KlTokens, spec §11.2). There is no light scheme and no dynamic (wallpaper)
// colour: the app looks like the desktop whatever the system setting.
// Every pair a person reads is at least 4.5:1 (tests/mobile-design-tokens.test.js).
private val KlColors = darkColorScheme(
    primary = KlTokens.accent,
    onPrimary = KlTokens.bgBase,
    primaryContainer = KlTokens.accentSurface,
    onPrimaryContainer = KlTokens.accent,
    inversePrimary = KlTokens.accentDim,
    secondary = KlTokens.textSecondary,
    onSecondary = KlTokens.bgBase,
    secondaryContainer = KlTokens.bgOverlay,
    onSecondaryContainer = KlTokens.textPrimary,
    tertiary = KlTokens.info,
    onTertiary = KlTokens.bgBase,
    tertiaryContainer = KlTokens.infoBg,
    onTertiaryContainer = KlTokens.textPrimary,
    error = KlTokens.error,
    onError = KlTokens.bgBase,
    errorContainer = KlTokens.errorBg,
    onErrorContainer = KlTokens.error,
    background = KlTokens.bgBase,
    onBackground = KlTokens.textPrimary,
    surface = KlTokens.bgBase,
    onSurface = KlTokens.textPrimary,
    surfaceVariant = KlTokens.bgOverlay,
    onSurfaceVariant = KlTokens.textSecondary,
    inverseSurface = KlTokens.textPrimary,
    inverseOnSurface = KlTokens.bgBase,
    // No tonal tint: a surface is exactly its token.
    surfaceTint = Color.Transparent,
    outline = KlTokens.borderDefault,
    outlineVariant = KlTokens.borderSubtle,
    surfaceBright = KlTokens.bgOverlay,
    surfaceDim = KlTokens.bgSidebar,
    surfaceContainerLowest = KlTokens.bgSidebarHdr,
    surfaceContainerLow = KlTokens.bgSidebar,
    surfaceContainer = KlTokens.bgSurface,
    surfaceContainerHigh = KlTokens.bgElevated,
    surfaceContainerHighest = KlTokens.bgOverlay
)

/** Colours the Material scheme has no slot for. */
@Immutable
data class StatusColors(
    /** Warning text: paused, "Could not confirm with …", limits, a take's unattended line. */
    val warning: Color,
    /** A warning row's tint. */
    val warningBg: Color,
    val online: Color,
    /** The offline dot only; never text a person must read. */
    val offline: Color,
    // The two below are used only by today's lease banner (LeaseScreens.kt).
    // They go when that screen is rewritten (T12); do not use them in new code.
    val alertContainer: Color,
    val onAlertContainer: Color
)

private val KlStatus = StatusColors(
    warning = KlTokens.warning,
    warningBg = KlTokens.warningBg,
    online = KlTokens.success,
    offline = KlTokens.textMuted,
    alertContainer = KlTokens.errorBg,
    onAlertContainer = KlTokens.textPrimary
)

val LocalStatusColors = staticCompositionLocalOf { KlStatus }

/**
 * System sans (FontFamily.Default) in the phone's own sizes, a little larger
 * than Material's default: the app is read at arm's length, on the move.
 * These sizes are not tokens (spec §11.3).
 */
private val AppTypography = Typography().let { t ->
    t.copy(
        bodyLarge = t.bodyLarge.copy(fontSize = 17.sp, lineHeight = 24.sp),
        bodyMedium = t.bodyMedium.copy(fontSize = 16.sp, lineHeight = 22.sp),
        bodySmall = t.bodySmall.copy(fontSize = 14.sp, lineHeight = 20.sp),
        titleMedium = t.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        labelLarge = t.labelLarge.copy(fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    )
}

/** Monospace text (codes, fingerprints, ids, the relay pin, parameters, commands) in the body size. */
val MonoStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 15.sp, lineHeight = 21.sp)

/** The app's theme: the desktop's dark palette, always. */
@Composable
fun KingLouieTheme(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalStatusColors provides KlStatus) {
        MaterialTheme(colorScheme = KlColors, typography = AppTypography, content = content)
    }
}

/** The app's status colours. */
val statusColors: StatusColors
    @Composable get() = LocalStatusColors.current
