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
	"context"
	"errors"
	"fmt"
	"net"
	"sort"
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

// ForwardProtocol is the canonical product/data-plane protocol dimension.
//
// It is deliberately separate from TunnelMode: DIRECT/RELAY/EGRESS describes
// topology/role, while protocol describes how bytes/packets are transported.
// New protocol constants must not be added merely because a legacy Panel enum
// contains the name; they are opened only with their V5 protocol Gate.
type ForwardProtocol string

const (
	ProtocolTCP ForwardProtocol = "tcp"
	// ProtocolTLS is the same stream lifecycle with a TLS-terminated
	// client-facing listener (V5-WP5-A1). See the semantics contract in
	// DEVELOPMENT.md §6.1: TLS stops at the INGRESS listener; the inter-node hop
	// stays plain TCP.
	ProtocolTLS ForwardProtocol = "tls"
	// ProtocolWS is the stream lifecycle with a WebSocket front: the client's
	// frame payloads are unwrapped into the byte stream forwarded to the target
	// (V5-WP5-A2). Framing and transport security are separate dimensions, which
	// is why there is no `wss` protocol value.
	ProtocolWS ForwardProtocol = "ws"
	// ProtocolUDP is the client-facing datagram front (V5-WP5-B1). The client
	// speaks connectionless UDP datagrams, so this protocol is carried by the
	// datagram transport below, never by the stream one: there is no accepted
	// connection to map to an upstream, no connection count and no drain of
	// connections. Its semantics are frozen in
	// docs/v5-1b-datagram-contract-draft.md; V5.1b opens UDP **DIRECT only**, so
	// the RELAY/EGRESS shapes are refused in Validate instead of being
	// half-implemented.
	ProtocolUDP ForwardProtocol = "udp"
)

// ForwardTransport is the data-plane lifecycle contract that carries a protocol.
// It is derived from the protocol, never a second user-visible field.
type ForwardTransport string

const (
	// TransportStream is a connection-oriented runtime: one accepted connection
	// maps to one upstream connection, and the runtime can drain in-flight work
	// (see Forwarder.Drain).
	TransportStream ForwardTransport = "stream"
	// TransportDatagram is a packet-oriented runtime: the ingress listener keeps
	// ONE socket, and each client address gets an ingress **mapping** (§2.1 of
	// the datagram contract) instead of a connection. The consequences are not
	// stylistic — they are why the datagram runtime has its own contract below:
	//
	//   - work is counted in mappings, so "live connections" is not a question
	//     this transport can answer (§4.4);
	//   - the return path shares the ingress socket with the forward path, so
	//     closing the socket ends every mapping's replies at once (§4.3);
	//   - "the upstream address" is not a per-client fact, so retargeting moves
	//     only the mappings created afterwards (§3.4).
	TransportDatagram ForwardTransport = "datagram"
)

// protocolRuntime binds a protocol to the transport contract that actually
// carries it in this binary.
//
// This table — not a hand-maintained list elsewhere — is the single source of
// truth behind BOTH ParseForwardProtocol and the manifest the agent advertises
// (internal/control.Manifest). One table means there is no second list to drift
// out of sync with what the parser accepts.
type protocolRuntime struct {
	Protocol  ForwardProtocol
	Transport ForwardTransport
}

var protocolRuntimes = []protocolRuntime{
	{Protocol: ProtocolTCP, Transport: TransportStream},
	{Protocol: ProtocolTLS, Transport: TransportStream},
	{Protocol: ProtocolWS, Transport: TransportStream},
	{Protocol: ProtocolUDP, Transport: TransportDatagram},
}

// ParseForwardProtocol normalises a wire value and fails closed for protocols
// whose V5 runtime Gate has not been opened yet.
func ParseForwardProtocol(s string) (ForwardProtocol, error) {
	name := strings.ToLower(strings.TrimSpace(s))
	if name == "" {
		// An omitted protocol is the V4 client shape and means TCP.
		return ProtocolTCP, nil
	}
	for _, rt := range protocolRuntimes {
		if string(rt.Protocol) == name {
			return rt.Protocol, nil
		}
	}
	return "", fmt.Errorf("forwarder: protocol %q is not supported by the current runtime contract", s)
}

