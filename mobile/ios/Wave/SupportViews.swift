import SwiftUI

/// What the list links to. SwiftUI makes a NavigationLink's destination with
/// every redraw of the list -- once a second, with the status -- and LogView's
/// initial values read the whole log, up to half a megabyte. This page has
/// nothing to compare, so its body, and with it LogView, is made only when the
/// page is actually opened.
struct LogPage: View {
    var body: some View { LogView() }
}

/// The shared log (`WaveLog`): what the tunnel and the app did, newest last,
/// to be read here or shared with whoever helps.
struct LogView: View {
    @State private var lines = LogView.load()
    @State private var export = WaveLog.export()

    /// Line by line, newest last.
    private static func load() -> [String] {
        WaveLog.read().split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }

    private func reload() {
        lines = Self.load()
        export = WaveLog.export()
    }

    var body: some View {
        ScrollView {
            if lines.isEmpty {
                Text("The log is empty.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding()
            } else {
                // One Text per line, made as they scroll in. A single Text
                // holding the whole log -- up to half a megabyte -- is taller
                // than the largest layer iOS will draw, and the page came out
                // black on a phone that had been running for a day.
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(lines.indices, id: \.self) { index in
                        Text(verbatim: lines[index])
                            .font(.caption.monospaced())
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .textSelection(.enabled)
                .padding()
                .accessibilityIdentifier("log.lines")
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
                Button("Refresh", systemImage: "arrow.clockwise") { reload() }
                // A file, not the text: a messenger refuses a message of half
                // a megabyte -- Telegram sent nothing at all -- and takes a
                // document of any size.
                if let export, !lines.isEmpty {
                    ShareLink(item: export, preview: SharePreview(export.lastPathComponent)) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                    .accessibilityIdentifier("log.share")
                }
                Button("Clear", systemImage: "trash", role: .destructive) {
                    WaveLog.clear()
                    lines = []
                    export = nil
                }
            }
        }
    }
}
