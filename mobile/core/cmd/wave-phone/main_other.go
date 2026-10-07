//go:build !linux

// wave-phone needs a Linux TUN device; see main_linux.go.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "wave-phone runs on Linux only: it drives the core through a real TUN device")
	os.Exit(1)
}
