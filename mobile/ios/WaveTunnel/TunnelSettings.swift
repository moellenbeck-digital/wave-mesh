import NetworkExtension

/// The union, as the core sends it. One definition of the shape lives in Go
/// (`wavesettings.Settings`); this is its reading, and
/// `core/wavesettings/testdata/settings.json` is the contract both are tested
/// against -- a reader that drifted from it once applied nothing at all.
struct WaveSettings: Decodable, Equatable {
    let addresses: [String]
    let routes: [Route]
    let mtu: Int
    let dnsServers: [String]
    let matchDomains: [String]
    let searchDomains: [String]

    /// A destination for the tunnel and the address of ours to send from.
    ///
    /// iOS has no per-route source address, so `source` is decoded and not
    /// used: the core widens our own prefixes so that the kernel's choice is
    /// the right one anyway (`wavesettings/prefix.go`).
    struct Route: Decodable, Equatable {
        let cidr: String
        let source: String
    }

    static func decode(_ json: String) throws -> WaveSettings {
        try JSONDecoder().decode(WaveSettings.self, from: Data(json.utf8))
    }

    /// What `setTunnelNetworkSettings` takes. Pure, so the tests can look at
    /// it without a tunnel.
    func networkSettings() -> NEPacketTunnelNetworkSettings {
        // The remote address is a label in a packet tunnel -- there is no peer
        // at the other end of a utun. The first of our own addresses is the
        // honest thing to put there.
        let remote = addresses.first.map { String($0.split(separator: "/")[0]) } ?? "127.0.0.1"
        let network = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: remote)
        network.mtu = NSNumber(value: mtu)

        let routeCIDRs = routes.map(\.cidr)
        let ipv4 = addresses.compactMap(IPv4CIDR.init)
        if !ipv4.isEmpty {
            let configuration = NEIPv4Settings(addresses: ipv4.map(\.address), subnetMasks: ipv4.map(\.mask))
            configuration.includedRoutes = routeCIDRs.compactMap(IPv4CIDR.init).map {
                NEIPv4Route(destinationAddress: $0.network, subnetMask: $0.mask)
            }
            network.ipv4Settings = configuration
        }

        let ipv6 = addresses.compactMap(IPv6CIDR.init)
        if !ipv6.isEmpty {
            let configuration = NEIPv6Settings(
                addresses: ipv6.map(\.address),
                networkPrefixLengths: ipv6.map { NSNumber(value: $0.prefix) }
            )
            configuration.includedRoutes = routeCIDRs.compactMap(IPv6CIDR.init).map {
                NEIPv6Route(destinationAddress: $0.address, networkPrefixLength: NSNumber(value: $0.prefix))
            }
            network.ipv6Settings = configuration
        }

        if !dnsServers.isEmpty {
            let dns = NEDNSSettings(servers: dnsServers)
            // This is the whole reason the invariant holds on iOS: only these
            // namespaces are sent to us, and every other name on the phone
            // keeps resolving exactly as it did before wave was installed.
            dns.matchDomains = matchDomains
            dns.searchDomains = searchDomains
            network.dnsSettings = dns
        }
        return network
    }
}

/// A CIDR split the way NEIPv4Settings wants it: an address and a dotted mask.
struct IPv4CIDR {
    let address: String
    let mask: String
    /// The address with the host bits cleared: a route names a network, and
    /// iOS ignores one whose destination has host bits set.
    let network: String

    init?(_ cidr: String) {
        let parts = cidr.split(separator: "/")
        guard let first = parts.first, !first.contains(":") else { return nil }
        let octets = first.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return nil }
        let bits = max(0, min(32, parts.count > 1 ? Int(parts[1]) ?? 32 : 32))
        var maskOctets = [Int](repeating: 0, count: 4)
        for bit in 0..<bits {
            maskOctets[bit / 8] |= 1 << (7 - bit % 8)
        }
        address = String(first)
        mask = maskOctets.map(String.init).joined(separator: ".")
        network = zip(octets, maskOctets).map { String($0 & $1) }.joined(separator: ".")
    }
}

struct IPv6CIDR {
    let address: String
    let prefix: Int

    init?(_ cidr: String) {
        let parts = cidr.split(separator: "/")
        guard let first = parts.first, first.contains(":") else { return nil }
        address = String(first)
        prefix = parts.count > 1 ? Int(parts[1]) ?? 128 : 128
    }
}
