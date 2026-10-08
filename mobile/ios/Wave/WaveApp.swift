import NetworkExtension
import SwiftUI
import UIKit

@main
struct WaveApp: App {
    init() {
        #if DEBUG
            // Before any view reads a stored value: @AppStorage would have
            // read the disclosure flag by the time the tunnel is made.
            if ProcessInfo.processInfo.arguments.contains("-UITestReset") {
                // Key by key: removing the whole persistent domain left the
                // values in place in the simulator.
                let keys = ["disclosureAccepted.v1", "lastStatus", "deviceName", "autoConnect", "tunnelHasRun", PendingAuth.key]
                for defaults in [UserDefaults.standard, UserDefaults(suiteName: WaveIdentifiers.appGroup)] {
                    keys.forEach { defaults?.removeObject(forKey: $0) }
                }
                WaveLog.clear()
            }
            // A day's worth of log, to see that the page still draws it.
            if ProcessInfo.processInfo.arguments.contains("-UITestLongLog") {
                let lines = (1 ... 6000).map { "2026-10-07T12:00:00Z [tunnel] line \($0) of a long day: applied: addresses [...], dns [...]" }
                WaveLog.seed(lines.joined(separator: "\n") + "\n")
            }
        #endif
        // What iOS measured about the app since its last launch, and why a
        // previous run ended, if it ended badly -- into the shared log.
        WaveMetrics.start(as: .app)
    }

    /// The system's VPN, or -- in a debug build started by the UI tests -- a
    /// stand-in that behaves like the core, since the simulator has no packet
    /// tunnel. Release builds contain only the real one.
    @MainActor
    private static func tunnel() -> TunnelControl {
        #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-UITestFakeTunnel") {
                return FakeTunnel(arguments: ProcessInfo.processInfo.arguments)
            }
        #endif
        return SystemTunnel()
    }

    var body: some Scene {
        WindowGroup {
            WaveView(model: WaveModel(tunnel: Self.tunnel()))
        }
    }
}

/// The app owns nothing: the tunnel extension holds the core, and this asks it.
///
/// That split is not a preference. The extension is the process iOS keeps
/// running, and a core in the app would stop the moment somebody switched away
/// from it. It has one consequence everything below is shaped by: nothing can
/// be asked while the tunnel is down, so joining a wave starts the tunnel
/// first instead of quietly asking nobody, and what the screen shows while it
/// is down is the last thing the extension said.
@MainActor
final class WaveModel: ObservableObject {
    @Published var status = Status(port: 0, running: false, waves: [])
    @Published var failure: String?
    /// Where a login is, so the screen can say it instead of sitting still.
    @Published var login: LoginPhase = .idle
    /// The enrolment page currently shown in the app, if any.
    @Published var approval: Approval?
    /// Whether the tunnel is up, from the system rather than from the core:
    /// it is what decides whether the core can be asked at all.
    @Published var tunnelUp = false
    /// The name the next wave is joined with.
    @Published var deviceName: String {
        didSet { DeviceName.store(deviceName) }
    }
    /// Bring the tunnel back by itself after a restart or a network change.
    /// On by default; off for somebody who also uses another VPN and wants
    /// to choose each time, since iOS runs one at a time.
    @Published var autoConnect: Bool {
        didSet {
            UserDefaults(suiteName: WaveIdentifiers.appGroup)?.set(autoConnect, forKey: Self.autoConnectKey)
            Task { await applyOnDemand() }
        }
    }
    /// Set while the person is asked whether to take over from another VPN;
    /// the action runs once they agree.
    @Published var takeover: Takeover?

    struct Takeover: Identifiable {
        let id = UUID()
        let proceed: () -> Void
    }

    enum LoginPhase: Equatable {
        case idle
        /// Starting the tunnel, or registering with the control server.
        case connecting(String)
        /// Registered; somebody has to approve the device in a browser.
        case waitingForApproval(String)

        var address: String? {
            switch self {
            case .idle: nil
            case .connecting(let address), .waitingForApproval(let address): address
            }
        }
    }

