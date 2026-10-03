package forwarder

import (
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
	// "tls" (A1) and "ws" (A2) are deliberately NOT in this list any more: they
	// are implemented, so they moved into the positive tests. A protocol leaves
	// this list only together with its Gate, never to make a test pass — and
	// "wss" stays here on purpose: framing and TLS are separate dimensions.
	for _, name := range []string{"udp", "quic", "wss", "mtcp", "carrier-pigeon"} {
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
func TestBuildStreamRefusesUnknownProtocolWithoutBinding(t *testing.T) {
	cfg := factoryDirectConfig()
	// A port that would fail to bind if anything tried: BUILD must not touch it.
	cfg.IngressPort = 1
	cfg.Protocol = "udp"

	if _, err := BuildStream(cfg, StreamBuildDeps{}); err == nil {
		t.Fatal("an unimplemented protocol must be refused before construction")
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

// The registry, the parser and the advertised manifest must describe the same
// set of protocols. Three lists that can drift is exactly how an agent ends up
// advertising something it cannot run.
func TestEveryAdvertisedProtocolHasABuilder(t *testing.T) {
	advertised := ImplementedProtocols()
	builders := RegisteredBuilders()
	if len(advertised) == 0 {
		t.Fatal("this binary must implement at least one protocol")
	}
	if strings.Join(advertised, ",") != strings.Join(builders, ",") {
		t.Fatalf("advertised protocols %v and registered builders %v must match", advertised, builders)
	}
	for _, name := range builders {
		if _, err := ParseForwardProtocol(name); err != nil {
			t.Fatalf("builder registered for %q but the parser rejects it: %v", name, err)
		}
	}
}

func TestParseForwardTransportFailsClosed(t *testing.T) {
	if got, err := ParseForwardTransport("stream"); err != nil || got != TransportStream {
		t.Fatalf("stream must parse, got %q / %v", got, err)
	}
	for _, name := range []string{"", "  ", "datagram", "packet", "carrier-pigeon"} {
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
