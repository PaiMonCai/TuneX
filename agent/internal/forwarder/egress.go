package forwarder

import (
	"errors"
	"net"
)

// errNoTarget is returned by the egress pick function when the target pool is
// empty; the connection is dropped instead of dangling.
var errNoTarget = errors.New("forwarder: egress target pool is empty")

// EgressForwarder implements an EGRESS tunnel on the egress node: it listens on
// EgressPort and, for every connection, asks a target selector (an
// lb.LoadBalancer) which upstream to dial.
//
// The selector is the hot-update seam. Replacing targets through
// manager.EgressManager changes what the balancer returns without touching this
// listener, so existing connections are never interrupted (devmap §5.3).
type EgressForwarder struct {
	pipeTracker
	sel TargetSelector
}

// NewEgress builds an EGRESS forwarder (cfg.Mode must be ModeEgress). sel may
// not be nil; pass a lb.LoadBalancer built with the tunnel's initial pool.
func NewEgress(cfg TunnelConfig, sel TargetSelector) (*EgressForwarder, error) {
	if cfg.Mode != ModeEgress {
		return nil, errModeNot(ModeEgress, cfg.Mode)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if sel == nil {
		return nil, errors.New("forwarder: EGRESS tunnel requires a target selector")
	}
	return &EgressForwarder{pipeTracker: pipeTracker{cfg: cfg}, sel: sel}, nil
}

// Start binds the egress port and begins load-balanced forwarding. Returns
// ErrAlreadyStarted when the forwarder is already running.
func (f *EgressForwarder) Start() error {
	sel := f.sel
	return f.pipeTracker.start(func(net.Conn) (net.Conn, error) {
		t := sel.Select()
		addr := t.Addr()
		if addr == "" {
			// Pool is empty (not restored yet): drop instead of hanging.
			return nil, errNoTarget
		}
		return net.DialTimeout("tcp", addr, dialTimeout)
	})
}

// Stop releases the egress port and drains live connections.
func (f *EgressForwarder) Stop() error { return f.pipeTracker.stop() }

// Stats returns the total bytes forwarded in both directions.
func (f *EgressForwarder) Stats() int64 { return f.pipeTracker.stats() }

// LiveConns reports how many client connections are currently being relayed.
func (f *EgressForwarder) LiveConns() int { return f.pipeTracker.liveConns() }

// Running reports whether the egress listener is bound.
func (f *EgressForwarder) Running() bool { return f.pipeTracker.running() }
