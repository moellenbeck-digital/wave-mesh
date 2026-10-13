package org.wavemesh.app

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors

/// A log the tunnel and the app both write to, and the app can show and share
/// -- the same file WaveLog.swift keeps on iOS.
///
/// logcat needs a computer and a cable: on a phone in somebody's pocket this
/// file is the only way to see why a name did not resolve or a second wave did
/// not come up. It stays on the device and leaves it only when the person
/// shares it, the promise the disclosure makes. Kept to the last few hundred
/// kilobytes.
object WaveLog {
    private const val LIMIT = 512 * 1024
    private const val TAG = "wave"
    /** One writer, so lines from the tunnel and the app never interleave mid-line. */
    private val queue = Executors.newSingleThreadExecutor()
    @Volatile
    private var file: File? = null

    /** Who wrote a line: the service runs the core, the app only asks it. */
    enum class Source(val tag: String) { APP("app"), TUNNEL("tunnel") }

    fun init(context: Context) {
        if (file == null) file = File(context.applicationContext.filesDir, "wave.log")
    }

    fun write(line: String, source: Source) {
        Log.i(TAG, line)
        val target = file ?: return
        val entry = "${stamp()} [${source.tag}] $line\n"
        queue.execute {
            runCatching {
                target.appendText(entry)
                if (target.length() > LIMIT) trim(target)
            }
        }
    }

    fun read(): String = runCatching { file?.readText() ?: "" }.getOrDefault("")

    fun clear() {
        val target = file ?: return
        queue.execute { runCatching { target.writeText("") } }
    }

    /**
     * A copy to hand to the share sheet, named so that whoever receives it
     * knows what it is. In the cache directory: the share target reads it after
     * this returns, and the tunnel keeps writing to the original meanwhile.
     */
    fun export(context: Context): File? {
        val text = read()
        if (text.isEmpty()) return null
        val day = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(Date())
        val directory = File(context.cacheDir, "log").apply { mkdirs() }
        return runCatching { File(directory, "wave-mesh-log-$day.txt").apply { writeText(text) } }.getOrNull()
    }

    /**
     * Why the process ended last time, if it ended badly -- what MetricKit's
     * diagnostics are on iOS. Android keeps the reasons; this writes the ones
     * not written yet. The fdsan abort on the first netmap was exactly such a
     * reason, and nothing on the phone said so.
     */
    fun recordExits(context: Context) {
        val manager = context.getSystemService(ActivityManager::class.java) ?: return
        val prefs = prefs(context)
        val seen = prefs.getLong(LAST_EXIT, 0)
        val exits = runCatching { manager.getHistoricalProcessExitReasons(context.packageName, 0, 10) }
            .getOrDefault(emptyList())
            .filter { it.timestamp > seen && it.reason in WORTH_SAYING }
            .sortedBy { it.timestamp }
        for (exit in exits) {
            val description = exit.description?.let { ": $it" } ?: ""
            write("diagnostic: the app ended at ${stamp(exit.timestamp)}, ${reasonName(exit.reason)}$description", Source.APP)
        }
        exits.lastOrNull()?.let { prefs.edit().putLong(LAST_EXIT, it.timestamp).apply() }
    }

    private const val LAST_EXIT = "lastExitRecorded"

    private val WORTH_SAYING = setOf(
        ApplicationExitInfo.REASON_CRASH,
        ApplicationExitInfo.REASON_CRASH_NATIVE,
        ApplicationExitInfo.REASON_ANR,
        ApplicationExitInfo.REASON_LOW_MEMORY,
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE,
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE,
    )

    private fun reasonName(reason: Int): String = when (reason) {
        ApplicationExitInfo.REASON_CRASH -> "crash"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "native crash"
        ApplicationExitInfo.REASON_ANR -> "not responding"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "killed for memory"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "killed for resource use"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "failed to start"
        else -> "reason $reason"
    }

    /** Keeps the newer half, cut at a line boundary. */
    private fun trim(target: File) {
        val text = target.readText()
        val tail = text.takeLast(LIMIT / 2)
        target.writeText(tail.substringAfter('\n', tail))
    }

    private fun stamp(at: Long = System.currentTimeMillis()): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }
            .format(Date(at))
}
