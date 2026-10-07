package linkrunner

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestHTTPSourceDesiredAuthIdentityAndReconcile(t *testing.T) {
	cfg := exitConfig(t, "from-panel", "tcp", freePort(t, "tcp"), 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/internal/node/desired" || r.Header.Get("Authorization") != "Bearer credential" {
			t.Errorf("wrong path/auth: %s", r.URL.Path)
			w.WriteHeader(400)
			return
		}
		// Production authenticates by node Bearer credential and includes numeric
		// node_db_id; it does not need to return agent_id in the desired snapshot.
		json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"snapshot": map[string]any{"version": "v1", "tunnels": []any{}, "node_db_id": 7, "links": []Config{cfg}}}})
	}))
	defer srv.Close()
	snap, err := (HTTPSource{PanelURL: srv.URL, Credential: "credential", AgentID: "agent-one"}).FetchSnapshot(context.Background())
	if err != nil || snap.NodeDBID != 7 || len(snap.Links) != 1 {
		t.Fatalf("snapshot: %+v %v", snap, err)
	}
	dir := t.TempDir()
	m := newTestManager(t, helperBinary(t), dir)
	statuses, err := m.Reconcile(snap)
	if err != nil || !statuses[0].Ready || m.NodeDBID() != 7 {
		t.Fatalf("reconcile: %+v %v", statuses, err)
	}
	if _, err := m.Reconcile(&Snapshot{NodeDBID: 8, Links: []Config{}}); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("identity switch: %v", err)
	}
	if !m.Status()[0].Ready {
		t.Fatal("invalid snapshot stopped child")
	}
	if _, err := m.Reconcile(&Snapshot{NodeDBID: 7, Links: []Config{}}); err != nil {
		t.Fatal(err)
	}
	if m.Status()[0].State != "removed" {
		t.Fatal("omitted child not fenced")
	}
	m.Close()
	r := newTestManager(t, helperBinary(t), dir)
	if r.NodeDBID() != 7 {
		t.Fatal("cached DB identity missing")
	}
}

func TestHTTPSourceBoundariesAndNeverRedirects(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
		want       error
	}{
		{"missing links", `{"data":{"snapshot":{"node_db_id":7,"tunnels":[]}}}`, 200, ErrSnapshot},
		{"null links", `{"data":{"snapshot":{"node_db_id":7,"links":null}}}`, 200, ErrSnapshot},
		{"missing node", `{"data":{"snapshot":{"links":[]}}}`, 200, ErrSnapshot},
		{"foreign agent", `{"data":{"snapshot":{"node_db_id":7,"agent_id":"other","links":[]}}}`, 200, ErrAgentMismatch},
		{"unauthorized", `{}`, 401, ErrPanelUnauthorized},
		{"outage", `{}`, 503, ErrPanelUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); w.Write([]byte(tc.body)) }))
			defer srv.Close()
			_, err := (HTTPSource{PanelURL: srv.URL, Credential: "secret", AgentID: "agent-one"}).FetchSnapshot(context.Background())
			if !errors.Is(err, tc.want) {
				t.Fatal(err)
			}
		})
	}
	var reached atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached.Store(true) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer redirect.Close()
	_, err := (HTTPSource{PanelURL: redirect.URL, Credential: "secret", Client: &http.Client{}}).FetchSnapshot(context.Background())
	if !errors.Is(err, ErrSnapshot) || reached.Load() {
		t.Fatalf("redirect followed: %v reached=%v", err, reached.Load())
	}
}
