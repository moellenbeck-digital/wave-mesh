import XCTest

/// The app's status decoder against the file the Go side writes
/// (`core/waveengine/testdata/status.json`). The app decodes this every
/// second; a field that drifts makes the screen stop updating without a word.
final class StatusTests: XCTestCase {
    func testDecodesTheCoreContract() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "status", withExtension: "json"))
        let status = try JSONDecoder().decode(Status.self, from: Data(contentsOf: url))
        XCTAssertTrue(status.running)
        // Named by DNS suffix where the netmap said it, by host otherwise.
        XCTAssertEqual(status.waves.map(\.label), ["a.wave.example.com", "customer.a.wave.example.com", "b.example", "c.example"])
        let live = status.waves[0]
        XCTAssertEqual(live.id, "https://a.example")
        XCTAssertTrue(live.enabled)
        XCTAssertEqual(live.dnsName, "phone.a.wave.example.com")
        XCTAssertEqual(live.peers.map(\.dnsName), ["laptop.a.wave.example.com"])
        XCTAssertEqual(live.services.map(\.url), ["https://grafana.a.wave.example.com"])
        XCTAssertEqual(live.peers.first?.lastHandshakeSeconds, -1)
        XCTAssertEqual(live.problem, "")
        // A second wave at the same server: same address, its own key.
        let second = status.waves[1]
        XCTAssertEqual(second.controlUrl, live.controlUrl)
        XCTAssertEqual(second.id, "https://a.example#0f0f0f0f")
        XCTAssertNotEqual(second.id, live.id)
        // A paused wave is listed, switched off, with nothing else filled in.
        XCTAssertFalse(status.waves[2].enabled)
        XCTAssertTrue(status.waves[2].peers.isEmpty)
        // One the server ended says so.
        XCTAssertEqual(status.waves[3].problem, "removed")
        XCTAssertFalse(status.waves[3].enabled)
    }

    func testRoundTripsForTheCache() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "status", withExtension: "json"))
        let status = try JSONDecoder().decode(Status.self, from: Data(contentsOf: url))
        let again = try JSONDecoder().decode(Status.self, from: JSONEncoder().encode(status))
        XCTAssertEqual(status, again)
    }
}
