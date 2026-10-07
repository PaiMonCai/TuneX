package linkrunner

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestHTTPSourceDesiredAuthIdentityAndReconcile(t *testing.T) {
	// Keep the child port reserved while httptest allocates its listener and
	// FetchSnapshot opens its client connection. A released ephemeral port can
	// be reused by either socket before the helper starts, especially on Linux.
	reservation, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer reservation.Close()
	cfg := exitConfig(t, "from-panel", "tcp", reservation.Addr().(*net.TCPAddr).Port, 1)
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
	if err := reservation.Close(); err != nil {
		t.Fatal(err)
	}
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

func TestHTTPSourceDesiredBindCollisionFailsClosed(t *testing.T) {
	// Deterministically reproduce an occupied port between desired fetch and
	// child startup. The helper exits with code 3 before emitting any readiness
	// markers; this must remain an error, not trigger a launch retry.
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	cfg := exitConfig(t, "from-panel", "tcp", occupied.Addr().(*net.TCPAddr).Port, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"snapshot": Snapshot{NodeDBID: 7, Links: []Config{cfg}}}})
	}))
	defer srv.Close()
	snap, err := (HTTPSource{PanelURL: srv.URL, Credential: "credential", AgentID: "agent-one"}).FetchSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	m := newTestManager(t, helperBinary(t), t.TempDir())
	canonical := cloneConfig(snap.Links[0])
	deadline, expected, err := validateConfig(&canonical)
	if err != nil {
		t.Fatal(err)
	}
	p, err := startChild(m.binaryPath, m.runtimeDir, canonical, deadline, expected)
	if !errors.Is(err, ErrProcessExited) || p == nil {
		t.Fatalf("occupied startup: child=%v error=%v", p != nil, err)
	}
	<-p.done
	if p.exitCode != 3 || len(p.logs) != 0 {
		t.Fatalf("bind failure signature: exit=%d logs=%v", p.exitCode, p.logs)
	}
	statuses, err := m.Reconcile(snap)
	if !errors.Is(err, ErrProcessExited) || len(statuses) != 1 || statuses[0].Ready || statuses[0].State != "failed" || len(statuses[0].Logs) != 0 || m.NodeDBID() != 7 {
		t.Fatalf("occupied desired must fail closed: %+v %v", statuses, err)
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