// TransportForProtocol returns the transport that carries p in this binary, and
// whether p is implemented at all.
func TransportForProtocol(p ForwardProtocol) (ForwardTransport, bool) {
	for _, rt := range protocolRuntimes {
		if rt.Protocol == p {
			return rt.Transport, true
		}
	}
	return "", false
}

// ImplementedProtocols lists the product protocols this binary can actually run,
// sorted. It is derived from the same table ParseForwardProtocol consults, so
// the agent cannot advertise a protocol its own parser would reject.
func ImplementedProtocols() []string {
	out := make([]string, 0, len(protocolRuntimes))
	for _, rt := range protocolRuntimes {
		out = append(out, string(rt.Protocol))
	}
	sort.Strings(out)
	return out
}

// ImplementedTransports lists the distinct transport contracts reachable from
// the implemented protocols, sorted.
func ImplementedTransports() []string {
	seen := make(map[string]bool, len(protocolRuntimes))
	for _, rt := range protocolRuntimes {
		seen[string(rt.Transport)] = true
	}
	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
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

// Key returns the identity a target and its health entry are joined on.
func (t Target) Key() string { return TargetKey(t.Host, t.Port) }

// TargetKey is the ONE identity two facts about the same upstream are joined
// on (V5.2-WP7's parallel arrays, §7.3).
//
// It is deliberately not Addr(): the panel's target identity normalises a host
// before publishing it (`targetKeyOf` in node-state.ts trims, lower-cases and
// strips the square brackets of an IPv6 literal), and Addr() must NOT do that —
// it is the string handed to the dialer and to the WP5 ledger, where changing
// the spelling of a target would break both. A health array whose host came
// back lower-cased must still meet its target, or the breaker would silently
// never open for any target the panel re-spelled, which is exactly the kind of
// quiet no-op that looks like "health had nothing to say".
//
// Normalisation is the minimum that makes the two spellings the same name:
// trim, drop one layer of brackets, lower-case, drop one trailing root dot. It
// cannot invent a match — every step maps a name to itself under DNS rules.
func TargetKey(host string, port int) string {
	if !validPort(port) {
		return ""
	}
	h := strings.TrimSpace(host)
	if len(h) > 1 && strings.HasPrefix(h, "[") && strings.HasSuffix(h, "]") {
		h = h[1 : len(h)-1]
	}
	h = strings.TrimSuffix(strings.ToLower(h), ".")
	if h == "" {
		return ""
	}
	return net.JoinHostPort(h, strconv.Itoa(port))
}

// TargetHealthState is one of the five conclusions the panel's WP6 synthesis can
// report for a target (DEVELOPMENT.md §7.3 "线形状（加法）").
//
// The agent does not decide what "healthy" means. These five values arrive on
// the wire, and this side only folds them onto the frozen vocabulary — the
// health MODEL stays on the panel (§7.3: "状态模型只有一个"). The names are
// spelled exactly as the panel spells them, so a value that survives a round
// trip is recognisably the panel's word and not an agent invention.
type TargetHealthState string

const (
	// TargetHealthUnknown means "no evidence": never observed, the observation
	// is stale, or unreadable. It is not a synonym for healthy, and not proof
	// of failure either — WP7 ranks it after `degraded` and before `unhealthy`.
	TargetHealthUnknown TargetHealthState = "unknown"
	// TargetHealthHealthy is the panel's positive conclusion.
	TargetHealthHealthy TargetHealthState = "healthy"
	// TargetHealthDegraded means evidence of trouble below the "broken" line.
	TargetHealthDegraded TargetHealthState = "degraded"
	// TargetHealthUnhealthy is the one state that opens the circuit breaker.
	TargetHealthUnhealthy TargetHealthState = "unhealthy"
	// TargetHealthRecovering means "just left unhealthy, not proven stable".
	TargetHealthRecovering TargetHealthState = "recovering"
)

// ParseTargetHealthState folds a wire value onto the five frozen states.
//
// Anything unrecognised — an older or newer panel's spelling, a typo, an empty
// string — becomes TargetHealthUnknown. Refusing it would turn a health label
// the agent cannot read into a routing decision, which is the one thing the
// agent must never do; treating it as unknown keeps it out of the fast path
// without declaring the target broken.
func ParseTargetHealthState(s string) TargetHealthState {
	switch TargetHealthState(strings.ToLower(strings.TrimSpace(s))) {
	case TargetHealthHealthy:
		return TargetHealthHealthy
	case TargetHealthDegraded:
		return TargetHealthDegraded
	case TargetHealthUnhealthy:
		return TargetHealthUnhealthy
	case TargetHealthRecovering:
		return TargetHealthRecovering
	default:
		return TargetHealthUnknown
	}
}

// TargetHealth is one entry of the `target_health` array that travels PARALLEL
// to `targets` (§7.3 "线形状（加法）"): same identities, not the same facts.
//
// The shape is additive on purpose. Desired and health are two different kinds
// of fact, and folding a health field into `Target` would make it impossible to
// say which fields a later change belongs to; two parallel arrays keep "desired
// is byte-for-byte unchanged" structurally visible, and an older agent that
// ignores the unknown key still works.
type TargetHealth struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	// State is the panel's conclusion, kept as the raw string on purpose: it
	// must pass through ParseTargetHealthState before anything acts on it.
	State string `json:"state"`
	// LatencyMs / AgeMs / Evidence are the supporting facts. They are carried
	// (so a diag view can show why the panel concluded what it did) but the
	// agent does not re-derive a state from them — that would be the second
	// health model §7.3 forbids.
	LatencyMs int64 `json:"latency_ms,omitempty"`
	AgeMs     int64 `json:"age_ms,omitempty"`
	Evidence  bool  `json:"evidence,omitempty"`
}

