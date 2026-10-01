package wavetun

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"sync"
)

// Link is the one tunnel the operating system gave us.
//
// An interface rather than a file, for two reasons. The two platforms frame
// packets differently, and neither framing can be exercised on a development
// machine -- so the multiplexer above is written against this and tested with
// an in-memory link, which is the only way any of it can be tested at all
// without a phone.
type Link interface {
	// ReadPacket fills buf with one IP packet and returns its length.
	ReadPacket(buf []byte) (int, error)
	// WritePacket sends one IP packet to the operating system.
	WritePacket(packet []byte) error
	Close() error
}

// ErrLinkClosed is what a Link returns once it is done. The multiplexer takes
// it as the end of the tunnel rather than as an error worth logging.
var ErrLinkClosed = os.ErrClosed

// Framing says how packets appear on the file descriptor.
type Framing int

const (
	// FramingRaw is a bare IP packet, which is what Android's VpnService
	// descriptor carries.
	FramingRaw Framing = iota
	// FramingUtun prefixes every packet with a four-byte address family, which
	// is what a utun descriptor on Darwin carries -- the same convention
	// wireguard-go's own darwin TUN uses.
	FramingUtun
)

// Address families as Darwin numbers them. They are not the Linux ones, and
// this is the only place the difference matters.
const (
	darwinAFInet  = 2
	darwinAFInet6 = 30
)

// FDLink is a Link over a file descriptor handed in by the platform.
type FDLink struct {
	file    *os.File
	framing Framing

	// Writes are serialised because two waves write to the same descriptor,
	// and a utun write is a header and a body that must not interleave.
	writeMu sync.Mutex
	scratch []byte
}

// NewFDLink takes over a descriptor. The caller must not close it afterwards:
// it belongs to this link, and closing it twice on a phone closes whatever the
// number was reused for.
func NewFDLink(fd int, framing Framing, mtu int) (*FDLink, error) {
	if fd < 0 {
		return nil, errors.New("not a file descriptor")
	}
	file := os.NewFile(uintptr(fd), "wave-tun")
	if file == nil {
		return nil, fmt.Errorf("descriptor %d is not usable", fd)
	}
	return &FDLink{file: file, framing: framing, scratch: make([]byte, mtu+4)}, nil
}

func (l *FDLink) ReadPacket(buf []byte) (int, error) {
	if l.framing == FramingRaw {
		return l.file.Read(buf)
	}
	n, err := l.file.Read(l.scratch)
	if err != nil {
		return 0, err
	}
	if n <= 4 {
		return 0, nil // a header with no packet behind it
	}
	return copy(buf, l.scratch[4:n]), nil
}

func (l *FDLink) WritePacket(packet []byte) error {
	if l.framing == FramingRaw {
		_, err := l.file.Write(packet)
		return err
	}

	family := uint32(darwinAFInet)
	if Version(packet) == 6 {
		family = darwinAFInet6
	}
	l.writeMu.Lock()
	defer l.writeMu.Unlock()
	framed := make([]byte, 4+len(packet))
	binary.BigEndian.PutUint32(framed, family)
	copy(framed[4:], packet)
	_, err := l.file.Write(framed)
	return err
}

func (l *FDLink) Close() error { return l.file.Close() }
