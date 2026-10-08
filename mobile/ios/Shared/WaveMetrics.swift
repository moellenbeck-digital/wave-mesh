import Foundation
import MetricKit

/// What iOS measured about us, written into the shared log.
///
/// Two things nothing else on a phone shows us. How much the tunnel costs --
/// CPU time, bytes over cellular and Wi-Fi, time in the background -- once a
/// day, so a change meant to save battery can be seen to save it rather than
/// argued about. And why a process ended: a crash, a hang, a kill for memory or
/// CPU. A tester once reported the app closing by itself, and there was no
/// report under its name to read; MetricKit hands such a diagnostic to the next
/// launch, and from here on it lands in the log the tester can share.
///
/// Both halves subscribe: the app and the tunnel extension are separate
/// processes, and iOS reports each about itself. Nothing leaves the device
/// unless the log is shared -- the same promise the disclosure makes.
final class WaveMetrics: NSObject, MXMetricManagerSubscriber {
    private let source: WaveLog.Source

    private init(source: WaveLog.Source) {
        self.source = source
    }

    private static var subscriber: WaveMetrics?

    /// Starts listening, once per process.
    static func start(as source: WaveLog.Source) {
        guard subscriber == nil else { return }
        let metrics = WaveMetrics(source: source)
        subscriber = metrics
        MXMetricManager.shared.add(metrics)
    }

    func didReceive(_ payloads: [MXMetricPayload]) {
        for payload in payloads {
            WaveLog.write(Self.summary(of: payload), from: source)
        }
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            for line in Self.lines(of: payload) {
                WaveLog.write(line, from: source)
            }
        }
    }

    /// One line per day: what the tunnel cost.
    static func summary(of payload: MXMetricPayload) -> String {
        let hours = payload.timeStampEnd.timeIntervalSince(payload.timeStampBegin) / 3600
        var parts = [String(format: "metrics for %.0f h:", hours)]
        if let cpu = payload.cpuMetrics {
            parts.append(String(format: "cpu %.0f s", cpu.cumulativeCPUTime.converted(to: .seconds).value))
        }
        if let network = payload.networkTransferMetrics {
            parts.append("cellular \(megabytes(network.cumulativeCellularUpload)) up / \(megabytes(network.cumulativeCellularDownload)) down")
            parts.append("wifi \(megabytes(network.cumulativeWifiUpload)) up / \(megabytes(network.cumulativeWifiDownload)) down")
        }
        if let time = payload.applicationTimeMetrics {
            parts.append(String(format: "background %.1f h", time.cumulativeBackgroundTime.converted(to: .hours).value))
        }
        if let memory = payload.memoryMetrics {
            parts.append(String(format: "peak memory %.0f MB", memory.peakMemoryUsage.converted(to: .megabytes).value))
        }
        return parts.joined(separator: ", ")
    }

    /// What ended a process, kept short: the kind, and the first frames that
    /// say where. The full call stack is too long for a log line.
    static func lines(of payload: MXDiagnosticPayload) -> [String] {
        var lines: [String] = []
        for crash in payload.crashDiagnostics ?? [] {
            let reason = crash.terminationReason ?? "no reason given"
            let exception = crash.exceptionType.map { "exception \($0)" } ?? "no exception"
            let signal = crash.signal.map { "signal \($0)" } ?? "no signal"
            lines.append("diagnostic: crash in \(crash.metaData.applicationBuildVersion): \(exception), \(signal), \(reason)")
            lines.append("diagnostic: crash stack \(frames(of: crash.callStackTree))")
        }
        for hang in payload.hangDiagnostics ?? [] {
            let seconds = hang.hangDuration.converted(to: .seconds).value
            lines.append(String(format: "diagnostic: hang of %.1f s in %@", seconds, hang.metaData.applicationBuildVersion))
            lines.append("diagnostic: hang stack \(frames(of: hang.callStackTree))")
        }
        for cpu in payload.cpuExceptionDiagnostics ?? [] {
            let seconds = cpu.totalCPUTime.converted(to: .seconds).value
            lines.append(String(format: "diagnostic: too much CPU, %.0f s", seconds))
        }
        for write in payload.diskWriteExceptionDiagnostics ?? [] {
            let megabytes = write.totalWritesCaused.converted(to: .megabytes).value
            lines.append(String(format: "diagnostic: too many disk writes, %.0f MB", megabytes))
        }
        return lines
    }

    private static func megabytes(_ value: Measurement<UnitInformationStorage>) -> String {
        String(format: "%.1f MB", value.converted(to: .megabytes).value)
    }

    /// The first frames of the stack, as binary+offset: enough to tell our
    /// code from the system's, and short enough for one line.
    private static func frames(of tree: MXCallStackTree) -> String {
        guard let object = try? JSONSerialization.jsonObject(with: tree.jsonRepresentation()) as? [String: Any],
              let stacks = object["callStacks"] as? [[String: Any]]
        else { return "unreadable" }
        var found: [String] = []
        func walk(_ frames: [[String: Any]]) {
            for frame in frames where found.count < 8 {
                let binary = frame["binaryName"] as? String ?? "?"
                let offset = frame["offsetIntoBinaryTextSegment"] as? Int ?? 0
                found.append("\(binary)+\(offset)")
                if let deeper = frame["subFrames"] as? [[String: Any]] { walk(deeper) }
            }
        }
        // The thread that crashed or hung is marked; it is the one that says where.
        let thread = stacks.first(where: { $0["threadAttributed"] as? Bool == true }) ?? stacks.first
        walk(thread?["callStackRootFrames"] as? [[String: Any]] ?? [])
        return found.joined(separator: " < ")
    }
}
