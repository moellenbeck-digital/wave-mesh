import SwiftUI

/// One card per wave, each with its own switch -- the same shape as the tray on
/// the desktop, and for the same reason: a device can be in several waves, and
/// a single "connect" button would not say which one it meant.
struct WaveView: View {
    @StateObject var model: WaveModel
    @State private var controlURL = ""
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

                loginProgress

                Section(model.status.waves.isEmpty ? "Join a wave" : "Add another wave") {
                    TextField("Control server, e.g. wave.example.com", text: $controlURL)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.join)
                        .onSubmit(join)
                    Button("Log in", action: join)
                        .disabled(controlURL.trimmingCharacters(in: .whitespaces).isEmpty || model.login != .idle)
                }

                if model.status.waves.isEmpty && model.login == .idle {
                    Section {
                        // Not in any wave is a different thing from a tunnel
                        // that is down, and saying so is the difference between
                        // a person looking for a bug and a person logging in.
                        Text("This device is in no wave yet. Enter the address of your control server to join one; the tunnel starts by itself.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                ForEach(model.status.waves) { wave in
                    Section(wave.label) {
                        LabeledContent(wave.hostname, value: wave.ipv4)
                        if !wave.connected {
                            // The tunnel keeps carrying traffic without the
                            // control connection -- the netmap is signed and
                            // already here -- so this is a warning, not an
                            // outage.
                            Text("no control connection; peers will stop being updated")
                                .font(.footnote)
                                .foregroundStyle(.orange)
                        }
                        ForEach(wave.peers) { peer in
                            PeerRow(peer: peer)
                        }
                        ForEach(wave.services) { service in
                            LabeledContent(service.name, value: service.ipv4)
                                .foregroundStyle(.secondary)
                        }
                        Button("Leave this wave", role: .destructive) {
                            model.logout(controlURL: wave.controlUrl)
                        }
                    }
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
                Button(model.status.running ? LocalizedStringKey("Disconnect") : LocalizedStringKey("Connect")) {
                    model.status.running ? model.disconnect() : model.connect()
                }
            }
            .sheet(item: $model.approval) { approval in
                SafariView(url: approval.url).ignoresSafeArea()
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

private struct PeerRow: View {
    let peer: PeerStatus

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(peer.hostname)
                Text(peer.ipv4).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(path).font(.caption).foregroundStyle(.secondary)
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
