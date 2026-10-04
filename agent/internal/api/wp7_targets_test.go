package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/manager"
)

// V5.2-WP7: the local hot-update surface (PATCH /node/targets) carries the same
// parallel `target_health` array as the control-plane dispatch. If it did not,
// an operator editing a pool here would silently switch the breaker off while
// the panel's own dispatch would have kept it running — two apply surfaces with
// two behaviours, which is the failure mode §13.3.4 exists to prevent.

func newHealthAdmin(t *testing.T) (*Server, *manager.EgressManager, *manager.TunnelManager) {
	t.Helper()
	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")
	srv, err := New(Options{ListenHost: "127.0.0.1", Token: "test-token"}, tunnels, egress, nil)
	if err != nil {
		t.Fatalf("api.New: %v", err)
	}
	return srv, egress, tunnels
}

func patchTargets(t *testing.T, srv *Server, body any) int {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPatch, "/node/targets", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec.Code
}

func TestAdminTargetsPatchCarriesTargetHealth(t *testing.T) {
	srv, egress, _ := newHealthAdmin(t)
	egress.SetPool("eg", manager.RoundRobin, []forwarder.Target{{Host: "10.0.0.1", Port: 443, Weight: 1}})

	code := patchTargets(t, srv, map[string]any{
		"tunnel_id": "eg",
		"strategy":  "ROUND_ROBIN",
		"targets":   []forwarder.Target{{Host: "10.0.0.1", Port: 443, Weight: 1}},
		"target_health": []forwarder.TargetHealth{
			{Host: "10.0.0.1", Port: 443, State: "unhealthy", Evidence: true},
		},
	})
	if code != http.StatusOK {
		t.Fatalf("PATCH /node/targets = %d, want 200", code)
	}
	states := egress.BreakerStates("eg")
	if len(states) != 1 || states[0].Breaker != "open" {
		t.Fatalf("breaker states = %+v, want the unhealthy target open", states)
	}

	// The same endpoint without a health array is the pre-WP7 payload and must
	// leave no mechanism behind.
	code = patchTargets(t, srv, map[string]any{
		"tunnel_id": "eg",
		"strategy":  "ROUND_ROBIN",
		"targets":   []forwarder.Target{{Host: "10.0.0.1", Port: 443, Weight: 1}},
	})
	if code != http.StatusOK {
		t.Fatalf("second PATCH = %d, want 200", code)
	}
	if got := egress.BreakerStates("eg"); len(got) != 0 {
		t.Fatalf("breaker states after a health-less PATCH = %+v, want none", got)
	}
}
