package waveengine

import (
	"context"
	"net"
	"sync"
	"time"

	"github.com/pinguin45orga/wave-mesh/mobile/core/wavedns"
)

// resolver is the one resolver on the device: a suffix table over every wave,
// and no socket of its own.
//
// It sits behind wavetun.Resolver, which hands it the payload of a UDP packet
// addressed to one of our tunnel addresses on port 53. What it answers goes
// back out as a packet the same way.
type resolver struct {
	mu      sync.RWMutex
	config  wavedns.Config
	dialer  *net.Dialer
	timeout time.Duration
}

func newResolver(dialer *net.Dialer) *resolver {
	if dialer == nil {
		dialer = &net.Dialer{}
	}
	return &resolver{dialer: dialer, timeout: 3 * time.Second}
}

func (r *resolver) update(config wavedns.Config) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.config = config
}

// Answer returns the reply to a query, or nil when the query is not ours.
func (r *resolver) Answer(query []byte) []byte {
	r.mu.RLock()
	config := r.config
	r.mu.RUnlock()

	resolution := wavedns.Resolve(query, config)
	switch {
	case resolution.Drop:
		return nil
	case resolution.Packet != nil:
		return resolution.Packet
	}
	for _, nameserver := range resolution.Nameservers {
		if answer := r.forward(query, nameserver); answer != nil {
			return answer
		}
	}
	return nil
}

// forward asks an upstream nameserver and waits briefly for its answer.
//
// The dialer is the platform's: on Android a socket of ours that is not
// protected goes back into the tunnel we are serving, and the query would chase
// its own tail.
func (r *resolver) forward(query []byte, nameserver string) []byte {
	address := nameserver
	if _, _, err := net.SplitHostPort(nameserver); err != nil {
		address = net.JoinHostPort(nameserver, "53")
	}

	ctx, cancel := context.WithTimeout(context.Background(), r.timeout)
	defer cancel()
	connection, err := r.dialer.DialContext(ctx, "udp", address)
	if err != nil {
		return nil
	}
	defer connection.Close()

	_ = connection.SetDeadline(time.Now().Add(r.timeout))
	if _, err := connection.Write(query); err != nil {
		return nil
	}
	buffer := make([]byte, 1500)
	n, err := connection.Read(buffer)
	if err != nil || n == 0 {
		return nil
	}
	return buffer[:n]
}
