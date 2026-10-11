package org.wavemesh.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.net.VpnService
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.core.content.edit
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch

/// The window. It owns nothing: the service holds the core, because it is the
/// process Android keeps running, and WaveModel asks it.
class MainActivity : ComponentActivity() {
    private val model: WaveModel by viewModels()

    /// The answer to the system's VPN dialog, for the one request waiting on it.
    private var consent: CompletableDeferred<Boolean>? = null
    private val requestPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        consent?.complete(result.resultCode == Activity.RESULT_OK)
        consent = null
    }

    /// Whether an approval page is open in front of us, so the end of the
    /// login can take it away again.
    private var approvalOpen = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Status and navigation bar icons follow the theme instead of staying
        // white on a light screen.
        enableEdgeToEdge()
        model.requestConsent = ::askForConsent
        takeInvite(intent)

        lifecycleScope.launch { model.approvals.collect(::openApproval) }
        lifecycleScope.launch { model.approvalOver.collect { closeApproval() } }

        val prefs = prefs(this)
        setContent {
            WaveTheme {
                var accepted by remember { mutableStateOf(prefs.getBoolean(DISCLOSURE_ACCEPTED, false)) }
                if (!accepted) {
                    DisclosurePage {
                        prefs.edit { putBoolean(DISCLOSURE_ACCEPTED, true) }
                        accepted = true
                    }
                } else {
                    App(model)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeInvite(intent)
    }

    /// From a QR code: fill in nothing silently, join nothing silently.
    private fun takeInvite(intent: Intent?) {
        WaveInvite.server(intent?.data?.toString())?.let { model.invite = it }
    }

    /// Android asks the person once, in a dialog only the system can show.
    private suspend fun askForConsent(): Boolean {
        val request = VpnService.prepare(this) ?: return true
        val answer = CompletableDeferred<Boolean>()
        consent = answer
        requestPermission.launch(request)
        return answer.await()
    }

    /// The approval page in a Custom Tab rather than a web view of our own: it
    /// shares the browser's cookies, so somebody signed in to the control
    /// server there is not asked again -- with a password and a second factor
    /// -- every time. The counterpart of ASWebAuthenticationSession on iOS.
    private fun openApproval(url: String) {
        approvalOpen = true
        runCatching { CustomTabsIntent.Builder().build().launchUrl(this, Uri.parse(url)) }
            .onFailure { openUrl(this, url) }
    }

    /// The login is over: back to the app, which takes the Custom Tab above
    /// it away -- the sheet on iOS is cancelled at the same moment.
    private fun closeApproval() {
        if (!approvalOpen) return
        approvalOpen = false
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
    }

    private companion object {
        /// Versioned, so a changed statement is shown again.
        const val DISCLOSURE_ACCEPTED = "disclosureAccepted.v1"
    }
}

/// Which page is in front: the list, the log, or one wave's check.
private sealed interface Page {
    data object Waves : Page
    data object Log : Page
    data class Check(val waveId: String) : Page
}

@Composable
private fun App(model: WaveModel) {
    var page by remember { mutableStateOf<Page>(Page.Waves) }
    var leaving by remember { mutableStateOf<WaveStatus?>(null) }

    when (val current = page) {
        Page.Waves -> WaveScreen(
            model = model,
            onOpenLog = { page = Page.Log },
            onCheck = { page = Page.Check(it.id) },
            onLeave = { leaving = it },
        )
        Page.Log -> {
            BackHandler { page = Page.Waves }
            LogPage(onBack = { page = Page.Waves })
        }
        is Page.Check -> {
            BackHandler { page = Page.Waves }
            val wave = model.status.waves.firstOrNull { it.id == current.waveId }
            if (wave == null) {
                LaunchedEffect(Unit) { page = Page.Waves }
            } else {
                CheckPage(wave, model.tunnelUp, model::probe, onDone = { page = Page.Waves })
            }
        }
    }

    model.takeover?.let { takeover ->
        Confirm(
            title = stringResource(R.string.takeover_title),
            message = stringResource(R.string.takeover_message),
            confirm = stringResource(R.string.takeover_confirm),
            onConfirm = {
                model.takeover = null
                takeover.proceed()
            },
            onDismiss = { model.takeover = null },
        )
    }

    leaving?.let { wave ->
        Confirm(
            title = stringResource(R.string.leave_title, wave.label),
            message = stringResource(R.string.leave_message),
            confirm = stringResource(R.string.leave_wave),
            destructive = true,
            onConfirm = {
                leaving = null
                model.logout(wave)
            },
            onDismiss = { leaving = null },
        )
    }

    model.invite?.let { server ->
        val host = hostOf(server)
        val existing = model.status.waves.firstOrNull { it.controlUrl == server }
        Confirm(
            title = stringResource(R.string.invite_title, host),
            message = stringResource(if (existing != null) R.string.invite_add else R.string.invite_join, host),
            confirm = stringResource(if (existing != null) R.string.add_wave_here else R.string.connect),
            onConfirm = {
                model.invite = null
                if (existing != null) model.addWave(existing) else model.joinFromInvite(server)
            },
            onDismiss = { model.invite = null },
        )
    }
}

/// iOS's confirmation dialog: a title, what it means, and the one action.
@Composable
private fun Confirm(
    title: String,
    message: String,
    confirm: String,
    destructive: Boolean = false,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LocalWaveColors.current
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = colors.section,
        title = { Text(title, style = WaveType.headline, color = colors.label) },
        text = { Text(message, style = WaveType.footnote, color = colors.secondary) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(confirm, style = WaveType.headline, color = if (destructive) colors.red else colors.accent)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel), style = WaveType.body, color = colors.accent) }
        },
    )
}
