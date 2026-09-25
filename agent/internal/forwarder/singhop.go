// SingleHopForwarder implements the one-hop tunnel modes: DIRECT (upstream is
// the user-facing remote_host:remote_port) and RELAY (upstream is the egress
// node at next_hop).
//
// WP15 removed the second data-plane implementation that used to carry DIRECT
// (the engine package plus the old DIRECT forwarder). Both one-hop modes now
// share this file: the only thing that distinguishes them is where
// UpstreamAddr() points, and that is resolved from the validated config below.
// The listener/forward plumbing is therefore identical, which is the whole
// point of §7.16 DoD "同一套 v3 runtime 同时承载 DIRECT 与 RELAY".
//
// An EGRESS tunnel is NOT a one-hop tunnel and keeps its own implementation
// (egress.go): it load-balances over a target pool instead of dialing a single
// upstream address.
//
// WP2 adds the hot-reload seam here: SetUpstream swaps where NEW connections
// dial without touching the listener, which is exactly the §13.3.4 "Target
// Host / Port" row (old TCP connections continue, new ones take the new
// target). The DIRECT/RELAY distinction survives the swap because both simply
// dial one address; the mode only decided which address the config named.
package forwarder

import (
	"errors"
	"net"
	"strings"
	"time"
)

// SingleHopForwarder listens on the tunnel's ingress port and forwards every
// accepted connection to cfg.UpstreamAddr().
type SingleHopForwarder struct {
	pipeTracker
}

// NewSingleHop builds the forwarder for a DIRECT or RELAY tunnel. Anything
// else is an error: EGRESS must go through NewEgress, and an unknown mode has
// no listener semantics at all.
func NewSingleHop(cfg TunnelConfig) (*SingleHopForwarder, error) {
	if cfg.Mode != ModeDirect && cfg.Mode != ModeRelay {
		return nil, errModeNot(ModeDirect, cfg.Mode)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &SingleHopForwarder{pipeTracker{cfg: cfg, up: upstream{addr: cfg.UpstreamAddr()}}}, nil
}

// Start binds the listen port and begins forwarding. Returns ErrAlreadyStarted
// when the forwarder is already running.
//
// The upstream is read per accepted connection rather than captured once:
// a hot swap landing mid-flight therefore affects only the connections that
// arrive after it, and every connection always dials a complete address.
func (f *SingleHopForwarder) Start() error {
	return f.pipeTracker.start(func(net.Conn) (net.Conn, error) {
		return net.DialTimeout("tcp", f.up.get(), dialTimeout)
	})
}

// Stop releases the listen port and drains live connections.
func (f *SingleHopForwarder) Stop() error { return f.pipeTracker.stop() }

// Stats returns the total bytes forwarded in both directions.
func (f *SingleHopForwarder) Stats() int64 { return f.pipeTracker.stats() }

// LiveConns reports how many client connections are currently being relayed.
func (f *SingleHopForwarder) LiveConns() int { return f.pipeTracker.liveConns() }

// Running reports whether the listener is bound.
func (f *SingleHopForwarder) Running() bool { return f.pipeTracker.running() }

// SetUpstream hot-swaps where new connections dial. The listener is not
// touched, so this call cannot fail a bind and cannot drop a live connection.
//
// It refuses to act on a forwarder that was never started or was already
// stopped: installing an address on a dead listener would tell the caller a
// hot swap happened while the OS refuses every new connection.
// ErrForwarderNotRunning is the honest answer there.
func (f *SingleHopForwarder) SetUpstream(addr string) error {
	if strings.TrimSpace(addr) == "" {
		return errors.New("forwarder: empty upstream address")
	}
	if _, _, err := splitHostPort(addr); err != nil {
		return err
	}
	if !f.pipeTracker.up.swap(addr) {
		return ErrForwarderNotRunning
	}
	logUpstreamSwap(f.cfg.ID, addr)
	return nil
}

// Drain waits — bounded — for the in-flight connections to finish while the
// listener stays bound. The port is released by the manager (Remove / the
// replacement path), not here, so a drained tunnel keeps its reservation
// until the rollout says otherwise.
func (f *SingleHopForwarder) Drain(d time.Duration) error {
	f.pipeTracker.drainFor(d)
	return nil
}
