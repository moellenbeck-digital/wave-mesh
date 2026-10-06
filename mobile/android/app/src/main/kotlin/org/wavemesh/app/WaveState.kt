package org.wavemesh.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject

/// Where the enrolments live.
///
/// The state carries three private keys per wave, which is why this is
/// EncryptedSharedPreferences and not a file: a plain one in the app's data
/// directory ends up in a backup and is readable by anything that gets the
/// device unlocked. Losing it costs a re-enrolment; leaking it costs the wave.
object WaveState {
    private const val FILE = "wave-state"
    private const val KEY_STATE = "state"
    private const val KEY_PENDING_AUTH = "pendingAuthUrl"

    private fun preferences(context: Context): SharedPreferences =
        EncryptedSharedPreferences.create(
            context,
            FILE,
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )

    /// An empty string is a device that has never joined anything, which the
    /// core takes as exactly that rather than as an error.
    fun load(context: Context): String = preferences(context).getString(KEY_STATE, "") ?: ""

    fun save(context: Context, encoded: String) {
        preferences(context).edit().putString(KEY_STATE, encoded).apply()
    }

    fun setPendingAuthURL(context: Context, url: String) {
        preferences(context).edit().putString(KEY_PENDING_AUTH, url).apply()
    }

    fun pendingAuthURL(context: Context): String? =
        preferences(context).getString(KEY_PENDING_AUTH, null)

    fun clearPendingAuthURL(context: Context) {
        preferences(context).edit().remove(KEY_PENDING_AUTH).apply()
    }
}

/// The union, as the core sends it. One definition of the shape lives in Go
/// (`wavesettings.Settings`); this is its reading.
data class WaveSettings(
    val addresses: List<String>,
    val routes: List<String>,
    val mtu: Int,
    val dnsServers: List<String>,
    val matchDomains: List<String>,
    val searchDomains: List<String>,
) {
    companion object {
        fun parse(json: String): WaveSettings {
            val root = JSONObject(json)
            return WaveSettings(
                addresses = root.strings("addresses"),
                routes = root.strings("routes"),
                mtu = root.optInt("mtu", 1280),
                dnsServers = root.strings("dnsServers"),
                matchDomains = root.strings("matchDomains"),
                searchDomains = root.strings("searchDomains"),
            )
        }

        private fun JSONObject.strings(name: String): List<String> {
            val array: JSONArray = optJSONArray(name) ?: return emptyList()
            return (0 until array.length()).mapNotNull { array.optString(it).takeIf(String::isNotEmpty) }
        }
    }
}
