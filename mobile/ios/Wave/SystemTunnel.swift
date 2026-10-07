import NetworkExtension

/// What the app needs from the VPN system: one configuration, started and
/// stopped, and a way to ask the extension things.
///
/// A seam rather than NETunnelProviderManager everywhere, so the app's own
/// behaviour -- what it shows, asks and does -- can be driven in the
/// simulator, where there is no packet tunnel. The tunnel itself is tested on
/// Linux through the same core (test/e2e/mobile-lifecycle.sh).
@MainActor
protocol TunnelControl: AnyObject {
    /// Finds or creates the configuration. Creating it is what makes iOS ask
    /// whether wave-mesh may add a VPN.
    func load() async throws
    var isConnected: Bool { get }
    /// Starts the tunnel and returns once it is up, or throws why it is not.
    func start(autoConnect: Bool) async throws
    /// Stops it and keeps it stopped: on-demand is switched off first.
    func stop() async
    /// Brings the configuration's on-demand in line with the switch.
    func setOnDemand(_ on: Bool) async throws
    /// One question to the extension; nil when it is not there to answer.
    func send(_ message: [String: Any]) async -> String?
    /// Whether another app's VPN took the one slot iOS has since ours last
    /// ran -- so connecting now would disconnect it, without a word from iOS.
    func anotherVPNIsSelected() async -> Bool
}

/// The real one: NETunnelProviderManager and the packet tunnel extension.
@MainActor
final class SystemTunnel: TunnelControl {
    private var manager: NETunnelProviderManager?

    func load() async throws {
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
            // Not enabled yet: iOS has one VPN slot, and enabling ours here
            // would take it from Tailscale or any other just by opening the
            // app. The first connect enables it.
            manager.isEnabled = false
            try await manager.saveToPreferences()
            try await manager.loadFromPreferences()
        }
        self.manager = manager
    }

    var isConnected: Bool { manager?.connection.status == .connected }

    func start(autoConnect: Bool) async throws {
        guard let manager else { throw ModelError.notReady }
        if manager.connection.status == .connected { return }
        if !manager.isEnabled || manager.isOnDemandEnabled != autoConnect {
            // isEnabled: another VPN configuration may have taken over since
            // this one was saved.
            manager.isEnabled = true
            let always = NEOnDemandRuleConnect()
            always.interfaceTypeMatch = .any
            manager.onDemandRules = [always]
            manager.isOnDemandEnabled = autoConnect
            try await manager.saveToPreferences()
            try await manager.loadFromPreferences()
        }
        WaveLog.write("starting the tunnel", from: .app)
        try manager.connection.startVPNTunnel()
        try await waitUntilConnected(manager.connection)
        UserDefaults(suiteName: WaveIdentifiers.appGroup)?.set(true, forKey: Self.hasRunKey)
    }

    private static let hasRunKey = "tunnelHasRun"

    /// iOS disables our configuration when another app enables its own: that
    /// is the one reliable sign, since no API names other apps' VPNs (the
    /// system's own utun interfaces are there on every phone, VPN or not).
    /// Before ours ever ran, a disabled configuration only means it is new.
    func anotherVPNIsSelected() async -> Bool {
        guard let manager else { return false }
        try? await manager.loadFromPreferences()
        let hasRun = UserDefaults(suiteName: WaveIdentifiers.appGroup)?.bool(forKey: Self.hasRunKey) ?? false
        return hasRun && !manager.isEnabled
    }

    func stop() async {
        if let manager, manager.isOnDemandEnabled {
            manager.isOnDemandEnabled = false
            try? await manager.saveToPreferences()
        }
        manager?.connection.stopVPNTunnel()
    }

    func setOnDemand(_ on: Bool) async throws {
        // Only while connected when switching on: turning on-demand on for a
        // tunnel that is down would start it.
        guard let manager, manager.isEnabled, manager.isOnDemandEnabled != on else { return }
        if on && manager.connection.status != .connected { return }
        manager.isOnDemandEnabled = on
        try await manager.saveToPreferences()
    }

    func send(_ message: [String: Any]) async -> String? {
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

    /// Waits for the tunnel the system was just asked to start.
    ///
    /// Right after startVPNTunnel the status still reads "disconnected": the
    /// system takes the request asynchronously. Treating that first reading as
    /// a failure refused every start in build 4. So "disconnected" only counts
    /// once the tunnel was seen starting, or after a grace period in which it
    /// never did.
    private func waitUntilConnected(_ connection: NEVPNConnection) async throws {
        let started = Date()
        var seenStarting = false
        while Date().timeIntervalSince(started) < 30 {
            switch connection.status {
            case .connected:
                return
            case .connecting, .reasserting:
                seenStarting = true
            case .disconnected, .invalid:
                if seenStarting || Date().timeIntervalSince(started) > 5 {
                    throw await startFailure(connection)
                }
            default:
                break
            }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        throw await startFailure(connection)
    }

    /// Why the tunnel did not come up, as the system recorded it -- usually
    /// the error the extension's startTunnel ended with.
    private func startFailure(_ connection: NEVPNConnection) async -> Error {
        // The async form throws the recorded error rather than returning it;
        // returning normally means nothing was recorded.
        var text: String?
        do {
            try await connection.fetchLastDisconnectError()
        } catch {
            text = error.localizedDescription
        }
        WaveLog.write("the tunnel did not start: \(text ?? "no reason recorded")", from: .app)
        return ModelError.tunnelDidNotStart(text)
    }
}
