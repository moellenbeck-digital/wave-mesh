package de.robinlenz.wave

import android.content.Intent
import android.net.Uri
import android.net.VpnService
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
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
        setContent {
            MaterialTheme {
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

    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("wave", style = MaterialTheme.typography.headlineSmall)
            Button(onClick = { if (running) onDisconnect() else onConnect() }) {
                Text(if (running) "Disconnect" else "Connect")
            }
        }

        pending?.let {
            TextButton(onClick = onOpenAuthURL) { Text("Open the enrolment link") }
        }

        OutlinedTextField(
            value = controlURL,
            onValueChange = { controlURL = it },
            label = { Text("control server address") },
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = { onLogin(controlURL); controlURL = "" },
            enabled = controlURL.isNotBlank(),
        ) { Text("Log in") }

        if (waves.isEmpty()) {
            // Not in any wave is a different thing from a tunnel that is down,
            // and saying so is the difference between somebody looking for a
            // bug and somebody logging in.
            Text(
                "This device is in no wave yet. Logging in is the only way in — there is no second one.",
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
                    "no control connection; peers will stop being updated",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            val peers = wave.optJSONArray("peers")
            for (index in 0 until (peers?.length() ?: 0)) {
                val peer = peers!!.getJSONObject(index)
                Text("${peer.optString("hostname")} — ${pathOf(peer)}", style = MaterialTheme.typography.bodySmall)
            }
            TextButton(onClick = { onLogout(wave.optString("controlUrl")) }) {
                Text("Leave this wave")
            }
        }
    }
}

/// No confirmed path is not the same as a tunnel that is down: without one
/// every packet is sprayed at all known candidates, which carries -- it is only
/// wasteful and unmeasured. Saying "connecting" here would claim the tunnel is
/// down while a ping over it answers in 16 ms.
private fun pathOf(peer: JSONObject): String {
    val via = peer.optString("via")
    if (via.isEmpty()) return "no fixed path"
    val rtt = peer.optInt("rttMs", 0)
    return if (rtt > 0) "$via · $rtt ms" else via
}
