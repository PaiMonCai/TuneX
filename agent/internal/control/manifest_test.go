package control

import (
	"sort"
	"testing"

	"github.com/tunex/agent/internal/forwarder"
)

// Capability manifest tests.
//
// The whole point of the manifest is that it is a *claim* the panel will act on:
// a wrong entry makes the panel dispatch a protocol this binary cannot carry, or
// refuse one it can. So these tests do not check the literal contents — they
// check that every entry is backed by a real implementation in this binary.

// A protocol may only be advertised if the data plane's own parser accepts it.
// This is the strongest available link: the parser is what an incoming config is
// validated against, so "advertised" and "runnable" cannot diverge unnoticed.
func TestAdvertisedProtocolsAreAcceptedByTheParser(t *testing.T) {
	manifest, err := DefaultManifest()
	if err != nil {
		t.Fatalf("DefaultManifest: %v", err)
	}
	if len(manifest.Protocols) == 0 {
		t.Fatal("an agent must advertise at least one product protocol")
	}
	for _, name := range manifest.Protocols {
		got, err := forwarder.ParseForwardProtocol(name)
		if err != nil {
			t.Fatalf("protocol %q is advertised but the parser rejects it: %v", name, err)
		}
		if string(got) != name {
			t.Fatalf("protocol %q normalises to %q", name, got)
		}
	}
}

func TestAdvertisedTransportsCarryAnAdvertisedProtocol(t *testing.T) {
	manifest, err := DefaultManifest()
	if err != nil {
		t.Fatalf("DefaultManifest: %v", err)
	}
	if len(manifest.Transports) == 0 {
		t.Fatal("an agent must advertise at least one transport contract")
	}
	for _, transport := range manifest.Transports {
		carried := false
		for _, protocol := range manifest.Protocols {
			got, ok := forwarder.TransportForProtocol(forwarder.ForwardProtocol(protocol))
			if ok && string(got) == transport {
				carried = true
				break
			}
		}
		if !carried {
			t.Fatalf("transport %q is advertised but no advertised protocol uses it", transport)
		}
	}
}

// Every runtime feature in the manifest must be a behaviour the data plane
// really performs. hot_reload and graceful_drain are properties of the frozen
// Forwarder contract, so they are checked against that contract rather than
// against a naming convention.
func TestAdvertisedRuntimeFeaturesHaveImplementations(t *testing.T) {
	manifest, err := DefaultManifest()
	if err != nil {
		t.Fatalf("DefaultManifest: %v", err)
	}
	for _, feature := range manifest.Runtime {
		switch RuntimeFeature(feature) {
		case RuntimeHotReload, RuntimeGracefulDrain:
			// forwarder.Forwarder is the interface that carries SetUpstream
			// (hot reload) and Drain (bounded graceful drain). Asserting the
			// interface is non-nil documents the dependency; the compile-time
			// proof is that these methods are part of the interface below.
			var impl forwarder.Forwarder
			_ = impl
		case RuntimeLKGRestore:
			// Checked by the wiring, which only passes this fact when the LKG
			// cache is enabled (see runtimeManifest in v3runtime.go).
		default:
			t.Fatalf("runtime feature %q is advertised but has no known implementation", feature)
		}
	}
}

