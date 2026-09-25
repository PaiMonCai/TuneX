package forwarder

import (
	"errors"
	"net"
	"sort"
	"strconv"
	"sync"
	"time"
)

// errNoTarget is returned by the egress pick function when the target pool is
// empty; the connection is dropped instead of dangling.
var errNoTarget = errors.New("forwarder: egress target pool is empty")

// TargetStats is one target's observable health (WP5 DoD "target fail 可观测").
// It answers the two questions an operator actually asks: has this target ever
// worked (DialOK > 0), and is it broken *now* (DialFailed climbing with a
// recent LastErrAt). Bytes shows whether a working target also gets traffic,
// which is what distinguishes "no traffic because it is dead" from "no traffic
// because the balancer never picks it".
type TargetStats struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	DialOK     int64  `json:"dial_ok"`
	DialFailed int64  `json:"dial_failed"`
	Bytes      int64  `json:"bytes"`
	LastErrAt  int64  `json:"last_error_at,omitempty"` // unix seconds
	LastErr    string `json:"last_error,omitempty"`
	LastDialMs int64  `json:"last_dial_ms,omitempty"`
}

// Addr renders the target as "host:port".
func (s TargetStats) Addr() string { return net.JoinHostPort(s.Host, strconv.Itoa(s.Port)) }

// Healthy reports whether the target looks usable: the most recent dial must
// not have failed. A never-dialed target is healthy (nothing has shown it
// broken), and a target that recovered clears its last error.
func (s TargetStats) Healthy() bool { return s.LastErr == "" }

// TargetObserver is notified when a target fails to dial. main wires it to the
// agent logger; tests supply a recorder. A nil observer is fine — failures are
// always counted in the ledger, just not broadcast.
type TargetObserver func(stats TargetStats)

// targetHealth is the failure ledger an egress forwarder keeps per target.
// The zero value is unusable; use newTargetHealth. Every method is nil-safe, so
// a forwarder without a ledger can call them anyway.
type targetHealth struct {
	mu    sync.Mutex
	stats map[string]*TargetStats
	obs   TargetObserver
}

func newTargetHealth(obs TargetObserver) *targetHealth {
	return &targetHealth{stats: make(map[string]*TargetStats), obs: obs}
}

// snapshot copies the ledger ordered by address, so /health output is stable
// across calls and diffs are meaningful.
func (h *targetHealth) snapshot() []TargetStats {
	if h == nil {
		return nil
	}
	h.mu.Lock()
	out := make([]TargetStats, 0, len(h.stats))
	for _, s := range h.stats {
		out = append(out, *s)
	}
	h.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Addr() < out[j].Addr() })
	return out
}

// recordDial updates the ledger for one dial attempt: err is the dial error
// (nil on success), d the time the dial took.
//
// The observer runs outside the lock and is panic-guarded: an observer that
// blocks or blows up must not stall the accept loop or take the process down.
func (h *targetHealth) recordDial(t Target, d time.Duration, err error) {
	if h == nil {
		return
	}
	key := t.Addr()
	if key == "" {
		return
	}
	h.mu.Lock()
	s := h.stats[key]
	if s == nil {
		s = &TargetStats{Host: t.Host, Port: t.Port}
		h.stats[key] = s
	}
	s.LastDialMs = d.Milliseconds()
	if err == nil {
		s.DialOK++
		// The target answered, so the remembered failure is stale.
		s.LastErr = ""
		s.LastErrAt = 0
	} else {
		s.DialFailed++
		s.LastErrAt = time.Now().Unix()
		s.LastErr = err.Error()
	}
	out := *s
	obs := h.obs
	h.mu.Unlock()

	if obs != nil && err != nil {
		defer func() { _ = recover() }()
		obs(out)
	}
}

// addBytes attributes relayed bytes to the target that carried them.
func (h *targetHealth) addBytes(t Target, n int64) {
	if h == nil || n <= 0 {
		return
	}
	key := t.Addr()
	if key == "" {
		return
	}
	h.mu.Lock()
	if s := h.stats[key]; s != nil {
		s.Bytes += n
	}
	h.mu.Unlock()
}

// counterCarrier is implemented by an upstream connection that owns its own
// byte counter. The egress forwarder wraps its upstreams this way so each
// target is billed exactly the bytes it carried; pipeTracker prefers the
// per-connection counter when one is offered and folds it into the shared
// total, so the shared total keeps its meaning (all bytes, every connection)
// while attribution stays exact.
type counterCarrier interface{ ownCounter() *byteCounter }

