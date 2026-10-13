package org.wavemesh.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.VpnService
import android.provider.Settings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import wavemobile.Callbacks
import wavemobile.Core
import wavemobile.Wavemobile

/// The tunnel: a thin host around the Go core -- the counterpart of
/// PacketTunnelProvider on iOS, and asked the same things.
///
/// Everything that decides anything is in the core (`mobile/core`), which runs
/// under `go test` on any machine. What is left here is what only Android can
/// do: establish the tunnel, keep our own sockets out of it, and say when the
/// network changed.
class WaveVpnService : VpnService(), Callbacks {
    @Volatile
    private var core: Core? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    /// The network underneath last seen, so only a real change rebinds.
    @Volatile
    private var lastNetwork: Network? = null

    /// Where the tunnel is, for the app: it can only ask once the core runs.
    sealed interface State {
        data object Stopped : State
        data object Starting : State
        data object Running : State
        data class Failed(val reason: String) : State
    }

    override fun onCreate() {
        super.onCreate()
        WaveLog.init(this)
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            log("tunnel stopping")
            stopEverything()
            return START_NOT_STICKY
        }
        startInForeground()
        if (mutableState.value !is State.Starting && mutableState.value !is State.Running) {
            mutableState.value = State.Starting
            scope.launch { startCore() }
        }
        // The tunnel is the point of this service; if Android kills it, it
        // should come back.
        return START_STICKY
    }

    private fun startCore() {
        log("tunnel starting")
        try {
            // Established before the core: it needs a descriptor, and Android
            // only hands one over once something has been established. The
            // placeholder carries one address and no routes, so nothing is
            // reachable through it until the core has a netmap and applies the
            // real union.
            val descriptor = Builder()
                .setSession("wave")
                .setMtu(DEFAULT_MTU)
                .addAddress(PLACEHOLDER_ADDRESS, 32)
                .addDisallowedApplication(packageName)
                .establish()
                ?: throw IllegalStateException(getString(R.string.error_vpn_not_allowed))

            val created = Wavemobile.new_(
                WaveState.load(this),
                hostname(this),
                // Android's addDnsServer is device-wide: there is no
                // matchDomains, so every query reaches our resolver and
                // everything that is not ours has to be passed on rather than
                // dropped. The invariant "never take over the system resolver"
                // cannot be kept here, and this is where that is admitted.
                true,
                systemResolvers().joinToString(","),
                this,
            )
            // What the control server shows next to this device: the phones
            // register as "other", and say what they are in their hello.
            created.setClientInfo("android", appVersion())
            core = created
            // Android's descriptor carries bare IP packets; a utun on iOS
            // prefixes each one with an address family. Told rather than
            // guessed, because getting it wrong produces a tunnel where nothing
            // is ever parsed.
            //
            // Detached, not lent: the core closes it when it replaces or stops
            // the link. See applySettings for what a second owner did.
            created.start(descriptor.detachFd().toLong(), false, DEFAULT_MTU.toLong())
            watchNetwork()
            mutableState.value = State.Running
            log("tunnel running")
        } catch (error: Exception) {
            val reason = error.message ?: error.toString()
            log("the core did not start: $reason")
            stopEverything()
            mutableState.value = State.Failed(reason)
        }
    }

    /// The resolvers Android was using before we took over. On this platform
    /// they are a duty rather than an option: without them, taking the DNS
    /// server device-wide would break every name on the phone that is not in a
    /// wave.
    private fun systemResolvers(): List<String> {
        val manager = getSystemService(ConnectivityManager::class.java) ?: return emptyList()
        val active = manager.activeNetwork ?: return emptyList()
        return manager.getLinkProperties(active)?.dnsServers?.mapNotNull { it.hostAddress } ?: emptyList()
    }

    /// A phone changes network while it is being carried, and that is the
    /// normal case rather than the exception: without this the tunnel only
    /// recovers once its paths have timed out.
    ///
    /// Only a change of the network underneath counts. Android calls
    /// onAvailable at once for the network that is already there, and treated
    /// as a change that moved the UDP port on every start -- the port peers
    /// had learned to send to, so the tunnel stood still for half a minute
    /// after every connect (emulator, 11.10.2026). That first call only says
    /// where we are, as the first path update does on iOS; comparing it with
    /// activeNetwork was not enough, which can still be settling right after
    /// the tunnel is established.
    private fun watchNetwork() {
        val manager = getSystemService(ConnectivityManager::class.java) ?: return
        lastNetwork = null
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val previous = lastNetwork
                lastNetwork = network
                if (previous == null || previous == network) return
                val kind = describe(manager.getNetworkCapabilities(network))
                scope.launch {
                    log("network changed: $kind")
                    core?.networkChanged()
                }
            }
        }
        networkCallback = callback
        // The default network of this app, which is excluded from its own
        // tunnel: the one underneath, never our own interface.
        manager.registerDefaultNetworkCallback(callback)
    }

    private fun describe(capabilities: NetworkCapabilities?): String = when {
        capabilities == null -> "unknown"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        else -> "other"
    }

    // MARK: - Callbacks

    /// Applies the union of every wave to the one tunnel Android allows.
    ///
    /// establish() hands back a *new* descriptor every time, so the core has to
    /// be given the new one -- otherwise it goes on reading a descriptor the
    /// system has already taken away, and the tunnel simply goes quiet. This
    /// is the one place the two platforms genuinely differ: iOS keeps its
    /// packet flow across a settings change.
    override fun applySettings(settingsJSON: String) {
        val settings = WaveSettings.parse(settingsJSON)
        val builder = Builder().setSession("wave").setMtu(settings.mtu)

        for (address in settings.addresses) {
            val (host, prefix) = splitCidr(address) ?: continue
            builder.addAddress(host, prefix)
        }
        // No wave left, so no address of ours -- and Android refuses a tunnel
        // without one, which kept the old settings in place: the routes of a
        // wave that is gone and its resolver as the phone's only DNS server.
        // Leaving the last wave took every name on the phone with it
        // (emulator, 11.10.2026). The placeholder routes nothing, and with no
        // wave the settings carry no DNS server either.
        if (settings.addresses.none { splitCidr(it) != null }) {
            builder.addAddress(PLACEHOLDER_ADDRESS, 32)
        }
        for (route in settings.routes) {
            val (host, prefix) = splitCidr(route) ?: continue
            builder.addRoute(host, prefix)
        }
        for (server in settings.dnsServers) {
            builder.addDnsServer(server)
        }
        // One search domain: Android takes a single string, and the first wave
        // is the one a bare name is completed against -- the same order the
        // core puts them in.
        settings.searchDomains.firstOrNull()?.let { builder.addSearchDomain(it) }
        // Our own traffic must not go through our own tunnel. The core protects
        // its sockets through protectSocket below; this keeps the rest of the
        // app out as well.
        builder.addDisallowedApplication(packageName)

        val replacement = builder.establish()
            ?: throw IllegalStateException("android refused to apply the tunnel settings")
        // The core closes the old descriptor itself when it swaps the link, so
        // the new one is handed over outright with detachFd. Kept as a
        // ParcelFileDescriptor and closed here as well, the same number was
        // closed twice -- and since Android 11 fdsan aborts the process for
        // that: the app died on the first netmap it applied (emulator,
        // 11.10.2026), right after the device was approved.
        core?.replaceTunnel(replacement.detachFd().toLong(), false, settings.mtu.toLong())
    }

    override fun log(line: String) {
        WaveLog.write(line, WaveLog.Source.TUNNEL)
    }

    /// The private keys of every enrolment. Encrypted shared preferences,
    /// because a plain file in the app's data directory is readable by anything
    /// that gets the device unlocked and is included in a backup.
    override fun saveState(encoded: ByteArray) {
        WaveState.save(this, String(encoded, Charsets.UTF_8))
    }

    /// The enrolment link. The service cannot open a browser, so the app does
    /// -- it is what is in front of the person.
    override fun openAuthURL(url: String) {
        log("open this link to connect this device: $url")
        WaveState.setPendingAuthURL(this, url)
    }

    /// Android's escape from its own tunnel.
    ///
    /// Without it the encrypted traffic would be routed into the tunnel
    /// carrying it -- which looks exactly like a peer that never answers, and
    /// is the single most common way a VpnService comes out silently broken.
    override fun protectSocket(fd: Long): Boolean = protect(fd.toInt())

    // MARK: - what the app asks

    // Each returns an empty string on success and the core's words otherwise,
    // like the answers PacketTunnelProvider gives the iOS app: a failure that
    // only reaches the log is one nobody sees. All of them block -- a login
    // until somebody approves the device -- so callers are off the main thread.

    fun status(): String = core?.status() ?: "{}"

    fun login(controlURL: String, hostname: String): String {
        log("login to $controlURL")
        WaveState.clearPendingAuthURL(this)
        if (hostname.isNotEmpty()) core?.setHostname(hostname)
        val failure = attempt { requireCore().login(controlURL, "") }
        // Approved, refused or timed out: either way the link is spent, and a
        // stale one would invite approving a request that is gone.
        WaveState.clearPendingAuthURL(this)
        log(failure?.let { "login to $controlURL failed: $it" } ?: "login to $controlURL done")
        return failure ?: ""
    }

    /// A further wave at a server this device is already in: a new enrolment,
    /// and the server asks which wave it goes to.
    fun addWave(controlURL: String, hostname: String): String {
        log("adding a wave at $controlURL")
        WaveState.clearPendingAuthURL(this)
        if (hostname.isNotEmpty()) core?.setHostname(hostname)
        val failure = attempt { requireCore().addWave(controlURL, "") }
        WaveState.clearPendingAuthURL(this)
        log(failure?.let { "adding a wave at $controlURL failed: $it" } ?: "added a wave at $controlURL")
        return failure ?: ""
    }

    fun cancelLogin(controlURL: String) {
        core?.cancelLogin(controlURL)
    }

    fun logout(controlURL: String): String {
        val failure = attempt { requireCore().logout(controlURL) }
        log(failure?.let { "logout from $controlURL failed: $it" } ?: "left $controlURL")
        return failure ?: ""
    }

    fun setEnabled(controlURL: String, enabled: Boolean): String {
        val failure = attempt { requireCore().setEnabled(controlURL, enabled) }
        log("$controlURL ${if (enabled) "switched on" else "paused"}${failure?.let { ": $it" } ?: ""}")
        return failure ?: ""
    }

    /// Without a core every call would go to nil and come back as success --
    /// a login that "worked" and joined nothing.
    private fun requireCore(): Core = core ?: throw IllegalStateException(getString(R.string.error_no_core))

    private fun attempt(work: () -> Unit): String? = try {
        work()
        null
    } catch (error: Exception) {
        error.message ?: error.toString()
    }

    // MARK: - lifecycle

    /// Another app's VPN took the slot, or the person revoked ours in the
    /// settings. Android allows one VPN at a time; ours is over either way.
    override fun onRevoke() {
        log("android revoked the VPN; another VPN may have taken over")
        stopEverything()
    }

    private fun startInForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        manager?.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW)
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = Notification.Builder(this, CHANNEL)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.notification_running))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(open)
            .build()
        startForeground(NOTIFICATION_ID, notification)
    }

    private fun stopEverything() {
        networkCallback?.let { callback ->
            runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(callback) }
        }
        networkCallback = null
        // The core owns the tunnel descriptor and closes it here.
        core?.stop()
        core = null
        if (mutableState.value !is State.Failed) mutableState.value = State.Stopped
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopEverything()
        instance = null
        super.onDestroy()
    }

    private fun appVersion(): String = runCatching {
        val info = packageManager.getPackageInfo(packageName, 0)
        "${info.versionName} (${info.longVersionCode})"
    }.getOrDefault("0")

    companion object {
        const val ACTION_STOP = "org.wavemesh.app.STOP"
        private const val CHANNEL = "wave"
        private const val NOTIFICATION_ID = 1
        private const val DEFAULT_MTU = 1280

        /// An address inside the wave block that no wave hands out, used only
        /// until the first netmap replaces it. Android will not establish a
        /// tunnel with no address at all.
        private const val PLACEHOLDER_ADDRESS = "10.64.255.254"

        @Volatile
        var instance: WaveVpnService? = null
            private set

        private val mutableState = MutableStateFlow<State>(State.Stopped)
        val state: StateFlow<State> = mutableState

        /// What the person chose in the app; otherwise the name the phone
        /// was given in its settings, and only then the model.
        fun hostname(context: Context): String =
            DeviceName.stored(context)?.let(DeviceName::label)?.takeIf { it.isNotEmpty() }
                ?: defaultDeviceName(context)

        fun defaultDeviceName(context: Context): String =
            runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }
                .getOrNull()?.takeIf { it.isNotBlank() }
                ?: android.os.Build.MODEL
                ?: "phone"

        fun splitCidr(cidr: String): Pair<String, Int>? {
            val parts = cidr.split("/")
            val host = parts.getOrNull(0)?.takeIf { it.isNotEmpty() } ?: return null
            val full = if (host.contains(":")) 128 else 32
            val prefix = parts.getOrNull(1)?.toIntOrNull() ?: full
            if (prefix < 0 || prefix > full) return null
            return host to prefix
        }
    }
}
