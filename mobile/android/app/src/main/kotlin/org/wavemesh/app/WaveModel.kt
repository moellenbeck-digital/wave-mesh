package org.wavemesh.app

import android.app.Application
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.VpnService
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.Socket

/// The app owns nothing: the service holds the core, and this asks it -- the
/// same split, and the same behaviour, as WaveModel in the iOS app.
///
/// The consequence everything below is shaped by: nothing can be asked while
/// the tunnel is down, so joining a wave starts the tunnel first instead of
/// quietly asking nobody, and what the screen shows while it is down is the
/// last thing the tunnel said.
class WaveModel(application: Application) : AndroidViewModel(application) {
    private val context get() = getApplication<Application>()

    var status by mutableStateOf(Status.EMPTY)
        private set
    var failure by mutableStateOf<String?>(null)
    /// Where a login is, so the screen can say it instead of sitting still.
    var login by mutableStateOf<LoginPhase>(LoginPhase.Idle)
        private set
    /// Whether the tunnel is up, from the service rather than from the core:
    /// it is what decides whether the core can be asked at all.
    var tunnelUp by mutableStateOf(false)
        private set
    /// The name the next wave is joined with.
    var deviceName by mutableStateOf(DeviceName.stored(application) ?: WaveVpnService.defaultDeviceName(application))
        private set
    /// Bring the tunnel back by itself after a restart. On by default; off for
    /// somebody who also uses another VPN and wants to choose each time.
    var autoConnect by mutableStateOf(prefs(application).getBoolean(BootReceiver.AUTO_CONNECT, true))
        private set
    /// Set while the person is asked whether to take over from another VPN.
    var takeover by mutableStateOf<Takeover?>(null)
    /// A server named by a QR code's link, waiting for the person to say yes.
    var invite by mutableStateOf<String?>(null)

    /// The approval pages to open, one each; the activity opens them.
    private val approvalsFlow = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val approvals: SharedFlow<String> = approvalsFlow
    /// Said when a login that showed an approval page is over, so the page can go.
    private val approvalOverFlow = MutableSharedFlow<Unit>(extraBufferCapacity = 4)
    val approvalOver: SharedFlow<Unit> = approvalOverFlow

    /// Asks Android for the VPN permission; set by the activity, which is the
    /// only one that can show the system's dialog. True when granted.
    var requestConsent: (suspend () -> Boolean)? = null

    /// Links already shown, so closing the page does not reopen it every second.
    private val presented = mutableSetOf<String>()
    /// Set when the person gave up on a login, so its answer is not an error.
    private var cancelled: String? = null

    sealed interface LoginPhase {
        val address: String?
        data object Idle : LoginPhase { override val address: String? = null }
        /** Starting the tunnel, or registering with the control server. */
        data class Connecting(override val address: String) : LoginPhase
        /** Registered; somebody has to approve the device in a browser. */
        data class WaitingForApproval(override val address: String) : LoginPhase
    }

    class Takeover(val proceed: () -> Unit)

    init {
        WaveLog.init(application)
        WaveLog.recordExits(application)
        // The last thing the tunnel reported: a device whose tunnel is down is
        // still in its waves, and an empty list would say it is in none.
        prefs(application).getString(LAST_STATUS, null)?.let(Status::parse)?.let {
            status = it.copy(running = false)
        }
        viewModelScope.launch {
            // A path, an RTT and a handshake age say nothing until you watch
            // them move, which is why this redraws rather than showing one
            // reading.
            while (true) {
                poll()
                delay(1000)
            }
        }
    }

    fun updateDeviceName(name: String) {
        deviceName = name
        DeviceName.store(context, name)
    }

    fun updateAutoConnect(on: Boolean) {
        autoConnect = on
        prefs(context).edit().putBoolean(BootReceiver.AUTO_CONNECT, on).apply()
    }

    fun connect() {
        askBeforeTakingOver {
            viewModelScope.launch {
                try {
                    ensureRunning()
                } catch (error: Exception) {
                    report(error.message ?: error.toString())
                }
            }
        }
    }

