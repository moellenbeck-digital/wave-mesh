package wavetun

import (
	"os"
	"syscall"
	"testing"
	"time"
)

// Stopping the core closes the link while its read loop waits for a packet.
// With the descriptor the platform hands over -- blocking -- that read used to
// sit until a packet happened to arrive, and disconnecting a quiet tunnel hung.
func TestCloseInterruptsAWaitingRead(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	// A fresh blocking descriptor, the way a platform passes one in.
	fd, err := dupBlocking(reader)
	if err != nil {
		t.Fatal(err)
	}
	reader.Close()
	link, err := NewFDLink(fd, FramingRaw, 1280)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := link.ReadPacket(make([]byte, 1500))
		done <- err
	}()
	time.Sleep(100 * time.Millisecond)
	_ = link.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not interrupt the read: stopping the core would hang")
	}
}

func dupBlocking(file *os.File) (int, error) {
	fd, err := syscall.Dup(int(file.Fd()))
	if err != nil {
		return -1, err
	}
	return fd, syscall.SetNonblock(fd, false)
}
