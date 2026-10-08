import XCTest

/// What a QR code's link may make the app do: name a server, and nothing else.
final class InviteTests: XCTestCase {
    private func server(_ link: String) -> String? {
        URL(string: link).flatMap(WaveInvite.server(from:))
    }

    func testTheServerIsTakenFromTheLink() {
        XCTAssertEqual(server("wavemesh://join?server=https%3A%2F%2Fwave.example.com"), "https://wave.example.com")
        XCTAssertEqual(server("wavemesh://join?server=http://10.99.0.1:8080"), "http://10.99.0.1:8080")
    }

    /// A path or query in a printed code is not ours to follow: the origin only.
    func testOnlyTheOriginIsKept() {
        XCTAssertEqual(server("wavemesh://join?server=https://wave.example.com/evil?x=1"), "https://wave.example.com")
    }

    func testAnythingElseIsRefused() {
        XCTAssertNil(server("wavemesh://join"))
        XCTAssertNil(server("wavemesh://leave?server=https://wave.example.com"))
        XCTAssertNil(server("otherapp://join?server=https://wave.example.com"))
        XCTAssertNil(server("wavemesh://join?server=javascript:alert(1)"))
        XCTAssertNil(server("wavemesh://join?server=file:///etc/passwd"))
    }
}
