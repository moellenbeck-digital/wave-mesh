import XCTest

/// Everything a person can do in the app, in the simulator, against a
/// stand-in for the tunnel that behaves like the core (FakeTunnel). The
/// tunnel itself is tested on Linux, through the real core, by
/// test/e2e/mobile-lifecycle.sh; this is the half above it: what the app
/// shows, asks and does. In German, so the translations are exercised too.
final class WaveUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
    }

    /// Starts the app as a fresh install unless `fresh` is false, with the
    /// stand-in tunnel, and past the disclosure.
    private func launch(_ extra: [String] = [], fresh: Bool = true, acceptDisclosure: Bool = true) {
        app = XCUIApplication()
        app.launchArguments = ["-UITestFakeTunnel", "-AppleLanguages", "(de)", "-AppleLocale", "de_DE"]
            + (fresh ? ["-UITestReset"] : []) + extra
        app.launch()
        if acceptDisclosure, app.buttons["disclosure.continue"].waitForExistence(timeout: 3) {
            app.buttons["disclosure.continue"].firstMatch.tap()
        }
    }

    /// The element with this identifier, by the type it really is. SwiftUI
    /// hands a control's identifier to the container around it as well, and
    /// a query over any type picks that container -- which cannot be tapped.
    /// Looked up again on every call, so a wait and a tap see the same thing.
    private func element(_ identifier: String) -> XCUIElement {
        let types: [XCUIElement.ElementType] = [.button, .textField, .switch, .link, .staticText, .cell]
        for type in types {
            let candidate = app.descendants(matching: type).matching(identifier: identifier).firstMatch
            if candidate.exists { return candidate }
        }
        return app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// Waits for an element to exist, then hands back its typed form.
    private func appear(_ identifier: String, timeout: TimeInterval = 8) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let found = element(identifier)
            if found.exists { return found }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return nil
    }

    /// Scrolls until the element exists and is hittable, or fails.
    @discardableResult
    private func reveal(_ identifier: String, timeout: TimeInterval = 8, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let target = element(identifier)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if target.exists && target.isHittable { return target }
            if target.exists { app.swipeUp() } else { _ = target.waitForExistence(timeout: 0.5); if !target.exists { app.swipeUp() } }
        }
        XCTFail("\(identifier) never appeared", file: file, line: line)
        return target
    }

    /// Taps the switch itself, not its label: a tap on the row's text does
    /// not toggle it.
    private func tapSwitch(_ identifier: String) {
        let row = reveal(identifier)
        let inner = row.switches.firstMatch
        (inner.exists ? inner : row).coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    }

    private func snapshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func join(_ address: String) {
        let field = reveal("join.address")
        field.tap()
        field.typeText(address)
        reveal("join.login").tap()
    }

    // MARK: -

    func testTheDisclosureComesFirstAndOnlyOnce() {
        launch(acceptDisclosure: false)
        XCTAssertTrue(app.buttons["disclosure.continue"].waitForExistence(timeout: 3))
        snapshot("1 disclosure")
        app.buttons["disclosure.continue"].firstMatch.tap()
        XCTAssertTrue(reveal("join.address").exists)
        snapshot("2 empty")
        app.terminate()
        launch(fresh: false, acceptDisclosure: false)
        XCTAssertFalse(app.buttons["disclosure.continue"].waitForExistence(timeout: 2), "the disclosure came back")
    }

    func testJoiningStartsTheTunnelAndShowsTheWave() {
        launch()
        join("wave.example.org")
        XCTAssertTrue((appear("wave.self.ops.example.org", timeout: 8) != nil))
        XCTAssertTrue(element("tunnel.disconnect").exists, "the tunnel did not start by itself")
        XCTAssertTrue(element("wave.self.ops.example.org").label.contains(".ops.example.org"))
        snapshot("3 joined")
    }

    func testTheDeviceNameIsShownAsTheWaveWillCallIt() {
        launch()
        let field = reveal("device.name")
        field.tap()
        field.press(forDuration: 1.2)
        if app.menuItems["Alles auswählen"].waitForExistence(timeout: 2) { app.menuItems["Alles auswählen"].tap() }
        field.typeText(XCUIKeyboardKey.delete.rawValue)
        field.typeText("Möllenbeck Büro")
        XCTAssertTrue(reveal("device.preview").label.contains("moellenbeck-buero"), element("device.preview").label)
        app.swipeDown()
        join("wave.example.org")
        XCTAssertTrue((appear("wave.self.ops.example.org", timeout: 8) != nil))
        XCTAssertTrue(element("wave.self.ops.example.org").label.contains("moellenbeck-buero."),
                      element("wave.self.ops.example.org").label)
    }

    func testTheWavesDomainInsteadOfItsControlServerIsExplained() {
        launch()
        join("ops.example.org")
        let failure = appear("failure") ?? element("failure")
        XCTAssertTrue(failure.exists)
        XCTAssertTrue(failure.label.contains("nicht die Domain deines Waves"), failure.label)
        snapshot("4 wrong address")
    }

    func testAWaitingLoginCanBeCancelled() {
        launch()
        join("slow.example.org")
        XCTAssertTrue((appear("login.waiting", timeout: 8) != nil))
        snapshot("5 waiting for approval")
        reveal("login.cancel").tap()
        XCTAssertTrue(element("login.waiting").waitForNonExistence(timeout: 5))
        XCTAssertFalse(element("failure").exists, "a cancel the person chose was reported as an error")
        XCTAssertFalse(element("wave.toggle.slow.example.org").exists)
    }

    func testAWaveIsPausedAndResumedWithoutLeaving() {
        launch()
        join("wave.example.org")
        XCTAssertNotNil(appear("wave.toggle.ops.example.org"))
        tapSwitch("wave.toggle.ops.example.org")
        XCTAssertTrue((appear("wave.paused.ops.example.org", timeout: 5) != nil))
        snapshot("6 paused")
        tapSwitch("wave.toggle.ops.example.org")
        XCTAssertTrue((appear("wave.self.ops.example.org", timeout: 5) != nil))
    }

    func testLeavingAsksFirst() {
        launch()
        join("wave.example.org")
        XCTAssertTrue((appear("wave.self.ops.example.org", timeout: 8) != nil))
        reveal("wave.leave.ops.example.org").tap()
        XCTAssertTrue(app.buttons["leave.confirm"].waitForExistence(timeout: 3), "leaving did not ask")
        snapshot("7 leave?")
        app.buttons["leave.confirm"].firstMatch.tap()
        XCTAssertTrue(element("wave.toggle.ops.example.org").waitForNonExistence(timeout: 5))
    }

    func testARemovedWaveSaysSoAndOffersANewLogin() {
        launch(["-UITestRemovedWave"])
        XCTAssertNotNil(appear("tunnel.connect"))
        element("tunnel.connect").tap()
        XCTAssertTrue((appear("wave.removed.ops.example.org", timeout: 8) != nil))
        snapshot("8 removed")
        reveal("wave.loginAgain.ops.example.org").tap()
        XCTAssertTrue((appear("wave.self.ops.example.org", timeout: 8) != nil))
        XCTAssertFalse(element("wave.removed.ops.example.org").exists)
    }

    func testAnotherVPNIsAskedAboutBeforeConnecting() {
        launch(["-UITestOtherVPN"])
        XCTAssertNotNil(appear("tunnel.connect"))
        element("tunnel.connect").tap()
        XCTAssertTrue(app.buttons["takeover.confirm"].waitForExistence(timeout: 3), "connected over another VPN without asking")
        snapshot("9 another VPN")
        app.buttons["takeover.confirm"].firstMatch.tap()
        XCTAssertTrue((appear("tunnel.disconnect", timeout: 5) != nil))
    }

    func testDisconnectingKeepsTheWavesOnScreen() {
        launch()
        join("wave.example.org")
        XCTAssertTrue((appear("wave.self.ops.example.org", timeout: 8) != nil))
        XCTAssertNotNil(appear("tunnel.disconnect"))
        element("tunnel.disconnect").tap()
        XCTAssertTrue((appear("tunnelOff", timeout: 5) != nil))
        XCTAssertTrue(element("wave.toggle.ops.example.org").exists, "the wave vanished with the tunnel")
        snapshot("10 tunnel off")
    }

    func testServicesAndTheWebInterfaceAreOneTapAway() {
        launch()
        join("wave.example.org")
        XCTAssertTrue((appear("wave.self.ops.example.org", timeout: 8) != nil))
        XCTAssertTrue(reveal("service.grafana").exists)
        XCTAssertTrue(reveal("wave.web.ops.example.org").exists)
        snapshot("11 services and web")
    }

    func testTheLogSaysWhatHappened() {
        launch()
        join("wave.example.org")
        XCTAssertTrue((appear("wave.self.ops.example.org", timeout: 8) != nil))
        reveal("log").tap()
        let text = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "join wave.example.org")).firstMatch
        XCTAssertTrue(text.waitForExistence(timeout: 5), "the join is not in the log")
        snapshot("12 log")
    }

    /// Half a megabyte of log once drew as a black page, and sharing it as
    /// text sent nothing. Now it is drawn line by line and shared as a file.
    func testALongLogIsReadableAndSharedAsAFile() {
        launch(["-UITestLongLog"])
        reveal("log").tap()
        let last = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "line 6000 of a long day")).firstMatch
        XCTAssertTrue(last.waitForExistence(timeout: 5), "the end of a long log is not shown")
        snapshot("13 long log")
        let share = app.buttons["log.share"]
        XCTAssertTrue(share.waitForExistence(timeout: 2))
        share.tap()
        // The share sheet offers a document, which is what a messenger takes.
        let sheet = app.otherElements["ActivityListView"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 5), "the share sheet did not open")
        snapshot("14 share log")
    }

    func testConnectingAutomaticallyIsAChoiceThatIsKept() {
        launch()
        XCTAssertEqual(reveal("autoConnect").value as? String, "1")
        tapSwitch("autoConnect")
        XCTAssertEqual(element("autoConnect").value as? String, "0")
        app.terminate()
        launch(fresh: false)
        XCTAssertEqual(reveal("autoConnect").value as? String, "0", "the choice was not kept")
    }

    /// A fresh start forgets the last test's choices -- the other tests rely
    /// on starting from the defaults.
    func testAFreshStartBeginsFromTheDefaults() {
        launch()
        tapSwitch("autoConnect")
        XCTAssertEqual(element("autoConnect").value as? String, "0")
        app.terminate()
        launch()
        XCTAssertEqual(reveal("autoConnect").value as? String, "1", "a fresh start kept the last choice")
    }

    /// One server, two projects: the second wave is added at the same server,
    /// listed beside the first under its own name, and paused on its own.
    func testASecondWaveAtTheSameServerStaysApart() {
        launch()
        join("wave.example.org")
        XCTAssertNotNil(appear("wave.self.ops.example.org"))
        reveal("wave.add.ops.example.org").tap()
        XCTAssertNotNil(appear("wave.self.project-b.example.org"), "the second wave did not appear")
        XCTAssertTrue(element("wave.self.ops.example.org").exists, "the first wave went away")
        snapshot("13 two waves at one server")
        tapSwitch("wave.toggle.project-b.example.org")
        XCTAssertNotNil(appear("wave.paused.project-b.example.org"))
        XCTAssertTrue(element("wave.self.ops.example.org").exists, "pausing the second paused the first")
    }
}
