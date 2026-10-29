---
id: T09
title: Desktop tokens, dark-only theme, Ui wearing the tokens; drift test
status: done (merge f69f686f)
blocked_by: []
---
## Goal
`KlTokens` mirrors `styles.css`'s `:root`; the theme is dark only; a node test
holds them equal.

## Spec sections
§11.1 to §11.4, R-AN-8, C-16.

## Files
New `mobile/android/app/src/main/kotlin/com/example/kinglouie/Tokens.kt`;
rewritten `Theme.kt` (`KingLouieTheme()` with no parameters; `StatusColors`
keeps `warning`, `warningBg`, `online`, `offline`; the demo colours go when
nothing uses them, otherwise T11/T12 remove them and the ledger says so);
`Ui.kt` restyled with the same public composable signatures (other tickets
rewrite the screens); `res/values/themes.xml` dark window `kl_window`
`#FF1E1E2E`; delete `res/values-night/`; new
`tests/mobile-design-tokens.test.js`.

## Acceptance
`node --test tests/mobile-design-tokens.test.js` passes every §11.4 assertion.
If "no other `Color(0x…)` literal" or "no `textMuted` `Text`" cannot pass until
the screens are rewritten, write them as `todo` with the reason (here and in
the ledger); T12 lifts the `todo`. The app compiles
(`./gradlew :app:compileNopushDebugKotlin`, JDK 17) if the build works here.
