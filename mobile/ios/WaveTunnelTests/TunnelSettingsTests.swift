import NetworkExtension
import XCTest

/// The settings reader against the file the Go side writes
/// (`core/wavesettings/testdata/settings.json`). A reader that drifted from the
/// core's shape once applied no settings at all, on every phone, without a
/// word -- this is where that shows up instead.
final class TunnelSettingsTests: XCTestCase {
    private func contract() throws -> WaveSettings {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "settings", withExtension: "json"))
        return try WaveSettings.decode(String(contentsOf: url, encoding: .utf8))
    }

    func testDecodesTheCoreContract() throws {
        let settings = try contract()
        XCTAssertEqual(settings.routes.map(\.cidr), ["10.77.0.0/16", "10.77.0.53/32", "10.96.0.0/16", "10.96.0.53/32"])
        XCTAssertEqual(settings.mtu, 1200)
        // The reserved resolvers, never an address the phone holds itself.
        XCTAssertEqual(settings.dnsServers, ["10.77.0.53", "10.96.0.53"])
        XCTAssertTrue(settings.matchDomains.contains("rl.wave.example.com"))
    }

    func testBuildsTheTunnelSettingsFromIt() throws {
        let network = try contract().networkSettings()
        let ipv4 = try XCTUnwrap(network.ipv4Settings)
        XCTAssertEqual(ipv4.addresses, ["10.77.0.2", "10.96.0.5"])
        XCTAssertEqual(ipv4.subnetMasks, ["255.255.0.0", "255.255.0.0"])
        XCTAssertEqual(ipv4.includedRoutes?.map(\.destinationAddress), ["10.77.0.0", "10.77.0.53", "10.96.0.0", "10.96.0.53"])
        XCTAssertEqual(network.ipv6Settings?.addresses, ["fd7a:1::2"])
        // Only the waves' own names go to our resolver; everything else on the
        // phone resolves as before.
        XCTAssertEqual(network.dnsSettings?.matchDomains?.count, 4)
        XCTAssertEqual(network.mtu, 1200)
    }

    func testARouteNamesItsNetwork() throws {
        let cidr = try XCTUnwrap(IPv4CIDR("10.77.3.9/16"))
        XCTAssertEqual(cidr.network, "10.77.0.0")
        XCTAssertEqual(cidr.mask, "255.255.0.0")
        XCTAssertNil(IPv4CIDR("fd7a::1/64"))
        XCTAssertNil(IPv4CIDR("not an address"))
    }
}

/// The two ways a tunnel can take a phone's whole connectivity: routes that
/// pull in everything, and DNS that answers for every name. Neither may happen
/// whatever the core sends.
final class TunnelSafetyTests: XCTestCase {
    private func settings(routes: [String], addresses: [String] = ["10.160.0.20/27"],
                          dns: [String] = ["10.160.0.53"], match: [String] = ["ops.example"]) throws -> WaveSettings {
        let json: [String: Any] = [
            "addresses": addresses,
            "routes": routes.map { ["cidr": $0, "source": "10.160.0.20"] },
            "mtu": 1280, "dnsServers": dns, "matchDomains": match, "searchDomains": [],
        ]
        return try WaveSettings.decode(String(decoding: JSONSerialization.data(withJSONObject: json), as: UTF8.self))
    }

    func testADefaultRouteIsNeverApplied() throws {
        let network = try settings(routes: ["0.0.0.0/0", "10.160.0.0/27", "::/0", "128.0.0.0/1"]).networkSettings()
        XCTAssertEqual(network.ipv4Settings?.includedRoutes?.map(\.destinationAddress), ["10.160.0.0"])
        XCTAssertNil(network.ipv6Settings)
    }

    func testAnAddressWidenedTooFarKeepsItsHostPrefix() throws {
        let network = try settings(routes: [], addresses: ["10.160.0.20/0"]).networkSettings()
        XCTAssertEqual(network.ipv4Settings?.subnetMasks, ["255.255.255.255"])
    }

    func testNoDNSWithoutMatchDomains() throws {
        XCTAssertNil(try settings(routes: [], match: []).networkSettings().dnsSettings)
        XCTAssertNil(try settings(routes: [], match: [""]).networkSettings().dnsSettings)
        XCTAssertNotNil(try settings(routes: []).networkSettings().dnsSettings)
    }
}
