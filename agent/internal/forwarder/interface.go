// Package forwarder holds the v3 data plane: the Forwarder contract that every
// tunnel mode implements plus the TCP implementations for DIRECT, RELAY and
// EGRESS tunnels.
//
// The interface and the TunnelConfig shape are the WP4 freeze (see
// docs/tunex-devmap-v3.md §7.1): later protocols (UDP / WS / TLS / QUIC) are
// expected to satisfy the same contract without changing it. Like the rest of
// the agent module this package is standard-library only, so `go build ./...`
// keeps working fully offline.
//
// Nothing here talks to the control plane. A Forwarder is built from a
// TunnelConfig and is owned by manager.TunnelManager, the only place that knows
// about revisions, node roles and the shared port guard. DIRECT and RELAY share
// one implementation (singhop.go); EGRESS has its own because it load-balances
// over a pool. Since WP15 there is exactly one data plane per tunnel mode and no
// second "legacy" implementation to fall back to.
package forwarder

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/tunex/agent/internal/logx"
)

// TunnelMode is the role a tunnel plays on this node (the tunnelMode column).
type TunnelMode string

const (
	// ModeDirect listens on IngressPort and forwards to RemoteHost:RemotePort.
	ModeDirect TunnelMode = "DIRECT"
	// ModeRelay listens on IngressPort and forwards to the egress node at
	// NextHop (egress node IP : egressPort).
	ModeRelay TunnelMode = "RELAY"
	// ModeEgress listens on EgressPort and load-balances over Targets.
	ModeEgress TunnelMode = "EGRESS"
)

// ParseTunnelMode normalises a wire value. The panel sends the upper-case enum
// name; a lower-case spelling is accepted so a hand-written config still works.
func ParseTunnelMode(s string) (TunnelMode, error) {
	switch TunnelMode(strings.ToUpper(strings.TrimSpace(s))) {
	case ModeDirect:
		return ModeDirect, nil
	case ModeRelay:
		return ModeRelay, nil
	case ModeEgress:
		return ModeEgress, nil
	default:
		return "", fmt.Errorf("forwarder: unknown tunnel mode %q", s)
	}
}

// LBStrategy selects how an EGRESS tunnel spreads connections over its pool.
// The values are the devmap §3 enum names; ParseLBStrategy also accepts the
// panel's short EgressPool spellings ("round" / "rand" / "weighted_round") so
// a payload from either side of the wire is understood.
type LBStrategy string

const (
	// LBRoundRobin walks the pool in order, one connection per target.
	LBRoundRobin LBStrategy = "ROUND_ROBIN"
	// LBRandom picks a uniformly random target per connection.
	LBRandom LBStrategy = "RANDOM"
	// LBWeightedRoundRobin spreads connections proportionally to weight.
	LBWeightedRoundRobin LBStrategy = "WEIGHTED_ROUND_ROBIN"
)

// ParseLBStrategy normalises a wire value. Both the long devmap names and the
// short EgressPool names ("round" / "rand" / "weighted_round") resolve to the
// same policy. Unknown strategies are an error: silently falling back would
// route live traffic under a policy the operator did not choose.
func ParseLBStrategy(s string) (LBStrategy, error) {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case string(LBRoundRobin), "ROUND":
		return LBRoundRobin, nil
	case string(LBRandom), "RAND":
		return LBRandom, nil
	case string(LBWeightedRoundRobin), "WEIGHTED_ROUND", "WEIGHTED":
		return LBWeightedRoundRobin, nil
	default:
		return "", fmt.Errorf("forwarder: unknown lb strategy %q", s)
	}
}

// Target is one upstream of an egress pool (an EgressTarget row).
type Target struct {
	Host   string `json:"host"`
	Port   int    `json:"port"`
	Weight int    `json:"weight,omitempty"`
	Order  int    `json:"order,omitempty"`
	Remark string `json:"remark,omitempty"`
}

// Addr returns "host:port", or "" when the target is unusable.
func (t Target) Addr() string {
	if !t.usable() {
		return ""
	}
	return net.JoinHostPort(strings.TrimSpace(t.Host), strconv.Itoa(t.Port))
}

func (t Target) usable() bool { return strings.TrimSpace(t.Host) != "" && validPort(t.Port) }

