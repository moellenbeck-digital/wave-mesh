// The Go core is not a Gradle project: `mobile/build.sh android` turns it into
// app/libs/wavemobile.aar, and that file is what this build consumes. Keeping
// it out of Gradle is deliberate -- gomobile needs the NDK and a Go toolchain,
// and a Gradle task that shells out to both would fail in a way that reads like
// a Kotlin problem.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "wave"
include(":app")
