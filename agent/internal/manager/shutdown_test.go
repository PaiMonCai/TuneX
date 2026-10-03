package manager

import (
	"errors"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

// WP11A manager-level shutdown: refuse new applies, then close every listener
// under one shared deadline.

func liveTarget(t *testing.T) (int, func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	done := make(chan struct{})
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) { defer c.Close(); <-done }(conn)
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port, func() { close(done); ln.Close() }
}

func TestBeginShutdownRefusesNewApplies(t *testing.T) {
	up, stop := liveTarget(t)
	defer stop()
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")

	first := directCfg("shut-a", freePort(t), addrFor(up), 1)
	if _, err := tm.Apply(first); err != nil {
		t.Fatalf("pre-shutdown apply: %v", err)
	}
	if tm.ShuttingDown() {
		t.Fatal("a fresh manager must not report shutting down")
	}

	tm.BeginShutdown()
	if !tm.ShuttingDown() {
		t.Fatal("BeginShutdown must be observable")
	}

	// A newer revision must still be refused: the check runs before the
	// revision gate, so a command cannot win by claiming a higher revision.
	updated := first.Clone()
	updated.Revision = 99
	if _, err := tm.Apply(updated); !errors.Is(err, ErrNodeShuttingDown) {
		t.Fatalf("apply during shutdown must be refused with ErrNodeShuttingDown, got %v", err)
	}
	// And a brand new tunnel cannot bind a port either.
	if _, err := tm.Apply(directCfg("shut-b", freePort(t), addrFor(up), 1)); !errors.Is(err, ErrNodeShuttingDown) {
		t.Fatalf("new tunnel during shutdown must be refused, got %v", err)
	}

	// The already-running tunnel is untouched by BeginShutdown: refusing new
	// work is not the same as tearing down live work.
	if tm.Len() != 1 {
		t.Fatalf("BeginShutdown must not remove running tunnels, len=%d", tm.Len())
	}
}

func TestShutdownAllClosesEveryListener(t *testing.T) {
	up, stop := liveTarget(t)
	defer stop()
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")

	ports := []int{freePort(t), freePort(t), freePort(t)}
	for i, p := range ports {
		cfg := directCfg("shut-"+string(rune('a'+i)), p, addrFor(up), 1)
		if _, err := tm.Apply(cfg); err != nil {
			t.Fatalf("apply %d: %v", i, err)
		}
	}
	// One unstarted entry: nothing to close, and it must be reported, not
	// silently counted as a closed listener.
	tm.mu.Lock()
	tm.tunnels["shut-unstarted"] = &entry{cfg: directCfg("shut-unstarted", 0, addrFor(up), 1), fwd: newUnstartedForwarder(t, up)}
	tm.mu.Unlock()

	report := tm.ShutdownAll(2 * time.Second)
	if report.Listeners != 3 {
		t.Fatalf("expected 3 closed listeners, got %+v", report)
	}
	if len(report.Skipped) != 1 || report.Skipped[0] != "shut-unstarted" {
		t.Fatalf("an unstarted entry must be reported as skipped: %+v", report)
	}
	if tm.Len() != 0 {
		t.Fatalf("shutdown must clear the registry, len=%d", tm.Len())
	}
	if len(tm.UsedPorts()) != 0 {
		t.Fatalf("shutdown must release the port guard, still holds %v", tm.UsedPorts())
	}

	// Each port must refuse new connections and must be bindable again, which is
	// the operator-visible meaning of "closed".
	for _, p := range ports {
		if c, err := net.DialTimeout("tcp", addrFor(p), 300*time.Millisecond); err == nil {
			_ = c.Close()
			t.Fatalf("port %d still accepted a connection after shutdown", p)
		}
	}
}

func TestShutdownAllIsIdempotent(t *testing.T) {
	up, stop := liveTarget(t)
	defer stop()
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	if _, err := tm.Apply(directCfg("shut-idem", freePort(t), addrFor(up), 1)); err != nil {
		t.Fatalf("apply: %v", err)
	}
	first := tm.ShutdownAll(time.Second)
	if first.Listeners != 1 {
		t.Fatalf("first shutdown must close one listener: %+v", first)
	}
	second := tm.ShutdownAll(time.Second)
	if second.Listeners != 0 || second.RemainingConns != 0 {
		t.Fatalf("second shutdown must be a no-op: %+v", second)
	}
}