    struct Approval: Identifiable, Equatable {
        let url: URL
        var id: String { url.absoluteString }
    }

    private let tunnel: TunnelControl
    private var timer: Timer?
    /// Links already shown, so closing the page does not reopen it every second.
    private var presented: Set<URL> = []
    /// Set when the person gave up on a login, so its answer is not an error.
    private var cancelled: String?
    private static let lastStatusKey = "lastStatus"
    private static let autoConnectKey = "autoConnect"

    init(tunnel: TunnelControl) {
        self.tunnel = tunnel
        deviceName = DeviceName.stored ?? UIDevice.current.name
        autoConnect = UserDefaults(suiteName: WaveIdentifiers.appGroup)?.object(forKey: Self.autoConnectKey) as? Bool ?? true
        // The last thing the extension reported: a device whose tunnel is
        // down is still in its waves, and an empty list would say it is in
        // none.
        if let data = UserDefaults(suiteName: WaveIdentifiers.appGroup)?.data(forKey: Self.lastStatusKey),
           let last = try? JSONDecoder().decode(Status.self, from: data)
        {
            status = Status(port: last.port, running: false, waves: last.waves)
        }
    }

    func load() async {
        do {
            try await tunnel.load()
            tunnelUp = tunnel.isConnected
            startPolling()
        } catch {
            report(error.localizedDescription)
        }
    }

    func connect() {
        askBeforeTakingOver {
            Task {
                do {
                    try await self.ensureRunning()
                } catch {
                    self.report(error.localizedDescription)
                }
            }
        }
    }

    /// Runs the action at once, or after the person agreed to disconnect the
    /// other VPN that is up. Asked every time: which VPN runs is theirs to
    /// decide, and iOS would switch without a word.
    private func askBeforeTakingOver(_ action: @escaping () -> Void) {
        Task {
            if !tunnelUp, await tunnel.anotherVPNIsSelected() {
                takeover = Takeover(proceed: action)
            } else {
                action()
            }
        }
    }

    /// Joins again a wave the server ended: that very enrolment, by its key.
    func loginAgain(_ wave: WaveStatus) {
        Task { _ = await join(controlURL: wave.id) }
    }

    /// Joins a further wave at the server this one is on -- another project's
    /// network there. The server asks, on approval, which wave it goes to.
    func addWave(at wave: WaveStatus) {
        Task { _ = await join(controlURL: wave.controlUrl, kind: "add") }
    }

    /// Stops the tunnel and keeps it stopped: with on-demand still on, iOS
    /// would bring it straight back.
    func disconnect() {
        WaveLog.write("disconnect", from: .app)
        Task { await tunnel.stop() }
    }

    /// Joins a wave: tunnel up, register, wait for approval. Returns whether
    /// the request was taken, so the field keeps what was typed when it was not.
    func join(controlURL: String, kind: String = "login") async -> Bool {
        let address = controlURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else { return false }
        if !tunnelUp, await tunnel.anotherVPNIsSelected() {
            // Asked first; the join goes ahead from the dialog.
            takeover = Takeover { Task { _ = await self.joinNow(address, kind: kind) } }
            return true
        }
        return await joinNow(address, kind: kind)
    }

    private func joinNow(_ address: String, kind: String) async -> Bool {
        failure = nil
        cancelled = nil
        login = .connecting(address)
        WaveLog.write("join \(address) as \(deviceName)", from: .app)
        do {
            try await ensureRunning()
        } catch {
            login = .idle
            report(error.localizedDescription)
            return false
        }
        // Answered only once the device is approved, refused, or the wait
        // timed out -- possibly minutes from now.
        Task {
            let answer = await ask(["kind": kind, "controlURL": address, "hostname": DeviceName.label(deviceName)])
            login = .idle
            approval = nil
            if cancelled == address {
                cancelled = nil
                WaveLog.write("join \(address) cancelled", from: .app)
                return
            }
            switch answer {
            case .none:
                report(String(localized: "The tunnel stopped before the login finished."))
            case .some(let message) where !message.isEmpty:
                report(LoginFailure.describe(message, address: address))
            default:
                WaveLog.write("joined \(address)", from: .app)
            }
        }
        return true
    }

