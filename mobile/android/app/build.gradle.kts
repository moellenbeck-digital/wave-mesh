import java.util.Base64

plugins {
    // AGP 9 compiles Kotlin itself; the separate kotlin-android plugin is gone.
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

fun env(name: String): String? = System.getenv(name)?.takeIf { it.isNotBlank() }

// The store version has one home: MARKETING_VERSION in the iOS project, so both
// stores show the same number. VERSION_NAME overrides it for a one-off build.
val storeVersion: String = env("VERSION_NAME")
    ?: Regex("""MARKETING_VERSION:\s*"([^"]+)"""")
        .find(rootProject.file("../ios/project.yml").readText())
        ?.groupValues?.get(1)
    ?: error("MARKETING_VERSION not found in mobile/ios/project.yml")

// Release signing comes from the environment only, never from the repo:
// ANDROID_UPLOAD_KEYSTORE_BASE64 (or ANDROID_UPLOAD_KEYSTORE_PATH),
// ANDROID_UPLOAD_KEYSTORE_PASSWORD, ANDROID_UPLOAD_KEY_ALIAS and
// ANDROID_UPLOAD_KEY_PASSWORD (defaults to the store password).
val uploadKeystore: File? = env("ANDROID_UPLOAD_KEYSTORE_PATH")?.let(::file)
    ?: env("ANDROID_UPLOAD_KEYSTORE_BASE64")?.let { encoded ->
        layout.buildDirectory.file("signing/upload.jks").get().asFile.apply {
            parentFile.mkdirs()
            writeBytes(Base64.getMimeDecoder().decode(encoded))
        }
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
        // The Play workflow sets the next free number; a local build stays at 1.
        versionCode = env("VERSION_CODE")?.toInt() ?: 1
        versionName = storeVersion
    }

    signingConfigs {
        if (uploadKeystore != null) {
            create("upload") {
                storeFile = uploadKeystore
                storePassword = env("ANDROID_UPLOAD_KEYSTORE_PASSWORD")
                keyAlias = env("ANDROID_UPLOAD_KEY_ALIAS")
                keyPassword = env("ANDROID_UPLOAD_KEY_PASSWORD")
                    ?: env("ANDROID_UPLOAD_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("upload")
            // R8 stays off: the gomobile bindings (go.*, wavemobile.*) are
            // reached through JNI by name, and a missing keep rule would only
            // show as a crash at start. The core is most of the bundle anyway.
            isMinifyEnabled = false
        }
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

// A release bundle without the upload key would be rejected by Play, so stop
// before building one rather than after.
tasks.matching { it.name == "bundleRelease" || it.name == "assembleRelease" }.configureEach {
    doFirst {
        val missing = listOf("ANDROID_UPLOAD_KEYSTORE_PASSWORD", "ANDROID_UPLOAD_KEY_ALIAS")
            .filter { env(it) == null } +
            (if (uploadKeystore == null) listOf("ANDROID_UPLOAD_KEYSTORE_BASE64 or ANDROID_UPLOAD_KEYSTORE_PATH") else emptyList())
        if (missing.isNotEmpty()) {
            throw GradleException(
                "Release signing is not configured. Missing: ${missing.joinToString()}. " +
                    "See mobile/README.md, section Release-Build."
            )
        }
    }
}
