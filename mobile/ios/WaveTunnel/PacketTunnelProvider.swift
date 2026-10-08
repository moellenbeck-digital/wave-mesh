import NetworkExtension
import Network
import UIKit
import Wavemobile

/// The tunnel: a thin host around the Go core.
///
/// Everything that decides anything is in the core (`mobile/core`), which runs
/// under `go test` on any machine. What is left here is the three things only
/// iOS can do: hand over the tunnel descriptor, apply the settings the core
/// computed, and say when the network changed.
///
/// The extension is capped at roughly 50 MB, which is why the core is Go and
/// not a JavaScript runtime -- and why there is nothing in this file that could
/// be in the core instead.
class PacketTunnelProvider: NEPacketTunnelProvider {
    /// Read from the app's message queue and from background work, cleared by
    /// stopTunnel on another: unguarded, a read could meet the release halfway.
    private var core: WavemobileCore? {
        get { coreLock.withLock { storedCore } }
        set { coreLock.withLock { storedCore = newValue } }
    }
    private var storedCore: WavemobileCore?
    private let coreLock = NSLock()
    private var host: WaveHost?
    private let monitor = NWPathMonitor()
    /// The core needs the descriptor, and the descriptor only exists once
    /// settings have been applied at least once. Hence the two-step start
    /// below: empty settings first, then the core, then the real ones.
    private var started = false
    /// Found while preparing, used once the core runs.
    private var descriptor: Int32?
    /// Left once the core has started (or failed to). Requests from the app
    /// wait on it: a login that arrives while the waves are still coming up
    /// would otherwise reach a core whose socket does not exist yet.
    private let ready = DispatchGroup()
    /// The physical networks last seen, so only a real change rebinds.
    private var lastNetworks: String?

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        let host = WaveHost(provider: self)
        self.host = host
        host.log("tunnel starting")

