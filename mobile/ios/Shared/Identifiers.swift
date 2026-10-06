import Foundation

/// The identifiers both halves of the app have to agree on. They are registered
/// in the Apple Developer account of Moellenbeck-Digital UG (team L6R92A4Y7C)
/// and cannot change once the app is in the store; `project.yml` uses the same
/// strings for the bundle identifiers and entitlements.
enum WaveIdentifiers {
    /// Shared container: the extension leaves the enrolment link here for the
    /// app, which cannot be asked through a provider message while the tunnel
    /// is still starting.
    static let appGroup = "group.org.wavemesh.app"
    /// The packet tunnel extension the app installs as its VPN configuration.
    static let tunnelBundleIdentifier = "org.wavemesh.app.tunnel"
}

/// The enrolment link, passed from the extension to the app through the
/// shared defaults: the extension has no window to open a browser in.
enum PendingAuth {
    static let key = "pendingAuthURL"

    static var url: URL? {
        UserDefaults(suiteName: WaveIdentifiers.appGroup)?.string(forKey: key).flatMap(URL.init(string:))
    }

    static func clear() {
        UserDefaults(suiteName: WaveIdentifiers.appGroup)?.removeObject(forKey: key)
    }
}
