// Package wavestun is a STUN client (RFC 5389 binding request) that shares the
// data-path socket.
//
// Sharing matters: the mapping a STUN server reports only describes the port
// the request went out of, so asking from a separate socket would return an
// address no peer can use.
package wavestun

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"net/netip"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/waveproto"
)

const (
	magicCookie           = 0x2112a442
	bindingRequest        = 0x0001
	bindingSuccess        = 0x0101
	attrMappedAddress     = 0x0001
	attrXorMappedAddress  = 0x0020
	headerLength          = 20
	transactionIDPosition = 8
	transactionIDLength   = 12
)

// LooksLikeStun reports whether a datagram is STUN. Like the disco test, it
// decides which of several protocols sharing this socket a packet belongs to.
func LooksLikeStun(packet []byte) bool {
	return len(packet) >= headerLength && binary.BigEndian.Uint32(packet[4:]) == magicCookie
}

// BuildBindingRequest returns the packet and the transaction id to file the
// pending query under.
func BuildBindingRequest() (packet []byte, txid string) {
	packet = make([]byte, headerLength)
	binary.BigEndian.PutUint16(packet[0:], bindingRequest)
	binary.BigEndian.PutUint16(packet[2:], 0)
	binary.BigEndian.PutUint32(packet[4:], magicCookie)
	_, _ = rand.Read(packet[transactionIDPosition : transactionIDPosition+transactionIDLength])
	return packet, hex.EncodeToString(packet[transactionIDPosition : transactionIDPosition+transactionIDLength])
}

// ParseBindingResponse reads the mapped address out of a success response.
// Returns ok=false for anything else, including a response we did not ask for.
func ParseBindingResponse(packet []byte) (txid string, mapped waveproto.Endpoint, ok bool) {
	if !LooksLikeStun(packet) || binary.BigEndian.Uint16(packet[0:]) != bindingSuccess {
		return "", waveproto.Endpoint{}, false
	}
	txid = hex.EncodeToString(packet[transactionIDPosition : transactionIDPosition+transactionIDLength])

	end := headerLength + int(binary.BigEndian.Uint16(packet[2:]))
	if end > len(packet) {
		end = len(packet)
	}
	for offset := headerLength; offset+4 <= end; {
		attribute := binary.BigEndian.Uint16(packet[offset:])
		length := int(binary.BigEndian.Uint16(packet[offset+2:]))
		value := offset + 4
		if value+length > len(packet) {
			break
		}
		if attribute == attrXorMappedAddress || attribute == attrMappedAddress {
			// The XOR key is the cookie followed by the transaction id, so the
			// whole header has to come along -- for IPv6 the id covers twelve
			// of the sixteen bytes.
			var key [16]byte
			binary.BigEndian.PutUint32(key[0:], magicCookie)
			copy(key[4:], packet[transactionIDPosition:transactionIDPosition+transactionIDLength])
			if endpoint, decoded := decodeAddress(packet[value:value+length], attribute == attrXorMappedAddress, key); decoded {
				return txid, endpoint, true
			}
		}
		offset = value + length + (4-length%4)%4
	}
	return txid, waveproto.Endpoint{}, false
}

// decodeAddress reads one MAPPED-ADDRESS attribute. Both families are handled:
// a phone on a v6-only mobile network gets a v6 mapping, and treating that as
// "no answer" would look exactly like a STUN server that is down.
func decodeAddress(value []byte, xor bool, key [16]byte) (waveproto.Endpoint, bool) {
	if len(value) < 4 {
		return waveproto.Endpoint{}, false
	}
	family := value[1]
	port := int(binary.BigEndian.Uint16(value[2:]))
	body := value[4:]
	if xor {
		port ^= magicCookie >> 16
	}

	switch family {
	case 0x01:
		if len(body) < 4 {
			return waveproto.Endpoint{}, false
		}
		var raw [4]byte
		copy(raw[:], body)
		if xor {
			for i := range raw {
				raw[i] ^= key[i]
			}
		}
		return waveproto.Endpoint{IP: netip.AddrFrom4(raw).String(), Port: port}, true
	case 0x02:
		if len(body) < 16 {
			return waveproto.Endpoint{}, false
		}
		var raw [16]byte
		copy(raw[:], body)
		if xor {
			for i := range raw {
				raw[i] ^= key[i]
			}
		}
		return waveproto.Endpoint{IP: netip.AddrFrom16(raw).String(), Port: port}, true
	}
	return waveproto.Endpoint{}, false
}

// Mapping is what comparing two servers' answers says about the NAT in front
// of us. It is the cheapest reliable predictor of whether hole punching can
// work at all.
type Mapping string

const (
	EndpointIndependent Mapping = "endpoint-independent"
	AddressDependent    Mapping = "address-dependent"
	Undetermined        Mapping = "undetermined"
)

// Classify compares the mappings several servers reported.
func Classify(results []waveproto.Endpoint) Mapping {
	// One answer tells us our address but nothing about how the NAT behaves:
	// the question is whether the mapping changes per destination.
	if len(results) < 2 {
		return Undetermined
	}
	for _, result := range results[1:] {
		if result != results[0] {
			return AddressDependent
		}
	}
	return EndpointIndependent
}
