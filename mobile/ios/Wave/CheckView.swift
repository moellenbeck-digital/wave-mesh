import Network
import SwiftUI

/// "Check connection" for one wave: what works and what does not, in sentences.
///
/// Built after a night of guessing. A connector that was dead, a server that
/// offered no relay and a phone that reset its sessions all looked the same
/// from the outside: a page that did not load. Each of them is one line here.
/// The checks read what the tunnel already reports, and for every service the
/// wave offers they open a real connection -- through the tunnel, the same way
/// Safari would -- because "the path looks fine" is not the same as "it
/// answers".
struct CheckView: View {
    let wave: WaveStatus
    let tunnelUp: Bool
    /// Opens a TCP connection and says how long it took. A parameter so the
    /// UI tests can check the page without a tunnel to connect through.
    let probe: (String, UInt16) async -> Probe

    @State private var results: [String: Probe] = [:]
    @State private var running = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    line(tunnelUp, "Tunnel is running", "The tunnel is not running. Connect first.")
                        .accessibilityIdentifier("check.tunnel")
                    line(wave.connected, "Connected to the control server", "No connection to the control server: devices still reach each other, but changes do not arrive.")
                        .accessibilityIdentifier("check.control")
                    relayLine.accessibilityIdentifier("check.relay")
                    line(!wave.resolver.isEmpty, "Names in this wave resolve through the tunnel", "No resolver for this wave: names will not resolve, addresses still work.")
                        .accessibilityIdentifier("check.dns")
                } header: {
                    Text(verbatim: wave.label)
                }

                if !wave.peers.isEmpty {
                    Section("Devices") {
                        ForEach(wave.peers) { peer in
                            peerLine(peer)
                        }
                    }
                }

                if !wave.services.isEmpty {
                    Section {
                        ForEach(wave.services) { service in
                            serviceLine(service)
                        }
                    } header: {
                        Text("Services")
                    } footer: {
                        Text("Each service gets a real connection through the tunnel, the way a browser would open it.")
                    }
                }
            }
            .navigationTitle("Check connection")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Again", systemImage: "arrow.clockwise") { Task { await runProbes() } }
                        .disabled(running)
                }
            }
            .task { await runProbes() }
        }
    }

    private func runProbes() async {
        running = true
        results = [:]
        await withTaskGroup(of: (String, Probe).self) { group in
            for service in wave.services {
                let (host, port) = Self.target(of: service)
                group.addTask { (service.id, await probe(host, port)) }
            }
            for await (id, result) in group {
                results[id] = result
            }
        }
        running = false
    }

    /// Where a service is opened: its address, and the port its URL implies.
    static func target(of service: ServiceStatus) -> (String, UInt16) {
        let port: UInt16 = URL(string: service.url).flatMap { url in
            url.port.map(UInt16.init) ?? (url.scheme == "http" ? 80 : 443)
        } ?? 443
        return (service.ipv4, port)
    }

    // MARK: - Lines

    private func line(_ ok: Bool, _ good: LocalizedStringKey, _ bad: LocalizedStringKey) -> some View {
        Label {
            Text(ok ? good : bad).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: ok ? "checkmark.circle" : "exclamationmark.triangle")
                .foregroundStyle(ok ? Color.accentColor : .orange)
        }
    }

    @ViewBuilder
    private var relayLine: some View {
        if !wave.relay.isEmpty {
            line(true, "Relay connected: devices behind NAT stay reachable", "")
        } else if wave.relayOffered == true {
            line(false, "", "The relay is not connected: devices only reachable through it are cut off for now.")
        } else if wave.relayOffered == false {
            line(false, "", "This server offers no relay: devices the phone cannot reach directly, such as a connector in a cluster, stay unreachable.")
        }
    }

    private func peerLine(_ peer: PeerStatus) -> some View {
        let name = peer.dnsName.isEmpty ? peer.hostname : peer.dnsName
        let (ok, text): (Bool, String) = {
            if !peer.online {
                return (true, String(localized: "\(name): offline at the server"))
            }
            if peer.via == "idle" {
                return (true, String(localized: "\(name): resting, wakes with the first packet"))
            }
            if peer.lastHandshakeSeconds >= 0 && peer.lastHandshakeSeconds < 300 {
                let way = peer.via == "relay" ? String(localized: "through the relay") : String(localized: "directly")
                return (true, String(localized: "\(name): reachable \(way)"))
            }
            if peer.via.isEmpty {
                return (false, String(localized: "\(name): online at the server, but never reached from here. Is it running, and does the server offer a relay?"))
            }
            return (false, String(localized: "\(name): no handshake for a while"))
        }()
        return Label {
            Text(verbatim: text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: ok ? "checkmark.circle" : "exclamationmark.triangle")
                .foregroundStyle(ok ? Color.accentColor : .orange)
        }
        .accessibilityIdentifier("check.peer.\(name)")
    }

    private func serviceLine(_ service: ServiceStatus) -> some View {
        let name = service.dnsName.isEmpty ? service.name : service.dnsName
        let text: String
        let icon: String
        let tint: Color
        switch results[service.id] {
        case .none:
            text = String(localized: "\(name): checking …")
            icon = "hourglass"
            tint = .secondary
        case let .answered(milliseconds):
            text = String(localized: "\(name): answers in \(milliseconds) ms")
            icon = "checkmark.circle"
            tint = .accentColor
        case .refused:
            text = String(localized: "\(name): reached, but nothing listens on that port")
            icon = "exclamationmark.triangle"
            tint = .orange
        case .silent:
            text = String(localized: "\(name): no answer. The device that serves it may be down or unreachable.")
            icon = "xmark.octagon"
            tint = .red
        }
        return Label {
            Text(verbatim: text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: icon).foregroundStyle(tint)
        }
        .accessibilityIdentifier("check.service.\(service.name)")
    }
}

/// What one connection attempt found.
enum Probe: Equatable, Sendable {
    case answered(milliseconds: Int)
    /// Something answered, and said no: the path works, the port does not.
    case refused
    /// Nothing at all within the time allowed.
    case silent
}

extension Probe {
    /// A TCP connection through whatever route the system picks -- for a wave
    /// address, the tunnel.
    static func tcp(host: String, port: UInt16, timeout: TimeInterval = 5) async -> Probe {
        guard let endpointPort = NWEndpoint.Port(rawValue: port) else { return .silent }
        let connection = NWConnection(host: NWEndpoint.Host(host), port: endpointPort, using: .tcp)
        let started = Date()
        return await withCheckedContinuation { continuation in
            let finished = Finished()
            @Sendable func finish(_ result: Probe) {
                guard finished.claim() else { return }
                connection.cancel()
                continuation.resume(returning: result)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    finish(.answered(milliseconds: Int(Date().timeIntervalSince(started) * 1000)))
                case let .waiting(error), let .failed(error):
                    if case let .posix(code) = error, code == .ECONNREFUSED {
                        finish(.refused)
                    }
                default:
                    break
                }
            }
            connection.start(queue: .global())
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { finish(.silent) }
        }
    }
}

/// Lets exactly one of several racing callbacks finish a continuation.
private final class Finished: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    func claim() -> Bool {
        lock.withLock {
            if done { return false }
            done = true
            return true
        }
    }
}
