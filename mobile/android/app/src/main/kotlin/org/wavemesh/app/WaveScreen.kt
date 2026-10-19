package org.wavemesh.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.DateUtils
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.AddCircle
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/// One section per wave, each with its own switch -- the same shape as the
/// tray on the desktop and WaveView on iOS: a device can be in several waves,
/// and a single "connect" button would not say which one it meant.
@Composable
fun WaveScreen(
    model: WaveModel,
    onOpenLog: () -> Unit,
    onCheck: (WaveStatus) -> Unit,
    onLeave: (WaveStatus) -> Unit,
) {
    val colors = LocalWaveColors.current
    val focus = LocalFocusManager.current
    val scope = rememberCoroutineScope()
    val list = rememberLazyListState()
    var controlURL by rememberSaveable { mutableStateOf("") }
    val scrolled by remember { derivedStateOf { list.firstVisibleItemIndex > 0 } }

    fun join() {
        focus.clearFocus()
        val address = controlURL
        scope.launch { if (model.join(address)) controlURL = "" }
    }

    Column(Modifier.fillMaxSize().background(colors.background).safeDrawingPadding()) {
        // The bar: the button stays, the large title below scrolls away and
        // comes back small, as on iOS.
        Box(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 16.dp)) {
            androidx.compose.animation.AnimatedVisibility(
                visible = scrolled,
                modifier = Modifier.align(Alignment.Center),
                enter = fadeIn(),
                exit = fadeOut(),
            ) {
                Text(stringResource(R.string.app_name), style = WaveType.headline, color = colors.label)
            }
            Box(Modifier.align(Alignment.CenterEnd)) {
                PillButton(stringResource(if (model.tunnelUp) R.string.disconnect else R.string.connect)) {
                    if (model.tunnelUp) model.disconnect() else model.connect()
                }
            }
        }
        LazyColumn(state = list, modifier = Modifier.fillMaxSize().imePadding()) {
            item("title") {
                // The product name is a name, not a word: it stays as it is
                // in every language.
                Text(
                    stringResource(R.string.app_name),
                    style = WaveType.largeTitle,
                    color = colors.label,
                    modifier = Modifier.padding(start = 20.dp, top = 2.dp, bottom = 2.dp),
                )
            }

            model.failure?.let { failure ->
                item("failure") {
                    Section {
                        row { LabelRow(Icons.Outlined.Warning, failure, colors.red, textColor = colors.red) }
                        row { ButtonRow(stringResource(R.string.dismiss)) { model.failure = null } }
                    }
                }
            }

            if (!model.tunnelUp && model.status.waves.isNotEmpty() && model.login == WaveModel.LoginPhase.Idle) {
                item("tunnelOff") {
                    // The sections below are what the tunnel last reported;
                    // saying so keeps them from reading as live.
                    Section {
                        row { LabelRow(WaveIcons.PauseCircle, stringResource(R.string.tunnel_off), colors.accent) }
                        row { ButtonRow(stringResource(R.string.connect)) { model.connect() } }
                    }
                }
            }

            item("login") { LoginProgress(model) }

            for (wave in model.status.waves) {
                item("wave:${wave.id}") {
                    WaveSection(
                        wave = wave,
                        live = model.tunnelUp,
                        onToggle = { model.setEnabled(wave, it) },
                        onLeave = { onLeave(wave) },
                        onLoginAgain = { model.loginAgain(wave) },
                        onAddWave = { model.addWave(wave) },
                        onCheck = { onCheck(wave) },
                    )
                }
            }

            item("join") {
                Section(
                    header = stringResource(if (model.status.waves.isEmpty()) R.string.join_header else R.string.add_header),
                    // Not in any wave is a different thing from a tunnel that
                    // is down, and saying so is the difference between a
                    // person looking for a bug and a person logging in.
                    footer = if (model.status.waves.isEmpty()) stringResource(R.string.no_wave_yet) else null,
                ) {
                    row {
                        TextRow(
                            value = controlURL,
                            onChange = { controlURL = it },
                            placeholder = stringResource(R.string.address_placeholder),
                            keyboard = KeyboardOptions(
                                keyboardType = KeyboardType.Uri,
                                imeAction = ImeAction.Go,
                                autoCorrectEnabled = false,
                                capitalization = KeyboardCapitalization.None,
                            ),
                            onDone = ::join,
                        )
                    }
                    row {
                        ButtonRow(
                            stringResource(R.string.log_in),
                            enabled = controlURL.isNotBlank() && model.login == WaveModel.LoginPhase.Idle,
                            onClick = ::join,
                        )
                    }
                }
            }

            item("device") {
                val label = DeviceName.label(model.deviceName)
                Section(
                    header = stringResource(R.string.this_device),
                    footer = stringResource(R.string.device_preview, label.ifEmpty { stringResource(R.string.device_fallback) }),
                ) {
                    row {
                        TextRow(
                            value = model.deviceName,
                            onChange = model::updateDeviceName,
                            placeholder = stringResource(R.string.device_name),
                            keyboard = KeyboardOptions(
                                capitalization = KeyboardCapitalization.Words,
                                autoCorrectEnabled = false,
                                imeAction = ImeAction.Done,
                            ),
                            onDone = { focus.clearFocus() },
                        )
                    }
                }
            }

            item("auto") {
                Section(footer = stringResource(R.string.auto_connect_footer)) {
                    row {
                        ToggleRow(model.autoConnect, onChange = model::updateAutoConnect) {
                            Text(stringResource(R.string.connect_automatically), style = WaveType.body, color = colors.label)
                        }
                    }
                }
            }

            item("log") {
                Section {
                    row {
                        ListRow(onClick = onOpenLog) {
                            Text(stringResource(R.string.log), style = WaveType.body, color = colors.label, modifier = Modifier.weight(1f))
                            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = colors.secondary)
                        }
                    }
                }
            }

            item("end") { Spacer(Modifier.height(32.dp)) }
        }
    }
}

