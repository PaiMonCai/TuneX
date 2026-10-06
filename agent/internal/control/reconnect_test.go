package control

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tunex/agent/internal/manager"
)

// The reconnect hook is what makes an agent that booted during a panel outage
// reconcile once the panel answers again. Two situations must trigger
// it, and a healthy boot must not:
//
//	· this process watched the panel go away and come back;
//	· this process restored from the local cache because the panel was down at
//	  boot (it never saw a failed pull of its own — the case that used to leave a
//	  deleted Forward running forever).
func TestReconnectHookTransitions(t *testing.T) {
	t.Run("healthy boot does not reconcile", func(t *testing.T) {
		calls := int32(0)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"data":{"command":null}}`))
		}))
		defer srv.Close()

		client := newReconnectClient(t, srv.URL, func(context.Context) { atomic.AddInt32(&calls, 1) })
		runBriefly(t, client)
		if got := atomic.LoadInt32(&calls); got != 0 {
			t.Fatalf("a healthy boot must not reconcile, got %d calls", got)
		}
	})

	t.Run("outage then recovery reconciles once", func(t *testing.T) {
		calls := int32(0)
		var down atomic.Bool
		down.Store(true)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if down.Load() {
				w.WriteHeader(http.StatusBadGateway)
				return
			}
			_, _ = w.Write([]byte(`{"data":{"command":null}}`))
		}))
		defer srv.Close()

		client := newReconnectClient(t, srv.URL, func(context.Context) { atomic.AddInt32(&calls, 1) })
		stop := startRun(client)
		time.Sleep(1500 * time.Millisecond) // at least one failed pull
		down.Store(false)
		time.Sleep(2500 * time.Millisecond) // recovery, then a few clean pulls
		stop()

		if got := atomic.LoadInt32(&calls); got != 1 {
			t.Fatalf("expected exactly one reconcile after recovery, got %d", got)
		}
	})

	t.Run("boot during an outage reconciles when the panel returns", func(t *testing.T) {
		calls := int32(0)
		var down atomic.Bool
		down.Store(true)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if down.Load() {
				w.WriteHeader(http.StatusBadGateway)
				return
			}
			_, _ = w.Write([]byte(`{"data":{"command":null}}`))
		}))
		defer srv.Close()

		client := newReconnectClient(t, srv.URL, func(context.Context) { atomic.AddInt32(&calls, 1) })
		// The runtime marks this when the startup restore used the local cache.
		client.MarkStartupFromCache()
		stop := startRun(client)
		time.Sleep(1200 * time.Millisecond)
		down.Store(false)
		time.Sleep(2500 * time.Millisecond)
		stop()

		if got := atomic.LoadInt32(&calls); got != 1 {
			t.Fatalf("a node that booted from cache must reconcile exactly once, got %d", got)
		}
	})

	t.Run("boot from cache with a healthy panel reconciles once", func(t *testing.T) {
		calls := int32(0)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"data":{"command":null}}`))
		}))
		defer srv.Close()

		client := newReconnectClient(t, srv.URL, func(context.Context) { atomic.AddInt32(&calls, 1) })
		client.MarkStartupFromCache()
		stop := startRun(client)
		time.Sleep(2500 * time.Millisecond)
		stop()

		if got := atomic.LoadInt32(&calls); got != 1 {
			t.Fatalf("a cache-booted node must reconcile once, got %d", got)
		}
	})
}

func newReconnectClient(t *testing.T, panelURL string, onReconnect func(context.Context)) *Client {
	t.Helper()
	egress := manager.NewEgressManager()
	client := New(Config{
		PanelURL:    panelURL,
		Credential:  "cred",
		Reconnected: onReconnect,
	}, manager.NewTunnelManager(egress, "127.0.0.1"), egress)
	return client
}

func startRun(client *Client) func() {
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = client.Run(ctx) }()
	return cancel
}

func runBriefly(t *testing.T, client *Client) {
	t.Helper()
	stop := startRun(client)
	time.Sleep(1500 * time.Millisecond)
	stop()
}
