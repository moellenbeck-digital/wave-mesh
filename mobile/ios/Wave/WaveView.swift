import SwiftUI

/// One card per wave, each with its own switch -- the same shape as the tray on
/// the desktop, and for the same reason: a device can be in several waves, and
/// a single "connect" button would not say which one it meant.
struct WaveView: View {
    @StateObject var model: WaveModel
    @State private var controlURL = ""
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
                        Button("Dismiss") { model.failure = nil }
                    }
                }

                if !model.tunnelUp && !model.status.waves.isEmpty && model.login == .idle {
                    Section {
                        // The cards below are what the tunnel last reported;
                        // saying so keeps them from reading as live.
                        Label("The tunnel is off. Nothing in your waves is reachable from this device.", systemImage: "pause.circle")
                        Button("Connect") { model.connect() }
                    }
                }

                loginProgress

                ForEach(model.status.waves) { wave in
                    WaveSection(
                        wave: wave,
                        live: model.tunnelUp,
                        onToggle: { model.setEnabled(wave, $0) },
                        onLeave: { leaving = wave }
                    )
                }

                Section {
                    TextField("Control server, e.g. wave.example.com", text: $controlURL)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.join)
                        .onSubmit(join)
                    Button("Log in", action: join)
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
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                } header: {
                    Text("This device")
                } footer: {
                    let label = DeviceName.label(model.deviceName)
                    Text("In the next wave you join, this device is called \(label.isEmpty ? "node" : label). A wave it is already in keeps the name it got there.")
                }

                Section {
                    NavigationLink("Log") { LogView() }
                }
            }
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
            }
            .sheet(item: $model.approval) { approval in
                SafariView(url: approval.url).ignoresSafeArea()
            }
            .confirmationDialog(
                Text("Leave \(leaving?.label ?? "")?"),
                isPresented: Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } }),
                titleVisibility: .visible,
                presenting: leaving
            ) { wave in
                Button("Leave this wave", role: .destructive) { model.logout(controlURL: wave.controlUrl) }
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
            }
        case .waitingForApproval(let address):
            Section(address) {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Waiting for approval in the browser…")
                }
                Button("Open the approval page again") { model.reopenApproval() }
                Button("Cancel", role: .destructive) { model.cancelLogin() }
            }
        }
    }

    private func join() {
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

    var body: some View {
        Section {
            Toggle(isOn: Binding(get: { wave.enabled }, set: onToggle)) {
                Text(verbatim: wave.label).font(.headline)
            }
            // Petrol, not the system's green: there is no success green
            // (DESIGN.md), and "on" is the one signal.
            .tint(Color.accentColor)
            .disabled(!live)

            if wave.enabled && live {
                if !wave.dnsName.isEmpty {
                    CopyableRow(title: wave.dnsName, detail: wave.ipv4)
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
                    CopyableRow(title: service.dnsName.isEmpty ? service.name : service.dnsName, detail: service.ipv4)
                }
            } else if !wave.enabled {
                Text("Paused. This device stays in the wave and can switch it back on without a new approval.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Button("Leave this wave", role: .destructive, action: onLeave)
                .disabled(!live)
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
        HStack(alignment: .firstTextBaseline) {
            // State never by colour alone: the dot is decoration, the word
            // beside the path says it.
            Circle()
                .fill(peer.online ? Color.accentColor : Color.secondary.opacity(0.5))
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: peer.dnsName.isEmpty ? peer.hostname : peer.dnsName)
                Text(verbatim: peer.ipv4).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(peer.online ? path : String(localized: "offline"))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .contextMenu {
            Button("Copy name", systemImage: "doc.on.doc") { UIPasteboard.general.string = peer.dnsName }
            Button("Copy address", systemImage: "number") { UIPasteboard.general.string = peer.ipv4 }
        }
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