/// Says where a login is: a join that shows nothing for half a minute looks
/// exactly like one that was ignored.
@Composable
private fun LoginProgress(model: WaveModel) {
    when (val phase = model.login) {
        WaveModel.LoginPhase.Idle -> Unit
        // Cancellable here too: the core keeps trying a control server that is
        // not there yet for as long as it takes, so this can be a long wait.
        is WaveModel.LoginPhase.Connecting -> Section {
            row { ProgressRow(stringResource(R.string.connecting_to, phase.address)) }
            row { ButtonRow(stringResource(R.string.cancel), destructive = true) { model.cancelLogin() } }
        }
        // An address, or a wave's key ("https://…#a1b2") when one is logged
        // in again: the host is what a person recognises.
        is WaveModel.LoginPhase.WaitingForApproval -> Section(header = hostOf(phase.address)) {
            row { ProgressRow(stringResource(R.string.waiting_for_approval)) }
            row { ButtonRow(stringResource(R.string.open_approval_again)) { model.reopenApproval() } }
            row { ButtonRow(stringResource(R.string.cancel), destructive = true) { model.cancelLogin() } }
        }
    }
}

@Composable
private fun ProgressRow(text: String) {
    val colors = LocalWaveColors.current
    ListRow {
        CircularProgressIndicator(Modifier.size(20.dp), color = colors.secondary, strokeWidth = 2.dp)
        Text(text, style = WaveType.body, color = colors.label)
    }
}

/// A text field as a list row: no box around it, the placeholder in grey.
@Composable
private fun TextRow(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    keyboard: KeyboardOptions,
    onDone: () -> Unit,
) {
    val colors = LocalWaveColors.current
    ListRow {
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            textStyle = WaveType.body.copy(color = colors.label),
            cursorBrush = SolidColor(colors.accent),
            keyboardOptions = keyboard,
            keyboardActions = KeyboardActions(onAny = { onDone() }),
            modifier = Modifier.fillMaxWidth(),
            decorationBox = { field ->
                Box {
                    if (value.isEmpty()) Text(placeholder, style = WaveType.body, color = colors.secondary)
                    field()
                }
            },
        )
    }
}

