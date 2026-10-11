package org.wavemesh.app

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import java.net.URI

/// "Check connection" for one wave: what works and what does not, in
/// sentences -- the same page as CheckView on iOS.
///
/// A connector that was dead, a server that offered no relay and a phone that
/// reset its sessions all looked the same from the outside: a page that did
/// not load. Each of them is one line here. For every service the wave offers
/// it opens a real connection through the tunnel, because "the path looks
/// fine" is not the same as "it answers".
@Composable
fun CheckPage(wave: WaveStatus, tunnelUp: Boolean, probe: suspend (String, Int) -> Probe, onDone: () -> Unit) {
    val colors = LocalWaveColors.current
    val results = remember { mutableStateMapOf<String, Probe>() }
    var running by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    suspend fun runProbes() {
        running = true
        results.clear()
        coroutineScope {
            wave.services.map { service ->
                async {
                    val (host, port) = target(service)
                    results[service.key] = probe(host, port)
                }
            }.awaitAll()
        }
        running = false
    }

    LaunchedEffect(wave.id) { runProbes() }

    Column(Modifier.fillMaxSize().background(colors.background).safeDrawingPadding()) {
        InlineBar(
            title = stringResource(R.string.check_connection),
            leading = { BarButton(icon = Icons.Outlined.Refresh, text = stringResource(R.string.again), enabled = !running) { scope.launch { runProbes() } } },
            trailing = { BarButton(text = stringResource(R.string.done), bold = true, onClick = onDone) },
        )
        LazyColumn(Modifier.fillMaxSize()) {
            item("basics") {
                Section(header = wave.label) {
                    row { CheckLine(tunnelUp, stringResource(R.string.check_tunnel_ok), stringResource(R.string.check_tunnel_bad)) }
                    row { CheckLine(wave.connected, stringResource(R.string.check_control_ok), stringResource(R.string.check_control_bad)) }
                    when {
                        wave.relay.isNotEmpty() -> row { CheckLine(true, stringResource(R.string.check_relay_ok), "") }
                        wave.relayOffered == true -> row { CheckLine(false, "", stringResource(R.string.check_relay_down)) }
                        wave.relayOffered == false -> row { CheckLine(false, "", stringResource(R.string.check_relay_none)) }
                    }
                    row { CheckLine(wave.resolver.isNotEmpty(), stringResource(R.string.check_dns_ok), stringResource(R.string.check_dns_bad)) }
                }
            }
            if (wave.peers.isNotEmpty()) {
                item("peers") {
                    Section(header = stringResource(R.string.devices)) {
                        for (peer in wave.peers) row { PeerLine(peer) }
                    }
                }
            }
            if (wave.services.isNotEmpty()) {
                item("services") {
                    Section(header = stringResource(R.string.services), footer = stringResource(R.string.check_services_footer)) {
                        for (service in wave.services) row { ServiceLine(service, results[service.key]) }
                    }
                }
            }
            item("end") { Spacer(Modifier.height(32.dp)) }
        }
    }
}

/// Where a service is opened: its address, and the port its URL implies.
fun target(service: ServiceStatus): Pair<String, Int> {
    val url = runCatching { URI(service.url) }.getOrNull()
    val port = when {
        url == null -> 443
        url.port > 0 -> url.port
        url.scheme == "http" -> 80
        else -> 443
    }
    return service.ipv4 to port
}

@Composable
private fun CheckLine(ok: Boolean, good: String, bad: String) {
    val colors = LocalWaveColors.current
    Line(if (ok) Icons.Outlined.CheckCircle else Icons.Outlined.Warning, if (ok) colors.accent else colors.orange, if (ok) good else bad)
}

@Composable
private fun Line(icon: ImageVector, tint: Color, text: String) {
    val colors = LocalWaveColors.current
    ListRow {
        Icon(icon, null, tint = tint, modifier = Modifier.size(22.dp).align(Alignment.Top))
        Text(text, style = WaveType.body, color = colors.label)
    }
}

@Composable
private fun PeerLine(peer: PeerStatus) {
    val colors = LocalWaveColors.current
    val name = peer.title
    val (ok, text) = when {
        !peer.online -> true to stringResource(R.string.check_peer_offline, name)
        peer.via == "idle" -> true to stringResource(R.string.check_peer_resting, name)
        peer.lastHandshakeSeconds in 0 until 300 -> {
            val way = stringResource(if (peer.via == "relay") R.string.through_relay else R.string.directly)
            true to stringResource(R.string.check_peer_reachable, name, way)
        }
        peer.via.isEmpty() -> false to stringResource(R.string.check_peer_never, name)
        else -> false to stringResource(R.string.check_peer_quiet, name)
    }
    Line(if (ok) Icons.Outlined.CheckCircle else Icons.Outlined.Warning, if (ok) colors.accent else colors.orange, text)
}

