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

/// The name this device asks for when it joins a wave. Set in the app, read by
/// the extension; the shared defaults are the one place both can see.
enum DeviceName {
    private static let key = "deviceName"

    static var stored: String? {
        let value = UserDefaults(suiteName: WaveIdentifiers.appGroup)?.string(forKey: key)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return value?.isEmpty == false ? value : nil
    }

    static func store(_ name: String) {
        UserDefaults(suiteName: WaveIdentifiers.appGroup)?.set(name, forKey: key)
    }

    /// The name as it will appear in the wave. The control server keeps
    /// [a-z0-9-] and turns everything else into a hyphen, which makes
    /// "Möllenbeck" into "m-llenbeck"; folding first keeps it readable, and the
    /// app shows the result before anybody joins with it.
    static func label(_ name: String) -> String {
        var folded = name.lowercased()
        for (from, to) in [("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")] {
            folded = folded.replacingOccurrences(of: from, with: to)
        }
        folded = folded.applyingTransform(.stripDiacritics, reverse: false) ?? folded
        var label = ""
        var lastWasHyphen = false
        for character in folded.unicodeScalars {
            if ("a"..."z").contains(character) || ("0"..."9").contains(character) {
                label.unicodeScalars.append(character)
                lastWasHyphen = false
            } else if !lastWasHyphen {
                label.append("-")
                lastWasHyphen = true
            }
        }
        label = label.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return String(label.prefix(63))
    }
}
