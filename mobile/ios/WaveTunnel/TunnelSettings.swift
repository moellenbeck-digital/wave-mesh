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
        let remote = addresses.first.flatMap { $0.split(separator: "/").first.map(String.init) } ?? "127.0.0.1"
        let network = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: remote)
        network.mtu = NSNumber(value: mtu)

        let routeCIDRs = routes.map(\.cidr).filter(Self.isNarrowEnough)
        let ipv4 = addresses.compactMap(IPv4CIDR.init).map(Self.clamped)
        if !ipv4.isEmpty {
            let configuration = NEIPv4Settings(addresses: ipv4.map(\.address), subnetMasks: ipv4.map(\.mask))
            configuration.includedRoutes = routeCIDRs.compactMap(IPv4CIDR.init).map {
                NEIPv4Route(destinationAddress: $0.network, subnetMask: $0.mask)
            }
            network.ipv4Settings = configuration
        }

        let ipv6 = addresses.compactMap(IPv6CIDR.init).map(Self.clamped)
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

        // Never without matchDomains: an NEDNSSettings without them makes our
        // resolver the phone's resolver for every name, and it answers only
        // the waves' -- the whole phone would stop resolving. No domains, no
        // DNS settings at all.
        if !dnsServers.isEmpty && !matchDomains.filter({ !$0.isEmpty }).isEmpty {
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

extension WaveSettings {
    /// The broadest prefix a wave may route through the tunnel. A wave is a
    /// /16 out of the wave's own block in practice (D5); anything near a
    /// default route would pull the phone's whole traffic in, where nothing
    /// carries it on. Such a route is a broken netmap, never a feature, and it
    /// is dropped rather than obeyed.
    static let broadestIPv4 = 8
    static let broadestIPv6 = 16

    static func isNarrowEnough(_ cidr: String) -> Bool {
        if let v4 = IPv4CIDR(cidr) { return v4.bits >= broadestIPv4 }
        if let v6 = IPv6CIDR(cidr) { return v6.prefix >= broadestIPv6 }
        return false
    }

    /// An address whose widened prefix came out too broad keeps its host
    /// prefix instead: on an interface, the prefix of an address is a route.
    static func clamped(_ cidr: IPv4CIDR) -> IPv4CIDR {
        cidr.bits >= broadestIPv4 ? cidr : IPv4CIDR("\(cidr.address)/32") ?? cidr
    }

    static func clamped(_ cidr: IPv6CIDR) -> IPv6CIDR {
        cidr.prefix >= broadestIPv6 ? cidr : IPv6CIDR("\(cidr.address)/128") ?? cidr
    }
}

/// A CIDR split the way NEIPv4Settings wants it: an address and a dotted mask.
struct IPv4CIDR {
    let address: String
    let mask: String
    let bits: Int
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
        self.bits = bits
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
