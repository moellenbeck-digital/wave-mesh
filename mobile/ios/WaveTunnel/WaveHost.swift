import Foundation
import NetworkExtension
import Wavemobile

/// What the core calls back into.
///
/// Four things, and each is something only the platform can do: apply the
/// settings it computed, keep a line, persist the keys, show an enrolment link.
/// Nothing here decides anything.
final class WaveHost: NSObject, WavemobileCallbacks {
    private weak var provider: NEPacketTunnelProvider?
    /// The private keys of every enrolment. The keychain, because a plain file
    /// in the container is backed up and readable by anything that gets the
    /// container.
    private let stateAccount = "wave.state"
    private let stateService = "org.wave.enrolments"

    init(provider: NEPacketTunnelProvider) {
        self.provider = provider
        super.init()
    }

    // MARK: - WavemobileCallbacks

    /// Applies the union of every wave to the one tunnel iOS allows.
    ///
    /// Synchronous towards the core on purpose: it is called only when the
    /// union actually changed, and the core wants to know whether the tunnel is
    /// what it believes it is. `setTunnelNetworkSettings` is atomic and knows
    /// no partial failure, which is why the core refuses a colliding wave
    /// before it ever gets here rather than repairing one afterwards.
    func applySettings(_ settingsJSON: String?) throws {
        guard let settingsJSON, let data = settingsJSON.data(using: .utf8) else {
            throw WaveError.noCore
        }
        let settings = try JSONDecoder().decode(WaveSettings.self, from: data)
        guard let provider else { throw WaveError.noCore }

        // The remote address is a label in a packet tunnel -- there is no peer
        // at the other end of a utun. The first of our own addresses is the
        // honest thing to put there.
        let remote = settings.addresses.first.map { String($0.split(separator: "/")[0]) } ?? "127.0.0.1"
        let network = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: remote)
        network.mtu = NSNumber(value: settings.mtu)

        let ipv4 = settings.addresses.compactMap(IPv4Address.init)
        if !ipv4.isEmpty {
            let configuration = NEIPv4Settings(
                addresses: ipv4.map(\.address),
                subnetMasks: ipv4.map(\.mask)
            )
            configuration.includedRoutes = settings.routes.compactMap(IPv4Address.init).map {
                NEIPv4Route(destinationAddress: $0.address, subnetMask: $0.mask)
            }
            network.ipv4Settings = configuration
        }

        let ipv6 = settings.addresses.compactMap(IPv6Address.init)
        if !ipv6.isEmpty {
            let configuration = NEIPv6Settings(
                addresses: ipv6.map(\.address),
                networkPrefixLengths: ipv6.map { NSNumber(value: $0.prefix) }
            )
            configuration.includedRoutes = settings.routes.compactMap(IPv6Address.init).map {
                NEIPv6Route(destinationAddress: $0.address, networkPrefixLength: NSNumber(value: $0.prefix))
            }
            network.ipv6Settings = configuration
        }

        if !settings.dnsServers.isEmpty {
            let dns = NEDNSSettings(servers: settings.dnsServers)
            // This is the whole reason the invariant holds on iOS: only these
            // namespaces are sent to us, and every other name on the phone
            // keeps resolving exactly as it did before wave was installed.
            dns.matchDomains = settings.matchDomains
            dns.searchDomains = settings.searchDomains
            network.dnsSettings = dns
        }

        // Applied without waiting: the completion arrives on another queue, and
        // blocking the core's caller here would hold up the netmap handler that
        // asked for it. A failure is logged, which is what the core would do
        // with it anyway.
        provider.setTunnelNetworkSettings(network) { [weak self] error in
            if let error {
                self?.log("could not apply the tunnel settings: \(error.localizedDescription)")
            }
        }
    }

    func log(_ line: String?) {
        guard let line else { return }
        NSLog("[wave] %@", line)
    }

    func saveState(_ encoded: Data?) {
        guard let encoded else { return }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: stateService,
            kSecAttrAccount as String: stateAccount,
        ]
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = encoded
        // After first unlock, not "when unlocked": the tunnel comes up at boot
        // and there is nobody there to unlock the phone for it.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(query as CFDictionary, nil)
        if status != errSecSuccess {
            log("could not store the enrolments (keychain status \(status))")
        }
    }

    func loadState() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: stateService,
            kSecAttrAccount as String: stateAccount,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let text = String(data: data, encoding: .utf8)
        else {
            // A device that has never joined anything, which is not an error.
            return ""
        }
        return text
    }

    /// The enrolment link. The extension cannot open a browser, so it is put
    /// where the app will find it and the app opens it.
    func openAuthURL(_ url: String?) {
        guard let url else { return }
        log("open this link to connect this device: \(url)")
        UserDefaults(suiteName: appGroup)?.set(url, forKey: "pendingAuthURL")
    }

    /// Nothing to do: a packet tunnel provider's own sockets do not go through
    /// its tunnel. Android is where this matters.
    func protectSocket(_ fd: Int) -> Bool { true }
}

/// The app group both halves share. The extension owns the core; the app only
/// ever asks it things.
let appGroup = "group.org.wave"

/// The union, as the core sends it. One definition of the shape lives in Go
/// (`wavesettings.Settings`); this is its reading.
private struct WaveSettings: Decodable {
    let addresses: [String]
    let routes: [String]
    let mtu: Int
    let dnsServers: [String]
    let matchDomains: [String]
    let searchDomains: [String]
}

/// A CIDR split the way NEIPv4Settings wants it: an address and a dotted mask.
private struct IPv4Address {
    let address: String
    let mask: String

    init?(_ cidr: String) {
        let parts = cidr.split(separator: "/")
        guard let first = parts.first, !first.contains(":") else { return nil }
        address = String(first)
        let bits = parts.count > 1 ? Int(parts[1]) ?? 32 : 32
        var octets = [Int](repeating: 0, count: 4)
        for bit in 0..<max(0, min(32, bits)) {
            octets[bit / 8] |= 1 << (7 - bit % 8)
        }
        mask = octets.map(String.init).joined(separator: ".")
    }
}

private struct IPv6Address {
    let address: String
    let prefix: Int

    init?(_ cidr: String) {
        let parts = cidr.split(separator: "/")
        guard let first = parts.first, first.contains(":") else { return nil }
        address = String(first)
        prefix = parts.count > 1 ? Int(parts[1]) ?? 128 : 128
    }
}
