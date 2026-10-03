package forwarder

import (
	"sort"
	"strings"
	"testing"
)

// V5-WP2 runtime factory tests.
//
// The factory exists to answer one question *before* anything binds: "which
// runtime class carries this config, and does this binary implement it?" These
// tests pin the ordering (unknown protocol fails before a listener exists) and
// the coherence between what the parser accepts, what the manifest advertises
// and what the factory can actually build.

func factoryDirectConfig() TunnelConfig {
	return TunnelConfig{
		ID:          "tunex-1-direct",
		Mode:        ModeDirect,
		IngressPort: 20001,
		RemoteHost:  "192.168.1.10",
		RemotePort:  8080,
		Protocol:    ProtocolTCP,
		Revision:    1,
	}
}

func TestResolveRuntimeTargetForTCP(t *testing.T) {
	target, err := ResolveRuntimeTarget(factoryDirectConfig())
	if err != nil {
		t.Fatalf("ResolveRuntimeTarget: %v", err)
	}
	if target.Protocol != ProtocolTCP {
		t.Fatalf("protocol = %q, want tcp", target.Protocol)
	}
	if target.Transport != TransportStream {
		t.Fatalf("transport = %q, want stream", target.Transport)
	}
}

// An omitted protocol is the V4 client shape. Resolving it must not fail — that
// is the whole compatibility contract of V5-WP0/WP1/WP2.
func TestResolveRuntimeTargetDefaultsToTCP(t *testing.T) {
	cfg := factoryDirectConfig()
	cfg.Protocol = ""
	target, err := ResolveRuntimeTarget(cfg)
	if err != nil {
		t.Fatalf("an omitted protocol must mean TCP, got error %v", err)
	}
	if target.Protocol != ProtocolTCP {
		t.Fatalf("protocol = %q, want tcp", target.Protocol)
	}
}

func TestResolveRuntimeTargetFailsClosedForUnknownProtocol(t *testing.T) {
	// "tls" (A1), "ws" (A2) and "udp" (B1) are deliberately NOT in this list any
	// more: they are implemented, so they moved into the positive tests. A
	// protocol leaves this list only together with its Gate, never to make a test
	// pass — and "wss" stays here on purpose: framing and TLS are separate
	// dimensions. udp's transport is datagram (see the assertion below), which is
	// why it left the "no runtime at all" list without joining streamBuilders.
	for _, name := range []string{"quic", "wss", "mtcp", "carrier-pigeon"} {
		cfg := factoryDirectConfig()
		cfg.Protocol = ForwardProtocol(name)
		if _, err := ResolveRuntimeTarget(cfg); err == nil {
			t.Fatalf("protocol %q has no runtime in this binary and must be refused", name)
		}
	}
}

// The critical ordering property: a rejected config must not create a listener.
// BuildStream is the first thing the manager calls, so if it fails, nothing has
// bound yet — this test proves BuildStream itself never binds.
//
// Two refusals, two reasons, one rule: a protocol this binary does not implement
// (quic), and a protocol it does implement but by ANOTHER transport (udp, B1).
// The second one is the §4.1 rule — a datagram protocol behind a stream listener
// is not a partial implementation, it is a wrong one.
func TestBuildStreamRefusesUnknownProtocolWithoutBinding(t *testing.T) {
	for _, name := range []ForwardProtocol{"quic", ProtocolUDP} {
		cfg := factoryDirectConfig()
		// A port that would fail to bind if anything tried: BUILD must not touch it.
		cfg.IngressPort = 1
		cfg.Protocol = name

		if _, err := BuildStream(cfg, StreamBuildDeps{}); err == nil {
			t.Fatalf("protocol %q must be refused by BuildStream before construction", name)
		}
	}
}

// V5-WP5-A1: tls is a stream protocol, resolved like any other.
func TestResolveRuntimeTargetForTLS(t *testing.T) {
	cfg := factoryDirectConfig()
	cfg.Protocol = ProtocolTLS
	cfg.TLSCertPath = "/nonexistent/cert.pem"
	cfg.TLSKeyPath = "/nonexistent/key.pem"
	target, err := ResolveRuntimeTarget(cfg)
	if err != nil {
		t.Fatalf("ResolveRuntimeTarget: %v", err)
	}
	if target.Protocol != ProtocolTLS || target.Transport != TransportStream {
		t.Fatalf("tls must resolve to the stream transport, got %+v", target)
	}
}

// A TLS tunnel with no certificate paths is a configuration error, and it must be
// refused by Validate — i.e. before any listener exists.
func TestTLSWithoutCertificatePathsIsRefused(t *testing.T) {
	cfg := factoryDirectConfig()
	cfg.Protocol = ProtocolTLS
	if err := cfg.Validate(); err == nil {
		t.Fatal("a tls tunnel without cert/key paths must not validate")
	}
}

// A certificate that cannot be loaded fails the BUILD, before binding: the
// listener must never come up with a broken TLS front.
func TestBuildStreamTLSFailsClosedOnBadCertificate(t *testing.T) {
	cfg := factoryDirectConfig()
	cfg.Protocol = ProtocolTLS
	cfg.TLSCertPath = "/nonexistent/cert.pem"
	cfg.TLSKeyPath = "/nonexistent/key.pem"
	// Port 1 would fail to bind anyway; the point is that the failure is the
	// certificate, and that nothing was bound.
	if _, err := BuildStream(cfg, StreamBuildDeps{}); err == nil {
		t.Fatal("an unloadable certificate must refuse the build")
	}
}