// TunnelConfig describes one tunnel as the control plane wants it to run on
// this node. JSON tags are the panel contract (snake_case) so a decoded payload
// can be handed straight to a Forwarder.
//
// Revision is the WP6 monotonic revision of the resource. 0 means "this source
// does not track revisions" and always applies; the manager enforces the rest
// (newer applies, equal is a no-op, older is rejected as stale).
//
// ListenHost and Revision are additive fields on top of the frozen MVP shape:
// ListenHost lets the operator pin the ingress interface, Revision carries the
// WP6 revision the command layer needs. Neither changes the MVP semantics.
type TunnelConfig struct {
	ID          string     `json:"id"`
	Mode        TunnelMode `json:"mode"`
	IngressPort int        `json:"ingress_port"`
	EgressPort  int        `json:"egress_port"`
	RemoteHost  string     `json:"remote_host"`
	RemotePort  int        `json:"remote_port"`
	NextHop     string     `json:"next_hop"`
	Targets     []Target   `json:"targets"`
	LBStrategy  LBStrategy `json:"lb_strategy"`
	Protocol    string     `json:"protocol"`
	SpeedLimit  int64      `json:"speed_limit"`
	Revision    int64      `json:"revision"`
	ListenHost  string     `json:"listen_host,omitempty"`
}

// Clone returns a copy that shares no mutable state with c.
func (c TunnelConfig) Clone() TunnelConfig {
	out := c
	if len(c.Targets) > 0 {
		out.Targets = make([]Target, len(c.Targets))
		copy(out.Targets, c.Targets)
	}
	return out
}

// Validate normalises and checks a config. Normalisation is in place (upper
// case enums, empty protocol -> tcp) so the manager stores the canonical form.
func (c *TunnelConfig) Validate() error {
	if strings.TrimSpace(c.ID) == "" {
		return errors.New("forwarder: tunnel id is required")
	}
	mode, err := ParseTunnelMode(string(c.Mode))
	if err != nil {
		return err
	}
	c.Mode = mode

	switch strings.ToUpper(strings.TrimSpace(c.Protocol)) {
	case "", "TCP":
		c.Protocol = "tcp"
	default:
		// UDP / WS / TLS / QUIC land in later work packages; rejecting them
		// loudly beats silently running them over TCP.
		return fmt.Errorf("forwarder: protocol %q is not implemented in WP4 (tcp only)", c.Protocol)
	}

	if strategy := strings.TrimSpace(string(c.LBStrategy)); strategy != "" {
		parsed, err := ParseLBStrategy(strategy)
		if err != nil {
			return err
		}
		c.LBStrategy = parsed
	}

	switch mode {
	case ModeDirect:
		if !validPort(c.IngressPort) {
			return fmt.Errorf("forwarder: DIRECT tunnel %s needs a valid ingress_port (got %d)", c.ID, c.IngressPort)
		}
		if strings.TrimSpace(c.RemoteHost) == "" || !validPort(c.RemotePort) {
			return fmt.Errorf("forwarder: DIRECT tunnel %s needs remote_host/remote_port (got %q:%d)", c.ID, c.RemoteHost, c.RemotePort)
		}
	case ModeRelay:
		if !validPort(c.IngressPort) {
			return fmt.Errorf("forwarder: RELAY tunnel %s needs a valid ingress_port (got %d)", c.ID, c.IngressPort)
		}
		if _, _, err := splitHostPort(c.NextHop); err != nil {
			return fmt.Errorf("forwarder: RELAY tunnel %s: %w", c.ID, err)
		}
	case ModeEgress:
		if !validPort(c.EgressPort) {
			return fmt.Errorf("forwarder: EGRESS tunnel %s needs a valid egress_port (got %d)", c.ID, c.EgressPort)
		}
		// An empty pool is allowed: the forwarder closes connections until the
		// first PATCH /node/targets fills it in.
		for i, t := range c.Targets {
			if !t.usable() {
				return fmt.Errorf("forwarder: EGRESS tunnel %s target %d is invalid (%q:%d)", c.ID, i, t.Host, t.Port)
			}
		}
	}
	return nil
}

// ListenPort is the port the tunnel binds: IngressPort for DIRECT/RELAY,
// EgressPort for EGRESS.
func (c TunnelConfig) ListenPort() int {
	if c.Mode == ModeEgress {
		return c.EgressPort
	}
	return c.IngressPort
}