        // Applying settings is what creates the utun, so the descriptor cannot
        // exist before this. The placeholder carries no addresses and no
        // routes: nothing is reachable through it, and the core replaces it
        // with the real union as soon as it has a netmap.
        let placeholder = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "127.0.0.1")
        placeholder.mtu = NSNumber(value: 1280)
        setTunnelNetworkSettings(placeholder) { [weak self] error in
            guard let self else { return }
            if let error {
                host.log("tunnel could not start: \(error.localizedDescription)")
                completionHandler(error)
                return
            }
            do {
                try self.prepareCore(host: host)
            } catch {
                host.log("tunnel could not start: \(error.localizedDescription)")
                completionHandler(error)
                return
            }
            // Reported as started before the core touches the network. With
            // on-demand on, iOS holds the phone's traffic while a tunnel is
            // still connecting -- and bringing a wave up means a request to
            // its control server, which can take as long as that server
            // takes, and the whole phone would wait with it. The placeholder
            // routes nothing, so being "up" early costs nothing.
            //
            // Entered before the system hears "up", so no request from the
            // app can slip in ahead of the start.
            self.ready.enter()
            completionHandler(nil)
            DispatchQueue.global(qos: .userInitiated).async {
                defer { self.ready.leave() }
                do {
                    try self.runCore()
                    host.log("tunnel running")
                } catch {
                    host.log("the core did not start: \(error.localizedDescription)")
                    self.cancelTunnelWithError(error)
                }
            }
        }
    }

    /// What has to happen before the system is told the tunnel is up, and
    /// needs no network: the descriptor, and a core that has not started.
    private func prepareCore(host: WaveHost) throws {
        guard let descriptor = tunnelFileDescriptor else {
            throw WaveError.noTunnelDescriptor
        }

        var error: NSError?
        let core = WavemobileNew(
            host.loadState(),
            // What the person chose in the app; otherwise the model. Since
            // iOS 16 UIDevice.name is "iPhone" or "iPad", not the name the
            // owner gave the device -- reading that needs an entitlement Apple
            // grants case by case.
            DeviceName.stored.map(DeviceName.label).flatMap { $0.isEmpty ? nil : $0 } ?? UIDevice.current.name,
            // iOS can limit which names reach us (matchDomains), so the
            // resolver never has to answer for anything but the waves --
            // the invariant "never take over the system resolver" holds here.
            false,
            "",
            host,
            &error
        )
        if let error { throw error }
        guard let core else { throw WaveError.noCore }
        // What the control server shows next to this device: the phones
        // register as "other", and say what they are in their hello.
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        core.setClientInfo("ios", version: "\(version) (\(build))")
        self.core = core
        self.descriptor = descriptor
    }

    /// Starts the core: the socket, the multiplexer, and every wave -- which
    /// asks each control server for a netmap. Runs after the tunnel is up.
    private func runCore() throws {
        guard let core, let descriptor else { throw WaveError.noCore }

        // A utun descriptor prefixes every packet with a four-byte address
        // family; Android's does not. Getting this wrong produces a tunnel
        // where nothing is ever parsed, so it is told rather than guessed.
        try core.start(Int(descriptor), utunFraming: true, mtu: 1280)
        started = true

        // A phone changes network while it is being carried, and that is the
        // normal case rather than the exception: without this the tunnel only
        // recovers once its paths have timed out.
        //
        // Only a change of the networks underneath counts. The monitor also
        // fires for our own utun -- every time settings are applied -- and
        // rebinding on that would make the tunnel trip over itself.
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self, path.status == .satisfied else { return }
            let underneath = path.availableInterfaces
                .filter { $0.type != .other && $0.type != .loopback }
                .map { "\($0.type):\($0.name)" }
                .joined(separator: ",")
            guard underneath != self.lastNetworks else { return }
            let first = self.lastNetworks == nil
            self.lastNetworks = underneath
            if !first {
                self.host?.log("network changed: \(underneath)")
                self.core?.networkChanged()
            }
        }
        monitor.start(queue: DispatchQueue(label: "org.wavemesh.path"))
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        host?.log("tunnel stopping (reason \(reason.rawValue))")
        monitor.cancel()
        core?.stop()
        core = nil
        completionHandler()
    }

    /// After sleep NAT mappings and idle connections may have expired, so the
    /// core asks STUN and each connection whether they still hold. Waking is
    /// not a network change: treated as one, every wake-up rebound the socket,
    /// reconnected every wave and made the whole wave re-punch -- and iOS
    /// wakes a tunnel far more often than anybody changes network. A real
    /// change arrives through the path monitor above.
    override func wake() {
        host?.log("woke up")
        core?.woke()
    }

    /// Messages from the app: the extension owns the core, so the app asks it.
    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        guard let request = try? JSONDecoder().decode(AppRequest.self, from: messageData) else {
            completionHandler?(nil)
            return
        }
        // Without a core every call below would go to nil and come back as
        // success -- a login that "worked" and joined nothing.
        if core == nil && request.kind != "status" {
            completionHandler?(Data((WaveError.noCore.errorDescription ?? "").utf8))
            return
        }
        // Everything but status and cancel waits until the core has started;
        // a cancel must never queue behind the login it is meant to end.
        if request.kind != "status" && request.kind != "cancelLogin" {
            ready.notify(queue: .global()) { [weak self] in
                self?.handle(request, completionHandler: completionHandler)
            }
            return
        }
        handle(request, completionHandler: completionHandler)
    }

    private func handle(_ request: AppRequest, completionHandler: ((Data?) -> Void)?) {
        switch request.kind {
        case "status":
            completionHandler?(Data((core?.status() ?? "{}").utf8))
        case "login":
            // Blocks until somebody approves the device in a browser, so it
            // must not run on the thread that answers the app.
            let controlURL = request.controlURL ?? ""
            host?.log("login to \(controlURL)")
            PendingAuth.clear()
            if let name = request.hostname, !name.isEmpty {
                core?.setHostname(name)
            }
            DispatchQueue.global().async { [weak self] in
                let failure = self?.attempt { try self?.core?.login(controlURL, authKey: request.authKey ?? "") }
                // Approved, refused or timed out: either way the link is spent,
                // and a stale one would invite approving a request that is gone.
                PendingAuth.clear()
                self?.host?.log(failure.map { "login to \(controlURL) failed: \($0)" } ?? "login to \(controlURL) done")
                completionHandler?(Data((failure ?? "").utf8))
            }
        case "add":
            // A further wave at a server this device is already in: a new
            // enrolment, and the server asks which wave it goes to.
            let controlURL = request.controlURL ?? ""
            host?.log("adding a wave at \(controlURL)")
            PendingAuth.clear()
            if let name = request.hostname, !name.isEmpty {
                core?.setHostname(name)
            }
            DispatchQueue.global().async { [weak self] in
                let failure = self?.attempt { try self?.core?.addWave(controlURL, authKey: request.authKey ?? "") }
                PendingAuth.clear()
                self?.host?.log(failure.map { "adding a wave at \(controlURL) failed: \($0)" } ?? "added a wave at \(controlURL)")
                completionHandler?(Data((failure ?? "").utf8))
            }
        case "logout":
            let controlURL = request.controlURL ?? ""
            DispatchQueue.global().async { [weak self] in
                let failure = self?.attempt { try self?.core?.logout(controlURL) }
                self?.host?.log(failure.map { "logout from \(controlURL) failed: \($0)" } ?? "left \(controlURL)")
                completionHandler?(Data((failure ?? "").utf8))
            }
        case "cancelLogin":
            core?.cancelLogin(request.controlURL ?? "")
            completionHandler?(Data())
        case "setEnabled":
            let controlURL = request.controlURL ?? ""
            let enabled = request.enabled ?? true
            DispatchQueue.global().async { [weak self] in
                let failure = self?.attempt { try self?.core?.setEnabled(controlURL, enabled: enabled) }
                self?.host?.log("\(controlURL) \(enabled ? "switched on" : "paused")\(failure.map { ": \($0)" } ?? "")")
                completionHandler?(Data((failure ?? "").utf8))
            }
        default:
            completionHandler?(nil)
        }
    }

    private func attempt(_ work: () throws -> Void) -> String? {
        do {
            try work()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// The descriptor of the tunnel iOS just created.
    ///
    /// `packetFlow` offers packets but no descriptor, and the core needs one --
    /// a Go read loop on a file, not a callback per packet. There is no API for
    /// it, so the process is asked instead: exactly one of its sockets is a
    /// utun control socket, and `UTUN_OPT_IFNAME` is what identifies it. The
    /// alternative doing the rounds -- reading `socket.fileDescriptor` off
    /// `packetFlow` by key path -- depends on a private property name and
    /// breaks silently when it changes.
    private var tunnelFileDescriptor: Int32? {
        var name = [CChar](repeating: 0, count: Int(IFNAMSIZ))
        for descriptor in Int32(0)...1024 {
            var length = socklen_t(name.count)
            let found = getsockopt(descriptor, sysprotoControl, utunOptIfname, &name, &length)
            if found == 0 && String(cString: name).hasPrefix("utun") {
                return descriptor
            }
        }
        return nil
    }
}

// From <sys/kern_control.h> and <net/if_utun.h>, which the iOS SDK does not
// ship although the kernel is the same as on macOS.
private let sysprotoControl: Int32 = 2
private let utunOptIfname: Int32 = 2

private struct AppRequest: Decodable {
    let kind: String
    let controlURL: String?
    let authKey: String?
    /// The name to ask for, sent with a login.
    let hostname: String?
    /// For setEnabled.
    let enabled: Bool?
}

enum WaveError: LocalizedError {
    case noTunnelDescriptor
    case noCore
    case settingsTimedOut

    /// Shown by iOS when the tunnel fails to start, so it is localized. The
    /// lookup goes to the extension's own bundle -- which is why the catalog
    /// has to be a member of this target too, not only of the app.
    var errorDescription: String? {
        switch self {
        case .noTunnelDescriptor:
            return String(localized: "the tunnel interface has no descriptor; the extension cannot carry traffic")
        case .noCore:
            return String(localized: "the wave core did not start")
        case .settingsTimedOut:
            return String(localized: "iOS did not apply the tunnel settings in time")
        }
    }
}
