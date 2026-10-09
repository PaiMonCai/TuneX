package control

import (
	"slices"
	"testing"
)

func TestSourceCapabilityRequiresConstructedLinkAndActualRunner(t *testing.T) {
	for _, facts := range []RuntimeFacts{{}, {FXPSource: true}, {FXPLink: true}, {PolicyRuntime: true, FXPSource: true}} {
		if slices.Contains(Capabilities(facts), CapabilityFXPSource) {
			t.Fatal("source capability without constructed/probed runtime", facts)
		}
	}
	if !slices.Contains(Capabilities(RuntimeFacts{FXPLink: true, FXPSource: true}), CapabilityFXPSource) {
		t.Fatal("constructed source runtime not advertised")
	}
}
