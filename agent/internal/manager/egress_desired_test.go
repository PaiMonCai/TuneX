package manager

import (
	"testing"

	"github.com/tunex/agent/internal/forwarder"
)

// V5.2-WP5: DesiredTargets is the ONLY accessor the target observer enumerates
// from, so "observe only the targets of this node's desired state" is a property
// of the manager, not of the observer's good behaviour. These tests pin the two
// facts the observer depends on: every served pool is covered, and the result is
// read-only (mutating it cannot reach desired state).

func TestDesiredTargetsCoversEveryServedPoolDeterministically(t *testing.T) {
	em := NewEgressManager()
	em.SetPool("pool-b", RoundRobin, []forwarder.Target{tg("10.0.0.2", 443)})
	em.SetPool("pool-a", RoundRobin, []forwarder.Target{tg("10.0.0.1", 443), tg("10.0.0.1", 8443)})

	got := em.DesiredTargets()
	want := []forwarder.Target{
		{Host: "10.0.0.1", Port: 443, Weight: 1},
		{Host: "10.0.0.1", Port: 8443, Weight: 1},
		{Host: "10.0.0.2", Port: 443, Weight: 1},
	}
	if len(got) != len(want) {
		t.Fatalf("DesiredTargets = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("DesiredTargets[%d] = %+v, want %+v (order must be stable)", i, got[i], want[i])
		}
	}

	// The caller owns the result: an observer (or a test) that writes to it must
	// not be able to rewrite what this node is supposed to serve.
	got[0].Host = "tampered"
	again := em.DesiredTargets()
	if again[0].Host != "10.0.0.1" {
		t.Fatalf("DesiredTargets handed out a view into desired state: %+v", again[0])
	}
}

func TestDesiredTargetsIsEmptyForANodeWithNoPools(t *testing.T) {
	em := NewEgressManager()
	if got := em.DesiredTargets(); len(got) != 0 {
		t.Fatalf("DesiredTargets = %+v, want empty", got)
	}
	// A dropped pool stops being desired state — the observer must stop
	// reporting its targets, not keep probing a pool the panel deleted.
	em.SetPool("gone", RoundRobin, []forwarder.Target{tg("10.0.0.3", 443)})
	if got := em.DesiredTargets(); len(got) != 1 {
		t.Fatalf("DesiredTargets = %+v, want the pool that exists", got)
	}
	em.DropPool("gone")
	if got := em.DesiredTargets(); len(got) != 0 {
		t.Fatalf("DesiredTargets = %+v after DropPool, want empty", got)
	}
}
