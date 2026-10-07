import AuthenticationServices
import SwiftUI

/// One card per wave, each with its own switch -- the same shape as the tray on
/// the desktop, and for the same reason: a device can be in several waves, and
/// a single "connect" button would not say which one it meant.
struct WaveView: View {
    @StateObject var model: WaveModel
    @Environment(\.webAuthenticationSession) private var webAuthentication
    /// The approval page currently open, cancelled once the login is over.
    @State private var approvalTask: Task<Void, Never>?
    @State private var controlURL = ""
    /// Released after "Log in", so the keyboard does not cover the progress
    /// and the wave that follow.
    @FocusState private var addressFocused: Bool
    /// The wave whose "leave" is being confirmed.
    @State private var leaving: WaveStatus?
    /// Versioned, so a changed disclosure is shown again rather than counted as
    /// already accepted.
    @AppStorage("disclosureAccepted.v1") private var disclosureAccepted = false

    var body: some View {
        if disclosureAccepted {
            waves
        } else {
            DisclosureView { disclosureAccepted = true }
        }
    }

    private var waves: some View {
        NavigationStack {
            List {
                if let failure = model.failure {
                    Section {
                        Label(failure, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("failure")
                        Button("Dismiss") { model.failure = nil }
                    }
                }

                if !model.tunnelUp && !model.status.waves.isEmpty && model.login == .idle {
                    Section {
                        // The cards below are what the tunnel last reported;
                        // saying so keeps them from reading as live.
                        Label("The tunnel is off. Nothing in your waves is reachable from this device.", systemImage: "pause.circle")
                            .accessibilityIdentifier("tunnelOff")
                        Button("Connect") { model.connect() }
                    }
                }

                loginProgress

                ForEach(model.status.waves) { wave in
                    WaveSection(
                        wave: wave,
                        live: model.tunnelUp,
                        onToggle: { model.setEnabled(wave, $0) },
                        onLeave: { leaving = wave },
                        onLoginAgain: { model.loginAgain(wave) },
                        onAddWave: { model.addWave(at: wave) }
                    )
                }

                Section {
                    TextField("Control server, e.g. wave.example.com", text: $controlURL)
                        .focused($addressFocused)
                        .accessibilityIdentifier("join.address")
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.join)
                        .onSubmit(join)
                    Button("Log in", action: join)
                        .accessibilityIdentifier("join.login")
                        .disabled(controlURL.trimmingCharacters(in: .whitespaces).isEmpty || model.login != .idle)
                } header: {
                    Text(model.status.waves.isEmpty ? "Join a wave" : "Add another wave")
                } footer: {
                    if model.status.waves.isEmpty {
                        // Not in any wave is a different thing from a tunnel
                        // that is down, and saying so is the difference
                        // between a person looking for a bug and a person
                        // logging in.
                        Text("This device is in no wave yet. Enter the address of your control server to join one; the tunnel starts by itself.")
                    }
                }

                Section {
                    TextField("Device name", text: $model.deviceName)
                        .accessibilityIdentifier("device.name")
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                } header: {
                    Text("This device")
                } footer: {
                    let label = DeviceName.label(model.deviceName)
                    Text("In the next wave you join, this device is called \(label.isEmpty ? "node" : label). A wave it is already in keeps the name it got there.")
                        .accessibilityIdentifier("device.preview")
                }

                Section {
                    Toggle("Connect automatically", isOn: $model.autoConnect)
                        .accessibilityIdentifier("autoConnect")
                        .tint(Color.accentColor)
                } footer: {
                    Text("After a restart or a network change the tunnel comes back by itself. iOS runs one VPN at a time: switch this off if you also use another one and want to choose each time.")
                }

                Section {
                    NavigationLink("Log") { LogPage() }
                        .accessibilityIdentifier("log")
                }
            }
            // The keyboard goes as soon as the list moves: left open after
            // typing an address it covered the end of the list, and with it
            // "Leave this wave" and the log.
            .scrollDismissesKeyboard(.immediately)
            // The product name is a name, not a word: it stays as it is in
            // every language, so it does not go through the catalog.
            .navigationTitle(Text(verbatim: "wave-mesh"))
            .toolbar {
                // Spelled out rather than as a ternary of literals: which
                // initializer a ternary picks is up to the type checker, and
                // the String one would silently skip the catalog.
                Button(model.tunnelUp ? LocalizedStringKey("Disconnect") : LocalizedStringKey("Connect")) {
                    model.tunnelUp ? model.disconnect() : model.connect()
                }
                .accessibilityIdentifier(model.tunnelUp ? "tunnel.disconnect" : "tunnel.connect")
            }
            .onChange(of: model.approval) { _, approval in
                approvalTask?.cancel()
                approvalTask = nil
                guard let approval else { return }
                #if DEBUG
                    // The UI tests' stand-in link: the system sheet would
                    // stop them, and there is nothing behind it to approve.
                    if approval.url.host == "approval.invalid" { return }
                #endif
                // The system's sign-in sheet rather than a Safari view of our
                // own: it shares Safari's cookies, so somebody signed in to
                // the control server there is not asked again -- with a
                // password and a second factor -- every time. Nothing calls
                // back; the core notices the approval, and the sheet is
                // cancelled when the login is over.
                approvalTask = Task {
                    _ = try? await webAuthentication.authenticate(
                        using: approval.url,
                        callbackURLScheme: "wavemesh-approval",
                        preferredBrowserSession: .shared
                    )
                    if !Task.isCancelled { model.approval = nil }
                }
            }
            .confirmationDialog(
                "Another VPN is connected",
                isPresented: Binding(get: { model.takeover != nil }, set: { if !$0 { model.takeover = nil } }),
                titleVisibility: .visible,
                presenting: model.takeover
            ) { takeover in
                Button("Connect wave-mesh") { takeover.proceed() }
                    .accessibilityIdentifier("takeover.confirm")
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("iOS runs one VPN at a time. Connecting wave-mesh disconnects the other one, for example Tailscale.")
            }
            .confirmationDialog(
                Text("Leave \(leaving?.label ?? "")?"),
                isPresented: Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } }),
                titleVisibility: .visible,
                presenting: leaving
            ) { wave in
                Button("Leave this wave", role: .destructive) { model.logout(controlURL: wave.id) }
                    .accessibilityIdentifier("leave.confirm")
            } message: { _ in
                Text("This device leaves the wave and forgets its keys. Joining again needs a new approval.")
            }
        }
        .task { await model.load() }
    }

    /// Says where a login is: a join that shows nothing for half a minute
    /// looks exactly like one that was ignored.
    @ViewBuilder
    private var loginProgress: some View {
        switch model.login {
        case .idle:
            EmptyView()
        case .connecting(let address):
            Section {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Connecting to \(address)…")
                }
                .accessibilityIdentifier("login.connecting")
            }
        case .waitingForApproval(let address):
            // An address, or a wave's key ("https://…#a1b2") when one is
            // logged in again: the host is what a person recognises.
            Section(URL(string: address)?.host() ?? address) {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Waiting for approval in the browser…")
                }
                .accessibilityIdentifier("login.waiting")
                Button("Open the approval page again") { model.reopenApproval() }
                Button("Cancel", role: .destructive) { model.cancelLogin() }
                    .accessibilityIdentifier("login.cancel")
            }
        }
    }

    private func join() {
        addressFocused = false
        let address = controlURL
        Task {
            if await model.join(controlURL: address) { controlURL = "" }
        }
    }
}

