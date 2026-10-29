import java.util.Properties

plugins {
    // AGP 9 compiles Kotlin itself, so there is no org.jetbrains.kotlin.android here.
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.example.kinglouie"
    compileSdk = 37

    defaultConfig {
        applicationId = localProperties.getProperty("kl.applicationId", "com.example.kinglouie")
        // Ed25519 in java.security from API 33 (spec §12).
        minSdk = 33
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"
    }

    flavorDimensions += "push"
    productFlavors {
        create("fcm") { dimension = "push" }
        create("nopush") { dimension = "push" }
    }

    buildFeatures { compose = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation("com.example.kinglouie:protocol:1.0")
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.fragment:fragment-ktx:1.9.1")
    // ProcessLifecycleOwner: the foreground loop starts and stops with the app (android-slim §9).
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    implementation("androidx.biometric:biometric:1.1.0")
    // 1.4.2 and later ship 16 KB-aligned native libraries (1.3.4 did not).
    implementation("androidx.camera:camera-camera2:1.6.2")
    implementation("androidx.camera:camera-lifecycle:1.6.2")
    implementation("androidx.camera:camera-view:1.6.2")
    implementation("com.google.zxing:core:3.5.4")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    "fcmImplementation"("com.google.firebase:firebase-messaging:26.0.1")
}

// Only an owner who configured their own Firebase project gets the plugin.
if (file("src/fcm/google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
