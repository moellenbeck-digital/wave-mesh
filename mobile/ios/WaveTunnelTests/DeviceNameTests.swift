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
