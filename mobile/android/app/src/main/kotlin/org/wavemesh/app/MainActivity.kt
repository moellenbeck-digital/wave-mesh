package org.wavemesh.app

import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.net.VpnService
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.edit
import kotlinx.coroutines.delay
import org.json.JSONObject

/// The window. It owns nothing: the service holds the core, because it is the
/// process Android keeps running.
class MainActivity : ComponentActivity() {
    private val requestPermission = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) startService(Intent(this, WaveVpnService::class.java))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Status and navigation bar icons follow the theme instead of staying
        // white on a light screen.
        enableEdgeToEdge()
        val prefs = getSharedPreferences("app", MODE_PRIVATE)
        setContent {
            MaterialTheme(colorScheme = waveColors(isSystemInDarkTheme())) {
                Surface(Modifier.fillMaxSize()) { Content(prefs) }
            }
        }
    }

    @Composable
    private fun Content(prefs: SharedPreferences) {
        var disclosureAccepted by remember { mutableStateOf(prefs.getBoolean(DISCLOSURE_ACCEPTED, false)) }
        if (!disclosureAccepted) {
            DisclosureScreen(onAccept = {
                prefs.edit { putBoolean(DISCLOSURE_ACCEPTED, true) }
                disclosureAccepted = true
            })
        } else {
            WaveScreen(
                onConnect = ::connect,
                onDisconnect = ::disconnect,
                onLogin = { url -> WaveVpnService.instance?.login(url) { } },
                onLogout = { url -> WaveVpnService.instance?.logout(url) { } },
                onOpenAuthURL = ::openPendingAuthURL,
                pendingAuthURL = { WaveState.pendingAuthURL(this) },
                status = { WaveVpnService.instance?.status() ?: "{}" },
            )
        }
    }

    /// Android asks the person once, in a dialog only the system can show.
    private fun connect() {
        val consent = VpnService.prepare(this)
        if (consent != null) {
            requestPermission.launch(consent)
            return
        }
        startService(Intent(this, WaveVpnService::class.java))
    }

    private fun disconnect() {
        startService(Intent(this, WaveVpnService::class.java).setAction(WaveVpnService.ACTION_STOP))
    }

    private fun openPendingAuthURL() {
        val url = WaveState.pendingAuthURL(this) ?: return
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        WaveState.clearPendingAuthURL(this)
    }

    private companion object {
        /// Versioned, so a changed statement is shown again.
        const val DISCLOSURE_ACCEPTED = "disclosureAccepted.v1"
    }
}

/// Petrol is the one accent (DESIGN.md, "Mobile Apps"); on dark surfaces a
/// shade lighter, as for the tray icon. Material's default surfaces carry a
/// tint of its purple seed, so they are set neutral; the rest stays default.
private fun waveColors(dark: Boolean) =
    if (dark) {
        darkColorScheme(
            primary = Color(0xFF0F7F7F),
            onPrimary = Color.White,
            background = Color(0xFF121212),
            surface = Color(0xFF121212),
        )
    } else {
        lightColorScheme(
            primary = Color(0xFF0F6E6E),
            onPrimary = Color.White,
            background = Color.White,
            surface = Color.White,
        )
    }

/// What the app does with data, said before it does anything: the Play policy
/// for VpnService and the same statement the iOS app shows. Once, before the
/// first connect, and only what is true of this app -- there is no server of
/// ours in the path, no analytics and no advertising.
@Composable
private fun DisclosureScreen(onAccept: () -> Unit) {
    Column(
        Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineMedium)
            Text(stringResource(R.string.disclosure_intro), style = MaterialTheme.typography.titleLarge)
            DisclosurePoint(R.string.disclosure_connects_title, R.string.disclosure_connects_body)
            DisclosurePoint(R.string.disclosure_control_title, R.string.disclosure_control_body)
            DisclosurePoint(R.string.disclosure_ours_title, R.string.disclosure_ours_body)
            Text(stringResource(R.string.disclosure_next), style = MaterialTheme.typography.bodySmall)
        }
        Button(onClick = onAccept, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.disclosure_continue))
        }
    }
}

