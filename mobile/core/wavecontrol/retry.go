package wavecontrol

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"syscall"
	"time"
)

// The bounds of the wait between two tries, the same as the socket's
// reconnect and the desktop client's (apps/client/src/retry.ts).
const (
	DefaultMinBackoff = 500 * time.Millisecond
	DefaultMaxBackoff = 30 * time.Second
)

// Retriable says whether a failure to reach the control server is worth
// another try. The same rule as retry.ts on the desktop; a change to which
// errors count as "the server is not there yet" is a change to both.
//
// Retried: connection refused or reset, timeout, network or host unreachable,
// HTTP 502, 503 and 504. Reported at once: every other answer (a wrong
// address, a refusal) and everything that is not a connection problem at all
// -- retrying those would hide the real reason behind a wait that never ends.
//
// knownAddress is whether this device has enrolled at that address before. A
// name that does not resolve is then the network not being up yet, and is
// retried; for an address a person has just typed it is most likely a typo,
// and is reported. A certificate error is reported either way: waiting does
// not fix it.
func Retriable(err error, knownAddress bool) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	var status *StatusError
	if errors.As(err, &status) {
		return status.Status == http.StatusBadGateway ||
			status.Status == http.StatusServiceUnavailable ||
			status.Status == http.StatusGatewayTimeout
	}

	// Certificates first: a failed verification can arrive wrapped in a
	// network error, and must not be mistaken for one.
	var unknownAuthority x509.UnknownAuthorityError
	var invalid x509.CertificateInvalidError
	var wrongHost x509.HostnameError
	var verification *tls.CertificateVerificationError
	if errors.As(err, &unknownAuthority) || errors.As(err, &invalid) ||
		errors.As(err, &wrongHost) || errors.As(err, &verification) ||
		strings.Contains(err.Error(), "x509:") {
		return false
	}

	var lookup *net.DNSError
	if errors.As(err, &lookup) {
		// "No such host" is the name; anything else is the resolver or the
		// network under it, which is not a property of the address.
		if lookup.IsNotFound {
			return knownAddress
		}
		return true
	}

	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	for _, errno := range []syscall.Errno{
		syscall.ECONNREFUSED, syscall.ECONNRESET, syscall.ECONNABORTED, syscall.EPIPE,
		syscall.ETIMEDOUT, syscall.EHOSTUNREACH, syscall.ENETUNREACH, syscall.ENETDOWN,
	} {
		if errors.Is(err, errno) {
			return true
		}
	}
	var network net.Error
	if errors.As(err, &network) && network.Timeout() {
		return true
	}
	// An attempt that ran out of its own time. A caller that gave up is told
	// apart by Retrying, which looks at the context first.
	return errors.Is(err, context.DeadlineExceeded)
}

// RetryOptions says how Retrying waits.
type RetryOptions struct {
	// KnownAddress: see Retriable.
	KnownAddress bool
	// The bounds of the wait, doubling from the minimum; zero takes the defaults.
	MinBackoff time.Duration
	MaxBackoff time.Duration
	// OnWait is called after each failed attempt, before the wait.
	OnWait func(err error, delay time.Duration)
	// OnRecovered is called when an attempt that followed a failure succeeds.
	OnRecovered func()
	// A time limit that retrying does not move: past it, the next failure
	// returns DeadlineError (or the failure itself, if that is nil) instead of
	// waiting. The approval wait has one.
	Deadline      time.Time
	DeadlineError error
}

// Retrying runs attempt until it succeeds, fails with something that is not
// a connection problem, or ctx ends. The wait doubles from the minimum to the
// maximum and starts over with every call.
//
// This is what keeps a client from giving up at the first connect: everything
// after it already reconnects (Socket), and enrolment did not.
func Retrying[T any](ctx context.Context, options RetryOptions, attempt func(context.Context) (T, error)) (T, error) {
	delay := options.MinBackoff
	if delay <= 0 {
		delay = DefaultMinBackoff
	}
	limit := options.MaxBackoff
	if limit <= 0 {
		limit = DefaultMaxBackoff
	}
	waited := false
	for {
		result, err := attempt(ctx)
		if err == nil {
			if waited && options.OnRecovered != nil {
				options.OnRecovered()
			}
			return result, nil
		}
		// A context that ended wins over whatever the request it cut short
		// made of it.
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		if !Retriable(err, options.KnownAddress) {
			return result, err
		}
		if !options.Deadline.IsZero() && !time.Now().Before(options.Deadline) {
			if options.DeadlineError != nil {
				return result, options.DeadlineError
			}
			return result, err
		}
		if options.OnWait != nil {
			options.OnWait(err, delay)
		}
		waited = true
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return result, ctx.Err()
		case <-timer.C:
		}
		delay *= 2
		if delay > limit {
			delay = limit
		}
	}
}
