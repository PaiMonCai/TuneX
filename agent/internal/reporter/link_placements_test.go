package reporter

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/tunex/agent/internal/linkrunner"
)

func TestLinkPlacementsReachTheAuthenticatedStateReportWithoutSecrets(t *testing.T) {
	ack := "2026-10-07T07:59:00.123456789Z"
	status := []linkrunner.Observation{{
		ID: "tunex-link-8-p2-egress", LinkID: 8, WorkspaceID: 7, NodeID: 2, Role: "egress",
		Generation: 6, ObservedGeneration: 5, DesiredConfigDigest: strings.Repeat("a", 64),
		ConfigDigest: strings.Repeat("b", 64), Ready: true, State: "rolled_back",
		LeaseExpiresAt: "2026-10-07T08:00:00Z", RuntimeIDs: []string{"link-8-exit-tcp"},
		Ports: []linkrunner.Port{{Protocol: "tcp", Host: "", Port: 22000}},
		PID:   1234, Logs: []string{"runner key=secret-output"}, LastError: "secret-arbitrary-error",
		TrafficStatus: &linkrunner.TrafficStatus{RotationSupported: true, ProducerCount: 2, SampleCount: 500,
			RuleCount: 250, SpoolBytes: 123456, LastAckAt: &ack, State: "blocked"},
	}}
	var sent [][]byte
	r := New(Config{PanelURL: "http://panel.invalid", NodeID: "n2", Credential: "credential"},
		WithLinkPlacements(func() []linkrunner.Observation { return status }),
		WithPost(func(_ context.Context, url string, body []byte, headers map[string]string) error {
			if !strings.HasSuffix(url, StatePath) || headers[CredentialHeader] != "Bearer credential" {
				t.Fatal("Link facts must use the authenticated state channel")
			}
			sent = append(sent, append([]byte(nil), body...))
			return nil
		}),
	)
	if err := r.ReportOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"secret", "logs", "pid", "last_error", "runner_config", "transport_key"} {
		if bytes.Contains(sent[0], []byte(forbidden)) {
			t.Fatalf("report leaked forbidden field/content %q", forbidden)
		}
	}
	var payload struct {
		Placements []LinkPlacement `json:"link_placements"`
	}
	if err := json.Unmarshal(sent[0], &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Placements) != 1 || payload.Placements[0].Generation != 6 || payload.Placements[0].ObservedGeneration != 5 || !payload.Placements[0].Ready {
		t.Fatalf("rollback facts lost: %+v", payload.Placements)
	}
	if got := payload.Placements[0].TrafficStatus; got == nil || got.State != "blocked" || got.LastAckAt == nil || *got.LastAckAt != ack {
		t.Fatalf("statistics receipt lost or confused with runtime state: %+v", got)
	}
	// The heartbeat pulls a new observation, rather than repeating an apply ACK.
	status[0].Ready, status[0].State, status[0].ObservedGeneration = false, "exited", 0
	if err := r.ReportOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(sent[1], &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Placements[0].Ready || payload.Placements[0].State != "exited" {
		t.Fatal("stale readiness repeated")
	}
	// Deep copies prevent the next status read from changing an in-flight report.
	copy := r.StatePayload()
	status[0].Ports[0].Port, status[0].RuntimeIDs[0] = 23000, "changed"
	status[0].TrafficStatus.ProducerCount = 99
	ack = "2026-10-07T08:00:00Z"
	if (*copy.LinkPlacements)[0].Ports[0].Port != 22000 || (*copy.LinkPlacements)[0].RuntimeIDs[0] != "link-8-exit-tcp" {
		t.Fatal("placement report aliases runtime state")
	}
	if got := (*copy.LinkPlacements)[0].TrafficStatus; got.ProducerCount != 2 || *got.LastAckAt != "2026-10-07T07:59:00.123456789Z" {
		t.Fatal("statistics report aliases runtime state or receipt pointer")
	}
}

