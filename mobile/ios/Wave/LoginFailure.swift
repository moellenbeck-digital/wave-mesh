import Foundation

/// The core's errors are Go's: English, and written for a log. The common ones
/// when joining all come down to a wrong address -- the wave's DNS domain
/// typed instead of its control server is the classic -- so they get a sentence
/// a person can act on. The original stays in the log, written by the tunnel.
enum LoginFailure {
    static func describe(_ message: String, address: String) -> String {
        let text = message.lowercased()
        if text.contains("x509") || text.contains("certificate") {
            return String(localized: "No wave-mesh control server answers at \(address); its certificate belongs to another service. Enter the address of your control server, not the domain of your wave.")
        }
        if text.contains("no such host") {
            return String(localized: "The address \(address) does not exist. Check how your control server's address is spelled.")
        }
        if text.contains("connection refused") || text.contains("timeout") || text.contains("deadline exceeded")
            || text.contains("network is unreachable")
        {
            return String(localized: "No server answers at \(address). Check the address and this device's connection.")
        }
        if text.contains("/v1/machine/register failed: 404") || text.contains("/v1/machine/register failed: 405") {
            return String(localized: "\(address) is not a wave-mesh control server.")
        }
        if text.contains("is not a control server address") {
            return String(localized: "\(address) is not a valid address.")
        }
        return message
    }
}
