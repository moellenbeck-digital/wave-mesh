import SwiftUI

/// One card per wave, each with its own switch -- the same shape as the tray on
/// the desktop, and for the same reason: a device can be in several waves, and
/// a single "connect" button would not say which one it meant.
struct WaveView: View {
    @StateObject var model: WaveModel
    @State private var controlURL = ""

    var body: some View {
        NavigationStack {
            List {
                if let failure = model.failure {
                    Section {
                        Text(failure).foregroundStyle(.red)
                    }
                }

                if let url = model.pendingAuthURL {
                    Section("Waiting for approval") {
                        Link("Open the enrolment link", destination: url)
                    }
                }

                Section("Join a wave") {
                    TextField("control server address", text: $controlURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Log in") {
                        model.login(controlURL: controlURL)
                        controlURL = ""
                    }
                    .disabled(controlURL.isEmpty)
                }

                if model.status.waves.isEmpty {
                    Section {
                        // Not in any wave is a different thing from a tunnel
                        // that is down, and saying so is the difference between
                        // a person looking for a bug and a person logging in.
                        Text("This device is in no wave yet. `wave login` is the only way in — there is no second one.")
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
            }
            // The product name is a name, not a word: it stays as it is in
            // every language, so it does not go through the catalog.
            .navigationTitle(Text(verbatim: "wave"))
            .toolbar {
                // Spelled out rather than as a ternary of literals: which
                // initializer a ternary picks is up to the type checker, and
                // the String one would silently skip the catalog.
                Button(model.status.running ? LocalizedStringKey("Disconnect") : LocalizedStringKey("Connect")) {
                    model.status.running ? model.disconnect() : model.connect()
                }
            }
        }
        .task { await model.load() }
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