/// One wave: its switch, this device's name in it, and who else is there.
@Composable
private fun WaveSection(
    wave: WaveStatus,
    live: Boolean,
    onToggle: (Boolean) -> Unit,
    onLeave: () -> Unit,
    onLoginAgain: () -> Unit,
    onAddWave: () -> Unit,
    onCheck: () -> Unit,
) {
    val colors = LocalWaveColors.current
    val context = LocalContext.current
    Section {
        row {
            ToggleRow(wave.enabled, enabled = live && wave.problem != "removed", onChange = onToggle) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(wave.label, style = WaveType.headline, color = colors.label)
                    // Several waves can share a server; the name above is the
                    // wave's own, this says where it lives.
                    val host = hostOf(wave.controlUrl)
                    if (host != wave.label) Text(host, style = WaveType.caption, color = colors.secondary)
                }
            }
        }

        when (wave.problem) {
            "removed" -> {
                row { LabelRow(Icons.Outlined.Person, stringResource(R.string.removed), colors.red, textColor = colors.red) }
                row { ButtonRow(stringResource(R.string.log_in_again), onClick = onLoginAgain) }
            }
            "netmap-rejected" -> row {
                LabelRow(Icons.Outlined.Lock, stringResource(R.string.netmap_rejected), colors.red, textColor = colors.red)
            }
            "failed" -> row {
                LabelRow(Icons.Outlined.Warning, stringResource(R.string.wave_failed, wave.detail), colors.red, textColor = colors.red)
            }
        }

        if (wave.enabled && live) {
            if (wave.dnsName.isNotEmpty()) row { CopyableRow(wave.dnsName, wave.ipv4) }
            if (!wave.connected) {
                // The tunnel keeps carrying traffic without the control
                // connection -- the netmap is signed and already here -- so
                // this is a warning, not an outage.
                row {
                    ListRow {
                        Text(stringResource(R.string.no_control_connection), style = WaveType.footnote, color = colors.orange)
                    }
                }
            }
            for (peer in wave.peers) row { PeerRow(peer) }
            for (service in wave.services) row { ServiceRow(service) }
            if (wave.relay.isNotEmpty() || wave.relayOffered != null) row { RelayRow(wave) }
        } else if (!wave.enabled && wave.problem.isEmpty()) {
            row {
                ListRow { Text(stringResource(R.string.paused), style = WaveType.footnote, color = colors.secondary) }
            }
        }

        if (wave.enabled && live && wave.problem.isEmpty()) {
            row { ButtonRow(stringResource(R.string.check_connection), icon = Icons.Outlined.Search, onClick = onCheck) }
        }
        // The tray's "Open <host>": devices, people, access rules and
        // renaming this device all live in the web interface.
        row {
            ButtonRow(stringResource(R.string.open_web), icon = WaveIcons.Globe) { openUrl(context, wave.controlUrl) }
        }
        // Another project's network on the same server: a new enrolment, and
        // the approval asks which wave.
        row { ButtonRow(stringResource(R.string.add_wave_here), icon = Icons.Outlined.AddCircle, enabled = live, onClick = onAddWave) }
        row { ButtonRow(stringResource(R.string.leave_wave), destructive = true, enabled = live, onClick = onLeave) }
    }
}

/// Whether this wave has the relay that reaches what no direct path can: a
/// connector behind a cluster's NAT, a phone behind its carrier's. A peer with
/// "no fixed path" and no handshake is otherwise a mystery; with this line it
/// has an explanation.
@Composable
private fun RelayRow(wave: WaveStatus) {
    val colors = LocalWaveColors.current
    when {
        wave.relay.isNotEmpty() -> ListRow {
            Icon(WaveIcons.Relay, null, tint = colors.accent, modifier = Modifier.size(20.dp))
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(stringResource(R.string.relay_connected), style = WaveType.footnote, color = colors.label)
                Text(hostOf(wave.relay), style = WaveType.caption, color = colors.secondary)
            }
        }
        wave.relayOffered == true -> Warning(stringResource(R.string.relay_down))
        wave.relayOffered == false -> Warning(stringResource(R.string.no_relay))
    }
}

/// A warning said whole: cut short in a list row, the part that explains it
/// was lost.
@Composable
private fun Warning(text: String) {
    val colors = LocalWaveColors.current
    ListRow {
        Icon(Icons.Outlined.Warning, null, tint = colors.orange, modifier = Modifier.size(18.dp).align(Alignment.Top))
        Text(text, style = WaveType.footnote, color = colors.orange)
    }
}

/// A name and an address, both copyable: the name is what gets typed into a
/// browser or an SSH client, so it has to be easy to take from here.
@Composable
private fun CopyableRow(title: String, detail: String) {
    val colors = LocalWaveColors.current
    CopyMenu(title, detail) { open ->
        ListRow(onLongClick = open, onClick = open) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = WaveType.body, color = colors.label)
                if (detail.isNotEmpty()) Text(detail, style = WaveType.caption, color = colors.secondary)
            }
        }
    }
}

