//go:build linux

package main

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/unix"

	"github.com/pinguin45orga/wave-mesh/mobile/core/wavetun"
)

// tunLink is a real TUN device, wrapped as the Link the multiplexer expects.
//
// This is the piece the phones supply and a development machine does not, so it
// is the one piece of the harness that has no counterpart in the core. On
// Android the descriptor comes from VpnService and on iOS from the packet
// tunnel; here it is made by hand. Everything above it -- the demultiplexer,
// the WireGuard devices, the resolver, the magic socket -- is the code that
// runs on a phone, unchanged.
type tunLink struct {
	file *os.File
	name string
}

var _ wavetun.Link = (*tunLink)(nil)

// openTUN creates a TUN interface and hands back a Link over it.
//
// IFF_NO_PI, so the descriptor carries bare IP packets: the same framing as
// Android's, which is why the harness passes FramingRaw. A utun on Darwin
// prefixes four bytes of address family instead, and that difference is why the
// core is told which framing it has rather than guessing.
func openTUN(name string) (*tunLink, error) {
	fd, err := unix.Open("/dev/net/tun", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("open /dev/net/tun: %w (load the driver: modprobe tun)", err)
	}

	// struct ifreq: the name, then the flags.
	var request struct {
		name  [unix.IFNAMSIZ]byte
		flags uint16
		pad   [22]byte
	}
	if len(name) >= unix.IFNAMSIZ {
		unix.Close(fd)
		return nil, fmt.Errorf("%q is too long for an interface name", name)
	}
	copy(request.name[:], name)
	request.flags = unix.IFF_TUN | unix.IFF_NO_PI

	if _, _, errno := unix.Syscall(
		unix.SYS_IOCTL, uintptr(fd), uintptr(unix.TUNSETIFF), uintptr(unsafe.Pointer(&request)),
	); errno != 0 {
		unix.Close(fd)
		return nil, fmt.Errorf("TUNSETIFF %s: %w", name, errno)
	}

	// Non-blocking, so the runtime polls it and Close actually interrupts a
	// read that is waiting. Without this, shutdown hangs in the read loop until
	// a packet happens to arrive.
	if err := unix.SetNonblock(fd, true); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("set %s non-blocking: %w", name, err)
	}
	return &tunLink{file: os.NewFile(uintptr(fd), "/dev/net/tun"), name: name}, nil
}

func (l *tunLink) ReadPacket(buf []byte) (int, error) { return l.file.Read(buf) }

func (l *tunLink) WritePacket(packet []byte) error {
	_, err := l.file.Write(packet)
	return err
}

func (l *tunLink) Close() error { return l.file.Close() }