// EGRESS keeps a plain listener: the egress node listens for the ingress node,
// and the inter-node hop is plain TCP by contract.
func TestTLSCannotBeUsedForEgress(t *testing.T) {
	cfg := factoryDirectConfig()
	cfg.Mode = ModeEgress
	cfg.EgressPort = 30001
	cfg.Protocol = ProtocolTLS
	cfg.TLSCertPath = "/nonexistent/cert.pem"
	cfg.TLSKeyPath = "/nonexistent/key.pem"
	if err := cfg.Validate(); err == nil {
		t.Fatal("tls on an EGRESS tunnel must not validate")
	}
}

func TestBuildStreamBuildsTheStreamRuntimeForDirect(t *testing.T) {
	cfg := factoryDirectConfig()
	// A never-started runtime must not hold the port, so an arbitrary port here
	// is safe: construction binds nothing.
	runtime, err := BuildStream(cfg, StreamBuildDeps{})
	if err != nil {
		t.Fatalf("BuildStream: %v", err)
	}
	if runtime == nil {
		t.Fatal("BuildStream returned a nil runtime without an error")
	}
	if runtime.Running() {
		t.Fatal("construction must not start the listener; Start() is the only place that binds")
	}
	if err := runtime.Stop(); err != nil {
		t.Fatalf("Stop on a never-started runtime must be a no-op: %v", err)
	}
}

// EGRESS needs a pool selector; a build without one must fail with a clear
// message rather than nil-panicking somewhere inside the forwarder.
func TestBuildStreamEgressRequiresASelector(t *testing.T) {
	cfg := factoryDirectConfig()
	cfg.Mode = ModeEgress
	cfg.EgressPort = 30001

	if _, err := BuildStream(cfg, StreamBuildDeps{}); err == nil {
		t.Fatal("an EGRESS build without a selector must fail")
	}

	sel := staticSelector{t: Target{Host: "192.168.1.10", Port: 8080}}
	runtime, err := BuildStream(cfg, StreamBuildDeps{SelectorFor: func(string) (TargetSelector, error) {
		return sel, nil
	}})
	if err != nil {
		t.Fatalf("BuildStream with a selector: %v", err)
	}
	if runtime == nil {
		t.Fatal("expected an egress runtime")
	}
}

type staticSelector struct{ t Target }

func (s staticSelector) Select() Target { return s.t }

// The registries, the parser and the advertised manifest must describe the same
// set of protocols. Lists that can drift are exactly how an agent ends up
// advertising something it cannot run.
//
// V5.1b made this a per-TRANSPORT question: udp is advertised, and it has a
// datagram builder, not a stream one. The invariant is therefore "every
// advertised protocol has a builder in the registry its transport names, and no
// registry holds a protocol the parser rejects" — which is stronger than the old
// single-list equality because it also pins the transport→registry split.
func TestEveryAdvertisedProtocolHasABuilder(t *testing.T) {
	advertised := ImplementedProtocols()
	if len(advertised) == 0 {
		t.Fatal("this binary must implement at least one protocol")
	}
	streamBuilders := RegisteredBuilders()
	datagramBuilders := RegisteredDatagramBuilders()
	all := append(append([]string{}, streamBuilders...), datagramBuilders...)
	sort.Strings(all)
	if strings.Join(advertised, ",") != strings.Join(all, ",") {
		t.Fatalf("advertised protocols %v and registered builders %v must match", advertised, all)
	}
	for _, name := range advertised {
		protocol, err := ParseForwardProtocol(name)
		if err != nil {
			t.Fatalf("advertised protocol %q is rejected by the parser: %v", name, err)
		}
		transport, ok := TransportForProtocol(protocol)
		if !ok {
			t.Fatalf("advertised protocol %q has no transport", name)
		}
		registry := streamBuilders
		if transport == TransportDatagram {
			registry = datagramBuilders
		}
		if !containsString(registry, name) {
			t.Fatalf("protocol %q resolves to the %q transport but has no builder in that registry (%v)",
				name, transport, registry)
		}
	}
}

func TestParseForwardTransportFailsClosed(t *testing.T) {
	// V5.1b opened the datagram transport, so it moved out of the fail-closed list
	// together with its protocol — the two leaves this list only as a pair.
	for _, want := range []ForwardTransport{TransportStream, TransportDatagram} {
		if got, err := ParseForwardTransport(string(want)); err != nil || got != want {
			t.Fatalf("%s must parse, got %q / %v", want, got, err)
		}
	}
	for _, name := range []string{"", "  ", "packet", "carrier-pigeon"} {
		if _, err := ParseForwardTransport(name); err == nil {
			t.Fatalf("transport %q is not implemented and must be refused", name)
		}
	}
}

// StreamRuntime is the explicit name; Forwarder stays as an alias so the frozen
// data plane keeps compiling. This asserts the alias really is the same type,
// which is what makes "no churn" true rather than hopeful.
func TestForwarderIsAnAliasOfStreamRuntime(t *testing.T) {
	var runtime StreamRuntime = &SingleHopForwarder{}
	var legacy Forwarder = runtime
	if legacy != runtime {
		t.Fatal("Forwarder must alias StreamRuntime, not mirror it")
	}
}
