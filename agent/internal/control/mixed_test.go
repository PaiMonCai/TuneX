package control

import (
	"slices"
	"testing"
)

func TestNativeBothCapabilityRequiresConstructedNativeRuntime(t *testing.T) {
	for _, facts := range []RuntimeFacts{{}, {FXPLink: true}, {PolicyRuntime: true}} {
		if slices.Contains(Capabilities(facts), CapabilityNativeBoth) {
			t.Fatal("unconstructed native both advertised")
		}
	}
	if !slices.Contains(Capabilities(RuntimeFacts{NativeBoth: true}), CapabilityNativeBoth) {
		t.Fatal("constructed native both missing")
	}
}
