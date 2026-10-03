package reporter

import (
	"encoding/json"
	"testing"
)

// V5-WP1: the state report carries the additive v2 capability manifest.
//
// The distinction that matters is the same one as WP11B's: "absent" means the
// agent never described itself (the panel falls back to the V4 baseline), while
// an empty list means "I implement nothing" (the panel fails closed). Sending a
// zero-valued manifest for an unconfigured reporter would erase that difference.

func TestManifestOmittedWhenNotConfigured(t *testing.T) {
	p := New(Config{PanelURL: "http://panel.invalid", NodeID: "n1"}, WithProtocol(2, []string{"apply_tunnel"})).StatePayload()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := decoded["capability_manifest"]; present {
		t.Fatalf("capability_manifest must be absent when not configured (got %v)", decoded["capability_manifest"])
	}
}

func TestManifestTravelsOnTheWire(t *testing.T) {
	manifest := &CapabilityManifest{
		SchemaVersion: 2,
		Protocols:     []string{"tcp"},
		Transports:    []string{"stream"},
		Runtime:       []string{"graceful_drain", "hot_reload"},
		Diagnostics:   []string{"tunnel_probe"},
	}
	p := New(
		Config{PanelURL: "http://panel.invalid", NodeID: "n1"},
		WithProtocol(2, []string{"apply_tunnel"}),
		WithManifest(manifest),
	).StatePayload()

	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	node, ok := decoded["capability_manifest"].(map[string]any)
	if !ok {
		t.Fatalf("wire field capability_manifest missing or wrong shape: %v", decoded["capability_manifest"])
	}
	if node["schema_version"] != float64(2) {
		t.Fatalf("schema_version mismatch: %v", node["schema_version"])
	}
	protocols, ok := node["protocols"].([]any)
	if !ok || len(protocols) != 1 || protocols[0] != "tcp" {
		t.Fatalf("protocols mismatch: %v", node["protocols"])
	}
	// The panel normalises missing dimensions to "empty", so a dimension the
	// agent does not report must still be present as an array rather than null:
	// null would be indistinguishable from a malformed payload.
	for _, key := range []string{"protocols", "transports", "runtime", "diagnostics"} {
		if _, ok := node[key].([]any); !ok {
			t.Fatalf("dimension %q must serialize as an array, got %v", key, node[key])
		}
	}
}

// A nil manifest must be storable without panicking, and must clear any
// previously configured manifest.
func TestWithManifestNilClears(t *testing.T) {
	r := New(
		Config{PanelURL: "http://panel.invalid", NodeID: "n1"},
		WithManifest(&CapabilityManifest{SchemaVersion: 2, Protocols: []string{"tcp"}}),
		WithManifest(nil),
	)
	if p := r.StatePayload(); p.CapabilityManifest != nil {
		t.Fatalf("a nil manifest must clear the advertisement, got %v", p.CapabilityManifest)
	}
}

// The injected manifest is copied: a caller mutating its own slices afterwards
// must not change what the agent advertises.
func TestWithManifestCopiesLists(t *testing.T) {
	protocols := []string{"tcp"}
	manifest := &CapabilityManifest{SchemaVersion: 2, Protocols: protocols}
	r := New(Config{PanelURL: "http://panel.invalid", NodeID: "n1"}, WithManifest(manifest))
	protocols[0] = "mutated"
	manifest.Transports = []string{"mutated"}

	p := r.StatePayload()
	if p.CapabilityManifest == nil {
		t.Fatal("manifest must be advertised")
	}
	if p.CapabilityManifest.Protocols[0] != "tcp" {
		t.Fatalf("WithManifest must copy the input slice, got %v", p.CapabilityManifest.Protocols)
	}
	if len(p.CapabilityManifest.Transports) != 0 {
		t.Fatalf("WithManifest must snapshot the struct, got %v", p.CapabilityManifest.Transports)
	}
	// And the payload itself must not alias the stored manifest.
	p.CapabilityManifest.Protocols[0] = "payload-mutated"
	if got := r.StatePayload().CapabilityManifest.Protocols[0]; got != "tcp" {
		t.Fatalf("a payload must not mutate the reporter's manifest, got %q", got)
	}
}