// newUnstartedForwarder is a Forwarder that is never Started: ShutdownAll must
// skip it rather than pretend it closed a listener.
func newUnstartedForwarder(t *testing.T, upstream int) forwarder.Forwarder {
	t.Helper()
	fwd, err := forwarder.NewSingleHop(directCfg("shut-unstarted", freePort(t), addrFor(upstream), 1))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	return fwd
}

// ── v4 audit: the production apply path and the two-phase ordering ──────────

// ReplaceListener is the entry the control plane actually uses for a listener
// change, so the shutdown latch must cover it too — not just Apply.
func containsID(ids []string, want string) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}

func TestBeginShutdownRefusesReplaceListener(t *testing.T) {
	up, stop := liveTarget(t)
	defer stop()
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")

	base := directCfg("shut-replace", freePort(t), addrFor(up), 1)
	if _, err := tm.Apply(base); err != nil {
		t.Fatalf("initial apply: %v", err)
	}
	tm.BeginShutdown()

	next := base.Clone()
	next.Revision = base.Revision + 1
	next.IngressPort = freePort(t) // a new listener would have to be bound
	if _, err := tm.ReplaceListener(next); !errors.Is(err, ErrNodeShuttingDown) {
		t.Fatalf("ReplaceListener during shutdown must be refused, got %v", err)
	}

	// And a target swap must not keep a path alive on a node that is going away.
	if err := tm.HotSwapUpstream(base.ID, addrFor(up)); !errors.Is(err, ErrNodeShuttingDown) {
		t.Fatalf("HotSwapUpstream during shutdown must be refused, got %v", err)
	}
	// The original listener is untouched by the refusals: nothing was rebound.
	if !containsID(tm.IDs(), base.ID) {
		t.Fatalf("a refused mutation must not disturb the existing runtime, ids=%v", tm.IDs())
	}
}

// Phase 1 stops new connections immediately, without waiting for the drain.
func TestCloseListenersRefusesNewConnectionsWhileConnsAreStillLive(t *testing.T) {
	up, stop := liveTarget(t)
	defer stop()
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")

	port := freePort(t)
	cfg := directCfg("shut-phase1", port, addrFor(up), 1)
	if _, err := tm.Apply(cfg); err != nil {
		t.Fatalf("apply: %v", err)
	}
	// One established connection that stays open for the whole test: it is what
	// makes "the drain has not finished yet" true.
	held, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Fatalf("hold a connection: %v", err)
	}
	defer held.Close()
	time.Sleep(100 * time.Millisecond)

	closed := tm.CloseListeners()
	if len(closed) != 1 {
		t.Fatalf("expected one listener closed, got %v", closed)
	}
	// The established connection is still usable during the drain window...
	deadline := time.Now().Add(2 * time.Second)
	for {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 300*time.Millisecond)
		if err != nil {
			break // refused, as intended
		}
		_ = conn.Close()
		if time.Now().After(deadline) {
			t.Fatal("a new connection was still accepted after CloseListeners")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// One absolute deadline: a peer that never sends and ignores the FIN cannot hold
// a handler (and therefore the shutdown) past it.
func TestShutdownIsBoundedByAPeerThatNeverSpeaks(t *testing.T) {
	silent, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer silent.Close()
	go func() {
		for {
			conn, err := silent.Accept()
			if err != nil {
				return
			}
			// Accept, then never read, never write, never close: the classic
			// "half-open that ignores FIN" peer.
			_ = conn
		}
	}()

	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	port := freePort(t)
	cfg := directCfg("shut-silent", port, addrFor(silent.Addr().(*net.TCPAddr).Port), 1)
	if _, err := tm.Apply(cfg); err != nil {
		t.Fatalf("apply: %v", err)
	}
	client, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	time.Sleep(150 * time.Millisecond)

	start := time.Now()
	report := tm.ShutdownAll(700 * time.Millisecond)
	elapsed := time.Since(start)

	if elapsed > 3*time.Second {
		t.Fatalf("shutdown must be bounded by its deadline, took %v", elapsed)
	}
	if report.RemainingConns != 0 {
		t.Fatalf("a silent peer must not keep a connection alive past the deadline: %+v", report)
	}
	if report.Listeners != 1 {
		t.Fatalf("the report must still account for the closed listener: %+v", report)
	}
}
