package org.wavemesh.app

import android.content.Context
import java.net.URI
import java.net.URLDecoder
import java.text.Normalizer

/// The name this device asks for when it joins a wave -- the same rules as
/// DeviceName in the iOS app, so the two show the same preview for the same
/// input.
object DeviceName {
    private const val KEY = "deviceName"

    fun stored(context: Context): String? =
        prefs(context).getString(KEY, null)?.trim()?.takeIf { it.isNotEmpty() }

    fun store(context: Context, name: String) {
        prefs(context).edit().putString(KEY, name).apply()
    }

    /**
     * The name as it will appear in the wave. The control server keeps
     * [a-z0-9-] and turns everything else into a hyphen, which makes
     * "Möllenbeck" into "m-llenbeck"; folding first keeps it readable, and the
     * app shows the result before anybody joins with it.
     */
    fun label(name: String): String {
        var folded = name.lowercase()
        for ((from, to) in listOf("ä" to "ae", "ö" to "oe", "ü" to "ue", "ß" to "ss")) {
            folded = folded.replace(from, to)
        }
        folded = Normalizer.normalize(folded, Normalizer.Form.NFD).replace(Regex("\\p{Mn}+"), "")
        val label = StringBuilder()
        var lastWasHyphen = false
        for (character in folded) {
            if (character in 'a'..'z' || character in '0'..'9') {
                label.append(character)
                lastWasHyphen = false
            } else if (!lastWasHyphen) {
                label.append('-')
                lastWasHyphen = true
            }
        }
        return label.toString().trim('-').take(63)
    }
}

/// The core's errors are Go's: English, and written for a log. The common ones
/// when joining all come down to a wrong address -- the wave's DNS domain
/// typed instead of its control server is the classic -- so they get a
/// sentence a person can act on. The original stays in the log. The same
/// cases as LoginFailure.swift.
object LoginFailure {
    fun describe(context: Context, message: String, address: String): String {
        val text = message.lowercase()
        return when {
            "x509" in text || "certificate" in text -> context.getString(R.string.failure_certificate, address)
            "no such host" in text -> context.getString(R.string.failure_no_such_host, address)
            "connection refused" in text || "timeout" in text || "deadline exceeded" in text ||
                "network is unreachable" in text -> context.getString(R.string.failure_no_answer, address)
            "/v1/machine/register failed: 404" in text || "/v1/machine/register failed: 405" in text ->
                context.getString(R.string.failure_not_a_server, address)
            "is not a control server address" in text -> context.getString(R.string.failure_invalid_address, address)
            else -> message
        }
    }
}

/// The link a QR code in the web interface carries: `wavemesh://join?server=<url>`.
///
/// Nothing but the control server's address. Opening it never joins anything
/// by itself: the app asks first, and the browser approval still follows, so a
/// code somebody else printed grants nothing.
object WaveInvite {
    const val SCHEME = "wavemesh"

    /**
     * The server a link names, or null for anything that is not such a link.
     * java.net.URI rather than android.net.Uri, so the rules run in a plain
     * unit test.
     */
    fun server(link: String?): String? {
        val uri = link?.let { runCatching { URI(it) }.getOrNull() } ?: return null
        if (uri.scheme?.lowercase() != SCHEME || uri.host?.lowercase() != "join") return null
        val value = uri.rawQuery?.split("&")
            ?.map { it.split("=", limit = 2) }
            ?.firstOrNull { it.size == 2 && it[0] == "server" }
            ?.get(1)
            ?.let { URLDecoder.decode(it, "UTF-8") }
            ?: return null
        val server = runCatching { URI(value) }.getOrNull() ?: return null
        val scheme = server.scheme?.lowercase()
        if (scheme != "https" && scheme != "http") return null
        val host = server.host?.takeIf { it.isNotEmpty() } ?: return null
        // Only the origin: a path or query in a printed code is not ours to follow.
        return if (server.port > 0) "$scheme://$host:${server.port}" else "$scheme://$host"
    }
}

/// The host of an address, for showing: a wave's key ("https://…#a1b2") or a
/// server URL, either way the host is what a person recognises.
fun hostOf(address: String): String =
    runCatching { URI(address).host }.getOrNull()?.takeIf { it.isNotEmpty() } ?: address

/// Plain preferences for what is not a secret: the device name, the switch,
/// the last status. The keys live in WaveState, encrypted.
fun prefs(context: Context) = context.getSharedPreferences("app", Context.MODE_PRIVATE)
