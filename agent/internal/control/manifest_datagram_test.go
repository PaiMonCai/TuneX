package control

import (
	"testing"

	"github.com/tunex/agent/internal/forwarder"
)

// The capability manifest is derived from implemented datagram support, never hand-written.
//
// Opening the datagram runtime in the forwarder's protocol table is therefore the
// whole change on this side: nobody edits a protocol list here, and that is the
// point. These tests pin the chain end to end (parser table → manifest the panel
// reads), so "the agent advertises udp" can never become a claim that outlives the
// runtime behind it.
func TestManifestAdvertisesTheDatagramPair(t *testing.T) {
	transport, ok := forwarder.TransportForProtocol(forwarder.ProtocolUDP)
	if !ok || transport != forwarder.TransportDatagram {
		t.Fatalf("udp resolves to %q/%v, want datagram/true", transport, ok)
	}

	manifest, err := DefaultManifest()
	if err != nil {
		t.Fatalf("DefaultManifest: %v", err)
	}
	if !manifestHasName(manifest.Protocols, "udp") {
		t.Fatalf("the manifest must advertise udp now that its runtime exists, got %v", manifest.Protocols)
	}
	if !manifestHasName(manifest.Transports, "datagram") {
		t.Fatalf("the manifest must advertise datagram, the transport that carries udp, got %v", manifest.Transports)
	}
	// The derived facts must still agree with the parser: an advertised protocol
	// the parser rejects is exactly the drift BuildManifest refuses.
	for _, name := range manifest.Protocols {
		if _, err := forwarder.ParseForwardProtocol(name); err != nil {
			t.Fatalf("manifest advertises %q but the parser rejects it: %v", name, err)
		}
	}
}

// The reverse direction: a protocol advertised with a transport that nothing
// carries is a build error, so the udp/datagram pair cannot drift apart silently
// in either direction.
func TestManifestRejectsAProtocolWhoseTransportIsMissing(t *testing.T) {
	if _, err := BuildManifest(ImplementationFacts{
		Protocols:  []string{"udp"},
		Transports: []string{"stream"},
	}); err == nil {
		t.Fatal("udp is carried by datagram; advertising only stream must fail the build")
	}
	if _, err := BuildManifest(ImplementationFacts{
		Protocols:  []string{"tcp"},
		Transports: []string{"stream", "datagram"},
	}); err == nil {
		t.Fatal("datagram is carried by no advertised protocol here; the build must fail")
	}
}

func manifestHasName(list []string, want string) bool {
	for _, name := range list {
		if name == want {
			return true
		}
	}
	return false
}
