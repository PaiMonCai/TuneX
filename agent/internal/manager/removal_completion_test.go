package manager

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/portlease"
)

func TestRemovalReplayWaitsForActualStopAfterCancellation(t *testing.T) {
	m := NewTunnelManager(nil, "127.0.0.1")
	t.Cleanup(m.StopAll)
	port := freeSharedPort(t)
	cfg := directCfg("remove-completion", port, "127.0.0.1:9", 1)
	cfg.Protocol = forwarder.ProtocolBoth
	runtime, err := m.Apply(cfg)
	if err != nil {
		t.Fatal(err)
	}
	paused, release := pauseTunnelStop(t, m, cfg.ID, runtime)
	if err := m.RemoveAtRevision(cfg.ID, 2); err != nil {
		t.Fatal(err)
	}
	select {
	case <-paused.entered:
	case <-time.After(time.Second):
		t.Fatal("Stop did not start")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := m.RemoveAtRevisionAndWait(ctx, cfg.ID, 2); !errors.Is(err, context.Canceled) {
		t.Fatalf("absent registry was mistaken for completed Stop: %v", err)
	}
	if err := m.RemoveAtRevisionAndWait(ctx, cfg.ID, 0); !errors.Is(err, context.Canceled) {
		t.Fatalf("unversioned replay did not retain pending Stop: %v", err)
	}
	assertRemovalPorts(t, m, port, true)
	// Other socket namespaces remain usable while this remove waits.
	sibling := directCfg("independent", freeSharedPort(t), "127.0.0.1:9", 1)
	if _, err := m.Apply(sibling); err != nil {
		t.Fatalf("waiting Stop held the manager lock: %v", err)
	}
	release()
	waitCtx, waitCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer waitCancel()
	if err := m.RemoveAtRevisionAndWait(waitCtx, cfg.ID, 2); err != nil {
		t.Fatal(err)
	}
	assertRemovalPorts(t, m, port, false)
	if _, err := m.Apply(cfg); !errors.Is(err, ErrStaleRevision) {
		t.Fatalf("successful Stop erased the removal tombstone: %v", err)
	}
	cfg.ID = "new-owner"
	if _, err := m.Apply(cfg); err != nil {
		t.Fatalf("confirmed Stop did not release both sockets: %v", err)
	}
}

type failFirstStopRuntime struct {
	forwarder.Runtime
	fail atomic.Bool
}

func (r *failFirstStopRuntime) Stop() error {
	if r.fail.Swap(false) {
		return errors.New("fixture stop unconfirmed")
	}
	return r.Runtime.Stop()
}

func TestFailedRemovalKeepsBindingsUntilRetryConfirmsStop(t *testing.T) {
	m := NewTunnelManager(nil, "127.0.0.1")
	t.Cleanup(m.StopAll)
	port := freeSharedPort(t)
	cfg := directCfg("failed-stop", port, "127.0.0.1:9", 2)
	cfg.Protocol = forwarder.ProtocolBoth
	runtime, err := m.Apply(cfg)
	if err != nil {
		t.Fatal(err)
	}
	wrapped := &failFirstStopRuntime{Runtime: runtime}
	wrapped.fail.Store(true)
	m.mu.Lock()
	m.tunnels[cfg.ID].fwd = wrapped
	m.mu.Unlock()
	t.Cleanup(func() { _ = runtime.Stop() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.RemoveAtRevisionAndWait(ctx, cfg.ID, 2); err == nil {
		t.Fatal("unconfirmed Stop was acknowledged as successful")
	}
	assertRemovalPorts(t, m, port, true)
	// A grace timer is not evidence of successful Stop. Force only the note's
	// age, not the real socket/state, to exercise that boundary deterministically.
	m.mu.Lock()
	for key, note := range m.stoppingPorts {
		note.until = time.Now().Add(-time.Second)
		m.stoppingPorts[key] = note
	}
	m.mu.Unlock()
	assertRemovalPorts(t, m, port, true)
	if err := m.ReserveExternal("foreign", []portlease.Binding{portlease.New("tcp", port, "127.0.0.1")}); err == nil {
		t.Fatal("aged grace note exposed an unconfirmed socket to another owner")
	}
	if err := m.RemoveAtRevisionAndWait(ctx, cfg.ID, 1); !errors.Is(err, ErrStaleRevision) {
		t.Fatalf("stale retry changed a pending removal: %v", err)
	}
	if err := m.RemoveAtRevisionAndWait(ctx, cfg.ID, 2); err != nil {
		t.Fatalf("same-revision retry could not complete Stop: %v", err)
	}
	assertRemovalPorts(t, m, port, false)
	cfg.ID = "confirmed-new-owner"
	if _, err := m.Apply(cfg); err != nil {
		t.Fatal(err)
	}
}

func TestLateRemovalCompletionPreservesNewerSameIDOwner(t *testing.T) {
	m := NewTunnelManager(nil, "127.0.0.1")
	t.Cleanup(m.StopAll)
	cfg := directCfg("recreated-owner", freeSharedPort(t), "127.0.0.1:9", 1)
	cfg.Protocol = forwarder.ProtocolBoth
	runtime, err := m.Apply(cfg)
	if err != nil {
		t.Fatal(err)
	}
	paused, release := pauseTunnelStop(t, m, cfg.ID, runtime)
	if err := m.RemoveAtRevision(cfg.ID, 2); err != nil {
		t.Fatal(err)
	}
	select {
	case <-paused.entered:
	case <-time.After(time.Second):
		t.Fatal("Stop did not start")
	}
	next := cfg.Clone()
	next.IngressPort, next.Revision = freeSharedPort(t), 3
	if _, err := m.Apply(next); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.RemoveAtRevisionAndWait(ctx, cfg.ID, 2); !errors.Is(err, ErrStaleRevision) {
		t.Fatalf("old remove targeted the new incarnation: %v", err)
	}
	release()
	waitProtocolPort(t, m, "tcp", cfg.IngressPort, false)
	assertRemovalPorts(t, m, cfg.IngressPort, false)
	assertRemovalPorts(t, m, next.IngressPort, true)
	if err := m.RemoveAtRevisionAndWait(ctx, cfg.ID, 4); err != nil {
		t.Fatal(err)
	}
	assertRemovalPorts(t, m, next.IngressPort, false)
}

func assertRemovalPorts(t *testing.T, m *TunnelManager, port int, occupied bool) {
	t.Helper()
	byProtocol := m.UsedPortsByProtocol()
	if byProtocol["tcp"][port] != occupied || byProtocol["udp"][port] != occupied {
		t.Fatalf("both reservations = %v, occupied=%v", byProtocol, occupied)
	}
}
