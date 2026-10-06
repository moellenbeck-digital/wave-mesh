import Foundation
import NetworkExtension
import Wavemobile

/// What the core calls back into.
///
/// Four things, and each is something only the platform can do: apply the
/// settings it computed, keep a line, persist the keys, show an enrolment link.
/// Nothing here decides anything.
final class WaveHost: NSObject, WavemobileCallbacksProtocol {
    private weak var provider: NEPacketTunnelProvider?
    /// The private keys of every enrolment. The keychain, because a plain file
    /// in the container is backed up and readable by anything that gets the
    /// container.
    private let stateAccount = "wave.state"
    private let stateService = "org.wavemesh.enrolments"

    init(provider: NEPacketTunnelProvider) {
        self.provider = provider
        super.init()
    }

    // MARK: - WavemobileCallbacks

    /// Applies the union of every wave to the one tunnel iOS allows.
    ///
    /// Synchronous towards the core on purpose: it is called only when the
    /// union actually changed, and the core wants to know whether the tunnel is
    /// what it believes it is. `setTunnelNetworkSettings` is atomic and knows
    /// no partial failure, which is why the core refuses a colliding wave
    /// before it ever gets here rather than repairing one afterwards.
    func applySettings(_ settingsJSON: String?) throws {
        guard let settingsJSON else { throw WaveError.noCore }
        let settings: WaveSettings
        do {
            settings = try WaveSettings.decode(settingsJSON)
        } catch {
            // The one failure that once left every phone without addresses,
            // routes or DNS, silently: said out loud from now on.
            log("could not read the tunnel settings from the core: \(error)")
            throw error
        }
        guard let provider else { throw WaveError.noCore }
        let dropped = settings.routes.map(\.cidr).filter { !WaveSettings.isNarrowEnough($0) }
        if !dropped.isEmpty {
            log("refused routes broad enough to take over the phone's traffic: \(dropped)")
        }
        if !settings.dnsServers.isEmpty && settings.matchDomains.isEmpty {
            log("no DNS settings: the core named servers but no domains, and without domains they would answer for every name")
        }
        let network = settings.networkSettings()

        // Applied without waiting: the completion arrives on another queue, and
        // blocking the core's caller here would hold up the netmap handler that
        // asked for it. A failure is logged, which is what the core would do
        // with it anyway.
        provider.setTunnelNetworkSettings(network) { [weak self] error in
            if let error {
                self?.log("could not apply the tunnel settings: \(error.localizedDescription)")
                return
            }
            // What a missing route or an unresolved name is checked against.
            self?.log(
                "applied: addresses \(settings.addresses), routes \(settings.routes.map(\.cidr)), "
                    + "dns \(settings.dnsServers) for \(settings.matchDomains), mtu \(settings.mtu)"
            )
        }
    }

    func log(_ line: String?) {
        guard let line else { return }
        WaveLog.write(line, from: .tunnel)
    }

    func saveState(_ encoded: Data?) {
        guard let encoded else { return }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: stateService,
            kSecAttrAccount as String: stateAccount,
        ]
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = encoded
        // After first unlock, not "when unlocked": the tunnel comes up at boot
        // and there is nobody there to unlock the phone for it.
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(query as CFDictionary, nil)
        if status != errSecSuccess {
            log("could not store the enrolments (keychain status \(status))")
        }
    }

    func loadState() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: stateService,
            kSecAttrAccount as String: stateAccount,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let text = String(data: data, encoding: .utf8)
        else {
            // A device that has never joined anything, which is not an error.
            return ""
        }
        return text
    }

    /// The enrolment link. The extension cannot open a browser, so it is put
    /// where the app will find it and the app opens it.
    func openAuthURL(_ url: String?) {
        guard let url else { return }
        log("waiting for approval: \(url)")
        UserDefaults(suiteName: appGroup)?.set(url, forKey: PendingAuth.key)
    }

    /// Nothing to do: a packet tunnel provider's own sockets do not go through
    /// its tunnel. Android is where this matters.
    func protectSocket(_ fd: Int) -> Bool { true }
}

/// The app group both halves share. The extension owns the core; the app only
/// ever asks it things.
let appGroup = WaveIdentifiers.appGroup
