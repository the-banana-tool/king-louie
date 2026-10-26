package com.example.kinglouie

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// The static scheme, used where the system offers no dynamic colours. Every
// on-colour is at least 4.5:1 on the colour it sits on, in both modes.
private val LightColors = lightColorScheme(
    primary = Color(0xFF2B5A8C),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFD3E4FF),
    onPrimaryContainer = Color(0xFF001C38),
    secondary = Color(0xFF545F71),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFD8E3F8),
    onSecondaryContainer = Color(0xFF111C2B),
    error = Color(0xFFBA1A1A),
    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
    background = Color(0xFFF8F9FF),
    onBackground = Color(0xFF191C20),
    surface = Color(0xFFF8F9FF),
    onSurface = Color(0xFF191C20),
    surfaceVariant = Color(0xFFDFE2EB),
    onSurfaceVariant = Color(0xFF43474E),
    outline = Color(0xFF73777F)
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFA2C9FF),
    onPrimary = Color(0xFF00315C),
    primaryContainer = Color(0xFF0E4881),
    onPrimaryContainer = Color(0xFFD3E4FF),
    secondary = Color(0xFFBCC7DB),
    onSecondary = Color(0xFF263141),
    secondaryContainer = Color(0xFF3C4758),
    onSecondaryContainer = Color(0xFFD8E3F8),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
    background = Color(0xFF111418),
    onBackground = Color(0xFFE1E2E8),
    surface = Color(0xFF111418),
    onSurface = Color(0xFFE1E2E8),
    surfaceVariant = Color(0xFF43474E),
    onSurfaceVariant = Color(0xFFC3C6CF),
    outline = Color(0xFF8D9199)
)

/**
 * Colours the Material scheme has no slot for: the demo banner and the
 * warnings. Fixed, not dynamic, so a wallpaper never makes a warning look
 * like ordinary text. Each pair is at least 4.5:1.
 */
@Immutable
data class StatusColors(
    val demoContainer: Color,
    val onDemoContainer: Color,
    /** Warning text on the ordinary surface. */
    val warning: Color,
    /** A row about something running on a computer (the lease banner). */
    val alertContainer: Color,
    val onAlertContainer: Color,
    val online: Color,
    val offline: Color
)

private val LightStatus = StatusColors(
    demoContainer = Color(0xFFFFE08A),
    onDemoContainer = Color(0xFF2A1F00),
    warning = Color(0xFF8A4F00),
    alertContainer = Color(0xFFFFDAD6),
    onAlertContainer = Color(0xFF410002),
    online = Color(0xFF1E7B34),
    offline = Color(0xFF73777F)
)

private val DarkStatus = StatusColors(
    demoContainer = Color(0xFF5A4500),
    onDemoContainer = Color(0xFFFFE08A),
    warning = Color(0xFFFFB95C),
    alertContainer = Color(0xFF5C1313),
    onAlertContainer = Color(0xFFFFDAD6),
    online = Color(0xFF7BDA8F),
    offline = Color(0xFF8D9199)
)

val LocalStatusColors = staticCompositionLocalOf { LightStatus }

/** Body text a little larger than Material's default: the app is read at arm's length, on the move. */
private val AppTypography = Typography().let { t ->
    t.copy(
        bodyLarge = t.bodyLarge.copy(fontSize = 17.sp, lineHeight = 24.sp),
        bodyMedium = t.bodyMedium.copy(fontSize = 16.sp, lineHeight = 22.sp),
        bodySmall = t.bodySmall.copy(fontSize = 14.sp, lineHeight = 20.sp),
        titleMedium = t.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        labelLarge = t.labelLarge.copy(fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    )
}

/** Monospace text (ids, fingerprints, commands) in the body size. */
val MonoStyle = TextStyle(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, fontSize = 15.sp, lineHeight = 21.sp)

/** Follows the system light/dark setting; dynamic (Material You) colours on Android 12 and later. */
@Composable
fun KingLouieTheme(darkTheme: Boolean = isSystemInDarkTheme(), dynamicColor: Boolean = true, content: @Composable () -> Unit) {
    val context = LocalContext.current
    val colors: ColorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        darkTheme -> DarkColors
        else -> LightColors
    }
    androidx.compose.runtime.CompositionLocalProvider(LocalStatusColors provides if (darkTheme) DarkStatus else LightStatus) {
        MaterialTheme(colorScheme = colors, typography = AppTypography, content = content)
    }
}

/** The app's status colours, for the current light/dark mode. */
val statusColors: StatusColors
    @Composable get() = LocalStatusColors.current