@Composable
private fun DisclosurePoint(title: Int, body: Int) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(stringResource(title), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(body), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun WaveScreen(
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onLogin: (String) -> Unit,
    onLogout: (String) -> Unit,
    onOpenAuthURL: () -> Unit,
    pendingAuthURL: () -> String?,
    status: () -> String,
) {
    var raw by remember { mutableStateOf("{}") }
    var pending by remember { mutableStateOf<String?>(null) }
    var controlURL by remember { mutableStateOf("") }

    // A path, an RTT and a handshake age say nothing until you watch them move,
    // which is why this redraws rather than showing one reading.
    LaunchedEffect(Unit) {
        while (true) {
            raw = status()
            pending = pendingAuthURL()
            delay(1000)
        }
    }

    val root = remember(raw) { runCatching { JSONObject(raw) }.getOrDefault(JSONObject()) }
    val running = root.optBoolean("running", false)
    val waves = remember(raw) {
        val array = root.optJSONArray("waves")
        (0 until (array?.length() ?: 0)).map { array!!.getJSONObject(it) }
    }

    // From targetSdk 35 every app is drawn edge to edge; the insets keep the
    // header out from under the status bar and the list above the gesture bar.
    Column(Modifier.safeDrawingPadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineSmall)
            Button(onClick = { if (running) onDisconnect() else onConnect() }) {
                Text(stringResource(if (running) R.string.disconnect else R.string.connect))
            }
        }

        pending?.let {
            TextButton(onClick = onOpenAuthURL) { Text(stringResource(R.string.open_enrolment_link)) }
        }

        OutlinedTextField(
            value = controlURL,
            onValueChange = { controlURL = it },
            label = { Text(stringResource(R.string.control_server_address)) },
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = { onLogin(controlURL); controlURL = "" },
            enabled = controlURL.isNotBlank(),
        ) { Text(stringResource(R.string.log_in)) }

        if (waves.isEmpty()) {
            // Not in any wave is a different thing from a tunnel that is down,
            // and saying so is the difference between somebody looking for a
            // bug and somebody logging in.
            Text(
                stringResource(R.string.no_wave_yet),
                style = MaterialTheme.typography.bodySmall,
            )
        }

        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(waves) { wave ->
                WaveCard(wave = wave, onLogout = onLogout)
            }
        }
    }
}

@Composable
private fun WaveCard(wave: JSONObject, onLogout: (String) -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(wave.optString("label"), style = MaterialTheme.typography.titleMedium)
            Text("${wave.optString("hostname")} · ${wave.optString("ipv4")}")
            if (!wave.optBoolean("connected", false)) {
                // The tunnel keeps carrying traffic without the control
                // connection -- the netmap is signed and already here -- so
                // this is a warning, not an outage.
                Text(
                    stringResource(R.string.no_control_connection),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            val peers = wave.optJSONArray("peers")
            for (index in 0 until (peers?.length() ?: 0)) {
                val peer = peers!!.getJSONObject(index)
                Text("${peer.optString("hostname")} — ${pathOf(peer)}", style = MaterialTheme.typography.bodySmall)
            }
            TextButton(onClick = { onLogout(wave.optString("controlUrl")) }) {
                Text(stringResource(R.string.leave_wave))
            }
        }
    }
}

/// No confirmed path is not the same as a tunnel that is down: without one
/// every packet is sprayed at all known candidates, which carries -- it is only
/// wasteful and unmeasured. Saying "connecting" here would claim the tunnel is
/// down while a ping over it answers in 16 ms.
///
/// Composable only for `stringResource`: the core reports "relay" or the
/// address of the direct path, and only the word is translated -- an address is
/// the same in every language.
@Composable
private fun pathOf(peer: JSONObject): String {
    val raw = peer.optString("via")
    if (raw.isEmpty()) return stringResource(R.string.path_none)
    val via = if (raw == "relay") stringResource(R.string.path_relay) else raw
    val rtt = peer.optInt("rttMs", 0)
    return if (rtt > 0) stringResource(R.string.path_with_rtt, via, rtt) else via
}
