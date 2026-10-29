package com.example.kinglouie

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * The desktop's design tokens: the first `:root` block of `styles.css`
 * ("King Louie – Dark UI Theme"), one `val` per CSS variable, camel-cased
 * (`--bg-base` -> `bgBase`). `tests/mobile-design-tokens.test.js` holds the
 * two equal, so a change to the desktop palette fails until this file
 * follows. An `rgba` token is `Color(red, green, blue, alpha)` with the
 * alpha rounded to a byte (0.08 -> 0x14, 0.06 -> 0x0F). Not carried:
 * `--transition`, `--font-sans`, `--font-mono`.
 *
 * Every other Kotlin file takes its colours from here (through the theme or
 * directly), never from a literal.
 */
object KlTokens {
    // Surfaces
    val bgBase = Color(0xFF1E1E2E)
    val bgSurface = Color(0xFF232334)
    val bgElevated = Color(0xFF2A2A3C)
    val bgOverlay = Color(0xFF313244)
    val bgSidebar = Color(0xFF181825)
    val bgSidebarHdr = Color(0xFF11111B)
    val bgInput = Color(0xFF1E1E2E)

    // Borders
    val borderSubtle = Color(0xFF2E2E42)
    val borderDefault = Color(0xFF3B3B52)
    val borderStrong = Color(0xFF4E4E66)

    // Text. textMuted is 3.4:1 on bgBase: disabled text and the offline dot
    // only, never text a person must read.
    val textPrimary = Color(0xFFCDD6F4)
    val textSecondary = Color(0xFFA6ADC8)
    val textMuted = Color(0xFF6C7086)
    val textFaint = Color(0xFF45475A)

    // Accent
    val accent = Color(0xFF89B4FA)
    val accentDim = Color(0xFF45475A)
    val accentSurface = Color(137, 180, 250, 0x14)

    // Semantic
    val success = Color(0xFFA6E3A1)
    val successBg = Color(166, 227, 161, 0x14)
    val error = Color(0xFFF38BA8)
    val errorBg = Color(243, 139, 168, 0x14)
    val warning = Color(0xFFFAB387)
    val warningBg = Color(250, 179, 135, 0x14)
    val info = Color(0xFF89B4FA)
    val infoBg = Color(137, 180, 250, 0x0F)

    // Misc
    val radiusSm = 6.dp
    val radiusMd = 10.dp
    val radiusLg = 14.dp
}
