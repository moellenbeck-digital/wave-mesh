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
            .navigationTitle("wave")
            .toolbar {
                Button(model.status.running ? "Disconnect" : "Connect") {
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
    private var path: String {
        if peer.via.isEmpty { return "no fixed path" }
        if peer.rttMs > 0 { return "\(peer.via) · \(peer.rttMs) ms" }
        return peer.via
    }
}
