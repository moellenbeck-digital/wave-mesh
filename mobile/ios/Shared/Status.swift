import Foundation

// What the core reports, decoded. One definition of the shape lives in Go
// (`waveengine.Status`), and `core/waveengine/testdata/status.json` is the
// contract both are tested against: a decoder that drifts from it fails every
// second, and the screen simply stops updating.

struct Status: Codable, Equatable {
    /// The one public UDP port, shared by every wave.
    let port: Int
    let running: Bool
    let waves: [WaveStatus]
}

struct WaveStatus: Codable, Identifiable, Equatable {
    var id: String { controlUrl }
    let controlUrl: String
    let label: String
    let suffix: String
    let hostname: String
    let dnsName: String
    let ipv4: String
    /// Switched on. A paused wave stays enrolled and carries nothing else.
    let enabled: Bool
    let connected: Bool
    /// One per wave: the relay routes by disco key, and each enrolment has its
    /// own.
    let relay: String
    /// Where this wave's resolver answers.
    let resolver: String
    let peers: [PeerStatus]
    let services: [ServiceStatus]
}

struct PeerStatus: Codable, Identifiable, Equatable {
    /// Address and name together: either alone can be empty or repeat while a
    /// netmap is half there, and a list with two equal ids draws rows wrong.
    var id: String { "\(ipv4)|\(dnsName)|\(hostname)" }
    let hostname: String
    let dnsName: String
    let ipv4: String
    let online: Bool
    let via: String
    let rttMs: Int
}

struct ServiceStatus: Codable, Identifiable, Equatable {
    var id: String { "\(ipv4)|\(dnsName)|\(name)" }
    let name: String
    let dnsName: String
    let ipv4: String
}
