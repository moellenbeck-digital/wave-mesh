#if DEBUG
    import Foundation

    /// A stand-in for the extension and its core, for the UI tests.
    ///
    /// It answers the same messages with the same JSON the core writes
    /// (`waveengine.Status`), and behaves as the core does where it matters to
    /// the screen: a login waits for approval and can be cancelled, a wrong
    /// address fails with the core's own error, a paused wave keeps its place,
    /// a removed one says so. Only in debug builds; the tunnel itself is
    /// tested on Linux, through the real core.
    ///
    /// Launch arguments:
    ///   -UITestFakeTunnel      use this instead of the system's VPN
    ///   -UITestReset           start as a fresh install
    ///   -UITestRemovedWave     start in a wave the server has ended
    ///   -UITestOtherVPN        another app's VPN holds the slot until ours connects
    ///   -UITestDemo            a wave with more in it, for the store's screenshots
    @MainActor
    final class FakeTunnel: TunnelControl {

        private struct Wave {
            var id: String
            var controlUrl: String
            var suffix: String
            var enabled = true
            var problem = ""
            var hostname: String
        }

        private var connected = false
        /// Another app's VPN holds the slot until ours connects, as on a
        /// phone where iOS then disconnects the other one.
        private var otherSelected: Bool
        private var waves: [Wave] = []
        private var pending: [String: CheckedContinuation<String, Never>] = [:]
        /// More devices and services than the tests need, named as a small
        /// team would name them: what the store's screenshots show.
        private let demo: Bool

        init(arguments: [String]) {
            if arguments.contains("-UITestRemovedWave") {
                waves = [Wave(id: "https://wave.example.org", controlUrl: "https://wave.example.org", suffix: "ops.example.org",
                              enabled: false, problem: "removed", hostname: "phone")]
            }
            otherSelected = arguments.contains("-UITestOtherVPN")
            demo = arguments.contains("-UITestDemo")
        }

        func anotherVPNIsSelected() async -> Bool { otherSelected }

        func load() async throws {}

        var isConnected: Bool { connected }

        func start(autoConnect _: Bool) async throws {
            try await Task.sleep(nanoseconds: 300_000_000)
            connected = true
            otherSelected = false
        }

        func stop() async {
            connected = false
        }

        func setOnDemand(_: Bool) async throws {}

        func send(_ message: [String: Any]) async -> String? {
            guard connected, let kind = message["kind"] as? String else { return nil }
            let url = message["controlURL"] as? String ?? ""
            switch kind {
            case "status":
                return statusJSON()
            case "login":
                return await login(url, hostname: message["hostname"] as? String ?? "phone")
            case "add":
                // A further wave at the same server, as the core adds one:
                // its own key, its own name.
                try? await Task.sleep(nanoseconds: 800_000_000)
                let server = normalised(url)
                let count = waves.filter { $0.controlUrl == server }.count
                waves.append(Wave(id: "\(server)#\(count)", controlUrl: server, suffix: "project-b.example.org",
                                  hostname: message["hostname"] as? String ?? "phone"))
                return ""
            case "cancelLogin":
                pending.removeValue(forKey: normalised(url))?.resume(returning: "context canceled")
                PendingAuth.clear()
                return ""
            case "setEnabled":
                guard let index = waves.firstIndex(where: { $0.id == url || $0.id == normalised(url) }) else {
                    return "not in a wave at \(url)"
                }
                if waves[index].problem == "removed" {
                    return "the server removed this device from the wave at \(url); log in again"
                }
                waves[index].enabled = message["enabled"] as? Bool ?? true
                return ""
            case "logout":
                waves.removeAll { $0.id == url || $0.id == normalised(url) }
                return ""
            default:
                return nil
            }
        }

        /// What the core does with a login: a wrong address fails the way Go
        /// fails, "slow" waits for an approval until it is cancelled, anything
        /// else is approved after a moment.
        private func login(_ address: String, hostname: String) async -> String {
            // A wave's own key logs that enrolment in again.
            if let index = waves.firstIndex(where: { $0.id == address && $0.id.contains("#") }) {
                try? await Task.sleep(nanoseconds: 800_000_000)
                waves[index].problem = ""
                waves[index].enabled = true
                return ""
            }
            if let index = waves.firstIndex(where: { $0.id == normalised(address) }), waves[index].problem == "removed" {
                try? await Task.sleep(nanoseconds: 800_000_000)
                waves[index].problem = ""
                waves[index].enabled = true
                return ""
            }
            let url = normalised(address)
            if url.contains("ops.") {
                return #"Post "\#(url)/v1/machine/register": tls: failed to verify certificate: x509: certificate is valid for *.github.com, not \#(url.replacingOccurrences(of: "https://", with: ""))"#
            }
            if url.contains("slow") {
                // A link the view knows not to open: the simulator's sign-in
                // sheet would stop the test.
                UserDefaults(suiteName: WaveIdentifiers.appGroup)?.set("https://approval.invalid/approve", forKey: PendingAuth.key)
                return await withCheckedContinuation { pending[url] = $0 }
            }
            try? await Task.sleep(nanoseconds: 800_000_000)
            if waves.contains(where: { $0.id == url }) { return "" }
            let host = url.replacingOccurrences(of: "https://", with: "")
            waves.append(Wave(id: url, controlUrl: url, suffix: "ops.\(host.split(separator: ".").dropFirst().joined(separator: "."))",
                              hostname: hostname.isEmpty ? "phone" : hostname))
            return ""
        }

        private func normalised(_ address: String) -> String {
            let trimmed = address.trimmingCharacters(in: .whitespaces)
            let withScheme = trimmed.contains("://") ? trimmed : "https://" + trimmed
            return withScheme.hasSuffix("/") ? String(withScheme.dropLast()) : withScheme
        }

        private func statusJSON() -> String {
            let views: [[String: Any]] = waves.enumerated().map { index, wave in
                let suffix = wave.suffix
                let live = wave.enabled && wave.problem.isEmpty
                let third = index + 10
                return [
                    "id": wave.id, "controlUrl": wave.controlUrl, "label": suffix, "waveId": "w\(index)",
                    "suffix": live ? suffix : "", "hostname": live ? wave.hostname : "",
                    "dnsName": live ? "\(wave.hostname).\(suffix)" : "",
                    "ipv4": live ? "10.\(third).0.2" : "", "ipv6": "",
                    "enabled": wave.enabled, "problem": wave.problem,
                    "detail": wave.problem.isEmpty ? "" : "node-removed",
                    "connected": live,
                    // The first wave's server offers a relay and it is up; any
                    // further one offers none, as a server without WAVE_RELAYS.
                    "relay": live && index == 0 ? "wss://relay.\(wave.controlUrl.replacingOccurrences(of: "https://", with: ""))/relay" : "",
                    "relayOffered": live && index == 0,
                    "resolver": live ? "10.\(third).0.53" : "",
                    "peers": live ? (demo ? demoPeers(suffix, third) : [
                        ["hostname": "laptop", "dnsName": "laptop.\(suffix)", "ipv4": "10.\(third).0.3", "ipv6": "",
                         "online": true, "via": "192.168.1.20:41641", "rttMs": 12, "lastHandshakeSeconds": 8],
                        ["hostname": "nas", "dnsName": "nas.\(suffix)", "ipv4": "10.\(third).0.4", "ipv6": "",
                         "online": false, "via": "", "rttMs": 0, "lastHandshakeSeconds": -1],
                    ]) : [],
                    "services": live ? (demo ? demoServices(suffix, third) : [
                        ["name": "grafana", "dnsName": "grafana.\(suffix)", "ipv4": "10.\(third).0.9",
                         "url": "https://grafana.\(suffix)"],
                    ]) : [],
                ]
            }
            let status: [String: Any] = ["port": 41641, "running": connected, "waves": views]
            let data = (try? JSONSerialization.data(withJSONObject: status)) ?? Data("{}".utf8)
            return String(decoding: data, as: UTF8.self)
        }

        private func demoPeers(_ suffix: String, _ third: Int) -> [[String: Any]] {
            func peer(_ name: String, _ last: Int, via: String, rtt: Int, online: Bool = true) -> [String: Any] {
                ["hostname": name, "dnsName": "\(name).\(suffix)", "ipv4": "10.\(third).0.\(last)", "ipv6": "",
                 "online": online, "via": via, "rttMs": rtt, "lastHandshakeSeconds": online ? 6 : -1]
            }
            return [
                peer("macbook", 3, via: "192.168.1.20:41641", rtt: 4),
                peer("build-server", 4, via: "203.0.113.17:41641", rtt: 18),
                peer("cluster", 5, via: "relay", rtt: 31),
                peer("nas", 6, via: "", rtt: 0, online: false),
            ]
        }

        private func demoServices(_ suffix: String, _ third: Int) -> [[String: Any]] {
            ["grafana", "wiki", "git"].map { name in
                ["name": name, "dnsName": "\(name).\(suffix)", "ipv4": "10.\(third).0.5", "url": "https://\(name).\(suffix)"]
            }
        }
    }
#endif