// Key returns the identity this entry is joined to its target on. It uses the
// same normalisation as the target side (TargetKey), never Target.Addr(): the
// panel publishes health under its own normalised identity, and a join that
// depended on which side spelled the host first would drop facts silently.
func (h TargetHealth) Key() string {
	return TargetKey(h.Host, h.Port)
}

// StateValue is the parsed form of State.
func (h TargetHealth) StateValue() TargetHealthState {
	return ParseTargetHealthState(h.State)
}

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
	// HopPeer is the paired ingress node's ADDRESS for a datagram EGRESS
	// (V5.1b WP5-B2, contract §9.1).
	//
	// It exists because the hop is UDP: TCP gets "the peer really is the peer"
	// from the handshake, UDP does not, so the exit has to be told who may feed
	// it. An empty value on a datagram egress is REFUSED at construction — never
	// treated as "accept anyone", which would make the exit a relay to its
	// configured targets for whoever finds the port.
	//
	// It is an address (IP), not IP:port, on purpose: the ingress's source port is
	// ephemeral and changes when its runtime restarts, so pinning the port would
	// turn a normal restart into a permanent outage. The security property we need
	// is a property of the address.
	HopPeer string `json:"hop_peer,omitempty"`
	// omitempty keeps an empty pool from being emitted as `null`: the panel
	// treats absent as "no targets of its own", which is what a RELAY ingress
	// tunnel actually has.
	Targets    []Target        `json:"targets,omitempty"`
	LBStrategy LBStrategy      `json:"lb_strategy"`
	Protocol   ForwardProtocol `json:"protocol"`
	SpeedLimit int64           `json:"speed_limit"`
	Revision   int64           `json:"revision"`
	ListenHost string          `json:"listen_host,omitempty"`
	// TargetHealth is the panel's per-target health, parallel to Targets
	// (V5.2-WP7, §7.3): the same identities in the same order, carrying a
	// different kind of fact.
	//
	// Absent (an older panel, or a health read that failed) means "no health
	// signal": the agent must then behave exactly as it did before WP7 — no
	// breaker, no reordering. That is why this field is additive and optional
	// rather than something the agent fills in from local observation.
	//
	// It is deliberately NOT validated: health is an optimisation, not a gate.
	// A config that is otherwise applicable must never be refused because a
	// health label was unreadable.
	TargetHealth []TargetHealth `json:"target_health,omitempty"`
	// TLSCertPath / TLSKeyPath are the node-local file paths of the certificate
	// and its private key, used when Protocol is tls on a client-facing listener
	// (DIRECT / RELAY). The control plane carries PATHS, never key material
	// (§6.1 "Where are certificates owned?").
	TLSCertPath string `json:"tls_cert_path,omitempty"`
	TLSKeyPath  string `json:"tls_key_path,omitempty"`

	// ── V5.3 WP9 ownership facts (DEVELOPMENT.md §8) ──
	//
	// These two are the panel's statement that THIS node is the recorded owner
	// of the tunnel, and for how long: OwnershipEpoch is the generation it is
	// authorised to serve, LeaseExpiresAt is when that authorisation runs out
	// (RFC 3339, the panel's clock).
	//
	// They are OPTIONAL and their ABSENCE is meaningful: a config without them
	// is an older panel that sent no ownership information at all, and the node
	// must then behave exactly as it did before WP9 — no fencing, no lease
	// clock. Treating absent as epoch 0 would refuse every activation on such a
	// panel, which is why ownership.EpochFromConfig keys on presence-by-value:
	// epochs are >= 1 by contract (placement-lease.ts starts at 1 and 0 means
	// "never owned"), so zero can never be a legitimate generation.
	//
	// Neither field changes what the tunnel IS: the hostname/ports/targets stay
	// the only desired facts, and an epoch never rewrites one.
	OwnershipEpoch int64  `json:"ownership_epoch,omitempty"`
	LeaseExpiresAt string `json:"lease_expires_at,omitempty"`
}

