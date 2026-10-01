// Package wavetun multiplexes the waves into the one tunnel a phone allows.
//
// Both platforms permit exactly one tunnel per app -- one NEPacketTunnelProvider,
// one VpnService -- so the model from the desktop, an interface waveN and a UDP
// port 4164N per enrolment, does not exist here. Instead there is one device
// underneath and one virtual tun.Device per wave above it, with a demultiplexer
// in between that sorts outbound packets by destination prefix.
//
// The routing table that needs is exactly the one whose disjointness
// waveoverlap already guarantees: no condition is added, an existing one is
// used.
package wavetun

import (
	"encoding/binary"
	"net/netip"
)

// Protocol numbers, of which only UDP matters here: the resolver is the one
// thing this layer answers itself.
const (
	protocolUDP = 17
	// The minimum size of each header, which is also the point below which a
	// packet cannot be read at all.
	ipv4HeaderMin = 20
	ipv6Header    = 40
	udpHeader     = 8
)

// Version reads the IP version of a packet, or zero if it is not one.
func Version(packet []byte) int {
	if len(packet) < 1 {
		return 0
	}
	return int(packet[0] >> 4)
}

// Destination is the address a packet is going to. This is the whole input to
// the demultiplexer: which wave a packet belongs to is decided by where it is
// headed, and by nothing else.
func Destination(packet []byte) (netip.Addr, bool) {
	switch Version(packet) {
	case 4:
		if len(packet) < ipv4HeaderMin {
			return netip.Addr{}, false
		}
		return netip.AddrFrom4([4]byte(packet[16:20])), true
	case 6:
		if len(packet) < ipv6Header {
			return netip.Addr{}, false
		}
		return netip.AddrFrom16([16]byte(packet[24:40])), true
	}
	return netip.Addr{}, false
}

// Source is the address a packet came from.
func Source(packet []byte) (netip.Addr, bool) {
	switch Version(packet) {
	case 4:
		if len(packet) < ipv4HeaderMin {
			return netip.Addr{}, false
		}
		return netip.AddrFrom4([4]byte(packet[12:16])), true
	case 6:
		if len(packet) < ipv6Header {
			return netip.Addr{}, false
		}
		return netip.AddrFrom16([16]byte(packet[8:24])), true
	}
	return netip.Addr{}, false
}

// UDPDatagram is one parsed UDP packet. The payload points into the packet it
// came from, so a reply can be built from the same bytes.
type UDPDatagram struct {
	Source      netip.AddrPort
	Destination netip.AddrPort
	Payload     []byte
}

// ParseUDP reads a UDP datagram, or reports that the packet is not one.
//
// Deliberately narrow: IPv4 without options is what a tunnel produces, and an
// IPv6 packet with extension headers is not something this has to answer. What
// it cannot read, it does not claim.
func ParseUDP(packet []byte) (UDPDatagram, bool) {
	var (
		headerLen int
		source    netip.Addr
		dest      netip.Addr
	)
	switch Version(packet) {
	case 4:
		if len(packet) < ipv4HeaderMin {
			return UDPDatagram{}, false
		}
		headerLen = int(packet[0]&0x0f) * 4
		if headerLen < ipv4HeaderMin || len(packet) < headerLen+udpHeader || packet[9] != protocolUDP {
			return UDPDatagram{}, false
		}
		// A fragment carries no complete UDP header after the first piece, and
		// reassembly is not this layer's business.
		if binary.BigEndian.Uint16(packet[6:])&0x1fff != 0 {
			return UDPDatagram{}, false
		}
		source = netip.AddrFrom4([4]byte(packet[12:16]))
		dest = netip.AddrFrom4([4]byte(packet[16:20]))
	case 6:
		if len(packet) < ipv6Header+udpHeader || packet[6] != protocolUDP {
			return UDPDatagram{}, false
		}
		headerLen = ipv6Header
		source = netip.AddrFrom16([16]byte(packet[8:24]))
		dest = netip.AddrFrom16([16]byte(packet[24:40]))
	default:
		return UDPDatagram{}, false
	}

	udp := packet[headerLen:]
	length := int(binary.BigEndian.Uint16(udp[4:]))
	if length < udpHeader || headerLen+length > len(packet) {
		return UDPDatagram{}, false
	}
	return UDPDatagram{
		Source:      netip.AddrPortFrom(source, binary.BigEndian.Uint16(udp[0:])),
		Destination: netip.AddrPortFrom(dest, binary.BigEndian.Uint16(udp[2:])),
		Payload:     udp[udpHeader:length],
	}, true
}

