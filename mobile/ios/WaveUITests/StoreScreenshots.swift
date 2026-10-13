import XCTest

/// The App Store's screenshots, made the same way every time: the app against
/// FakeTunnel with a wave that has something in it (-UITestDemo).
///
/// Skipped unless asked for, since they only make pictures:
///
///   TEST_RUNNER_STORE_SCREENSHOTS_DIR=/path TEST_RUNNER_STORE_LANG=en \
///     xcodebuild test -only-testing:WaveUITests/StoreScreenshots ...
///
/// `mobile/ios/store/screenshots.sh` runs it for every device and language.
final class StoreScreenshots: XCTestCase {
    private var app: XCUIApplication!

    func testStoreScreenshots() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let directory = environment["STORE_SCREENSHOTS_DIR"] else {
            throw XCTSkip("only for the store: set TEST_RUNNER_STORE_SCREENSHOTS_DIR")
        }
        let language = environment["STORE_LANG"] ?? "en"
        let locale = language == "de" ? "de_DE" : "en_US"
        continueAfterFailure = false

        // The question before anything happens, and what the server learns.
        launch(language, locale, ["-UITestReset"])
        let disclosure = app.buttons["disclosure.continue"]
        XCTAssertTrue(disclosure.waitForExistence(timeout: 5))
        shoot("4-disclosure", in: directory)
        disclosure.tap()

        // Before anything is typed: the keyboard would cover the page.
        let field = app.textFields["join.address"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        shoot("3-join", in: directory)
        field.tap()
        field.typeText("wave.example.com")
        app.buttons["join.login"].tap()

        // The wave, with its devices and services.
        XCTAssertTrue(app.descendants(matching: .any)["wave.self.ops.example.com"].waitForExistence(timeout: 10))
        sleep(1)
        shoot("1-wave", in: directory)

        // "Check connection".
        let check = app.buttons["wave.check.ops.example.com"]
        for _ in 0 ..< 6 where !(check.exists && check.isHittable) { app.swipeUp() }
        check.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "23 ms")).firstMatch
            .waitForExistence(timeout: 8))
        shoot("2-check", in: directory)
    }

    private func launch(_ language: String, _ locale: String, _ extra: [String]) {
        app = XCUIApplication()
        app.launchArguments = ["-UITestFakeTunnel", "-UITestDemo", "-AppleLanguages", "(\(language))", "-AppleLocale", locale] + extra
        app.launch()
    }

    private func shoot(_ name: String, in directory: String) {
        let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
    }
}
