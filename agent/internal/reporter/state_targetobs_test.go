package reporter

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/targetobs"
)

// V5.2-WP5: the observation facts ride the EXISTING state report as a new
// top-level key. The two things worth guarding are that the key is additive
// (an older panel keeps seeing everything it saw before, and an older agent
// simply omits the key) and that `observation_age` never appears on the wire —
// age is derived by the panel at read time (DEVELOPMENT.md §7 row 7), so a
// stored one would be wrong from the moment it was written.

type staticObservations []targetobs.Observation

func (s staticObservations) TargetObservations() []targetobs.Observation { return s }

func TestStateReportCarriesTargetObservationsAdditively(t *testing.T) {
	latency := int64(7)
	observations := staticObservations{{
		Host: "example.com", Port: 443,
		Reachable: true, LatencyMS: &latency,
		ConsecutiveSuccess: 3, ConsecutiveFailure: 0,
		SuccessRate: 0.9, LastObservedAt: 1_700_000_000,
		ObservationSource: "node-1/tcp_connect",
	}}
	r := New(
		Config{PanelURL: "http://panel.invalid", AgentID: "agent-1", NodeID: "node-1", Credential: "cred"},
		WithTunnels(staticTunnels{}),
		WithEgress(staticEgress{}),
		WithTargetObservations(observations),
	)

	raw, err := json.Marshal(r.StatePayload())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if containsKey(raw, "observation_age") {
		t.Fatalf("state report must never carry observation_age: %s", raw)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// Additive: the pre-existing top-level keys are untouched.
	for _, key := range []string{"agent_id", "tunnels", "egress_pools"} {
		if _, present := decoded[key]; !present {
			t.Errorf("existing key %q disappeared from the state report: %s", key, raw)
		}
	}

	list, ok := decoded["target_observations"].([]any)
	if !ok || len(list) != 1 {
		t.Fatalf("target_observations missing or wrong shape: %v", decoded["target_observations"])
	}
	entry, _ := list[0].(map[string]any)
	for key, want := range map[string]any{
		"host":                "example.com",
		"port":                float64(443),
		"reachable":           true,
		"latency_ms":          float64(7),
		"consecutive_success": float64(3),
		"consecutive_failure": float64(0),
		"success_rate":        0.9,
		"last_observed_at":    float64(1_700_000_000),
		"observation_source":  "node-1/tcp_connect",
	} {
		if entry[key] != want {
			t.Errorf("target_observations[0].%s = %v, want %v", key, entry[key], want)
		}
	}
}

func TestStateReportOmitsTargetObservationsWithoutASource(t *testing.T) {
	// No observer wired: the key must be absent, not an empty array. The panel
	// reads absence as "unknown"; an empty array would read as "we looked and
	// every target is fine", which is a claim this agent never made.
	r := New(Config{PanelURL: "http://panel.invalid", NodeID: "node-1", Credential: "cred"})
	raw, err := json.Marshal(r.StatePayload())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if containsKey(raw, "target_observations") {
		t.Fatalf("target_observations must be absent when no observer is wired: %s", raw)
	}

	// main passes the option unconditionally with a nil interface when the
	// observer did not start, so an explicit nil must behave exactly the same
	// way. (A typed-nil pointer here would be a non-nil interface and panic on
	// the first call, which is why the wiring passes an interface variable.)
	r = New(
		Config{PanelURL: "http://panel.invalid", NodeID: "node-1", Credential: "cred"},
		WithTargetObservations(nil),
	)
	raw, err = json.Marshal(r.StatePayload())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if containsKey(raw, "target_observations") {
		t.Fatalf("a nil observation source must stay off the wire: %s", raw)
	}
}

func TestStateReportOmitsTargetObservationsWhenNothingWasObserved(t *testing.T) {
	r := New(
		Config{PanelURL: "http://panel.invalid", NodeID: "node-1", Credential: "cred"},
		WithTargetObservations(staticObservations{}),
	)
	raw, err := json.Marshal(r.StatePayload())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if containsKey(raw, "target_observations") {
		t.Fatalf("an empty observation set must stay off the wire: %s", raw)
	}
}

func TestStateReportPostsTargetObservations(t *testing.T) {
	var body []byte
	var sawCredential string
	r := New(
		Config{PanelURL: "http://panel.invalid", NodeID: "node-1", Credential: "cred"},
		WithTargetObservations(staticObservations{{
			Host: "10.0.0.5", Port: 443,
			Reachable: false, SuccessRate: 0, ConsecutiveFailure: 2,
			LastObservedAt: 1_700_000_000, ObservationSource: "node-1/tcp_connect",
		}}),
		WithPost(func(_ context.Context, _ string, b []byte, headers map[string]string) error {
			body = b
			sawCredential = headers[CredentialHeader]
			return nil
		}),
	)
	if err := r.ReportOnce(context.Background()); err != nil {
		t.Fatalf("ReportOnce: %v", err)
	}
	if sawCredential != "Bearer cred" {
		t.Errorf("credential header = %q", sawCredential)
	}
	if !containsKey(body, "target_observations") {
		t.Fatalf("posted state report is missing target_observations: %s", body)
	}
	// The unreachable case is the one the panel must render as a fact, so its
	// explicit null latency is asserted on the posted bytes too.
	if !bytes.Contains(body, []byte(`"latency_ms":null`)) {
		t.Fatalf("posted observation must carry an explicit null latency_ms: %s", body)
	}
	var decoded struct {
		Observations []map[string]any `json:"target_observations"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal posted body: %v", err)
	}
	if len(decoded.Observations) != 1 || decoded.Observations[0]["latency_ms"] != nil {
		t.Fatalf("unreachable observation must post latency_ms:null, got %v", decoded.Observations)
	}
}

// containsKey is a raw-bytes check, deliberately: it is the only way to tell
// "the key is absent" from "the key is present and null/empty" after a
// round-trip through a struct that would fill in the zero value.
func containsKey(raw []byte, key string) bool {
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return false
	}
	_, ok := decoded[key]
	return ok
}

// staticTunnels / staticEgress are minimal sources standing in for the manager,
// so the additive test can assert the old keys are still emitted.
type staticTunnels struct{}

func (staticTunnels) List() []forwarder.TunnelConfig {
	return []forwarder.TunnelConfig{{
		ID: "t1", Mode: forwarder.ModeDirect, IngressPort: 19000,
		RemoteHost: "127.0.0.1", RemotePort: 8080, Protocol: forwarder.ProtocolTCP,
	}}
}

type staticEgress struct{}

func (staticEgress) Snapshot() map[string]EgressPool {
	return map[string]EgressPool{"t1": {Strategy: "ROUND_ROBIN", Targets: []string{"10.0.0.5:443"}}}
}
