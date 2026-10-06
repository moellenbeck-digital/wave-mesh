import XCTest

/// What the app sends as the device name, and so what it promises on screen.
final class DeviceNameTests: XCTestCase {
    func testFoldsLikeTheControlServerWouldWithoutLosingLetters() {
        XCTAssertEqual(DeviceName.label("Max' iPhone"), "max-iphone")
        XCTAssertEqual(DeviceName.label("Möllenbeck Büro"), "moellenbeck-buero")
        XCTAssertEqual(DeviceName.label("Straße 12"), "strasse-12")
        XCTAssertEqual(DeviceName.label("  iPad (Küche)  "), "ipad-kueche")
        XCTAssertEqual(DeviceName.label("Café"), "cafe")
        XCTAssertEqual(DeviceName.label("---"), "")
        XCTAssertEqual(DeviceName.label(String(repeating: "a", count: 80)).count, 63)
    }
}

/// The sentences a wrong address gets, from the errors the core really writes.
final class LoginFailureTests: XCTestCase {
    func testTheWavesDomainInsteadOfItsControlServer() {
        // Verbatim from a phone that typed ops.moellenbeck-digital.io.
        let raw = #"Post "https://ops.moellenbeck-digital.io/v1/machine/register": tls: failed to verify certificate: x509: certificate is valid for *.github.com, not ops.moellenbeck-digital.io"#
        XCTAssertTrue(LoginFailure.describe(raw, address: "ops.moellenbeck-digital.io").contains("ops.moellenbeck-digital.io"))
        XCTAssertNotEqual(LoginFailure.describe(raw, address: "ops.moellenbeck-digital.io"), raw)
    }

    func testAnythingElseStaysAsTheCoreSaidIt() {
        XCTAssertEqual(LoginFailure.describe("the server said no", address: "a.example"), "the server said no")
    }
}
