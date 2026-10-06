import NetworkExtension
import SwiftUI

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
/// first instead of quietly asking nobody.
@MainActor
final class WaveModel: ObservableObject {
    @Published var status = Status(port: 0, running: false, waves: [])
    @Published var failure: String?
    /// Where a login is, so the screen can say it instead of sitting still.
    @Published var login: LoginPhase = .idle
    /// The enrolment page currently shown in the app, if any.
    @Published var approval: Approval?

    enum LoginPhase: Equatable {
        case idle
        /// Starting the tunnel, or registering with the control server.
        case connecting(String)
        /// Registered; somebody has to approve the device in a browser.
        case waitingForApproval(String)
    }

    struct Approval: Identifiable, Equatable {
        let url: URL
        var id: String { url.absoluteString }
    }

    private var manager: NETunnelProviderManager?
    private var timer: Timer?
    /// Links already shown, so closing the page does not reopen it every second.
    private var presented: Set<URL> = []

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
            startPolling()
        } catch {
            report(error.localizedDescription)
        }
    }

    func connect() {
        Task { try? await ensureRunning() }
    }

    func disconnect() {
        WaveLog.write("disconnect", from: .app)
        manager?.connection.stopVPNTunnel()
    }

    /// Joins a wave: tunnel up, register, wait for approval. Returns whether
    /// the request was taken, so the field keeps what was typed when it was not.
    func join(controlURL: String) async -> Bool {
        let address = controlURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else { return false }
        failure = nil
        login = .connecting(address)
        WaveLog.write("join \(address)", from: .app)
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
            let answer = await ask(["kind": "login", "controlURL": address])
            login = .idle
            approval = nil
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

    func logout(controlURL: String) {
        Task {
            if let answer = await ask(["kind": "logout", "controlURL": controlURL]), !answer.isEmpty {
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
    /// extension is the only one that can be asked anything.
    private func ensureRunning() async throws {
        guard let manager else { throw ModelError.notReady }
        if manager.connection.status == .connected { return }
        if !manager.isEnabled {
            // Another VPN configuration took over since this one was saved.
            manager.isEnabled = true
            try await manager.saveToPreferences()
            try await manager.loadFromPreferences()
        }
        WaveLog.write("starting the tunnel", from: .app)
        try manager.connection.startVPNTunnel()
        for _ in 0..<60 {
            switch manager.connection.status {
            case .connected:
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
        guard manager?.connection.status == .connected else {
            if status.running { status = Status(port: status.port, running: false, waves: status.waves) }
            return
        }
        guard let answer = await ask(["kind": "status"]),
              let decoded = try? JSONDecoder().decode(Status.self, from: Data(answer.utf8))
        else { return }
        status = decoded
    }

    /// One question to the extension; nil when it is not there to answer.
    private func ask(_ message: [String: String]) async -> String? {
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

struct Status: Decodable {
    /// The one public UDP port, shared by every wave.
    let port: Int
    let running: Bool
    let waves: [WaveStatus]
}

struct WaveStatus: Decodable, Identifiable {
    var id: String { controlUrl }
    let controlUrl: String
    let label: String
    let suffix: String
    let hostname: String
    let dnsName: String
    let ipv4: String
    let connected: Bool
    /// One per wave: the relay routes by disco key, and each enrolment has its
    /// own.
    let relay: String
    /// Where this wave's resolver answers.
    let resolver: String
    let peers: [PeerStatus]
    let services: [ServiceStatus]
}

struct PeerStatus: Decodable, Identifiable {
    var id: String { dnsName }
    let hostname: String
    let dnsName: String
    let ipv4: String
    let online: Bool
    let via: String
    let rttMs: Int
}

struct ServiceStatus: Decodable, Identifiable {
    var id: String { dnsName }
    let name: String
    let dnsName: String
    let ipv4: String
}
