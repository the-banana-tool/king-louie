// The approval-v1 protocol core, a plain JVM library so its tests run without
// the Android SDK: `../gradlew test` in this directory. The app includes it as
// a composite build (../settings.gradle.kts).
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

rootProject.name = "protocol"
