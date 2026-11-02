plugins {
    // AGP 9 compiles Kotlin itself; the separate kotlin-android plugin is gone.
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "org.wavemesh.app"
    // Compose needs the newest SDK to compile against; what the app opts in to
    // at runtime is targetSdk below.
    compileSdk = 37

    defaultConfig {
        // Registered in the Play Console of Moellenbeck-Digital UG; it can
        // never change once the app is published.
        applicationId = "org.wavemesh.app"
        // VpnService.Builder.addDisallowedApplication and the DNS handling
        // below want a recent platform; nothing here is worth supporting an
        // older one for.
        minSdk = 29
        // Google Play takes new apps and updates only at the current level.
        targetSdk = 36
        versionCode = 1
        versionName = "0.9.0"
    }

    sourceSets["main"].java.srcDirs("src/main/kotlin")
    sourceSets["test"].java.srcDirs("src/test/kotlin")

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        // gomobile ships the core for every architecture in one .aar; nothing
        // here may strip it.
        jniLibs.keepDebugSymbols += "**/libgojni.so"
    }
}

dependencies {
    // Built by `mobile/build.sh android`, not by Gradle. It is not in the repo:
    // it is 30 MB of compiled Go, and it is reproducible from the source beside
    // it.
    implementation(files("libs/wavemobile.aar"))

    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    // The core set only; the few symbols beyond it are drawn in WaveIcons.
    implementation("androidx.compose.material:material-icons-core")
    // The approval page opens in a Custom Tab, which shares the browser's sign-in.
    implementation("androidx.browser:browser:1.9.0")
    // The enrolment keys go here and nowhere else.
    implementation("androidx.security:security-crypto:1.1.0")

    testImplementation("junit:junit:4.13.2")
    // Android's own org.json is a stub under unit tests.
    testImplementation("org.json:json:20250517")
}
