package forwarder

import "net"

// DirectForwarder implements a DIRECT tunnel: it listens on IngressPort and
// forwards every accepted connection to RemoteHost:RemotePort.
type DirectForwarder struct {
	pipeTracker
}

// NewDirect builds a DIRECT forwarder (cfg.Mode must be ModeDirect).
func NewDirect(cfg TunnelConfig) (*DirectForwarder, error) {
	if cfg.Mode != ModeDirect {
		return nil, errModeNot(ModeDirect, cfg.Mode)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &DirectForwarder{pipeTracker{cfg: cfg}}, nil
}

// Start binds the ingress port and begins forwarding. Returns
// ErrAlreadyStarted when the forwarder is already running.
func (f *DirectForwarder) Start() error {
	addr := f.cfg.UpstreamAddr()
	return f.pipeTracker.start(func(net.Conn) (net.Conn, error) {
		return net.DialTimeout("tcp", addr, dialTimeout)
	})
}

// Stop releases the ingress port and drains live connections.
func (f *DirectForwarder) Stop() error { return f.pipeTracker.stop() }

// Stats returns the total bytes forwarded in both directions.
func (f *DirectForwarder) Stats() int64 { return f.pipeTracker.stats() }

// LiveConns reports how many client connections are currently being relayed.
func (f *DirectForwarder) LiveConns() int { return f.pipeTracker.liveConns() }

// Running reports whether the ingress listener is bound.
func (f *DirectForwarder) Running() bool { return f.pipeTracker.running() }