    /// Stops the tunnel and keeps it stopped: a disconnect by hand is not
    /// undone by the next restart.
    fun disconnect() {
        WaveLog.write("disconnect", WaveLog.Source.APP)
        prefs(context).edit().putBoolean(BootReceiver.TUNNEL_WANTED, false).apply()
        context.startService(Intent(context, WaveVpnService::class.java).setAction(WaveVpnService.ACTION_STOP))
    }

    /// Runs the action at once, or after the person agreed to disconnect the
    /// other VPN that is up. Asked every time: which VPN runs is theirs to
    /// decide, and Android would switch without a word.
    private fun askBeforeTakingOver(action: () -> Unit) {
        if (!tunnelUp && anotherVpnIsUp()) takeover = Takeover(action) else action()
    }

    /// A VPN network while ours is down can only be somebody else's.
    private fun anotherVpnIsUp(): Boolean {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return false
        @Suppress("DEPRECATION")
        return manager.allNetworks.any {
            manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
        }
    }

    /// Joins again a wave the server ended: that very enrolment, by its key.
    fun loginAgain(wave: WaveStatus) {
        viewModelScope.launch { join(wave.id) }
    }

    /// Joins the server a QR code named, once the person said yes.
    fun joinFromInvite(server: String) {
        viewModelScope.launch { join(server) }
    }

    /// Joins a further wave at the server this one is on -- another project's
    /// network there. The server asks, on approval, which wave it goes to.
    fun addWave(wave: WaveStatus) {
        viewModelScope.launch { join(wave.controlUrl, Kind.ADD) }
    }

    enum class Kind { LOGIN, ADD }

    /// Joins a wave: tunnel up, register, wait for approval. Returns whether
    /// the request was taken, so the field keeps what was typed when it was not.
    suspend fun join(controlURL: String, kind: Kind = Kind.LOGIN): Boolean {
        val address = controlURL.trim()
        if (address.isEmpty()) return false
        if (!tunnelUp && anotherVpnIsUp()) {
            // Asked first; the join goes ahead from the dialog.
            takeover = Takeover { viewModelScope.launch { joinNow(address, kind) } }
            return true
        }
        return joinNow(address, kind)
    }

    private suspend fun joinNow(address: String, kind: Kind): Boolean {
        failure = null
        cancelled = null
        login = LoginPhase.Connecting(address)
        val hostname = DeviceName.label(deviceName)
        WaveLog.write("join $address as $deviceName", WaveLog.Source.APP)
        try {
            ensureRunning()
        } catch (error: Exception) {
            login = LoginPhase.Idle
            report(error.message ?: error.toString())
            return false
        }
        // Answered only once the device is approved, refused, or the wait
        // timed out -- possibly minutes from now.
        viewModelScope.launch {
            val answer = withContext(Dispatchers.IO) {
                val service = WaveVpnService.instance ?: return@withContext null
                when (kind) {
                    Kind.LOGIN -> service.login(address, hostname)
                    Kind.ADD -> service.addWave(address, hostname)
                }
            }
            val showedApproval = login is LoginPhase.WaitingForApproval
            login = LoginPhase.Idle
            if (showedApproval) approvalOverFlow.tryEmit(Unit)
            if (cancelled == address) {
                cancelled = null
                WaveLog.write("join $address cancelled", WaveLog.Source.APP)
                return@launch
            }
            when {
                answer == null -> report(context.getString(R.string.error_tunnel_stopped_during_login))
                answer.isNotEmpty() -> report(LoginFailure.describe(context, answer, address))
                else -> WaveLog.write("joined $address", WaveLog.Source.APP)
            }
        }
        return true
    }

    /// Gives up on the login that is waiting for approval.
    fun cancelLogin() {
        val address = login.address ?: return
        cancelled = address
        viewModelScope.launch(Dispatchers.IO) { WaveVpnService.instance?.cancelLogin(address) }
    }

    fun logout(wave: WaveStatus) = ask { it.logout(wave.id) }

    /// Pauses or resumes one wave; the enrolment stays either way.
    fun setEnabled(wave: WaveStatus, enabled: Boolean) = ask { it.setEnabled(wave.id, enabled) }