/// A service: tapped, it opens -- in the browser, like the tray and the web
/// do; held, its name and address can be copied.
@Composable
private fun ServiceRow(service: ServiceStatus) {
    val colors = LocalWaveColors.current
    val context = LocalContext.current
    val opens = service.url.isNotEmpty()
    CopyMenu(service.title, service.ipv4) { open ->
        ListRow(onClick = { if (opens) openUrl(context, service.url) else open() }, onLongClick = open) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(service.title, style = WaveType.body, color = colors.label)
                Text(service.ipv4, style = WaveType.caption, color = colors.secondary)
            }
            if (opens) Icon(WaveIcons.OpenInNew, null, tint = colors.accent, modifier = Modifier.size(20.dp))
        }
    }
}

@Composable
private fun PeerRow(peer: PeerStatus) {
    val colors = LocalWaveColors.current
    CopyMenu(peer.dnsName.ifEmpty { peer.hostname }, peer.ipv4) { open ->
        ListRow(onLongClick = open) {
            // State never by colour alone: the dot is decoration, the word
            // beside it says it.
            Box(Modifier.align(Alignment.Top).padding(top = 7.dp)) {
                Dot(if (peer.online) colors.accent else colors.secondary.copy(alpha = 0.5f))
            }
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                // One line, shortened in the middle: the end of a name is the
                // wave's domain, the start is what tells two devices apart.
                Text(peer.title, style = WaveType.body, color = colors.label, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                Text(
                    "${peer.ipv4} · ${if (peer.online) pathOf(peer) else stringResource(R.string.offline)}",
                    style = WaveType.caption,
                    color = colors.secondary,
                )
                if (peer.lastHandshakeSeconds >= 0) {
                    // Our own view, beside the server's online state: when
                    // the two last talked through the tunnel.
                    Text(stringResource(R.string.last_handshake, ago(peer.lastHandshakeSeconds)), style = WaveType.caption2, color = colors.secondary)
                } else if (peer.online && peer.via != "idle") {
                    // Online at the server, yet never reached from here: the
                    // case a missing relay produces. Not for an idle peer: the
                    // core leaves those alone on purpose (battery), so no
                    // handshake is what idle looks like, not a fault.
                    Text(stringResource(R.string.not_reached), style = WaveType.caption2, color = colors.orange)
                }
            }
        }
    }
}

/// No confirmed path is not the same as a tunnel that is down: without one
/// every packet is sprayed at all known candidates, which carries -- it is
/// only wasteful and unmeasured. Saying "connecting" here would claim the
/// tunnel is down while a ping over it answers in 16 ms.
@Composable
private fun pathOf(peer: PeerStatus): String {
    if (peer.via.isEmpty()) return stringResource(R.string.path_none)
    // Nothing sent to it lately, so nothing is measured: the core probes a
    // peer only while something talks to it.
    if (peer.via == "idle") return stringResource(R.string.path_idle)
    // The core says "relay" or the address of the direct path; only the word
    // is translated, an address is the same in every language.
    val via = if (peer.via == "relay") stringResource(R.string.path_relay) else peer.via
    return if (peer.rttMs > 0) stringResource(R.string.path_with_rtt, via, peer.rttMs) else via
}

private fun ago(seconds: Int): String {
    val now = System.currentTimeMillis()
    return DateUtils.getRelativeTimeSpanString(
        now - seconds * 1000L, now, DateUtils.SECOND_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE,
    ).toString()
}

/// The context menu iOS shows on a long press: copy the name, copy the address.
@Composable
private fun CopyMenu(name: String, address: String, content: @Composable (open: () -> Unit) -> Unit) {
    val context = LocalContext.current
    var open by remember { mutableStateOf(false) }
    Box {
        content { open = true }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text(stringResource(R.string.copy_name)) }, onClick = {
                copy(context, name)
                open = false
            })
            if (address.isNotEmpty()) {
                DropdownMenuItem(text = { Text(stringResource(R.string.copy_address)) }, onClick = {
                    copy(context, address)
                    open = false
                })
            }
        }
    }
}

private fun copy(context: Context, text: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("wave", text))
}

fun openUrl(context: Context, url: String) {
    runCatching {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
