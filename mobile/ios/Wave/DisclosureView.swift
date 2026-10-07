import SwiftUI

/// What the app does with data, said before it does anything.
///
/// App Review guideline 5.4 asks VPN apps for a clear statement of what is
/// collected and where it goes "prior to any user action". It is shown once,
/// before the app creates its VPN configuration (which is what makes iOS ask
/// for permission), and it says only what is true of this app: there is no
/// server of ours in the path, no analytics and no advertising.
struct DisclosureView: View {
    let onAccept: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("wave-mesh sets up a VPN on this device that connects it with the other devices in your wave.")
                        .font(.title3.weight(.semibold))

                    point(
                        "network",
                        "What it connects",
                        "Traffic between your devices runs encrypted with WireGuard, directly from device to device. Where no direct path is possible, it runs encrypted through a relay of your wave."
                    )
                    point(
                        "server.rack",
                        "What your control server learns",
                        "To join a wave, the app sends the control server you enter this device's name, its public keys and the network addresses it can be reached at. Neither the control server nor the relay can read your traffic."
                    )
                    point(
                        "hand.raised",
                        "What we do not do",
                        "The app sends no data to Moellenbeck Digital. It contains no analytics and no advertising, and no data is sold or passed on."
                    )

                    Text("In the next step iOS asks whether wave-mesh may add a VPN configuration.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding()
            }
            .safeAreaInset(edge: .bottom) {
                Button(action: onAccept) {
                    Text("Continue").frame(maxWidth: .infinity)
                }
                .accessibilityIdentifier("disclosure.continue")
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding()
                .background(.bar)
            }
            .navigationTitle(Text(verbatim: "wave-mesh"))
        }
    }

    private func point(_ symbol: String, _ title: LocalizedStringKey, _ body: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(.tint)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(body).foregroundStyle(.secondary)
            }
        }
    }
}