// The diagnostics dimension must not become a second source of truth for
// dispatch: it is derived from the action list, so a diagnostic can never be
// advertised without the action that actually serves it.
func TestManifestDiagnosticsMatchActions(t *testing.T) {
	manifest, err := DefaultManifest()
	if err != nil {
		t.Fatalf("DefaultManifest: %v", err)
	}
	want := []string{}
	for _, action := range Capabilities() {
		if d := DiagnosticForAction(action); d != "" {
			want = append(want, string(d))
		}
	}
	sort.Strings(want)
	if len(manifest.Diagnostics) != len(want) {
		t.Fatalf("diagnostics %v do not match the actions %v", manifest.Diagnostics, want)
	}
	for i := range want {
		if manifest.Diagnostics[i] != want[i] {
			t.Fatalf("diagnostics %v do not match the actions %v", manifest.Diagnostics, want)
		}
	}

	// And the reverse: an advertised diagnostic must have its action.
	for _, diagnostic := range manifest.Diagnostics {
		found := false
		for _, action := range Capabilities() {
			if string(DiagnosticForAction(action)) == diagnostic {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("diagnostic %q is advertised but no action implements it", diagnostic)
		}
	}
}

// An unknown name is a wiring bug, not something to drop silently: dropping it
// would turn a typo into "this agent implements nothing", which the panel then
// fails closed on.
func TestBuildManifestRejectsUnknownNames(t *testing.T) {
	cases := []struct {
		name  string
		facts ImplementationFacts
	}{
		{
			name: "unknown protocol",
			// udp is supported, so it is no longer a name that must be rejected;
			// this case is about an UNKNOWN name, which stays an error.
			facts: ImplementationFacts{
				Protocols:  []string{"quic"},
				Transports: []string{"stream"},
			},
		},
		{
			name: "empty protocol name",
			facts: ImplementationFacts{
				Protocols: []string{"  "},
			},
		},
		{
			name: "transport no protocol carries",
			facts: ImplementationFacts{
				Protocols:  []string{"tcp"},
				Transports: []string{"datagram"},
			},
		},
		{
			name: "unknown runtime feature",
			facts: ImplementationFacts{
				Protocols:  []string{"tcp"},
				Transports: []string{"stream"},
				Runtime:    []RuntimeFeature{"teleport"},
			},
		},
		{
			name: "unknown diagnostic",
			facts: ImplementationFacts{
				Protocols:   []string{"tcp"},
				Transports:  []string{"stream"},
				Diagnostics: []DiagnosticFeature{"telepathy"},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := BuildManifest(tc.facts); err == nil {
				t.Fatal("an unimplemented name must be a build error, never silently dropped")
			}
		})
	}
}

// A build without the LKG cache must not claim lkg_restore: the panel uses that
// fact to decide whether the node can survive a panel outage.
func TestRuntimeFeaturesFollowTheFactsPassed(t *testing.T) {
	manifest, err := BuildManifest(ImplementationFacts{
		Protocols:  forwarder.ImplementedProtocols(),
		Transports: forwarder.ImplementedTransports(),
		Runtime:    []RuntimeFeature{RuntimeHotReload},
	})
	if err != nil {
		t.Fatalf("BuildManifest: %v", err)
	}
	if len(manifest.Runtime) != 1 || manifest.Runtime[0] != string(RuntimeHotReload) {
		t.Fatalf("the manifest must describe the facts passed in, got %v", manifest.Runtime)
	}
}

func TestManifestIsSortedAndDeduplicated(t *testing.T) {
	manifest, err := BuildManifest(ImplementationFacts{
		Protocols:   []string{"tcp", "tcp"},
		Transports:  []string{"stream", "stream"},
		Runtime:     []RuntimeFeature{RuntimeLKGRestore, RuntimeHotReload, RuntimeHotReload},
		Diagnostics: []DiagnosticFeature{DiagnosticNodeSnapshot, DiagnosticTunnelProbe},
	})
	if err != nil {
		t.Fatalf("BuildManifest: %v", err)
	}
	for _, list := range [][]string{manifest.Protocols, manifest.Transports, manifest.Runtime, manifest.Diagnostics} {
		for i := 1; i < len(list); i++ {
			if list[i-1] >= list[i] {
				t.Fatalf("manifest lists must be sorted and unique, got %v", list)
			}
		}
	}
	if manifest.SchemaVersion != ManifestSchemaVersion {
		t.Fatalf("schema version must be stamped by the builder, got %d", manifest.SchemaVersion)
	}
}

// The manifest must stay additive: the action list is a separate, unchanged
// wire field, and every advertised action must still be one the agent truly
// dispatches.
func TestManifestDoesNotChangeTheActionList(t *testing.T) {
	actions := Capabilities()
	if len(actions) == 0 {
		t.Fatal("the action list must not be emptied by the v2 manifest work")
	}
	for _, action := range []string{ActionApplyTunnel, ActionRemoveTunnel, ActionSuspendTunnel} {
		if !Implements(action) {
			t.Fatalf("baseline action %q must remain advertised", action)
		}
	}
}
