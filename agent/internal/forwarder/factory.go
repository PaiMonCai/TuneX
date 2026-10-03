package forwarder

import (
	"fmt"
	"sort"
	"strings"
)

// V5-WP2 runtime factory.
//
// The agent builds data-plane runtimes in exactly one place (manager.buildLocked
// used to switch on the tunnel *mode* alone). That was correct while TCP was the
// only protocol, but it left two things implicit:
//
//  1. a config whose protocol this binary does not implement would be caught,
//     if at all, by TunnelConfig.Validate — i.e. after the caller had already
//     committed to building something;
//  2. "which runtime class carries this config" was never named, so the first
//     datagram protocol would have had to be smuggled into the stream switch.
//
// The factory makes both explicit and keeps the manager owning what it already
// owns: desired state, revisions, the port guard and the single registry. It
// does NOT introduce a second manager, a second revision ledger or a second
// port system — protocol dispatch happens strictly inside runtime construction,
// which is the only place where it is real.

// StreamBuildDeps carries what a stream builder may need from its owner.
//
// It is a struct rather than positional arguments so a future builder (TLS/WSS
// in V5.1a, which reuse the stream lifecycle) can take the same shape without
// changing the registry signature.
type StreamBuildDeps struct {
	// SelectorFor resolves the egress pool for a tunnel id. Only the EGRESS
	// mode reads it; a DIRECT/RELAY build must not require one.
	SelectorFor func(tunnelID string) (TargetSelector, error)
	// Observer receives per-target dial failures (EGRESS only). Nil is a no-op.
	Observer TargetObserver
}

// StreamBuilder constructs the stream runtime for ONE protocol.
//
// It must not bind anything: Start() does that, long after the config has been
// validated. That separation is what makes "unknown protocol fails before a
// listener exists" checkable instead of aspirational.
type StreamBuilder func(cfg TunnelConfig, deps StreamBuildDeps) (StreamRuntime, error)

// RuntimeTarget is the runtime class a config resolves to. It is a pure
// description: no sockets, no goroutines, nothing that can fail to close.
type RuntimeTarget struct {
	Protocol  ForwardProtocol
	Transport ForwardTransport
}

// ResolveRuntimeTarget answers "which runtime class carries this config" and
// fails closed for anything not compiled into this binary.
//
// An empty Protocol is the V4 client shape and means TCP (see
// ParseForwardProtocol), so an old panel keeps working unchanged. An explicit
// protocol with no runtime is refused here — before any listener exists.
func ResolveRuntimeTarget(cfg TunnelConfig) (RuntimeTarget, error) {
	protocol, err := ParseForwardProtocol(string(cfg.Protocol))
	if err != nil {
		return RuntimeTarget{}, err
	}
	transport, ok := TransportForProtocol(protocol)
	if !ok {
		return RuntimeTarget{}, fmt.Errorf(
			"forwarder: protocol %q has no runtime in this binary", protocol)
	}
	return RuntimeTarget{Protocol: protocol, Transport: transport}, nil
}

// ParseForwardTransport normalises a wire value and fails closed for transport
// contracts this binary has not opened.
func ParseForwardTransport(s string) (ForwardTransport, error) {
	name := strings.ToLower(strings.TrimSpace(s))
	if name == "" {
		return "", fmt.Errorf("forwarder: transport is required")
	}
	for _, rt := range protocolRuntimes {
		if string(rt.Transport) == name {
			return rt.Transport, nil
		}
	}
	return "", fmt.Errorf("forwarder: transport %q is not supported by the current runtime contract", s)
}

// BuildStream builds the stream runtime for a config.
//
// Order is deliberate and is the whole point of the factory:
//  1. resolve protocol + transport (fail closed on unknown);
//  2. refuse a transport that is not the stream one — a datagram protocol must
//     never be handed to a stream builder "for now";
//  3. look up the builder registered for that protocol;
//  4. only then construct. Construction may still fail (bad port, bad mode),
//     but it is the first step that can touch a resource.
func BuildStream(cfg TunnelConfig, deps StreamBuildDeps) (StreamRuntime, error) {
	target, err := ResolveRuntimeTarget(cfg)
	if err != nil {
		return nil, err
	}
	if target.Transport != TransportStream {
		return nil, fmt.Errorf(
			"forwarder: protocol %q is carried by the %q transport, not stream",
			target.Protocol, target.Transport)
	}
	builder, ok := streamBuilders[target.Protocol]
	if !ok {
		return nil, fmt.Errorf(
			"forwarder: protocol %q has no stream builder registered", target.Protocol)
	}
	return builder(cfg, deps)
}

// streamBuilders is the protocol → constructor registry.
//
// It is keyed by the same ForwardProtocol values ParseForwardProtocol accepts,
// and TestEveryProtocolHasABuilder pins the two sets together: advertising (or
// parsing) a protocol without a constructor behind it is a bug the tests catch,
// not something production discovers as a nil map lookup.
var streamBuilders = map[ForwardProtocol]StreamBuilder{
	ProtocolTCP: buildTCPStream,
}

// buildTCPStream constructs the TCP stream runtime for one tunnel.
//
// The mode switch lives here rather than in the manager on purpose: DIRECT vs
// RELAY vs EGRESS is a property of *how TCP is wired on this node*, not a
// property of the runtime class system. The manager stays free of protocol
// knowledge; a future UDP builder gets the same freedom.
func buildTCPStream(cfg TunnelConfig, deps StreamBuildDeps) (StreamRuntime, error) {
	switch cfg.Mode {
	case ModeDirect, ModeRelay:
		// Both are one-hop tunnels: the only difference is where
		// UpstreamAddr() points, so one implementation carries both.
		return NewSingleHop(cfg)
	case ModeEgress:
		if deps.SelectorFor == nil {
			return nil, fmt.Errorf("forwarder: EGRESS tunnel %s needs a target pool selector", cfg.ID)
		}
		sel, err := deps.SelectorFor(cfg.ID)
		if err != nil {
			return nil, err
		}
		return NewEgressWithHealth(cfg, sel, deps.Observer)
	default:
		return nil, fmt.Errorf("forwarder: unsupported tunnel mode %q", cfg.Mode)
	}
}

// RegisteredBuilders reports the protocols this binary can build a stream
// runtime for, sorted. It exists so a test can compare it with the advertised
// protocol list instead of trusting a comment.
func RegisteredBuilders() []string {
	out := make([]string, 0, len(streamBuilders))
	for protocol := range streamBuilders {
		out = append(out, string(protocol))
	}
	sort.Strings(out)
	return out
}