// ListenAddr is the "host:port" this tunnel binds.
func (c TunnelConfig) ListenAddr() string {
	return net.JoinHostPort(strings.TrimSpace(c.ListenHost), strconv.Itoa(c.ListenPort()))
}

// UpstreamAddr is the address a DIRECT/RELAY connection is dialed to.
func (c TunnelConfig) UpstreamAddr() string {
	if c.Mode == ModeRelay {
		return strings.TrimSpace(c.NextHop)
	}
	return net.JoinHostPort(strings.TrimSpace(c.RemoteHost), strconv.Itoa(c.RemotePort))
}

// Forwarder is the WP4-frozen data-plane contract.
type Forwarder interface {
	// Start binds the tunnel's listen port and starts forwarding. Starting an
	// already running forwarder returns ErrAlreadyStarted.
	Start() error
	// Stop releases the port and tears down live connections. It is safe to
	// call before Start and more than once (both are no-ops returning nil).
	Stop() error
	// Stats returns the bytes forwarded in both directions, read atomically.
	Stats() int64
	// Running reports whether the listener is currently bound. A forwarder
	// that was never started, or was stopped, reports false.
	Running() bool
	// SetUpstream hot-swaps the upstream of a RUNNING forwarder: live
	// connections keep the upstream they were dialed with, every following
	// connection dials addr. It never touches the listener, so it cannot
	// fail a bind and cannot drop a live connection — this is what makes
	// the §13.3.4 "Target Host / Port" row a no-impact change.
	//
	// A forwarder whose upstream is not a single swappable address (EGRESS
	// load-balances over a pool owned by manager.EgressManager) returns
	// ErrUpstreamNotSwappable: retargeting it is PATCH /node/targets'
	// pool swap, not this call.
	SetUpstream(addr string) error
	// Drain stops accepting new connections and waits — bounded by timeout,
	// and never longer than the package's hard drain ceiling — for the
	// in-flight connections to finish. Unlike Stop it is a two-step API on
	// the manager side: the caller decides when the port is released
	// (Remove) so a drained-but-still-registered tunnel keeps its port
	// reserved while its connections fade out.
	//
	// Drain is irreversible and one-way. The accept loop ends and the
	// listener stays bound: the port is NOT freed, Running() keeps
	// reporting true, and the drained forwarder refuses swaps (an address
	// no new connection can reach would be a lie). Resuming means a new
	// forwarder; finishing means Stop, which is safe at any point after.
	//
	// An idle Drain returns immediately — d <= 0 means "do not wait", never
	// the ceiling. It is safe to call before Start and more than once.
	Drain(timeout time.Duration) error
}

// ErrUpstreamNotSwappable is returned by SetUpstream on a forwarder whose
// upstream is not one swappable address (an EGRESS pool).
var ErrUpstreamNotSwappable = errors.New("forwarder: upstream is not swappable")

// TargetSelector picks the upstream for the next egress connection. The egress
// forwarder depends only on this narrow interface so the hot-updatable
// manager.LoadBalancer can be injected without the forwarder package knowing
// about the manager (that would be an import cycle).
type TargetSelector interface {
	Select() Target
}

// ErrAlreadyStarted is returned when Start is called on a listening forwarder.
var ErrAlreadyStarted = errors.New("forwarder: listener already started")

// ErrForwarderNotRunning is returned by SetUpstream when the forwarder has no
// bound listener (never started, or already stopped). Swapping the upstream of
// a dead forwarder would be a silent no-op that the caller reads as success.
var ErrForwarderNotRunning = errors.New("forwarder: forwarder is not running")

// logUpstreamSwap records a hot swap on the agent log. It is a function
// variable so tests can observe swaps without wiring the logger: the manager
// and the forwarder tests both assert on it (nil-safe).
var logUpstreamSwap = func(tunnelID, addr string) {
	logx.Info("tunnel upstream hot-swapped", "id", tunnelID, "upstream", addr)
}

// validPort reports whether p is a bindable TCP port.
func validPort(p int) bool { return p > 0 && p <= 65535 }

// splitHostPort parses a strict "host:port" address.
func splitHostPort(addr string) (string, int, error) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "", 0, errors.New("forwarder: empty address")
	}
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return "", 0, fmt.Errorf("forwarder: invalid address %q (want host:port)", addr)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || !validPort(port) {
		return "", 0, fmt.Errorf("forwarder: invalid port in %q", addr)
	}
	return host, port, nil
}
