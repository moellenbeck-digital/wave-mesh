package org.wavemesh.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SupportTest {
    /// The same answers as DeviceNameTests on iOS: the two apps show the same
    /// preview for the same input.
    @Test
    fun foldsADeviceNameTheWayTheServerWould() {
        assertEquals("max-iphone", DeviceName.label("Max' iPhone"))
        assertEquals("moellenbeck-buero", DeviceName.label("Möllenbeck Büro"))
        assertEquals("strasse-12", DeviceName.label("Straße 12"))
        assertEquals("ipad-kueche", DeviceName.label("  iPad (Küche)  "))
        assertEquals("cafe", DeviceName.label("Café"))
        assertEquals("", DeviceName.label("---"))
        assertEquals(63, DeviceName.label("a".repeat(80)).length)
    }

    @Test
    fun anInviteNamesOnlyAServerOrigin() {
        assertEquals("https://wave.example.com", WaveInvite.server("wavemesh://join?server=https://wave.example.com"))
        assertEquals("https://wave.example.com", WaveInvite.server("wavemesh://join?server=https%3A%2F%2Fwave.example.com%2Fpath%3Fx%3D1"))
        assertEquals("http://10.0.2.2:8080", WaveInvite.server("wavemesh://join?server=http://10.0.2.2:8080"))
        assertNull(WaveInvite.server("wavemesh://join?server=ftp://wave.example.com"))
        assertNull(WaveInvite.server("wavemesh://other?server=https://wave.example.com"))
        assertNull(WaveInvite.server("https://join?server=https://wave.example.com"))
        assertNull(WaveInvite.server("wavemesh://join"))
        assertNull(WaveInvite.server(null))
    }

    @Test
    fun showsTheHostOfAnAddressOrAWaveKey() {
        assertEquals("a.example", hostOf("https://a.example"))
        assertEquals("a.example", hostOf("https://a.example#0f0f0f0f"))
        assertEquals("not a url", hostOf("not a url"))
    }

    @Test
    fun aServiceIsCheckedOnThePortItsUrlImplies() {
        assertEquals("10.0.0.9" to 443, target(ServiceStatus("g", "g.x", "10.0.0.9", "https://g.x")))
        assertEquals("10.0.0.9" to 80, target(ServiceStatus("g", "g.x", "10.0.0.9", "http://g.x")))
        assertEquals("10.0.0.9" to 8443, target(ServiceStatus("g", "g.x", "10.0.0.9", "https://g.x:8443")))
        assertEquals("10.0.0.9" to 443, target(ServiceStatus("g", "g.x", "10.0.0.9", "")))
    }

    @Test
    fun splitsAnAddressFromItsPrefix() {
        assertEquals("10.0.0.1" to 16, WaveVpnService.splitCidr("10.0.0.1/16"))
        assertEquals("fd7a::1" to 128, WaveVpnService.splitCidr("fd7a::1"))
        assertNull(WaveVpnService.splitCidr("10.0.0.1/40"))
        assertNull(WaveVpnService.splitCidr(""))
    }
}
