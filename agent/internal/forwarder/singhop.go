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
package forwarder

import "net"

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
	return &SingleHopForwarder{pipeTracker{cfg: cfg}}, nil
}

// Start binds the listen port and begins forwarding. Returns ErrAlreadyStarted
// when the forwarder is already running.
func (f *SingleHopForwarder) Start() error {
	addr := f.cfg.UpstreamAddr()
	return f.pipeTracker.start(func(net.Conn) (net.Conn, error) {
		return net.DialTimeout("tcp", addr, dialTimeout)
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
