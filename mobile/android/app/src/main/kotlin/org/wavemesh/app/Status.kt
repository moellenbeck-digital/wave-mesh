package org.wavemesh.app

import org.json.JSONArray
import org.json.JSONObject

// What the core reports, decoded. One definition of the shape lives in Go
// (`waveengine.Status`), and `core/waveengine/testdata/status.json` is the
// contract both apps are tested against: a reader that drifts from it fails
// every second, and the screen simply stops updating. The same structure as
// Status.swift on iOS.

data class Status(
    /** The one public UDP port, shared by every wave. */
    val port: Int,
    val running: Boolean,
    val waves: List<WaveStatus>,
) {
    fun toJSON(): String = JSONObject()
        .put("port", port)
        .put("running", running)
        .put("waves", JSONArray(waves.map { it.json }))
        .toString()

    companion object {
        val EMPTY = Status(port = 0, running = false, waves = emptyList())

        /** Null for anything that is not a status, so a bad answer keeps the last good one. */
        fun parse(json: String): Status? = runCatching {
            val root = JSONObject(json)
            Status(
                port = root.optInt("port"),
                running = root.optBoolean("running"),
                waves = root.objects("waves").map(::WaveStatus),
            )
        }.getOrNull()
    }
}

/** One wave. Kept on its JSON so a status cached by this build writes back what it read. */
data class WaveStatus(val json: JSONObject) {
    /**
     * The enrolment's key, what every action passes back: the server's address
     * for the first wave there, an id of its own for every further one.
     */
    val id: String get() = json.optString("id")
    val controlUrl: String get() = json.optString("controlUrl")
    /** The wave's DNS suffix once known, otherwise the server's host. */
    val label: String get() = json.optString("label")
    val hostname: String get() = json.optString("hostname")
    val dnsName: String get() = json.optString("dnsName")
    val ipv4: String get() = json.optString("ipv4")
    /** Switched on. A paused wave stays enrolled and carries nothing else. */
    val enabled: Boolean get() = json.optBoolean("enabled", true)
    /** "removed", "netmap-rejected" or "failed"; empty when fine. */
    val problem: String get() = json.optString("problem")
    /** The core's own words for it. */
    val detail: String get() = json.optString("detail")
    val connected: Boolean get() = json.optBoolean("connected")
    val relay: String get() = json.optString("relay")
    /** Whether the server offers a relay at all; null when an older core did not say. */
    val relayOffered: Boolean? get() = if (json.has("relayOffered")) json.optBoolean("relayOffered") else null
    val resolver: String get() = json.optString("resolver")
    val peers: List<PeerStatus> get() = json.objects("peers").map(::PeerStatus)
    val services: List<ServiceStatus> get() = json.objects("services").map(::ServiceStatus)

    // JSONObject has no value equality; two statuses are the same when they
    // read the same.
    override fun equals(other: Any?): Boolean = other is WaveStatus && other.json.toString() == json.toString()
    override fun hashCode(): Int = json.toString().hashCode()
}

data class PeerStatus(
    val hostname: String,
    val dnsName: String,
    val ipv4: String,
    val online: Boolean,
    val via: String,
    val rttMs: Int,
    /** Seconds since the last WireGuard handshake, -1 for none yet. */
    val lastHandshakeSeconds: Int,
) {
    constructor(json: JSONObject) : this(
        hostname = json.optString("hostname"),
        dnsName = json.optString("dnsName"),
        ipv4 = json.optString("ipv4"),
        online = json.optBoolean("online"),
        via = json.optString("via"),
        rttMs = json.optInt("rttMs"),
        lastHandshakeSeconds = json.optInt("lastHandshakeSeconds", -1),
    )

    /** Address and name together: either alone can be empty or repeat while a netmap is half there. */
    val key: String get() = "$ipv4|$dnsName|$hostname"
    val title: String get() = dnsName.ifEmpty { hostname }
}

data class ServiceStatus(
    val name: String,
    val dnsName: String,
    val ipv4: String,
    /** Where it opens, e.g. https://grafana.ops.example. */
    val url: String,
) {
    constructor(json: JSONObject) : this(
        name = json.optString("name"),
        dnsName = json.optString("dnsName"),
        ipv4 = json.optString("ipv4"),
        url = json.optString("url"),
    )

    val key: String get() = "$ipv4|$dnsName|$name"
    val title: String get() = dnsName.ifEmpty { name }
}

private fun JSONObject.objects(name: String): List<JSONObject> {
    val array = optJSONArray(name) ?: return emptyList()
    return (0 until array.length()).mapNotNull { array.optJSONObject(it) }
}
