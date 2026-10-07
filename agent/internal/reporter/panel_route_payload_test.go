package reporter

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tunex/agent/internal/panelroute"
)

type switchRouteDuringPorts struct {
	once   sync.Once
	router *panelroute.Router
}

func (p *switchRouteDuringPorts) UsedPorts() map[int]bool {
	p.once.Do(func() {
		// Emulate the control loop switching after the reporter snapshots its
		// route, but before it finishes collecting and sending the payload.
		p.router.NoteOutcome(panelroute.PanelOutcomeFailure, time.Now())
		p.router.NoteOutcome(panelroute.PanelOutcomeFailure, time.Now())
	})
	return nil
}

func TestStateReportDestinationMatchesPayloadDuringSwitch(t *testing.T) {
	cases := []struct {
		name string
		send func(*Reporter) error
	}{
		{"periodic", func(r *Reporter) error { r.sendState(context.Background()); return nil }},
		{"shutdown", func(r *Reporter) error { return r.ReportOnce(context.Background()) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			const primary = "http://primary.invalid"
			const fallback = "http://fallback.invalid"
			router := panelroute.New(panelroute.Config{
				PrimaryURL: primary,
				Migration:  panelroute.PanelMigration{FallbackURL: fallback, MigrationID: "snapshot-test"},
			})
			var destinations []string
			var payloads []StatePayload
			r := New(Config{PanelURL: primary, Credential: " cred ", Router: router},
				WithPorts(&switchRouteDuringPorts{router: router}),
				WithPostResponse(func(_ context.Context, endpoint string, body []byte, headers map[string]string) ([]byte, error) {
					var payload StatePayload
					if err := json.Unmarshal(body, &payload); err != nil {
						return nil, err
					}
					if got := headers[CredentialHeader]; got != "Bearer cred" {
						t.Fatalf("credential header = %q", got)
					}
					destinations = append(destinations, strings.TrimSuffix(endpoint, StatePath))
					payloads = append(payloads, payload)
					return nil, nil
				}))
			if err := tc.send(r); err != nil {
				t.Fatal(err)
			}
			if !router.InFallback() {
				t.Fatal("the route must switch while the first payload is collected")
			}
			if err := tc.send(r); err != nil {
				t.Fatal(err)
			}
			if len(destinations) != 2 {
				t.Fatalf("reports sent = %d, want 2", len(destinations))
			}
			for i, want := range []string{primary, fallback} {
				if destinations[i] != want || payloads[i].PanelURLInUse != want {
					t.Fatalf("report %d: destination=%q payload_url=%q, want both %q", i, destinations[i], payloads[i].PanelURLInUse, want)
				}
				if payloads[i].PanelFallbackActive != (i == 1) || payloads[i].PanelMigrationID != "snapshot-test" {
					t.Fatalf("report %d: inconsistent migration fields: %+v", i, payloads[i])
				}
			}
		})
	}
}

type unexpectedPortCollection struct{}

func (unexpectedPortCollection) UsedPorts() map[int]bool {
	panic("a disabled reporter must not collect its payload")
}

func TestStateRequestPreservesDisabledReporting(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
	}{
		{"no panel", Config{Credential: "cred"}},
		{"no credential", Config{PanelURL: "http://primary.invalid"}},
		{"blank credential", Config{PanelURL: "http://primary.invalid", Credential: "  "}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := New(tc.cfg, WithPorts(unexpectedPortCollection{}),
				WithPostResponse(func(context.Context, string, []byte, map[string]string) ([]byte, error) {
					t.Fatal("disabled reporter attempted a request")
					return nil, nil
				}))
			r.sendState(context.Background())
			if err := r.ReportOnce(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
	}
	var nilReporter *Reporter
	if err := nilReporter.ReportOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
}
