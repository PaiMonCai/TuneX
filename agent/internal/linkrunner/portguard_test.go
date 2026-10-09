package linkrunner

import (
	"errors"
	"testing"
	"time"

	"github.com/tunex/agent/internal/manager"
	"github.com/tunex/agent/internal/portlease"
)

func TestAllLifecyclePathsShareTunnelManagerSlots(t *testing.T) {
	dir := t.TempDir()
	native := manager.NewTunnelManager(manager.NewEgressManager(), "127.0.0.1")
	m := newTestManager(t, helperBinary(t), dir)
	if err := m.SetPortGuard(native); err != nil {
		t.Fatal(err)
	}
	cfg := exitConfig(t, "guarded", "tcp", freePort(t, "tcp"), 1)
	claim := bindingsFor(cfg.Ports)
	if err := native.ReserveExternal("foreign", claim); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Apply(cfg); !errors.Is(err, ErrPortConflict) {
		t.Fatalf("OS-free guarded port accepted: %v", err)
	}
	native.ReleaseExternal("foreign")
	o, err := m.Apply(cfg)
	requireReady(t, o, err)
	if err := native.ReserveExternal("foreign", claim); err == nil {
		t.Fatal("ready child has no shared slot")
	}
	udp := []portlease.Binding{portlease.New("udp", cfg.Ports[0].Port, cfg.Ports[0].Host)}
	if err := native.ReserveExternal("other-protocol", udp); err != nil {
		t.Fatal(err)
	}
	bad := testMode(t, cfg, "secretfail")
	bad.Generation = 2
	o, err = m.Apply(bad)
	if err == nil || !o.Ready || o.State != "rolled_back" {
		t.Fatalf("rollback: %+v %v", o, err)
	}
	if err := native.ReserveExternal("foreign", claim); err == nil {
		t.Fatal("rollback released shared slot")
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if err := native.ReserveExternal("foreign", claim); err != nil {
		t.Fatalf("Close retained slot: %v", err)
	}
	r := newTestManager(t, helperBinary(t), dir)
	r.SetPortGuard(native)
	if _, err := r.Restore(); !errors.Is(err, ErrPortConflict) {
		t.Fatalf("Restore bypassed native slot: %v", err)
	}
	native.ReleaseExternal("foreign")
	statuses, err := r.Restore()
	if err != nil || !statuses[0].Ready {
		t.Fatalf("restore: %+v %v", statuses, err)
	}
	if _, err := r.Remove(cfg.ID, 2); err != nil {
		t.Fatal(err)
	}
	if err := native.ReserveExternal("foreign", claim); err != nil {
		t.Fatalf("Remove retained slot: %v", err)
	}
}

func TestLeaseExitReleasesSharedSlotWithoutAnotherCommand(t *testing.T) {
	native := manager.NewTunnelManager(manager.NewEgressManager(), "127.0.0.1")
	m := newTestManager(t, helperBinary(t), t.TempDir())
	m.SetPortGuard(native)
	cfg := exitConfig(t, "expires", "tcp", freePort(t, "tcp"), 1)
	cfg.LeaseExpiresAt = time.Now().Add(400 * time.Millisecond).Format(time.RFC3339Nano)
	o, err := m.Apply(cfg)
	requireReady(t, o, err)
	waitFor(t, func() bool { return native.ReserveExternal("foreign", bindingsFor(cfg.Ports)) == nil })
	if m.Status()[0].Ready {
		t.Fatal("slot released before lease stop")
	}
}
