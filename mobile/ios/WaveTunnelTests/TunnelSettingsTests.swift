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
        XCTAssertEqual(settings.routes.map(\.cidr), ["10.77.0.0/16", "10.96.0.0/16"])
        XCTAssertEqual(settings.mtu, 1200)
        XCTAssertEqual(settings.dnsServers, ["10.77.0.2", "10.96.0.5"])
        XCTAssertTrue(settings.matchDomains.contains("rl.wave.example.com"))
    }

    func testBuildsTheTunnelSettingsFromIt() throws {
        let network = try contract().networkSettings()
        let ipv4 = try XCTUnwrap(network.ipv4Settings)
        XCTAssertEqual(ipv4.addresses, ["10.77.0.2", "10.96.0.5"])
        XCTAssertEqual(ipv4.subnetMasks, ["255.255.0.0", "255.255.0.0"])
        XCTAssertEqual(ipv4.includedRoutes?.map(\.destinationAddress), ["10.77.0.0", "10.96.0.0"])
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
