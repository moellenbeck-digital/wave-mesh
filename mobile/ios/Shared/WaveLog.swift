import Foundation

/// A log both halves write to and the app can show and share.
///
/// The extension has no window, and Console.app needs a Mac and a cable: on a
/// phone in somebody's pocket this file is the only way to see why a name did
/// not resolve or a second wave did not come up. It stays on the device and
/// leaves it only when the person shares it -- the same promise the disclosure
/// makes. Lines are kept to the last few hundred kilobytes.
enum WaveLog {
    private static let limit = 512 * 1024
    private static let queue = DispatchQueue(label: "org.wavemesh.log")

    static var fileURL: URL? {
        // The shared container is what lets the app read what the extension
        // wrote. A build without the app group entitlement (the simulator's
        // unsigned test builds) has none; the app's own caches are better
        // than writing nowhere.
        let shared = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: WaveIdentifiers.appGroup)
        let directory = shared ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        return directory?.appendingPathComponent("wave.log")
    }

    /// Who wrote a line: the extension runs the core, the app only asks it.
    enum Source: String {
        case app
        case tunnel
    }

    static func write(_ line: String, from source: Source) {
        NSLog("[wave] %@", line)
        guard let url = fileURL else { return }
        let stamp = ISO8601DateFormatter().string(from: Date())
        let entry = Data("\(stamp) [\(source.rawValue)] \(line)\n".utf8)
        queue.async {
            if let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: entry)
                if let size = try? handle.offset(), size > UInt64(limit) {
                    trim(url)
                }
            } else {
                try? entry.write(to: url, options: .atomic)
            }
        }
    }

    static func read() -> String {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    static func clear() {
        guard let url = fileURL else { return }
        queue.async { try? Data().write(to: url, options: .atomic) }
    }

    /// Keeps the newer half, cut at a line boundary.
    private static func trim(_ url: URL) {
        guard let data = try? Data(contentsOf: url) else { return }
        var tail = data.suffix(limit / 2)
        if let newline = tail.firstIndex(of: UInt8(ascii: "\n")) {
            tail = tail[tail.index(after: newline)...]
        }
        try? Data(tail).write(to: url, options: .atomic)
    }
}
