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
	status := []linkrunner.Observation{{
		ID: "tunex-link-8-p2-egress", LinkID: 8, WorkspaceID: 7, NodeID: 2, Role: "egress",
		Generation: 6, ObservedGeneration: 5, DesiredConfigDigest: strings.Repeat("a", 64),
		ConfigDigest: strings.Repeat("b", 64), Ready: true, State: "rolled_back",
		LeaseExpiresAt: "2026-10-07T08:00:00Z", RuntimeIDs: []string{"link-8-exit-tcp"},
		Ports: []linkrunner.Port{{Protocol: "tcp", Host: "", Port: 22000}},
		PID:   1234, Logs: []string{"runner key=secret-output"}, LastError: "secret-arbitrary-error",
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
	if (*copy.LinkPlacements)[0].Ports[0].Port != 22000 || (*copy.LinkPlacements)[0].RuntimeIDs[0] != "link-8-exit-tcp" {
		t.Fatal("placement report aliases runtime state")
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
