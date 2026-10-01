// Package wavedns is just enough DNS to answer questions about names in a
// wave, plus the split-DNS policy that decides which questions are ours.
//
// It is the Go half of packages/dns, with one difference that runs through the
// whole design: it owns no socket. On a phone the queries arrive as packets on
// the tunnel, because the resolver address the operating system was given is an
// address of ours inside it -- so the answer is built here and written back
// into the tunnel by the caller.
package wavedns

import (
	"encoding/binary"
	"net/netip"
	"strings"
)

// Record types this resolver knows. Everything else it either forwards or
// answers empty.
const (
	TypeA     = 1
	TypeCNAME = 5
	TypePTR   = 12
	TypeAAAA  = 28
)

// Response codes.
const (
	CodeNoError   = 0
	CodeNameError = 3
)

const (
	classIN         = 1
	maxNameLength   = 255
	pointerMask     = 0xc0
	headerLength    = 12
	ttlSeconds      = 60
	maxLabelLength  = 63
	questionTailLen = 4
)

// Question is the single question this resolver parses.
type Question struct {
	Name  string
	Type  int
	Class int
}

// Query is a decoded question, with the bits of the header an answer has to
// echo back.
type Query struct {
	ID int
	// Whether the client wants us to resolve on its behalf.
	RecursionDesired bool
	Question         Question
}

// Answer is one record in a response.
type Answer struct {
	Name string
	Type int
	TTL  int
	// Address for A and AAAA, Target for CNAME and PTR.
	Address string
	Target  string
}

// DecodeQuery parses a query. Returns ok=false for anything malformed, because
// a resolver that guesses is worse than one that stays silent.
func DecodeQuery(packet []byte) (Query, bool) {
	if len(packet) < headerLength {
		return Query{}, false
	}
	flags := binary.BigEndian.Uint16(packet[2:])
	isResponse := flags&0x8000 != 0
	opcode := (flags >> 11) & 0xf
	if isResponse || opcode != 0 || binary.BigEndian.Uint16(packet[4:]) != 1 {
		return Query{}, false
	}
	name, next, ok := decodeName(packet, headerLength)
	if !ok || next+questionTailLen > len(packet) {
		return Query{}, false
	}
	return Query{
		ID:               int(binary.BigEndian.Uint16(packet[0:])),
		RecursionDesired: flags&0x0100 != 0,
		Question: Question{
			Name:  name,
			Type:  int(binary.BigEndian.Uint16(packet[next:])),
			Class: int(binary.BigEndian.Uint16(packet[next+2:])),
		},
	}, true
}

func decodeName(packet []byte, offset int) (string, int, bool) {
	var labels []string
	cursor := offset
	length := 0
	for {
		if cursor >= len(packet) {
			return "", 0, false
		}
		size := int(packet[cursor])
		// Compression pointers are legal but never appear in a question, which
		// is all we parse; refusing them keeps this free of loop handling.
		if size&pointerMask == pointerMask {
			return "", 0, false
		}
		cursor++
		if size == 0 {
			break
		}
		length += size + 1
		if length > maxNameLength || cursor+size > len(packet) {
			return "", 0, false
		}
		labels = append(labels, string(packet[cursor:cursor+size]))
		cursor += size
	}
	return strings.Join(labels, "."), cursor, true
}

func encodeName(name string) []byte {
	out := []byte{}
	for _, label := range strings.Split(name, ".") {
		if label == "" {
			continue
		}
		if len(label) > maxLabelLength {
			return nil
		}
		out = append(out, byte(len(label)))
		out = append(out, label...)
	}
	return append(out, 0)
}

// EncodeIPv4 and EncodeIPv6 exist separately because a record says which one it
// holds; netip would happily give a v4-mapped v6 address for either.
func EncodeIPv4(address string) ([]byte, bool) {
	parsed, err := netip.ParseAddr(address)
	if err != nil || !parsed.Is4() {
		return nil, false
	}
	raw := parsed.As4()
	return raw[:], true
}

func EncodeIPv6(address string) ([]byte, bool) {
	parsed, err := netip.ParseAddr(address)
	if err != nil || parsed.Is4() {
		return nil, false
	}
	raw := parsed.As16()
	return raw[:], true
}

func recordData(answer Answer) []byte {
	switch answer.Type {
	case TypeA:
		data, ok := EncodeIPv4(answer.Address)
		if !ok {
			return nil
		}
		return data
	case TypeAAAA:
		data, ok := EncodeIPv6(answer.Address)
		if !ok {
			return nil
		}
		return data
	default:
		return encodeName(answer.Target)
	}
}

// EncodeResponse builds the reply to a query: the answers given, or a code and
// nothing else.
func EncodeResponse(query Query, answers []Answer, code int) []byte {
	packet := make([]byte, headerLength)
	binary.BigEndian.PutUint16(packet[0:], uint16(query.ID))
	// Authoritative: every answer here comes from our own records.
	flags := 0x8000 | 0x0400 | code
	if query.RecursionDesired {
		flags |= 0x0100
	}
	binary.BigEndian.PutUint16(packet[2:], uint16(flags))
	binary.BigEndian.PutUint16(packet[4:], 1)
	binary.BigEndian.PutUint16(packet[6:], uint16(len(answers)))

	packet = append(packet, encodeName(query.Question.Name)...)
	tail := make([]byte, questionTailLen)
	binary.BigEndian.PutUint16(tail[0:], uint16(query.Question.Type))
	binary.BigEndian.PutUint16(tail[2:], uint16(query.Question.Class))
	packet = append(packet, tail...)

	for _, answer := range answers {
		data := recordData(answer)
		if data == nil {
			continue
		}
		packet = append(packet, encodeName(answer.Name)...)
		record := make([]byte, 10)
		binary.BigEndian.PutUint16(record[0:], uint16(answer.Type))
		binary.BigEndian.PutUint16(record[2:], classIN)
		binary.BigEndian.PutUint32(record[4:], uint32(answer.TTL))
		binary.BigEndian.PutUint16(record[8:], uint16(len(data)))
		packet = append(packet, record...)
		packet = append(packet, data...)
	}
	return packet
}

// NormalizeName is the case- and trailing-dot-insensitive form DNS compares by.
func NormalizeName(name string) string {
	return strings.TrimRight(strings.ToLower(name), ".")
}

// IsWithinZone reports whether a name belongs to a zone, the zone itself
// included.
func IsWithinZone(name, zone string) bool {
	n, z := NormalizeName(name), NormalizeName(zone)
	return n == z || strings.HasSuffix(n, "."+z)
}
