plugins {
    id("com.android.application") version "9.4.1" apply false
    // AGP 9 compiles Kotlin itself (built-in Kotlin). This line is never
    // applied: it only puts this Kotlin Gradle plugin on the classpath, so the
    // app builds with the same Kotlin as the protocol build.
    id("org.jetbrains.kotlin.android") version "2.4.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
    id("com.google.gms.google-services") version "4.5.0" apply false
}
