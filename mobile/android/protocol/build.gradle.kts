plugins {
    kotlin("jvm") version "2.4.21"
}

group = "com.example.kinglouie"
version = "1.0"

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    // Ed25519 in software (Ed25519.kt): Android 16's java.security has only the Keystore's.
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")
    testImplementation("junit:junit:4.13.2")
}

// The vectors the node and iOS use too. `-Dkl.vectors=<dir>`,
// `-Dkl.grantVectors=<dir>` and `-Dkl.leaseVectors=<dir>` override the
// in-repo paths (for a build that mounts the vectors somewhere else).
val vectorsDir: String = providers.systemProperty("kl.vectors")
    .orElse(projectDir.resolve("../../../tests/vectors/approval-v1").canonicalPath)
    .get()
val grantVectorsDir: String = providers.systemProperty("kl.grantVectors")
    .orElse(projectDir.resolve("../../../tests/vectors/client-grant-v1").canonicalPath)
    .get()
val leaseVectorsDir: String = providers.systemProperty("kl.leaseVectors")
    .orElse(projectDir.resolve("../../../tests/vectors/lease-v1").canonicalPath)
    .get()

tasks.test {
    inputs.dir(vectorsDir)
    inputs.dir(grantVectorsDir)
    inputs.dir(leaseVectorsDir)
    systemProperty("kl.vectors", vectorsDir)
    systemProperty("kl.grantVectors", grantVectorsDir)
    systemProperty("kl.leaseVectors", leaseVectorsDir)
    testLogging {
        events("passed", "skipped", "failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
