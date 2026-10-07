import SwiftUI

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