/// One wave: its switch, this device's name in it, and who else is there.
private struct WaveSection: View {
    let wave: WaveStatus
    /// Whether this is the tunnel's current word or the last one it said.
    let live: Bool
    let onToggle: (Bool) -> Void
    let onLeave: () -> Void
    let onLoginAgain: () -> Void
    let onAddWave: () -> Void

    var body: some View {
        Section {
            Toggle(isOn: Binding(get: { wave.enabled }, set: onToggle)) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: wave.label).font(.headline)
                    // Several waves can share a server; the name above is the
                    // wave's own, this says where it lives.
                    if let host = URL(string: wave.controlUrl)?.host(), host != wave.label {
                        Text(verbatim: host).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            // Petrol, not the system's green: there is no success green
            // (DESIGN.md), and "on" is the one signal.
            .tint(Color.accentColor)
            .accessibilityIdentifier("wave.toggle.\(wave.label)")
            .disabled(!live || wave.problem == "removed")

            problem

            if wave.enabled && live {
                if !wave.dnsName.isEmpty {
                    CopyableRow(title: wave.dnsName, detail: wave.ipv4)
                        .accessibilityIdentifier("wave.self.\(wave.label)")
                }
                if !wave.connected {
                    // The tunnel keeps carrying traffic without the control
                    // connection -- the netmap is signed and already here --
                    // so this is a warning, not an outage.
                    Text("no control connection; peers will stop being updated")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
                ForEach(wave.peers) { peer in
                    PeerRow(peer: peer)
                }
                ForEach(wave.services) { service in
                    ServiceRow(service: service)
                }
            } else if !wave.enabled && wave.problem.isEmpty {
                Text("Paused. This device stays in the wave and can switch it back on without a new approval.")
                    .accessibilityIdentifier("wave.paused.\(wave.label)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            // The tray's "Open <host>": devices, people, access rules and
            // renaming this device all live in the web interface.
            if let url = URL(string: wave.controlUrl) {
                Link(destination: url) {
                    Label("Open the web interface", systemImage: "safari")
                }
                .accessibilityIdentifier("wave.web.\(wave.label)")
            }

            // Another project's network on the same server: a new enrolment,
            // and the approval asks which wave.
            Button("Add another wave at this server", systemImage: "plus.circle", action: onAddWave)
                .disabled(!live)
                .accessibilityIdentifier("wave.add.\(wave.label)")

            Button("Leave this wave", role: .destructive, action: onLeave)
                .disabled(!live)
                .accessibilityIdentifier("wave.leave.\(wave.label)")
        }
    }

    /// What is wrong with this wave, said where the wave is.
    @ViewBuilder
    private var problem: some View {
        switch wave.problem {
        case "removed":
            Label("This device was removed from the wave. Log in again to come back; it needs a new approval.", systemImage: "person.crop.circle.badge.xmark")
                .foregroundStyle(.red)
                .accessibilityIdentifier("wave.removed.\(wave.label)")
            Button("Log in again", action: onLoginAgain)
                .accessibilityIdentifier("wave.loginAgain.\(wave.label)")
        case "netmap-rejected":
            Label("The control server sent a network map that does not carry its signature. Nothing in it was used; the wave keeps the last good one.", systemImage: "exclamationmark.shield")
                .foregroundStyle(.red)
        case "failed":
            Label("This wave did not come up: \(wave.detail)", systemImage: "exclamationmark.triangle")
                .foregroundStyle(.red)
        default:
            EmptyView()
        }
    }
}

/// A service: tapped, it opens -- in the browser, like the tray and the web
/// do; held, its name and address can be copied.
private struct ServiceRow: View {
    let service: ServiceStatus

    var body: some View {
        let title = service.dnsName.isEmpty ? service.name : service.dnsName
        Group {
            if let url = URL(string: service.url), !service.url.isEmpty {
                Link(destination: url) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: title)
                                .accessibilityIdentifier("service.\(service.name)")
                            Text(verbatim: service.ipv4).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "arrow.up.forward.square").foregroundStyle(.tint)
                    }
                }
            } else {
                CopyableRow(title: title, detail: service.ipv4)
            }
        }
        .contextMenu {
            Button("Copy name", systemImage: "doc.on.doc") { UIPasteboard.general.string = title }
            Button("Copy address", systemImage: "number") { UIPasteboard.general.string = service.ipv4 }
        }
    }
}

