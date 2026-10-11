package org.wavemesh.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/// The shapes the core sends, read from the files `go test` writes -- the same
/// contract StatusTests and WaveTunnelTests hold the iOS app to. When the Go
/// side changes the form, this fails first, instead of a screen that silently
/// stops updating or a tunnel that gets no addresses.
class ContractTest {
    private fun fixture(path: String): String = File("../../core/$path").readText()

    @Test
    fun readsTheCoreStatus() {
        val status = Status.parse(fixture("waveengine/testdata/status.json"))
        assertNotNull(status)
        assertTrue(status!!.running)
        assertEquals(listOf("a.wave.example.com", "customer.a.wave.example.com", "b.example", "c.example"), status.waves.map { it.label })
        val live = status.waves[0]
        assertEquals("https://a.example", live.id)
        assertTrue(live.enabled)
        assertEquals("phone.a.wave.example.com", live.dnsName)
        assertEquals(listOf("laptop.a.wave.example.com"), live.peers.map { it.dnsName })
        assertEquals(listOf("https://grafana.a.wave.example.com"), live.services.map { it.url })
        assertEquals(-1, live.peers.first().lastHandshakeSeconds)
        assertEquals(true, live.relayOffered)
        val second = status.waves[1]
        assertEquals(live.controlUrl, second.controlUrl)
        assertEquals("https://a.example#0f0f0f0f", second.id)
        assertNotEquals(live.id, second.id)
        assertFalse(status.waves[2].enabled)
        assertTrue(status.waves[2].peers.isEmpty())
        assertEquals("removed", status.waves[3].problem)
    }

    /// What the app caches between runs reads back as what it was.
    @Test
    fun roundTripsForTheCache() {
        val status = Status.parse(fixture("waveengine/testdata/status.json"))!!
        assertEquals(status, Status.parse(status.toJSON()))
    }

    @Test
    fun anAnswerThatIsNotAStatusKeepsTheLastOne() {
        assertNull(Status.parse("not json"))
    }

    @Test
    fun readsTheCoreSettings() {
        val settings = WaveSettings.parse(fixture("wavesettings/testdata/settings.json"))
        assertEquals(listOf("10.77.0.2/16", "10.96.0.5/16", "fd7a:1::2/128"), settings.addresses)
        assertEquals(listOf("10.77.0.0/16", "10.77.0.53/32", "10.96.0.0/16", "10.96.0.53/32"), settings.routes)
        assertEquals(1200, settings.mtu)
        assertEquals(listOf("10.77.0.53", "10.96.0.53"), settings.dnsServers)
        assertEquals("rl.wave.example.com", settings.searchDomains.first())
    }
}