    private fun ask(request: (WaveVpnService) -> String) {
        viewModelScope.launch {
            val answer = withContext(Dispatchers.IO) { WaveVpnService.instance?.let(request) }
            if (!answer.isNullOrEmpty()) report(answer)
        }
    }

    /// Shows the approval page again after it was closed.
    fun reopenApproval() {
        WaveState.pendingAuthURL(context)?.let { approvalsFlow.tryEmit(it) }
    }

    private fun report(message: String) {
        failure = message
        WaveLog.write("error: $message", WaveLog.Source.APP)
    }

    /// Starts the tunnel unless it is running, and waits until it is -- the
    /// service is the only one that can be asked anything.
    private suspend fun ensureRunning() {
        if (WaveVpnService.state.value is WaveVpnService.State.Running) return
        if (VpnService.prepare(context) != null) {
            val granted = requestConsent?.invoke() ?: false
            if (!granted) throw IllegalStateException(context.getString(R.string.error_vpn_not_allowed))
        }
        prefs(context).edit().putBoolean(BootReceiver.TUNNEL_WANTED, true).apply()
        ContextCompat.startForegroundService(context, Intent(context, WaveVpnService::class.java))
        val settled = withTimeoutOrNull(START_TIMEOUT_MS) {
            WaveVpnService.state.first { it is WaveVpnService.State.Running || it is WaveVpnService.State.Failed }
        }
        when (settled) {
            is WaveVpnService.State.Running -> tunnelUp = true
            is WaveVpnService.State.Failed ->
                throw IllegalStateException(context.getString(R.string.error_tunnel_did_not_start, settled.reason))
            else -> throw IllegalStateException(context.getString(R.string.error_tunnel_did_not_start_log))
        }
    }

    private suspend fun poll() {
        val pending = WaveState.pendingAuthURL(context)
        val phase = login
        if (phase is LoginPhase.Connecting && pending != null) {
            login = LoginPhase.WaitingForApproval(phase.address)
            if (presented.add(pending)) approvalsFlow.tryEmit(pending)
        }
        val up = WaveVpnService.state.value is WaveVpnService.State.Running
        if (tunnelUp != up) tunnelUp = up
        if (!up) {
            if (status.running) status = status.copy(running = false)
            return
        }
        val answer = withContext(Dispatchers.IO) { WaveVpnService.instance?.status() } ?: return
        val decoded = Status.parse(answer) ?: return
        if (decoded != status) {
            status = decoded
            prefs(context).edit().putString(LAST_STATUS, decoded.toJSON()).apply()
        }
    }

    /// A TCP connection to a service through the tunnel, for "Check
    /// connection". The app is kept out of its own tunnel, so the socket is
    /// bound to the VPN network explicitly -- the way a browser's would go.
    suspend fun probe(host: String, port: Int): Probe = withContext(Dispatchers.IO) {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        @Suppress("DEPRECATION")
        val vpn = manager?.allNetworks?.firstOrNull {
            manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
        }
        val started = System.nanoTime()
        try {
            (vpn?.socketFactory?.createSocket() ?: Socket()).use { socket ->
                socket.connect(InetSocketAddress(host, port), PROBE_TIMEOUT_MS)
            }
            Probe.Answered(((System.nanoTime() - started) / 1_000_000).toInt())
        } catch (error: ConnectException) {
            if (error.message?.contains("ECONNREFUSED") == true) Probe.Refused else Probe.Silent
        } catch (error: Exception) {
            Probe.Silent
        }
    }

    companion object {
        private const val LAST_STATUS = "lastStatus"
        private const val START_TIMEOUT_MS = 20_000L
        private const val PROBE_TIMEOUT_MS = 5_000
    }
}

/// What one connection attempt found.
sealed interface Probe {
    data class Answered(val milliseconds: Int) : Probe
    /** Something answered, and said no: the path works, the port does not. */
    data object Refused : Probe
    /** Nothing at all within the time allowed. */
    data object Silent : Probe
}
