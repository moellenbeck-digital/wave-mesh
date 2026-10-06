import SafariServices
import SwiftUI

/// The enrolment page, inside the app.
///
/// Sending somebody to Safari and hoping they find their way back is where a
/// login used to get lost; here they approve and close, and the wave is there.
/// No callback URL is needed: the core polls the control server until the
/// device is approved.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.dismissButtonStyle = .close
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

/// The shared log (`WaveLog`): what the tunnel and the app did, newest last,
/// to be read here or shared with whoever helps.
struct LogView: View {
    @State private var text = WaveLog.read()

    var body: some View {
        ScrollView {
            if text.isEmpty {
                Text("The log is empty.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding()
            } else {
                Text(verbatim: text)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
        }
        .defaultScrollAnchor(.bottom)
        .safeAreaInset(edge: .bottom) {
            Text("The log stays on this device until you share it.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(8)
                .frame(maxWidth: .infinity)
                .background(.bar)
        }
        .navigationTitle("Log")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Refresh", systemImage: "arrow.clockwise") { text = WaveLog.read() }
                ShareLink(item: text) { Label("Share", systemImage: "square.and.arrow.up") }
                    .disabled(text.isEmpty)
                Button("Clear", systemImage: "trash", role: .destructive) {
                    WaveLog.clear()
                    text = ""
                }
            }
        }
    }
}
