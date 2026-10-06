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
    private var core: WavemobileCore?
    private var host: WaveHost?
    private let monitor = NWPathMonitor()
    /// The core needs the descriptor, and the descriptor only exists once
    /// settings have been applied at least once. Hence the two-step start
    /// below: empty settings first, then the core, then the real ones.
    private var started = false

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
                try self.startCore(host: host)
                host.log("tunnel running")
                completionHandler(nil)
            } catch {
                host.log("tunnel could not start: \(error.localizedDescription)")
                completionHandler(error)
            }
        }
    }

    private func startCore(host: WaveHost) throws {
        guard let descriptor = tunnelFileDescriptor else {
            throw WaveError.noTunnelDescriptor
        }

        var error: NSError?
        let core = WavemobileNew(
            host.loadState(),
            // Since iOS 16 this is the model ("iPhone", "iPad"), not the name
            // the owner gave the device; reading that needs an entitlement
            // Apple grants case by case.
            UIDevice.current.name,
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
        self.core = core

        // A utun descriptor prefixes every packet with a four-byte address
        // family; Android's does not. Getting this wrong produces a tunnel
        // where nothing is ever parsed, so it is told rather than guessed.
        try core.start(Int(descriptor), utunFraming: true, mtu: 1280)
        started = true

        // A phone changes network while it is being carried, and that is the
        // normal case rather than the exception: without this the tunnel only
        // recovers once its paths have timed out.
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            self?.core?.networkChanged()
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

    /// Messages from the app: the extension owns the core, so the app asks it.
    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        guard let request = try? JSONDecoder().decode(AppRequest.self, from: messageData) else {
            completionHandler?(nil)
            return
        }
        switch request.kind {
        case "status":
            completionHandler?(Data((core?.status() ?? "{}").utf8))
        case "login":
            // Blocks until somebody approves the device in a browser, so it
            // must not run on the thread that answers the app.
            let controlURL = request.controlURL ?? ""
            host?.log("login to \(controlURL)")
            PendingAuth.clear()
            DispatchQueue.global().async { [weak self] in
                let failure = self?.attempt { try self?.core?.login(controlURL, authKey: request.authKey ?? "") }
                // Approved, refused or timed out: either way the link is spent,
                // and a stale one would invite approving a request that is gone.
                PendingAuth.clear()
                self?.host?.log(failure.map { "login to \(controlURL) failed: \($0)" } ?? "login to \(controlURL) done")
                completionHandler?(Data((failure ?? "").utf8))
            }
        case "logout":
            let controlURL = request.controlURL ?? ""
            DispatchQueue.global().async { [weak self] in
                let failure = self?.attempt { try self?.core?.logout(controlURL) }
                self?.host?.log(failure.map { "logout from \(controlURL) failed: \($0)" } ?? "left \(controlURL)")
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
}

enum WaveError: LocalizedError {
    case noTunnelDescriptor
    case noCore

    /// Shown by iOS when the tunnel fails to start, so it is localized. The
    /// lookup goes to the extension's own bundle -- which is why the catalog
    /// has to be a member of this target too, not only of the app.
    var errorDescription: String? {
        switch self {
        case .noTunnelDescriptor:
            return String(localized: "the tunnel interface has no descriptor; the extension cannot carry traffic")
        case .noCore:
            return String(localized: "the wave core did not start")
        }
    }
}