    /// Gives up on the login that is waiting for approval.
    func cancelLogin() {
        guard let address = login.address else { return }
        cancelled = address
        approval = nil
        Task { _ = await ask(["kind": "cancelLogin", "controlURL": address]) }
    }

    func logout(controlURL: String) {
        Task {
            if let answer = await ask(["kind": "logout", "controlURL": controlURL]), !answer.isEmpty {
                report(answer)
            }
        }
    }

    /// Pauses or resumes one wave; the enrolment stays either way.
    func setEnabled(_ wave: WaveStatus, _ enabled: Bool) {
        Task {
            if let answer = await ask(["kind": "setEnabled", "controlURL": wave.id, "enabled": enabled]),
               !answer.isEmpty
            {
                report(answer)
            }
        }
    }

    /// Shows the enrolment page again after it was closed.
    func reopenApproval() {
        guard let url = PendingAuth.url else { return }
        approval = Approval(url: url)
    }

    private func report(_ message: String) {
        failure = message
        WaveLog.write("error: \(message)", from: .app)
    }

    /// Starts the tunnel unless it is running, and waits until it is -- the
    /// extension is the only one that can be asked anything. Turns on-demand
    /// on as well when the switch says so, so the tunnel comes back after a
    /// restart or a network change without anybody opening the app.
    private func ensureRunning() async throws {
        if tunnel.isConnected { return }
        try await tunnel.start(autoConnect: autoConnect)
        tunnelUp = true
    }

    /// Brings the configuration in line with the switch.
    private func applyOnDemand() async {
        do {
            try await tunnel.setOnDemand(autoConnect)
        } catch {
            report(error.localizedDescription)
        }
    }

    private var pollingSince: Date?

    private func startPolling() {
        timer?.invalidate()
        // A path, an RTT and a handshake age say nothing until you watch them
        // move, which is why this redraws rather than showing one reading.
        // The timer fires on the main run loop, but its closure is not
        // isolated, so it hops explicitly.
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.poll() }
        }
    }

    private func poll() async {
        // One at a time. A slow extension -- busy applying settings while a
        // wave is paused -- would otherwise collect a waiting request every
        // second, each with its task and its message, and the answers would
        // land in a burst and out of order.
        // An extension that never answers would stop the screen for good, so
        // a request older than ten seconds no longer holds the next one back.
        if let since = pollingSince, Date().timeIntervalSince(since) < 10 { return }
        let started = Date()
        pollingSince = started
        defer { if pollingSince == started { pollingSince = nil } }
        if case .connecting(let address) = login, let url = PendingAuth.url {
            login = .waitingForApproval(address)
            if !presented.contains(url) {
                presented.insert(url)
                approval = Approval(url: url)
            }
        }
        let up = tunnel.isConnected
        if tunnelUp != up { tunnelUp = up }
        guard up else {
            if status.running { status = Status(port: status.port, running: false, waves: status.waves) }
            return
        }
        guard let answer = await ask(["kind": "status"]),
              let decoded = try? JSONDecoder().decode(Status.self, from: Data(answer.utf8))
        else { return }
        if decoded != status {
            status = decoded
            if let data = try? JSONEncoder().encode(decoded) {
                UserDefaults(suiteName: WaveIdentifiers.appGroup)?.set(data, forKey: Self.lastStatusKey)
            }
        }
    }

    private func ask(_ message: [String: Any]) async -> String? {
        await tunnel.send(message)
    }
}

enum ModelError: LocalizedError {
    case notReady
    /// With the reason the system recorded, when it recorded one.
    case tunnelDidNotStart(String?)

    var errorDescription: String? {
        switch self {
        case .notReady:
            String(localized: "The VPN configuration is not set up yet.")
        case .tunnelDidNotStart(let reason?):
            String(localized: "The tunnel did not start: \(reason)")
        case .tunnelDidNotStart(nil):
            String(localized: "The tunnel did not start. The log says more.")
        }
    }
}
