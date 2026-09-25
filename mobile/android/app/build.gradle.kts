import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.example.kinglouie"
    compileSdk = 34

    defaultConfig {
        applicationId = localProperties.getProperty("kl.applicationId", "com.example.kinglouie")
        // Ed25519 in java.security from API 33 (spec §12).
        minSdk = 33
        targetSdk = 34
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
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("com.example.kinglouie:protocol:1.0")
    implementation(platform("androidx.compose:compose-bom:2024.09.02"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.fragment:fragment-ktx:1.8.3")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    implementation("com.google.zxing:core:3.5.3")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    "fcmImplementation"("com.google.firebase:firebase-messaging:24.0.1")
}

// Only an owner who configured their own Firebase project gets the plugin.
if (file("src/fcm/google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
