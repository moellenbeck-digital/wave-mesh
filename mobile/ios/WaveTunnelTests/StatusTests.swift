import XCTest

/// The app's status decoder against the file the Go side writes
/// (`core/waveengine/testdata/status.json`). The app decodes this every
/// second; a field that drifts makes the screen stop updating without a word.
final class StatusTests: XCTestCase {
    func testDecodesTheCoreContract() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "status", withExtension: "json"))
        let status = try JSONDecoder().decode(Status.self, from: Data(contentsOf: url))
        XCTAssertTrue(status.running)
        XCTAssertEqual(status.waves.map(\.label), ["a.example", "b.example"])
        let live = status.waves[0]
        XCTAssertTrue(live.enabled)
        XCTAssertEqual(live.dnsName, "phone.a.wave.example.com")
        XCTAssertEqual(live.peers.map(\.dnsName), ["laptop.a.wave.example.com"])
        // A paused wave is listed, switched off, with nothing else filled in.
        XCTAssertFalse(status.waves[1].enabled)
        XCTAssertTrue(status.waves[1].peers.isEmpty)
    }

    func testRoundTripsForTheCache() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "status", withExtension: "json"))
        let status = try JSONDecoder().decode(Status.self, from: Data(contentsOf: url))
        let again = try JSONDecoder().decode(Status.self, from: JSONEncoder().encode(status))
        XCTAssertEqual(status, again)
    }
}
