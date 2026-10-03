package reporter

import (
	"encoding/json"
	"testing"
)

// V4-WP11B: the state report carries the control-protocol negotiation facts.
// The distinction that matters is "absent" vs "empty": the panel decides whether
// it may send a non-baseline action from it, so an unconfigured agent must omit
// the fields rather than report zero values.

func TestProtocolFieldsOmittedWhenNotConfigured(t *testing.T) {
	p := New(Config{PanelURL: "http://panel.invalid", NodeID: "n1", Version: "0.13.22"}).StatePayload()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"control_protocol_version", "capabilities"} {
		if _, present := decoded[key]; present {
			t.Fatalf("%q must be absent when not configured (got %v); "+
				"the panel reads absence as 'this agent never told me'", key, decoded[key])
		}
	}
}

func TestProtocolFieldsReportedWhenConfigured(t *testing.T) {
	p := New(
		Config{PanelURL: "http://panel.invalid", NodeID: "n1", Version: "0.13.22"},
		WithProtocol(3, []string{"apply_tunnel", "remove_tunnel"}),
	).StatePayload()
	if p.ControlProtocolVersion != 3 {
		t.Fatalf("protocol version must be reported, got %d", p.ControlProtocolVersion)
	}
	if len(p.Capabilities) != 2 || p.Capabilities[0] != "apply_tunnel" {
		t.Fatalf("capabilities must be reported verbatim, got %v", p.Capabilities)
	}

	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded["control_protocol_version"] != float64(3) {
		t.Fatalf("wire field control_protocol_version mismatch: %v", decoded["control_protocol_version"])
	}
	caps, ok := decoded["capabilities"].([]any)
	if !ok || len(caps) != 2 {
		t.Fatalf("wire field capabilities mismatch: %v", decoded["capabilities"])
	}
}

// An empty capability list must be omitted too: on the wire, "[]" and "absent"
// would otherwise be indistinguishable after JSON round-tripping, and the panel
// treats those two cases differently.
func TestEmptyCapabilitiesAreOmitted(t *testing.T) {
	p := New(
		Config{PanelURL: "http://panel.invalid", NodeID: "n1"},
		WithProtocol(1, []string{}),
	).StatePayload()
	raw, _ := json.Marshal(p)
	var decoded map[string]any
	_ = json.Unmarshal(raw, &decoded)
	if _, present := decoded["capabilities"]; present {
		t.Fatalf("an empty capability list must be omitted, not serialized as []")
	}
	if decoded["control_protocol_version"] != float64(1) {
		t.Fatalf("the version is still a fact and must travel: %v", decoded["control_protocol_version"])
	}
}

// The injected slice is copied: a caller mutating its own slice afterwards must
// not change what the agent advertises.
func TestWithProtocolCopiesCapabilities(t *testing.T) {
	caps := []string{"apply_tunnel"}
	r := New(Config{PanelURL: "http://panel.invalid", NodeID: "n1"}, WithProtocol(1, caps))
	caps[0] = "mutated"
	if got := r.StatePayload().Capabilities; len(got) != 1 || got[0] != "apply_tunnel" {
		t.Fatalf("WithProtocol must copy the slice, got %v", got)
	}
}
