import NetworkExtension
import SwiftUI
import UIKit

@main
struct WaveApp: App {
    var body: some Scene {
        WindowGroup {
            WaveView(model: WaveModel())
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

    private var manager: NETunnelProviderManager?
    private var timer: Timer?
    /// Links already shown, so closing the page does not reopen it every second.
    private var presented: Set<URL> = []
    /// Set when the person gave up on a login, so its answer is not an error.
    private var cancelled: String?
    private static let lastStatusKey = "lastStatus"

    init() {
        deviceName = DeviceName.stored ?? UIDevice.current.name
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
            let managers = try await NETunnelProviderManager.loadAllFromPreferences()
            let manager = managers.first ?? NETunnelProviderManager()
            if managers.isEmpty {
                let configuration = NETunnelProviderProtocol()
                configuration.providerBundleIdentifier = WaveIdentifiers.tunnelBundleIdentifier
                // A packet tunnel needs a server address even when there is no
                // single server: a device can be in several waves at once, and
                // each names its own. This is a label in the settings app.
                configuration.serverAddress = "wave-mesh"
                manager.protocolConfiguration = configuration
                manager.localizedDescription = "wave-mesh"
                manager.isEnabled = true
                try await manager.saveToPreferences()
                try await manager.loadFromPreferences()
            }
            self.manager = manager
            tunnelUp = manager.connection.status == .connected
            startPolling()
        } catch {
            report(error.localizedDescription)
        }
    }

    func connect() {
        Task {
            do {
                try await ensureRunning()
            } catch {
                report(error.localizedDescription)
            }
        }
    }

    /// Stops the tunnel and keeps it stopped: with on-demand still on, iOS
    /// would bring it straight back.
    func disconnect() {
        WaveLog.write("disconnect", from: .app)
        Task {
            if let manager, manager.isOnDemandEnabled {
                manager.isOnDemandEnabled = false
                try? await manager.saveToPreferences()
            }
            manager?.connection.stopVPNTunnel()
        }
    }

    /// Joins a wave: tunnel up, register, wait for approval. Returns whether
    /// the request was taken, so the field keeps what was typed when it was not.
    func join(controlURL: String) async -> Bool {
        let address = controlURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else { return false }
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
            let answer = await ask(["kind": "login", "controlURL": address, "hostname": DeviceName.label(deviceName)])
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
                report(message)
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
            if let answer = await ask(["kind": "setEnabled", "controlURL": wave.controlUrl, "enabled": enabled]),
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
    /// on as well, so the tunnel comes back after a restart or a network
    /// change without anybody opening the app.
    private func ensureRunning() async throws {
        guard let manager else { throw ModelError.notReady }
        if manager.connection.status == .connected { return }
        if !manager.isEnabled || !manager.isOnDemandEnabled {
            // isEnabled: another VPN configuration may have taken over since
            // this one was saved.
            manager.isEnabled = true
            let always = NEOnDemandRuleConnect()
            always.interfaceTypeMatch = .any
            manager.onDemandRules = [always]
            manager.isOnDemandEnabled = true
            try await manager.saveToPreferences()
            try await manager.loadFromPreferences()
        }
        WaveLog.write("starting the tunnel", from: .app)
        try manager.connection.startVPNTunnel()
        for _ in 0..<60 {
            switch manager.connection.status {
            case .connected:
                tunnelUp = true
                return
            case .disconnected, .invalid:
                throw ModelError.tunnelDidNotStart
            default:
                try await Task.sleep(nanoseconds: 250_000_000)
            }
        }
        throw ModelError.tunnelDidNotStart
    }

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
        if case .connecting(let address) = login, let url = PendingAuth.url {
            login = .waitingForApproval(address)
            if !presented.contains(url) {
                presented.insert(url)
                approval = Approval(url: url)
            }
        }
        let up = manager?.connection.status == .connected
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

    /// One question to the extension; nil when it is not there to answer.
    private func ask(_ message: [String: Any]) async -> String? {
        guard let session = manager?.connection as? NETunnelProviderSession,
              let payload = try? JSONSerialization.data(withJSONObject: message)
        else { return nil }
        return await withCheckedContinuation { continuation in
            do {
                try session.sendProviderMessage(payload) { answer in
                    continuation.resume(returning: answer.map { String(decoding: $0, as: UTF8.self) })
                }
            } catch {
                continuation.resume(returning: nil)
            }
        }
    }
}

enum ModelError: LocalizedError {
    case notReady
    case tunnelDidNotStart

    var errorDescription: String? {
        switch self {
        case .notReady:
            String(localized: "The VPN configuration is not set up yet.")
        case .tunnelDidNotStart:
            String(localized: "The tunnel did not start. Allow the VPN configuration in Settings and try again.")
        }
    }
}
