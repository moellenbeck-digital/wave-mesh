package org.wavemesh.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.VpnService
import androidx.core.content.ContextCompat

/// Brings the tunnel back after a restart or an update -- what on-demand does
/// on iOS. Only when the switch "Connect automatically" is on, the tunnel was
/// running when the phone went down (a disconnect by hand stays a disconnect),
/// and the VPN permission is still ours: without it Android would have to ask,
/// and a broadcast receiver has nobody to ask.
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        WaveLog.init(context)
        val prefs = prefs(context)
        if (!prefs.getBoolean(AUTO_CONNECT, true) || !prefs.getBoolean(TUNNEL_WANTED, false)) return
        if (VpnService.prepare(context) != null) {
            WaveLog.write("not reconnecting after ${intent.action}: the VPN permission is no longer ours", WaveLog.Source.APP)
            return
        }
        WaveLog.write("reconnecting after ${intent.action}", WaveLog.Source.APP)
        ContextCompat.startForegroundService(context, Intent(context, WaveVpnService::class.java))
    }

    companion object {
        /** The switch "Connect automatically". On by default, as on iOS. */
        const val AUTO_CONNECT = "autoConnect"
        /** Whether the person last left the tunnel running. */
        const val TUNNEL_WANTED = "tunnelWanted"
    }
}