// BuildUDPReply turns a request into its answer: the same two endpoints the
// other way round, carrying the given payload.
//
// Built rather than sent, because the resolver here has no socket. The query
// arrived as a packet on the tunnel and the answer has to go back the same way,
// which means this layer does what the kernel would otherwise do -- including
// the checksums, which are not optional over IPv6 and which a resolver library
// would never have had to think about.
func BuildUDPReply(request UDPDatagram, payload []byte) []byte {
	source, dest := request.Destination, request.Source
	if source.Addr().Is4() != dest.Addr().Is4() {
		return nil
	}

	total := udpHeader + len(payload)
	var packet []byte
	if source.Addr().Is4() {
		packet = make([]byte, ipv4HeaderMin+total)
		packet[0] = 0x45
		binary.BigEndian.PutUint16(packet[2:], uint16(ipv4HeaderMin+total))
		// No fragmentation, and a TTL that is generous for a packet that never
		// leaves the device.
		packet[8] = 64
		packet[9] = protocolUDP
		copy(packet[12:16], addr4(source.Addr()))
		copy(packet[16:20], addr4(dest.Addr()))
		binary.BigEndian.PutUint16(packet[10:], checksum(packet[:ipv4HeaderMin]))
		writeUDP(packet[ipv4HeaderMin:], source, dest, payload)
		putUDPChecksum(packet[ipv4HeaderMin:], source.Addr(), dest.Addr(), total)
		return packet
	}

	packet = make([]byte, ipv6Header+total)
	packet[0] = 0x60
	binary.BigEndian.PutUint16(packet[4:], uint16(total))
	packet[6] = protocolUDP
	packet[7] = 64
	copy(packet[8:24], addr16(source.Addr()))
	copy(packet[24:40], addr16(dest.Addr()))
	writeUDP(packet[ipv6Header:], source, dest, payload)
	putUDPChecksum(packet[ipv6Header:], source.Addr(), dest.Addr(), total)
	return packet
}

func writeUDP(udp []byte, source, dest netip.AddrPort, payload []byte) {
	binary.BigEndian.PutUint16(udp[0:], source.Port())
	binary.BigEndian.PutUint16(udp[2:], dest.Port())
	binary.BigEndian.PutUint16(udp[4:], uint16(udpHeader+len(payload)))
	copy(udp[udpHeader:], payload)
}

// putUDPChecksum fills in the checksum over the pseudo-header and the datagram.
// Zero is legal over IPv4 and forbidden over IPv6, and the all-ones form is how
// a computed zero is written -- so this does the same thing for both families
// rather than carrying the exception.
func putUDPChecksum(udp []byte, source, dest netip.Addr, length int) {
	binary.BigEndian.PutUint16(udp[6:], 0)

	var pseudo []byte
	if source.Is4() {
		// src(4) dst(4) zero(1) protocol(1) length(2)
		pseudo = append(pseudo, addr4(source)...)
		pseudo = append(pseudo, addr4(dest)...)
		pseudo = append(pseudo, 0, protocolUDP)
		pseudo = binary.BigEndian.AppendUint16(pseudo, uint16(length))
	} else {
		// src(16) dst(16) length(4) zero(3) next header(1)
		pseudo = append(pseudo, addr16(source)...)
		pseudo = append(pseudo, addr16(dest)...)
		pseudo = binary.BigEndian.AppendUint32(pseudo, uint32(length))
		pseudo = append(pseudo, 0, 0, 0, protocolUDP)
	}

	sum := checksum(append(pseudo, udp[:length]...))
	if sum == 0 {
		sum = 0xffff
	}
	binary.BigEndian.PutUint16(udp[6:], sum)
}

// checksum is the one's complement sum RFC 1071 describes.
func checksum(data []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(data); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(data[i:]))
	}
	if len(data)%2 == 1 {
		sum += uint32(data[len(data)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = sum&0xffff + sum>>16
	}
	return ^uint16(sum)
}

func addr4(address netip.Addr) []byte {
	raw := address.As4()
	return raw[:]
}

func addr16(address netip.Addr) []byte {
	raw := address.As16()
	return raw[:]
}
