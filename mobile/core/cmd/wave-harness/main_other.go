//go:build !linux

// The harness makes a TUN device by hand, which is Linux-specific. It exists to
// exercise the core on a development machine, not to run anywhere else -- so
// everywhere else it is a package that builds and says so.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "wave-harness runs on Linux only: it creates a TUN device directly.")
	fmt.Fprintln(os.Stderr, "On a phone the descriptor comes from VpnService or the packet tunnel provider.")
	os.Exit(1)
}
