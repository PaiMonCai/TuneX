package forwarder

import "net"

// RelayForwarder implements a RELAY tunnel on the ingress node: it listens on
// IngressPort and forwards to the egress node at NextHop
// ("<egress IP>:<egressPort>"). The egress node runs an EgressForwarder on the
// matching port; this forwarder holds no target knowledge.
type RelayForwarder struct {
	pipeTracker
}

// NewRelay builds a RELAY forwarder (cfg.Mode must be ModeRelay).
func NewRelay(cfg TunnelConfig) (*RelayForwarder, error) {
	if cfg.Mode != ModeRelay {
		return nil, errModeNot(ModeRelay, cfg.Mode)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &RelayForwarder{pipeTracker{cfg: cfg}}, nil
}

// Start binds the ingress port and begins forwarding to NextHop. Returns
// ErrAlreadyStarted when the forwarder is already running.
func (f *RelayForwarder) Start() error {
	addr := f.cfg.UpstreamAddr()
	return f.pipeTracker.start(func(net.Conn) (net.Conn, error) {
		return net.DialTimeout("tcp", addr, dialTimeout)
	})
}

// Stop releases the ingress port and drains live connections.
func (f *RelayForwarder) Stop() error { return f.pipeTracker.stop() }

// Stats returns the total bytes forwarded in both directions.
func (f *RelayForwarder) Stats() int64 { return f.pipeTracker.stats() }

// LiveConns reports how many client connections are currently being relayed.
func (f *RelayForwarder) LiveConns() int { return f.pipeTracker.liveConns() }

// Running reports whether the ingress listener is bound.
func (f *RelayForwarder) Running() bool { return f.pipeTracker.running() }