@Composable
private fun ServiceLine(service: ServiceStatus, result: Probe?) {
    val colors = LocalWaveColors.current
    val name = service.title
    when (result) {
        null -> Line(WaveIcons.Hourglass, colors.secondary, stringResource(R.string.check_service_checking, name))
        is Probe.Answered -> Line(Icons.Outlined.CheckCircle, colors.accent, stringResource(R.string.check_service_answers, name, result.milliseconds))
        Probe.Refused -> Line(Icons.Outlined.Warning, colors.orange, stringResource(R.string.check_service_refused, name))
        Probe.Silent -> Line(WaveIcons.Blocked, colors.red, stringResource(R.string.check_service_silent, name))
    }
}

/// The shared log: what the tunnel and the app did, newest last, to be read
/// here or shared with whoever helps -- LogView on iOS.
@Composable
fun LogPage(onBack: () -> Unit) {
    val colors = LocalWaveColors.current
    val context = LocalContext.current
    var lines by remember { mutableStateOf(readLines()) }
    val list = rememberLazyListState()
    LaunchedEffect(lines.size) { if (lines.isNotEmpty()) list.scrollToItem(lines.size - 1) }

    Column(Modifier.fillMaxSize().background(colors.background).safeDrawingPadding()) {
        InlineBar(
            title = stringResource(R.string.log),
            leading = { BarButton(icon = Icons.AutoMirrored.Filled.KeyboardArrowLeft, text = stringResource(R.string.log), onClick = onBack) },
            trailing = {
                BarButton(icon = Icons.Outlined.Refresh, text = stringResource(R.string.refresh)) { lines = readLines() }
                if (lines.isNotEmpty()) {
                    // A file, not the text: a messenger refuses a message of
                    // half a megabyte and takes a document of any size.
                    BarButton(icon = Icons.Outlined.Share, text = stringResource(R.string.share)) {
                        val file = WaveLog.export(context) ?: return@BarButton
                        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
                        val send = Intent(Intent.ACTION_SEND)
                            .setType("text/plain")
                            .putExtra(Intent.EXTRA_STREAM, uri)
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        context.startActivity(Intent.createChooser(send, file.name))
                    }
                }
                BarButton(icon = Icons.Outlined.Delete, text = stringResource(R.string.clear), tint = colors.red) {
                    WaveLog.clear()
                    lines = emptyList()
                }
            },
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (lines.isEmpty()) {
                Text(
                    stringResource(R.string.log_empty),
                    style = WaveType.body,
                    color = colors.secondary,
                    modifier = Modifier.align(Alignment.TopCenter).padding(16.dp),
                )
            } else {
                // One row per line, made as they scroll in: a whole log in one
                // text is up to half a megabyte.
                SelectionContainer {
                    LazyColumn(state = list, contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp)) {
                        itemsIndexed(lines) { _, line ->
                            Text(line, style = WaveType.caption.copy(fontFamily = FontFamily.Monospace), color = colors.label)
                        }
                    }
                }
            }
        }
        Text(
            stringResource(R.string.log_footer),
            style = WaveType.footnote,
            color = colors.secondary,
            modifier = Modifier.fillMaxWidth().background(colors.section).padding(8.dp),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

private fun readLines(): List<String> = WaveLog.read().split('\n').filter { it.isNotEmpty() }

/// What the app does with data, said before it does anything: the Play policy
/// for VpnService and the statement the iOS app shows. Once, before the first
/// connect, and only what is true of this app -- there is no server of ours in
/// the path, no analytics and no advertising.
@Composable
fun DisclosurePage(onAccept: () -> Unit) {
    val colors = LocalWaveColors.current
    Column(Modifier.fillMaxSize().background(colors.section).safeDrawingPadding()) {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Text(stringResource(R.string.app_name), style = WaveType.largeTitle, color = colors.label, modifier = Modifier.padding(top = 58.dp))
            Text(stringResource(R.string.disclosure_intro), style = WaveType.title3, color = colors.label)
            DisclosurePoint(WaveIcons.Globe, R.string.disclosure_connects_title, R.string.disclosure_connects_body)
            DisclosurePoint(WaveIcons.Relay, R.string.disclosure_control_title, R.string.disclosure_control_body)
            DisclosurePoint(Icons.Outlined.Lock, R.string.disclosure_ours_title, R.string.disclosure_ours_body)
            Text(stringResource(R.string.disclosure_next), style = WaveType.footnote, color = colors.secondary)
            Spacer(Modifier.height(8.dp))
        }
        Box(Modifier.fillMaxWidth().background(colors.background).padding(16.dp)) {
            Button(
                onClick = onAccept,
                modifier = Modifier.fillMaxWidth().height(50.dp),
                shape = RoundedCornerShape(50),
                colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = Color.White),
            ) {
                Text(stringResource(R.string.disclosure_continue), style = WaveType.headline)
            }
        }
    }
}

@Composable
private fun DisclosurePoint(icon: ImageVector, title: Int, body: Int) {
    val colors = LocalWaveColors.current
    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Icon(icon, null, tint = colors.accent, modifier = Modifier.size(28.dp).width(32.dp))
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(title), style = WaveType.headline, color = colors.label)
            Text(stringResource(body), style = WaveType.body, color = colors.secondary)
        }
    }
}
