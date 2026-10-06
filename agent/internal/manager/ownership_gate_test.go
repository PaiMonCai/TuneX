package manager

import (
	"errors"
	"net"
	"testing"

	"github.com/tunex/agent/internal/forwarder"
)

// The activation gate is installed on the manager, so every path that
// can start serving a tunnel is fenced by one implementation — the control
// dispatch, the reconnect snapshot, startup restore and the local admin plane.
// These tests pin the two properties that make that claim true: a refusal
// happens before anything is bound, and it happens on BOTH activation entries
// (Apply and ReplaceListener).

// fakeGuard records what it was asked and answers with a fixed error.
type fakeGuard struct {
	calls  []string
	refuse error
}

func (g *fakeGuard) Admit(cfg forwarder.TunnelConfig) error {
	g.calls = append(g.calls, cfg.ID)
	return g.refuse
}

func TestOwnershipRefusalLeavesNothingBound(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	guard := &fakeGuard{refuse: errors.New("ownership: stale_epoch: refused")}
	tm.SetOwnershipGuard(guard)

	port := freePort(t)
	_, err := tm.Apply(forwarder.TunnelConfig{
		ID: "t1", Mode: forwarder.ModeRelay, IngressPort: port,
		NextHop: "127.0.0.1:9", Protocol: forwarder.ProtocolTCP, Revision: 1,
	})
	if err == nil {
		t.Fatal("a refused activation must not succeed")
	}
	if got := len(guard.calls); got != 1 {
		t.Fatalf("guard calls = %d, want 1", got)
	}
	if tm.Len() != 0 {
		t.Fatalf("registry has %d tunnels after a refusal, want 0", tm.Len())
	}
	if tm.UsedPorts()[port] {
		t.Fatalf("port %d stayed reserved after a refusal", port)
	}
	// Nothing is listening on that port: the refusal really happened before the
	// bind, not after a failed one.
	if !portIsFree(t, port) {
		t.Fatalf("a listener was bound for a refused activation on %d", port)
	}
}

func TestOwnershipRefusalAlsoCoversTheListenerReplacePath(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	port := freePort(t)
	base := forwarder.TunnelConfig{
		ID: "t2", Mode: forwarder.ModeRelay, IngressPort: port,
		NextHop: "127.0.0.1:9", Protocol: forwarder.ProtocolTCP, Revision: 1,
	}
	if _, err := tm.Apply(base); err != nil {
		t.Fatalf("apply: %v", err)
	}
	t.Cleanup(tm.StopAll)

	// This is the entry the control plane actually uses for a listener change:
	// a fence consulted only by Apply would be a fence production never passes.
	guard := &fakeGuard{refuse: errors.New("ownership: stale_epoch: refused")}
	tm.SetOwnershipGuard(guard)
	next := base.Clone()
	next.Revision = 2
	if _, err := tm.ReplaceListener(next); err == nil {
		t.Fatal("ReplaceListener ignored the ownership gate")
	}
	live, ok := tm.Get("t2")
	if !ok || live.Revision != 1 {
		t.Fatalf("a refused replacement changed the live tunnel: %+v (present=%v)", live, ok)
	}
}

// portIsFree reports whether nothing is listening on a loopback port.
func portIsFree(t *testing.T, port int) bool {
	t.Helper()
	ln, err := net.Listen("tcp", addrFor(port))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

func TestAdmitActivationChecksWithoutApplying(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	guard := &fakeGuard{}
	tm.SetOwnershipGuard(guard)

	cfg := forwarder.TunnelConfig{
		ID: "t3", Mode: forwarder.ModeRelay, IngressPort: freePort(t),
		NextHop: "127.0.0.1:9", Protocol: forwarder.ProtocolTCP, Revision: 1,
	}
	if err := tm.AdmitActivation(cfg); err != nil {
		t.Fatalf("AdmitActivation: %v", err)
	}
	if tm.Len() != 0 {
		t.Fatal("AdmitActivation must not apply anything")
	}
	if len(guard.calls) != 1 {
		t.Fatalf("guard calls = %d, want 1", len(guard.calls))
	}
}

func TestRemoveIfHonoursItsCondition(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	port := freePort(t)
	if _, err := tm.Apply(forwarder.TunnelConfig{
		ID: "t4", Mode: forwarder.ModeRelay, IngressPort: port,
		NextHop: "127.0.0.1:9", Protocol: forwarder.ProtocolTCP, Revision: 1,
	}); err != nil {
		t.Fatalf("apply: %v", err)
	}
	t.Cleanup(tm.StopAll)

	// The predicate is what turns the lease clock's check-then-act into
	// check-and-act: a tunnel whose condition no longer holds is left alone.
	removed, err := tm.RemoveIf("t4", func(forwarder.TunnelConfig) bool { return false })
	if err != nil {
		t.Fatalf("RemoveIf: %v", err)
	}
	if removed || tm.Len() != 1 {
		t.Fatalf("RemoveIf removed a tunnel whose condition was false (removed=%v, len=%d)", removed, tm.Len())
	}

	removed, err = tm.RemoveIf("t4", func(cfg forwarder.TunnelConfig) bool { return cfg.Revision == 1 })
	if err != nil {
		t.Fatalf("RemoveIf: %v", err)
	}
	if !removed || tm.Len() != 0 {
		t.Fatalf("RemoveIf did not remove a matching tunnel (removed=%v, len=%d)", removed, tm.Len())
	}

	// An unknown id is still a no-op, exactly like Remove.
	if removed, err := tm.RemoveIf("nope", nil); err != nil || removed {
		t.Fatalf("RemoveIf(unknown) = (%v,%v)", removed, err)
	}
}
