package control

import (
	"slices"
	"testing"
)

func TestTargetCapabilityRequiresConstructedAndProbedFXP(t *testing.T) {
	for _, facts := range []RuntimeFacts{{}, {FXPTargets: true}, {FXPLink: true}, {PolicyRuntime: true, FXPTargets: true}} {
		if slices.Contains(Capabilities(facts), CapabilityFXPTargets) {
			t.Fatal("unsupported runtime advertises multi-target capability", facts)
		}
	}
	if !slices.Contains(Capabilities(RuntimeFacts{FXPLink: true, FXPTargets: true}), CapabilityFXPTargets) {
		t.Fatal("constructed/probed runtime omits capability")
	}
}