/// A name and an address, both copyable: the name is what gets typed into a
/// browser or an SSH client, so it has to be easy to take from here.
private struct CopyableRow: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: title).textSelection(.enabled)
            Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
        }
        .contextMenu {
            Button("Copy name", systemImage: "doc.on.doc") { UIPasteboard.general.string = title }
            if !detail.isEmpty {
                Button("Copy address", systemImage: "number") { UIPasteboard.general.string = detail }
            }
        }
    }
}

private struct PeerRow: View {
    let peer: PeerStatus

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            // State never by colour alone: the dot is decoration, the word
            // beside it says it.
            Circle()
                .fill(peer.online ? Color.accentColor : Color.secondary.opacity(0.5))
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                // One line, shortened in the middle: the end of a name is the
                // wave's domain, the start is what tells two devices apart.
                Text(verbatim: peer.dnsName.isEmpty ? peer.hostname : peer.dnsName)
                    .lineLimit(1)
                    .truncationMode(.middle)
                // Address and path below the name rather than beside it:
                // side by side they squeezed the name into broken lines.
                Text(verbatim: "\(peer.ipv4) · \(peer.online ? path : String(localized: "offline"))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if peer.lastHandshakeSeconds >= 0 {
                    // Our own view, beside the server's online state: when the
                    // two last talked through the tunnel.
                    Text("Last handshake \(Self.ago(peer.lastHandshakeSeconds))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .contextMenu {
            Button("Copy name", systemImage: "doc.on.doc") { UIPasteboard.general.string = peer.dnsName }
            Button("Copy address", systemImage: "number") { UIPasteboard.general.string = peer.ipv4 }
        }
    }

    /// One for all rows: every row is drawn again each second.
    private static let agoFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter
    }()

    private static func ago(_ seconds: Int) -> String {
        agoFormatter.localizedString(fromTimeInterval: -TimeInterval(seconds))
    }

    /// No confirmed path is not the same as a tunnel that is down: without one
    /// every packet is sprayed at all known candidates, which carries -- it is
    /// only wasteful and unmeasured. Saying "connecting" here would claim the
    /// tunnel is down while a ping over it answers in 16 ms.
    ///
    /// A plain `String`, so every piece goes through `String(localized:)`
    /// explicitly -- `Text(path)` would show it verbatim.
    private var path: String {
        if peer.via.isEmpty { return String(localized: "no fixed path") }
        // The core says "relay" or the address of the direct path; only the
        // word is translated, an address is the same in every language.
        let via = peer.via == "relay" ? String(localized: "relay") : peer.via
        // Catalog key: "%@ · %lld ms" (String becomes %@, Int becomes %lld).
        if peer.rttMs > 0 { return String(localized: "\(via) · \(peer.rttMs) ms") }
        return via
    }
}
