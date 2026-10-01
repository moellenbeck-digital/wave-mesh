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
/// from it.
@MainActor
final class WaveModel: ObservableObject {
    @Published var status = Status(port: 0, running: false, waves: [])
    @Published var failure: String?

    private var manager: NETunnelProviderManager?
    private var timer: Timer?

    func load() async {
        do {
            let managers = try await NETunnelProviderManager.loadAllFromPreferences()
            let manager = managers.first ?? NETunnelProviderManager()
            if managers.isEmpty {
                let configuration = NETunnelProviderProtocol()
                configuration.providerBundleIdentifier = "org.wave.app.tunnel"
                // A packet tunnel needs a server address even when there is no
                // single server: a device can be in several waves at once, and
                // each names its own. This is a label in the settings app.
                configuration.serverAddress = "wave"
                manager.protocolConfiguration = configuration
                manager.localizedDescription = "wave"
                manager.isEnabled = true
                try await manager.saveToPreferences()
                try await manager.loadFromPreferences()
            }
            self.manager = manager
            startPolling()
        } catch {
            failure = error.localizedDescription
        }
    }

    func connect() {
        do {
            try manager?.connection.startVPNTunnel()
        } catch {
            failure = error.localizedDescription
        }
    }

    func disconnect() {
        manager?.connection.stopVPNTunnel()
    }

    func login(controlURL: String) {
        send(["kind": "login", "controlURL": controlURL]) { [weak self] answer in
            guard let answer, !answer.isEmpty else { return }
            self?.failure = answer
        }
    }

    func logout(controlURL: String) {
        send(["kind": "logout", "controlURL": controlURL]) { [weak self] answer in
            guard let answer, !answer.isEmpty else { return }
            self?.failure = answer
        }
    }

    /// The link the core produced during enrolment. The extension cannot open a
    /// browser, so it leaves it here.
    var pendingAuthURL: URL? {
        guard let stored = UserDefaults(suiteName: "group.org.wave")?.string(forKey: "pendingAuthURL") else {
            return nil
        }
        return URL(string: stored)
    }

    private func startPolling() {
        timer?.invalidate()
        // A path, an RTT and a handshake age say nothing until you watch them
        // move, which is why this redraws rather than showing one reading.
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.send(["kind": "status"]) { answer in
                guard let answer, let data = answer.data(using: .utf8),
                      let decoded = try? JSONDecoder().decode(Status.self, from: data)
                else { return }
                self?.status = decoded
            }
        }
    }

    private func send(_ message: [String: String], completion: @escaping (String?) -> Void) {
        guard let session = manager?.connection as? NETunnelProviderSession,
              let payload = try? JSONSerialization.data(withJSONObject: message)
        else { return }
        do {
            try session.sendProviderMessage(payload) { answer in
                Task { @MainActor in
                    completion(answer.map { String(decoding: $0, as: UTF8.self) })
                }
            }
        } catch {
            // The extension is not running; there is nothing to ask.
            completion(nil)
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