func TestLinkPlacementTrafficStatusOptionalAndClosed(t *testing.T) {
	observation := linkrunner.Observation{ID: "placement-1", LinkID: 1, WorkspaceID: 2, NodeID: 3,
		Generation: 4, ObservedGeneration: 4, Ready: false, State: "failed"}
	encode := func() map[string]json.RawMessage {
		t.Helper()
		payload, err := json.Marshal((*reportedLinkPlacements([]linkrunner.Observation{observation}))[0])
		if err != nil {
			t.Fatal(err)
		}
		var result map[string]json.RawMessage
		if err := json.Unmarshal(payload, &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	if _, ok := encode()["traffic_status"]; ok {
		t.Fatal("old observation invented capacity")
	}
	for _, state := range []string{"idle", "collecting", "backlogged", "blocked"} {
		observation.TrafficStatus = &linkrunner.TrafficStatus{State: state}
		payload := encode()
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(payload["traffic_status"], &fields); err != nil {
			t.Fatal(err)
		}
		if len(fields) != 7 || string(fields["last_ack_at"]) != "null" || string(fields["rotation_supported"]) != "false" ||
			string(fields["producer_count"]) != "0" || string(fields["sample_count"]) != "0" || string(fields["rule_count"]) != "0" ||
			string(fields["spool_bytes"]) != "0" || string(payload["ready"]) != "false" || string(payload["state"]) != `"failed"` {
			t.Fatalf("closed zero snapshot changed readiness or omitted capacity: %+v", fields)
		}
	}
	observation.TrafficStatus = &linkrunner.TrafficStatus{State: "backlogged", RotationSupported: true,
		ProducerCount: 128, SampleCount: 262144, RuleCount: 262144, SpoolBytes: 403701760}
	if _, ok := encode()["traffic_status"]; !ok {
		t.Fatal("inclusive capacity bounds rejected")
	}
}

func TestLinkPlacementTrafficStatusRejectsInvalidFacts(t *testing.T) {
	valid := linkrunner.TrafficStatus{State: "collecting"}
	for _, mutate := range []func(*linkrunner.TrafficStatus){
		func(s *linkrunner.TrafficStatus) { s.ProducerCount = -1 },
		func(s *linkrunner.TrafficStatus) { s.ProducerCount = 129 },
		func(s *linkrunner.TrafficStatus) { s.SampleCount = -1 },
		func(s *linkrunner.TrafficStatus) { s.SampleCount = 262145 },
		func(s *linkrunner.TrafficStatus) { s.RuleCount = -1 },
		func(s *linkrunner.TrafficStatus) { s.RuleCount = 262145 },
		func(s *linkrunner.TrafficStatus) { s.SpoolBytes = -1 },
		func(s *linkrunner.TrafficStatus) { s.SpoolBytes = 403701761 },
		func(s *linkrunner.TrafficStatus) { s.State = "ready" },
		func(s *linkrunner.TrafficStatus) { s.State = "credential=secret" },
	} {
		value := valid
		mutate(&value)
		if reportedTrafficStatus(&value) != nil {
			t.Fatalf("invalid capacity accepted: %+v", value)
		}
	}
	for _, ack := range []string{"", "key=secret", "2029-01-01", "2029-01-01T00:00:00", "2029-02-29T00:00:00Z",
		"2029-02-30T00:00:00Z", "2029-04-31T00:00:00+08:00", "2029-01-01T24:00:00Z", "2029-01-01T00:60:00Z",
		"2029-01-01T00:00:60Z", "2029-01-01T00:00:00+24:00", "2029-01-01T00:00:00+08:60", "2029-01-01T00:00:00Z\n"} {
		value := valid
		value.LastAckAt = &ack
		if reportedTrafficStatus(&value) != nil {
			t.Fatalf("invalid statistics ACK accepted: %q", ack)
		}
	}
	for _, ack := range []string{"2028-02-29T23:59:59Z", "2029-01-01T08:00:00.123+08:00", "2029-01-01T00:00:00.123456789-05:30"} {
		value := valid
		value.LastAckAt = &ack
		if reportedTrafficStatus(&value) == nil {
			t.Fatalf("valid statistics ACK rejected: %q", ack)
		}
	}
}

func TestLinkPlacementReportsDistinguishUnknownFromEmpty(t *testing.T) {
	for _, r := range []*Reporter{
		New(Config{}),
		New(Config{}, WithLinkPlacements(func() []linkrunner.Observation { return nil })),
	} {
		raw, err := json.Marshal(r.StatePayload())
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(raw, []byte("link_placements")) {
			t.Fatal("unknown snapshot became an idle claim")
		}
	}
	r := New(Config{}, WithLinkPlacements(func() []linkrunner.Observation { return []linkrunner.Observation{} }))
	raw, err := json.Marshal(r.StatePayload())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte(`"link_placements":[]`)) {
		t.Fatalf("configured empty snapshot missing: %s", raw)
	}
	// An unknown remove fence carries no ownership metadata and makes no claim.
	r = New(Config{}, WithLinkPlacements(func() []linkrunner.Observation {
		return []linkrunner.Observation{{ID: "unowned-remove-fence", Generation: 1, State: "removed"}}
	}))
	if got := r.StatePayload().LinkPlacements; got == nil || len(*got) != 0 {
		t.Fatal("unowned fence reported")
	}
}
