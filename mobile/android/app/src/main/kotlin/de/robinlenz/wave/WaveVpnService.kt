package de.robinlenz.wave

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import wavemobile.Callbacks
import wavemobile.Core
import wavemobile.Wavemobile

/// The tunnel: a thin host around the Go core.
///
/// Everything that decides anything is in the core (`mobile/core`), which runs
/// under `go test` on any machine. What is left here is what only Android can
/// do: establish the tunnel, keep our own sockets out of it, and say when the
/// network changed.
class WaveVpnService : VpnService(), Callbacks {
    private var core: Core? = null
    private var tunnel: ParcelFileDescriptor? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopEverything()
                return START_NOT_STICKY
            }
        }
        startInForeground()
        if (core == null) scope.launch { startCore() }
        // The tunnel is the point of this service; if Android kills it, it
        // should come back.
        return START_STICKY
    }

    private fun startCore() {
        // Established before the core: it needs a descriptor, and Android only
        // hands one over once something has been established. The placeholder
        // carries one address and no routes, so nothing is reachable through it
        // until the core has a netmap and applies the real union.
        val builder = Builder()
            .setSession("wave")
            .setMtu(DEFAULT_MTU)
            .addAddress(PLACEHOLDER_ADDRESS, 32)
        val descriptor = builder.establish() ?: run {
            log("android refused to establish a tunnel; is the VPN permission granted?")
            stopSelf()
            return
        }
        tunnel = descriptor

        core = Wavemobile.new_(
            WaveState.load(this),
            android.os.Build.MODEL ?: "phone",
            // Android's addDnsServer is device-wide: there is no matchDomains,
            // so every query reaches our resolver and everything that is not
            // ours has to be passed on rather than dropped. The invariant
            // "never take over the system resolver" cannot be kept here, and
            // this is where that is admitted.
            true,
            systemResolvers().joinToString(","),
            this,
        )
        // Android's descriptor carries bare IP packets; a utun on iOS prefixes
        // each one with an address family. Told rather than guessed, because
        // getting it wrong produces a tunnel where nothing is ever parsed.
        core?.start(descriptor.fd.toLong(), false, DEFAULT_MTU.toLong())
        watchNetwork()
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

    private fun watchNetwork() {
        val manager = getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            // A phone changes network while it is being carried, and that is
            // the normal case rather than the exception: without this the
            // tunnel only recovers once its paths have timed out.
            override fun onAvailable(network: Network) {
                scope.launch { core?.networkChanged() }
            }
        }
        networkCallback = callback
        manager.registerNetworkCallback(
            NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build(),
            callback,
        )
    }

    // MARK: - Callbacks

    /// Applies the union of every wave to the one tunnel Android allows.
    ///
    /// establish() hands back a *new* descriptor every time and closes the old
    /// one, so the core has to be given the new one -- otherwise it goes on
    /// reading a descriptor the system has already taken away, and the tunnel
    /// simply goes quiet. This is the one place the two platforms genuinely
    /// differ: iOS keeps its packet flow across a settings change.
    override fun applySettings(settingsJSON: String) {
        val settings = WaveSettings.parse(settingsJSON)
        val builder = Builder().setSession("wave").setMtu(settings.mtu)

        for (address in settings.addresses) {
            val (host, prefix) = splitCidr(address) ?: continue
            builder.addAddress(host, prefix)
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
        val previous = tunnel
        tunnel = replacement
        core?.replaceTunnel(replacement.fd.toLong(), false, settings.mtu.toLong())
        // The core holds the new one now; this is only our handle on the old.
        runCatching { previous?.close() }
    }

    override fun log(line: String) {
        Log.i(TAG, line)
    }

    /// The private keys of every enrolment. Encrypted shared preferences,
    /// because a plain file in the app's data directory is readable by anything
    /// that gets the device unlocked and is included in a backup.
    override fun saveState(encoded: ByteArray) {
        WaveState.save(this, String(encoded, Charsets.UTF_8))
    }

    /// The enrolment link. The service cannot open a browser, so the activity
    /// does -- it is what is in front of the person.
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

    // MARK: - lifecycle

    private fun startInForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        manager?.createNotificationChannel(
            NotificationChannel(CHANNEL, "wave", NotificationManager.IMPORTANCE_LOW)
        )
        val notification: Notification = Notification.Builder(this, CHANNEL)
            .setContentTitle("wave")
            .setContentText("the tunnel is running")
            .setSmallIcon(android.R.drawable.stat_sys_vpn_ic)
            .build()
        startForeground(NOTIFICATION_ID, notification)
    }

    private fun stopEverything() {
        networkCallback?.let { callback ->
            runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(callback) }
        }
        core?.stop()
        core = null
        // The core closed the descriptor it was holding; this is the handle we
        // kept, and closing it twice would close whatever the number was reused
        // for.
        tunnel = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopEverything()
        instance = null
        super.onDestroy()
    }

    /// What the activity talks to. The service owns the core, because it is the
    /// process Android keeps running.
    fun status(): String = core?.status() ?: "{}"

    fun login(controlURL: String, onFailure: (String) -> Unit) {
        scope.launch {
            // Blocks until somebody approves the device in a browser, so it
            // never runs on the thread that asked.
            runCatching { core?.login(controlURL, "") }
                .onFailure { onFailure(it.message ?: "login failed") }
        }
    }

    fun logout(controlURL: String, onFailure: (String) -> Unit) {
        scope.launch {
            runCatching { core?.logout(controlURL) }
                .onFailure { onFailure(it.message ?: "logout failed") }
        }
    }

    companion object {
        const val ACTION_STOP = "de.robinlenz.wave.STOP"
        private const val TAG = "wave"
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
