package waveengine

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/moellenbeck-digital/wave-mesh/mobile/core/wavedns"
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

	// What did not resolve, said in the log. A name that does not resolve on
	// a phone is otherwise invisible: the browser says "server not found" and
	// nothing says whether the question reached us, which wave it went to, or
	// that the netmap simply has no such name.
	log      func(string)
	noteMu   sync.Mutex
	noted    map[string]time.Time
	window   time.Time
	inWindow int
}

// What the log may take from the resolver: each name once a minute, and no
// more than this many lines a minute in all -- an app retrying in a loop must
// not fill the log, which is trimmed and would lose everything else.
const (
	noteEvery      = time.Minute
	notesPerMinute = 20
)

func newResolver(dialer *net.Dialer) *resolver {
	if dialer == nil {
		dialer = &net.Dialer{}
	}
	return &resolver{dialer: dialer, timeout: 3 * time.Second, noted: map[string]time.Time{}}
}

// note writes one line about a name, unless that name or the minute's budget
// has been spoken for.
func (r *resolver) note(name, line string) {
	if r.log == nil {
		return
	}
	now := time.Now()
	r.noteMu.Lock()
	if now.Sub(r.window) >= time.Minute {
		r.window, r.inWindow = now, 0
		for key, at := range r.noted {
			if now.Sub(at) >= noteEvery {
				delete(r.noted, key)
			}
		}
	}
	if at, seen := r.noted[name]; (seen && now.Sub(at) < noteEvery) || r.inWindow >= notesPerMinute {
		r.noteMu.Unlock()
		return
	}
	r.noted[name] = now
	r.inWindow++
	r.noteMu.Unlock()
	r.log(line)
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
		r.noteNameError(query, resolution.Packet, config)
		return resolution.Packet
	}
	for _, nameserver := range resolution.Nameservers {
		if answer := r.forward(query, nameserver); answer != nil {
			return answer
		}
	}
	if decoded, ok := wavedns.DecodeQuery(query); ok {
		name := wavedns.NormalizeName(decoded.Question.Name)
		r.note(name, "dns: "+name+" is delegated, and none of "+strings.Join(resolution.Nameservers, ", ")+" answered")
	}
	return nil
}

// noteNameError says when a name in one of our zones is not in the netmap.
// Reverse lookups are left out: anything that prints an address asks for its
// name, and "no name for this address" is the common, uninteresting case.
func (r *resolver) noteNameError(query, answer []byte, config wavedns.Config) {
	if len(answer) < 4 || answer[3]&0x0f != wavedns.CodeNameError {
		return
	}
	decoded, ok := wavedns.DecodeQuery(query)
	if !ok || decoded.Question.Type == wavedns.TypePTR {
		return
	}
	name := wavedns.NormalizeName(decoded.Question.Name)
	zone, peers, services := "", 0, 0
	for _, candidate := range config.Zones {
		if candidate.Suffix != "" && wavedns.IsWithinZone(name, candidate.Suffix) && len(candidate.Suffix) > len(zone) {
			zone, peers, services = candidate.Suffix, len(candidate.Records), candidate.Services
		}
	}
	r.note(name, fmt.Sprintf("dns: %s is not in the netmap of %s (%d names there, %d of them services)",
		name, zone, peers, services))
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
