import Foundation

/// The link a QR code in the web interface carries: `wavemesh://join?server=<url>`.
///
/// Nothing but the control server's address -- what `wave login <url>` takes on
/// the desktop, in a form a camera can read. Opening it never joins anything by
/// itself: the app asks first, and the browser approval still follows, so a
/// code somebody else printed grants nothing.
enum WaveInvite {
    static let scheme = "wavemesh"

    /// The server a link names, or nil for anything that is not such a link or
    /// names something other than an http(s) address.
    static func server(from url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == "join",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let value = components.queryItems?.first(where: { $0.name == "server" })?.value,
              let server = URL(string: value),
              let serverScheme = server.scheme?.lowercased(), serverScheme == "https" || serverScheme == "http",
              let host = server.host, !host.isEmpty
        else { return nil }
        // Only the origin: a path or query in a printed code is not ours to follow.
        var origin = "\(serverScheme)://\(host)"
        if let port = server.port { origin += ":\(port)" }
        return origin
    }
}
