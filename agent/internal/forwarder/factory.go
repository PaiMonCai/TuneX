package forwarder

import (
	"crypto/tls"
	"fmt"
	"net"
	"sort"
	"strings"
	"time"
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
	// Dial overrides the EGRESS upstream dialer (V5.3-WP8: the runtime injects a
	// resolver-backed one so target names get a TTL cache and a stale fallback).
	// Nil keeps Go's own dialer.
	Dial DialFunc
	// ServerName overrides the TLS server name. Tests set it; production leaves
	// it empty (the listener serves whatever SNI the client sends).
	ServerName string
	// HandshakeTimeout bounds a client's WebSocket handshake. Zero uses the
	// package default; tests shorten it.
	HandshakeTimeout time.Duration
	// ReportCertError is called when a rotated certificate cannot be loaded. The
	// tunnel keeps serving the last good certificate; the caller decides how loud
	// to be. Nil is silent.
	ReportCertError func(error)
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
// and TestEveryAdvertisedProtocolHasABuilder pins the two sets together: advertising (or
// parsing) a protocol without a constructor behind it is a bug the tests catch,
// not something production discovers as a nil map lookup.
var streamBuilders = map[ForwardProtocol]StreamBuilder{
	ProtocolTCP: buildTCPStream,
	ProtocolTLS: buildTLSStream,
	ProtocolWS:  buildWSStream,
}

// DatagramBuildDeps carries what a datagram builder may need from its owner.
//
// A struct for the same reason StreamBuildDeps is one: the fields a datagram
// runtime needs are not the fields a stream runtime needs, and a shared
// positional signature would force one to grow the other's parameters.
type DatagramBuildDeps struct {
	// IdleTimeout is the ingress mapping idle window (§2.3①). Zero uses the
	// package default. The value is a product decision (§9.2) and no per-Forward
	// column exists yet, so this is the seam where one would land.
	IdleTimeout time.Duration
	// MaxMappings is the mapping ceiling (§2.4). Zero uses the package default.
	MaxMappings int
}

// DatagramBuilder constructs the datagram runtime for ONE protocol.
//
// Like a stream builder it must not bind anything: Start() does that, long after
// the config was validated, which is what makes "an unusable config fails before
// a listener exists" checkable on this path too.
type DatagramBuilder func(cfg TunnelConfig, deps DatagramBuildDeps) (DatagramRuntime, error)

// BuildDatagram builds the datagram runtime for a config.
//
// The ordering is BuildStream's, with the transport check inverted:
//  1. resolve protocol + transport (fail closed on unknown);
//  2. refuse a transport that is not the datagram one — a stream protocol must
//     never be handed to a datagram builder either;
//  3. look up the builder registered for that protocol;
//  4. only then construct.
//
// Step 2 is what keeps §1.3's split from being cosmetic: a `udp` config sent to
// BuildStream is refused there, and a `tcp` config sent here is refused here.
// Neither "for now" fallback exists, because a stream listener carrying datagrams
// (or the reverse) is not a partial implementation, it is a wrong one.
func BuildDatagram(cfg TunnelConfig, deps DatagramBuildDeps) (DatagramRuntime, error) {
	target, err := ResolveRuntimeTarget(cfg)
	if err != nil {
		return nil, err
	}
	if target.Transport != TransportDatagram {
		return nil, fmt.Errorf(
			"forwarder: protocol %q is carried by the %q transport, not datagram",
			target.Protocol, target.Transport)
	}
	builder, ok := datagramBuilders[target.Protocol]
	if !ok {
		return nil, fmt.Errorf(
			"forwarder: protocol %q has no datagram builder registered", target.Protocol)
	}
	return builder(cfg, deps)
}

// datagramBuilders is the datagram half of the protocol → constructor registry.
//
// It is deliberately NOT streamBuilders: sharing one map would let a datagram
// protocol sit behind a StreamRuntime constructor, which is the §4.1 mistake
// expressed as a map. Keeping them apart means the transport a protocol resolves
// to and the constructor it reaches are two views of the same registration.
var datagramBuilders = map[ForwardProtocol]DatagramBuilder{
	ProtocolUDP: buildUDPDatagram,
}

// buildUDPDatagram constructs the UDP DIRECT datagram runtime.
//
// UDP needs no configuration beyond the protocol name yet (the idle timeout and
// the mapping ceiling are package defaults until §9.2/§9.3 decide whether they
// become per-Forward columns). RELAY and EGRESS never reach this builder:
// TunnelConfig.Validate refuses them, because the UDP inter-node hop is an open
// product decision (§9.1) and a datagram egress runtime does not exist.
func buildUDPDatagram(cfg TunnelConfig, deps DatagramBuildDeps) (DatagramRuntime, error) {
	if cfg.Mode != ModeDirect {
		// Unreachable through Validate; kept so a caller cannot get a datagram
		// runtime for a role the datagram contract does not define.
		return nil, errModeNot(ModeDirect, cfg.Mode)
	}
	return NewDatagram(cfg, DatagramOptions{
		IdleTimeout: deps.IdleTimeout,
		MaxMappings: deps.MaxMappings,
	})
}

// BuildDeps is everything the manager's single build entry point may need, split
// by transport so neither side grows with the other's parameters.
type BuildDeps struct {
	// Stream is handed to the stream builders unchanged.
	StreamBuildDeps
	// Datagram is handed to the datagram builder (udp only).
	Datagram DatagramBuildDeps
}

// BuildRuntime builds the runtime for whichever transport carries cfg.
//
// This is the entry point manager.buildLocked uses, so the manager never needs to
// know which protocol is which transport: it asks the factory, and the factory
// answers from the same table the parser and the capability manifest read. A
// config whose transport has no runtime fails here, before anything binds.
func BuildRuntime(cfg TunnelConfig, deps BuildDeps) (Runtime, error) {
	target, err := ResolveRuntimeTarget(cfg)
	if err != nil {
		return nil, err
	}
	switch target.Transport {
	case TransportStream:
		return BuildStream(cfg, deps.StreamBuildDeps)
	case TransportDatagram:
		return BuildDatagram(cfg, deps.Datagram)
	default:
		return nil, fmt.Errorf(
			"forwarder: protocol %q resolves to transport %q, which has no runtime in this binary",
			target.Protocol, target.Transport)
	}
}

// buildWSStream constructs the WebSocket-fronted stream runtime.
//
// WS needs no configuration beyond the protocol name: the handshake is
// server-side and the tunnel does not negotiate a subprotocol (it carries opaque
// bytes). So unlike TLS there is nothing that can be misconfigured here — the
// failure mode is per-connection (a client that is not a WS client), which must
// never take the listener down.
func buildWSStream(cfg TunnelConfig, deps StreamBuildDeps) (StreamRuntime, error) {
	if cfg.Mode == ModeEgress {
		// Unreachable through Validate; kept so the factory cannot silently
		// produce a WS front on the inter-node hop if called directly.
		return buildTCPStream(cfg, deps)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	diag := &diagRecorder{protocol: ProtocolWS}
	f := &SingleHopForwarder{pipeTracker{cfg: cfg, up: upstream{addr: cfg.UpstreamAddr()}}}
	f.diag = diag
	f.wrapConn = func(conn net.Conn) (net.Conn, error) {
		wrapped, err := upgradeWebSocket(conn, deps.HandshakeTimeout)
		if err != nil {
			// A client that is not a WebSocket client is usually not a fault (every
			// listener gets scanners), so it is counted separately from a failed
			// handshake — and the connection is dropped without touching the
			// listener.
			diag.noteUpgradeRefused()
			return nil, err
		}
		return wrapped, nil
	}
	return f, nil
}

// buildTLSStream constructs the TLS-fronted stream runtime.
//
// Ordering is the contract (§6.1 + WP2's "unknown protocol fails before a
// listener exists"):
//  1. the config has already been validated (paths present, mode applicable);
//  2. the certificate and key are LOADED here — a missing file, a mismatched
//     pair or an unreadable key fails now, before anything binds;
//  3. only then is the listener wrapped in TLS.
//
// EGRESS stays a plain listener on purpose: the egress node listens for the
// ingress node, and the inter-node hop is plain TCP by contract. Making the
// egress side speak TLS would be inventing a second inter-node transport in a
// protocol WP, which is exactly what the contract forbids.
func buildTLSStream(cfg TunnelConfig, deps StreamBuildDeps) (StreamRuntime, error) {
	if cfg.Mode == ModeEgress {
		return buildTCPStream(cfg, deps)
	}
	// The certificate is loaded through a reloader rather than once: rotation is
	// an operator replacing a file, and a hot-reloadable tunnel never rebuilds
	// its listener, so a one-shot load would keep serving the old certificate
	// forever (V5-G1A.6). The initial load still happens here, so a bad pair
	// fails before anything binds.
	diag := &diagRecorder{protocol: ProtocolTLS}
	reloader, err := newCertReloader(
		strings.TrimSpace(cfg.TLSCertPath), strings.TrimSpace(cfg.TLSKeyPath),
		func(err error) {
			// V5-WP5-A3: a failed rotation is both logged and REPORTED, because the
			// tunnel keeps serving the last good certificate and would otherwise
			// look perfectly healthy.
			diag.noteCertReloadError(err)
			if deps.ReportCertError != nil {
				deps.ReportCertError(err)
			}
		},
		diag.noteCertLoaded,
	)
	if err != nil {
		return nil, fmt.Errorf("forwarder: tls tunnel %s: %w", cfg.ID, err)
	}
	tlsConfig := &tls.Config{
		GetCertificate: reloader.GetCertificate,
		MinVersion:     tls.VersionTLS12,
	}
	if deps.ServerName != "" {
		tlsConfig.ServerName = deps.ServerName
	}
	return NewSingleHopTLS(cfg, tlsConfig, diag)
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
		return NewEgressWithOptions(cfg, sel, EgressOptions{Observer: deps.Observer, Dial: deps.Dial})
	default:
		return nil, fmt.Errorf("forwarder: unsupported tunnel mode %q", cfg.Mode)
	}
}

// RegisteredBuilders reports the protocols this binary can build a STREAM
// runtime for, sorted. It exists so a test can compare it with the advertised
// protocol list instead of trusting a comment; RegisteredDatagramBuilders is its
// datagram counterpart, and together they must cover every advertised protocol.
func RegisteredBuilders() []string {
	out := make([]string, 0, len(streamBuilders))
	for protocol := range streamBuilders {
		out = append(out, string(protocol))
	}
	sort.Strings(out)
	return out
}

// RegisteredDatagramBuilders reports the protocols this binary can build a
// datagram runtime for, sorted.
func RegisteredDatagramBuilders() []string {
	out := make([]string, 0, len(datagramBuilders))
	for protocol := range datagramBuilders {
		out = append(out, string(protocol))
	}
	sort.Strings(out)
	return out
}