// measuredConn wraps one relayed upstream and bills its bytes to a target.
//
// The wrapper must stay transparent to the relay's optional-interface
// type switches, not just to net.Conn's methods: the relay half-closes
// through a CloseWrite assertion (pipe.go closeWrite) and reads deadlines
// through SetDeadline. Embedding net.Conn satisfies the base interface but
// *hides* everything else the concrete type offered, so a wrapped TCP conn
// would silently lose its half-close — the exact proxy bug PipeConns is
// designed to avoid. Every optional method is therefore forwarded explicitly.
type measuredConn struct {
	net.Conn
	health    *targetHealth
	target    Target
	counted   byteCounter
	closeOnce sync.Once
}

// CloseWrite forwards the half-close to the real conn so the relay's
// EOF propagation still works through the wrapper.
func (c *measuredConn) CloseWrite() error {
	type halfCloser interface{ CloseWrite() error }
	if hc, ok := c.Conn.(halfCloser); ok {
		return hc.CloseWrite()
	}
	// A conn without CloseWrite (net.Pipe, TLS) has no half-close to do;
	// closing the write side is not expressible, so the relay's fallback
	// is for the caller to close the whole conn. Report success: the
	// direction is ending either way.
	return nil
}

// SetDeadline / SetReadDeadline / SetWriteDeadline forward to the real conn so
// a caller that bounds the relayed socket still can.
func (c *measuredConn) SetDeadline(t time.Time) error      { return c.Conn.SetDeadline(t) }
func (c *measuredConn) SetReadDeadline(t time.Time) error  { return c.Conn.SetReadDeadline(t) }
func (c *measuredConn) SetWriteDeadline(t time.Time) error { return c.Conn.SetWriteDeadline(t) }

func (c *measuredConn) ownCounter() *byteCounter { return &c.counted }

// Close bills the connection's bytes to its target, then closes for real.
// handleConn defers this call after PipeConns has returned — the moment the
// relayed byte total of this connection is final — so the sync.Once guard is
// belt-and-braces against a second close from anywhere else.
func (c *measuredConn) Close() error {
	c.closeOnce.Do(func() {
		c.health.addBytes(c.target, c.counted.load())
	})
	return c.Conn.Close()
}

// EgressForwarder implements an EGRESS tunnel on the egress node: it listens on
// EgressPort and, for every connection, asks a target selector (a
// manager.LoadBalancer) which upstream to dial.
//
// The selector is the hot-update seam. Replacing targets through
// manager.EgressManager changes what the balancer returns without touching this
// listener, so existing connections are never interrupted (devmap §5.3).
type EgressForwarder struct {
	pipeTracker
	sel    TargetSelector
	health *targetHealth
}

// NewEgress builds an EGRESS forwarder (cfg.Mode must be ModeEgress). sel may
// not be nil; pass a lb.LoadBalancer built with the tunnel's initial pool.
func NewEgress(cfg TunnelConfig, sel TargetSelector) (*EgressForwarder, error) {
	return NewEgressWithHealth(cfg, sel, nil)
}

// NewEgressWithHealth is NewEgress plus an observer notified whenever a target
// fails to dial (the WP5 "target fail 可观测" requirement). obs may be nil.
//
// The ledger is kept either way, so TargetStats() is usable on every egress
// forwarder: a silent target is visible even when nobody wired a logger.
func NewEgressWithHealth(cfg TunnelConfig, sel TargetSelector, obs TargetObserver) (*EgressForwarder, error) {
	if cfg.Mode != ModeEgress {
		return nil, errModeNot(ModeEgress, cfg.Mode)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if sel == nil {
		return nil, errors.New("forwarder: EGRESS tunnel requires a target selector")
	}
	return &EgressForwarder{
		pipeTracker: pipeTracker{cfg: cfg},
		sel:         sel,
		health:      newTargetHealth(obs),
	}, nil
}

// Start binds the egress port and begins load-balanced forwarding. Returns
// ErrAlreadyStarted when the forwarder is already running.
func (f *EgressForwarder) Start() error {
	sel, health := f.sel, f.health
	return f.pipeTracker.start(func(net.Conn) (net.Conn, error) {
		t := sel.Select()
		addr := t.Addr()
		if addr == "" {
			// Pool is empty (not restored yet): drop instead of hanging.
			return nil, errNoTarget
		}
		start := time.Now()
		raw, err := net.DialTimeout("tcp", addr, dialTimeout)
		health.recordDial(t, time.Since(start), err)
		if err != nil {
			return nil, err
		}
		// Wrap the upstream so this connection's bytes are billed to the
		// target they actually travelled to, even while other connections
		// of the same forwarder are mid-flight on other targets.
		return &measuredConn{Conn: raw, health: health, target: t}, nil
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

// TargetStats returns the per-target failure/throughput ledger, ordered by
// address. It is the machine-readable form of "target fail 可观测" and is what
// /health and a state_request reply expose.
func (f *EgressForwarder) TargetStats() []TargetStats {
	return f.health.snapshot()
}
