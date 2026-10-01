plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "de.robinlenz.wave"
    compileSdk = 35

    defaultConfig {
        applicationId = "de.robinlenz.wave"
        // VpnService.Builder.addDisallowedApplication and the DNS handling
        // below want a recent platform; nothing here is worth supporting an
        // older one for.
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    sourceSets["main"].java.srcDirs("src/main/kotlin")

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        jvmToolchain(17)
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

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    // The enrolment keys go here and nowhere else.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
}
