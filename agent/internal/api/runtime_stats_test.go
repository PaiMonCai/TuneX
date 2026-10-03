package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"

	"github.com/tunex/agent/internal/manager"
)

// V5-WP3: /debug/runtime exists so the TCP performance baseline can record
// goroutine count, which /proc cannot provide (it only has OS threads). These
// tests pin the two properties that matter for a measurement endpoint: it is
// authenticated like the rest of the management plane, and its numbers are real
// gauge readings rather than zero-valued placeholders.

func TestDebugRuntimeRequiresAuth(t *testing.T) {
	srv := newTestServer(t, manager.NewTunnelManager(manager.NewEgressManager(), ""))
	req := httptest.NewRequest(http.MethodGet, "/debug/runtime", nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated /debug/runtime must be 401, got %d", rec.Code)
	}
}

func TestDebugRuntimeRejectsNonGet(t *testing.T) {
	srv := newTestServer(t, manager.NewTunnelManager(manager.NewEgressManager(), ""))
	req := httptest.NewRequest(http.MethodPost, "/debug/runtime", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /debug/runtime must be 405, got %d", rec.Code)
	}
}

func TestDebugRuntimeReportsLiveGauges(t *testing.T) {
	srv := newTestServer(t, manager.NewTunnelManager(manager.NewEgressManager(), ""))
	// A goroutine that provably exists while the handler runs: the measurement
	// must see *this* process, not a copy or a zero value.
	blocked := make(chan struct{})
	started := make(chan struct{})
	go func() {
		close(started)
		<-blocked
	}()
	<-started
	defer close(blocked)

	req := httptest.NewRequest(http.MethodGet, "/debug/runtime", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var stats RuntimeStats
	if err := json.Unmarshal(rec.Body.Bytes(), &stats); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if stats.Goroutines < 2 {
		t.Fatalf("goroutines = %d, want at least the test's two live goroutines", stats.Goroutines)
	}
	if stats.GoVersion != runtime.Version() {
		t.Fatalf("go_version = %q, want %q", stats.GoVersion, runtime.Version())
	}
	if stats.GoMaxProcs < 1 {
		t.Fatalf("gomaxprocs = %d, want >= 1", stats.GoMaxProcs)
	}
	// Heap gauges must be non-zero in any process that has allocated at all:
	// a zero here would mean the JSON shape is wrong (wrong struct tag or a
	// forgotten field), and a baseline recorded with zeros is worse than none.
	if stats.HeapAllocBytes == 0 || stats.HeapSysBytes == 0 {
		t.Fatalf("heap gauges must be real readings, got alloc=%d sys=%d",
			stats.HeapAllocBytes, stats.HeapSysBytes)
	}
}