// Clone returns a copy that shares no mutable state with c.
func (c TunnelConfig) Clone() TunnelConfig {
	out := c
	if len(c.Targets) > 0 {
		out.Targets = make([]Target, len(c.Targets))
		copy(out.Targets, c.Targets)
	}
	if len(c.TargetHealth) > 0 {
		out.TargetHealth = make([]TargetHealth, len(c.TargetHealth))
		copy(out.TargetHealth, c.TargetHealth)
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

	protocol, err := ParseForwardProtocol(string(c.Protocol))
	if err != nil {
		return err
	}
	c.Protocol = protocol

	// A TLS front is a client-facing listener. EGRESS listens for the ingress
	// node, not for a client, and the hop is plain TCP by contract — so asking
	// for TLS there is a configuration error, not something to quietly ignore.
	if protocol == ProtocolTLS && mode == ModeEgress {
		return errors.New("forwarder: tls terminates at the client-facing listener; an EGRESS tunnel cannot be tls")
	}
	if protocol == ProtocolTLS {
		if strings.TrimSpace(c.TLSCertPath) == "" || strings.TrimSpace(c.TLSKeyPath) == "" {
			return fmt.Errorf("forwarder: tls tunnel %s needs tls_cert_path and tls_key_path", c.ID)
		}
	}
	// WS is a client-facing front like TLS: an EGRESS listener faces the ingress
	// node, and that hop is plain TCP by contract.
	if protocol == ProtocolWS && mode == ModeEgress {
		return errors.New("forwarder: ws terminates at the client-facing listener; an EGRESS tunnel cannot be ws")
	}
	// UDP is a client-facing datagram front. V5.1b opens DIRECT (WP5-B1) and now
	// the EXIT half of RELAY (WP5-B2, contract §9.1):
	//
	//   - EGRESS: allowed. The datagram hop is UDP end to end, so this node
	//     listens on UDP and is fed hop packets by the paired ingress. The peer is
	//     not implied by a handshake (there is none) — `hop_peer` tells this exit
	//     who may feed it, and the datagram egress constructor REFUSES to build
	//     without it.
	//   - RELAY: still refused, but no longer because the shape is undecided —
	//     §9.1 froze it as "datagram end to end". It is refused here because the
	//     ingress half of that hop has no runtime in this build yet. Accepting the
	//     config would produce exactly the failure the old comment warned about:
	//     a config that validates, reaches the node and fails where nobody looks.
	//     The refusal disappears in the same commit that lands the ingress runtime.
	if protocol == ProtocolUDP && mode == ModeRelay {
		return fmt.Errorf(
			"forwarder: udp RELAY needs the datagram hop ingress runtime, which is not wired in this build (the exit half is; see docs/v5-1b-datagram-contract-draft.md §12)")
	}
	if protocol == ProtocolUDP && mode == ModeEgress && strings.TrimSpace(c.HopPeer) == "" {
		return fmt.Errorf(
			"forwarder: udp EGRESS tunnel %s needs hop_peer (the paired ingress address); refusing to accept hop packets from an unattested source", c.ID)
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

// StreamRuntime is the data-plane contract for **connection-oriented**
// (stream) transports: one accepted connection maps to one upstream
// connection, and the runtime can drain work that is already in flight.
//
// V5-WP2 made the name explicit. It was called `Forwarder` and documented as
// "the contract every tunnel mode implements", which quietly claimed that a
// future datagram runtime would have to implement `Drain(time.Duration)` and
// `SetUpstream(string)` too. Both are stream-only notions: there are no
// "in-flight connections" to drain in a datagram runtime, and "the upstream
// address" is a per-connection fact for TCP but not for UDP. Keeping one name
// for both would have forced the UDP work (V5.1b) into either empty methods or
// a second, silently-divergent interface.
//
// So: every method below is a property of the stream lifecycle, not of
// "a tunnel". A datagram runtime (V5.1b) will get its own contract; the
// manager keeps owning desired state, revision and ports for both.
type StreamRuntime interface {
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

// Forwarder is the V4-WP4 name for StreamRuntime, kept as an alias so the
// frozen data plane and its tests do not churn.
//
// Read it as "the stream runtime this node runs today", never as "the contract
// every future protocol must satisfy": V5-WP2 split the concept precisely
// because that reading would have made UDP/QUIC awkward or dishonest. New code
// should prefer StreamRuntime.
type Forwarder = StreamRuntime

// Runtime is the transport-agnostic handle manager.TunnelManager keeps for one
// tunnel: whatever carries the payload, "a tunnel this node runs" means "a
// listener that can be bound, released and asked whether it is bound".
//
// It exists so the manager can own ONE registry (revision, port guard, reconcile,
// shutdown) without pretending a datagram runtime is a stream runtime. The
// stream and datagram contracts both include these three methods, and everything
// transport-specific stays behind an interface assertion at the call site: a
// target swap asks for SetUpstream or Retarget, a shutdown asks for Shutdown,
// in-flight work asks for LiveConns or LiveMappings.
//
// That assertion style is deliberate. The alternative — making the datagram
// runtime implement StreamRuntime's Drain/SetUpstream as empty shells — is
// forbidden by the datagram contract (§4.1): it would let a caller believe a
// drain happened on a transport that cannot drain, and it would erase the
// distinction between "this runtime has no such work" and "there is none now".
type Runtime interface {
	// Start binds the tunnel's listen port and starts forwarding.
	Start() error
	// Stop releases the port and tears down live work. Safe before Start and
	// safe to call more than once.
	Stop() error
	// Running reports whether the listener is currently bound.
	Running() bool
}

// DatagramStats is the structured count set a datagram runtime must report
// (§6.1 of the datagram contract). It is deliberately NOT the stream contract's
// single int64: "many tiny packets" (a scan, or an amplification attempt) and
// "few large packets" are the same byte total and completely different
// incidents, and there is no connection count to report at all.
//
// Field names match the per-tunnel `diag` wire keys (ProtocolDiagnostics) for
// the facts the panel consumes; the classified drop reasons are the agent-side
// detail behind the single wire total (Drops).
type DatagramStats struct {
	// Mappings is the datagram replacement for "live connections": it is the one
	// number that answers "how much work is in flight here" (§4.4).
	Mappings int64 `json:"mappings"`
	// MappingsCreated / MappingsExpired / MappingsRejected are cumulative since
	// this runtime was built and reset when it restarts — they are per-runtime
	// observations, never lifetime totals. A mapping ends by idle expiry or by
	// the socket closing, never by a client "hanging up": UDP has no such signal
	// (§2.3②).
	MappingsCreated  int64 `json:"mappings_created"`
	MappingsExpired  int64 `json:"mappings_expired"`
	MappingsRejected int64 `json:"mappings_rejected"`

	// PacketsIn / BytesIn count datagrams CLIENT → TARGET, PacketsOut /
	// BytesOut count TARGET → CLIENT. Both are counted on the write side, i.e.
	// only what was really delivered to the peer: a datagram that could not be
	// forwarded is a drop, never a byte (§6.1 inherits copyOne's rule). They are
	// cumulative per runtime and reset on restart.
	PacketsIn  int64 `json:"packets_in"`
	BytesIn    int64 `json:"bytes_in"`
	PacketsOut int64 `json:"packets_out"`
	BytesOut   int64 `json:"bytes_out"`

	// Drops is every datagram the runtime accepted from a client and then did
	// NOT deliver (no mapping and none could be created, over the ceiling, or a
	// failed send). The four reasons are separable for an operator reading the
	// agent-side facts; the wire carries Drops.
	Drops              int64 `json:"drops"`
	DropsUnknownSource int64 `json:"drops_unknown_source"`
	DropsCeiling       int64 `json:"drops_ceiling"`
	DropsSendError     int64 `json:"drops_send_error"`
	// DropsMalformed counts datagrams the runtime could not even read or key.
	// Payload BYTES are opaque to this runtime (it never interprets them), so
	// garbage content is forwarded, not dropped here.
	DropsMalformed int64 `json:"drops_malformed"`

	// LastActivityAt is the unix second of the last successfully forwarded
	// datagram in either direction (0 = none yet).
	LastActivityAt int64 `json:"last_activity_at"`
}

// DatagramRuntime is the data-plane contract for a datagram (packet) transport.
//
// The method set is the datagram translation of the stream contract, frozen in
// docs/v5-1b-datagram-contract-draft.md §4. Two stream methods are deliberately
// absent: `Drain` (a datagram has no in-flight connection to finish; its
// replacement is DrainMappings, which keeps the socket OPEN because the return
// path shares it — §4.3) and `SetUpstream` ("the upstream" is not a per-client
// fact here; its replacement is Retarget, which leaves existing mappings on the
// target they were created with — §3.4).
//
// A datagram runtime also answers the existing diagnostics and shutdown
// primitives (Diagnostician, Shutdowner, ListenerCloser); CloseListener's
// meaning changes with the transport, see its implementation.
type DatagramRuntime interface {
	Runtime

	// Stats reports the datagram facts. A caller must not expect the stream
	// contract's single byte total here.
	Stats() DatagramStats

	// Retarget replaces the target that NEW mappings use. It never touches the
	// listener and never rewrites a live mapping: the mappings already created
	// keep sending to (and receiving from) the target they were created with
	// until they expire — the §13.3.4 semantics, translated (§3.4).
	//
	// It is refused on a runtime with no live listener, or one that has stopped
	// admitting new work: A target no future mapping can reach is a lie.
	Retarget(target string) error

	// DrainMappings stops admitting NEW mappings and waits, bounded, for the
	// live ones to end. The listener stays bound and its socket stays open so
	// the existing mappings keep getting their replies (§4.3). Like the stream
	// Drain it is irreversible; teardown is Stop's job.
	DrainMappings(timeout time.Duration) error

	// CloseListener is the two-phase shutdown's phase 1 for a datagram tunnel:
	// it stops admitting new mappings and does NOT close the socket (§4.4.3).
	// Closing it is Shutdown/Stop's job, because the return path of every live
	// mapping goes through the same socket.
	CloseListener() bool

	// LiveMappings reports how much work is in flight, and is what a caller must
	// ask instead of LiveConns.
	LiveMappings() int
}

// ErrUpstreamNotSwappable is returned by SetUpstream on a forwarder whose
// upstream is not one swappable address (an EGRESS pool).
var ErrUpstreamNotSwappable = errors.New("forwarder: upstream is not swappable")

// DialFunc dials one address. Its shape is net.Dialer.DialContext, so a dialer
// that does more than Go's (V5.3-WP8's target resolver: TTL cache, stale
// fallback, observable facts) can be injected without the data plane knowing
// anything about DNS.
type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// TargetSelector picks the upstream for the next egress connection. The egress
// forwarder depends only on this narrow interface so the hot-updatable
// manager.LoadBalancer can be injected without the forwarder package knowing
// about the manager (that would be an import cycle).
type TargetSelector interface {
	Select() Target
}

// TargetReporter is the OPTIONAL other half of a TargetSelector: the egress
// forwarder tells the selector how the dial it just asked for turned out
// (V5.2-WP7 half-open probing).
//
// It is a separate interface rather than a second method on TargetSelector so
// every existing selector still satisfies the narrow contract. A selector that
// does not implement it simply never hears an outcome, and that is the safe
// direction: without an outcome the breaker can only ever be opened by the
// panel's word, never by the agent's own guess.
type TargetReporter interface {
	// ReportDial reports the outcome of one dial to the target Select handed
	// out. ok is false when the dial failed.
	ReportDial(t Target, ok bool)
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
