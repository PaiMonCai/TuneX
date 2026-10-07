package manager

import (
	"errors"
	"testing"

	"github.com/tunex/agent/internal/forwarder"
)

// The mutation hook is what lets the durable last-known-good cache follow an
// applied change instead of a periodic sample. Two properties matter:
// it fires when the running registry really changed, and it stays silent for an
// idempotent apply — a repeat of the same revision must not look like new work.

func TestMutationHookFiresOnlyOnRealChange(t *testing.T) {
	up := freePort(t)
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	fired := 0
	tm.SetMutationHook(func() { fired++ })

	base := directCfg("mut-a", freePort(t), addrFor(up), 1)

	if _, err := tm.Apply(base); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	if fired != 1 {
		t.Fatalf("a real apply must notify the hook once, got %d", fired)
	}

	// Same revision, same config: the manager's documented idempotent no-op.
	if _, err := tm.Apply(base); err != nil {
		t.Fatalf("idempotent apply: %v", err)
	}
	if fired != 1 {
		t.Fatalf("an idempotent apply must not notify the hook, got %d", fired)
	}

	// Newer revision: real work, real notification.
	bumped := base.Clone()
	bumped.Revision = 2
	if _, err := tm.Apply(bumped); err != nil {
		t.Fatalf("bumped apply: %v", err)
	}
	if fired != 2 {
		t.Fatalf("a revision bump must notify the hook, got %d", fired)
	}

	// Remove of a known id changes state; remove of an unknown id does not.
	if err := tm.Remove("mut-a"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if fired != 3 {
		t.Fatalf("a successful remove must notify the hook, got %d", fired)
	}
	if err := tm.Remove("does-not-exist"); err != nil {
		t.Fatalf("removing an unknown id must stay a no-op: %v", err)
	}
	if fired != 3 {
		t.Fatalf("a no-op remove must not notify the hook, got %d", fired)
	}
}

func TestRemoveRevisionTombstoneRejectsStaleResurrection(t *testing.T) {
	up := freePort(t)
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	id := "remove-fence"
	base := directCfg(id, freePort(t), addrFor(up), 5)

	if _, err := tm.Apply(base); err != nil {
		t.Fatalf("apply rev5: %v", err)
	}
	if err := tm.RemoveAtRevision(id, 4); !errors.Is(err, ErrStaleRevision) {
		t.Fatalf("stale remove rev4 = %v, want ErrStaleRevision", err)
	}
	if got, ok := tm.Get(id); !ok || got.Revision != 5 {
		t.Fatalf("stale remove changed live runtime: got=%+v ok=%v", got, ok)
	}

	if err := tm.RemoveAtRevision(id, 6); err != nil {
		t.Fatalf("remove rev6: %v", err)
	}
	if _, ok := tm.Get(id); ok {
		t.Fatal("runtime still live after rev6 remove")
	}

	for _, rev := range []int64{5, 6} {
		stale := base.Clone()
		stale.Revision = rev
		if _, err := tm.Apply(stale); !errors.Is(err, ErrStaleRevision) {
			t.Fatalf("apply rev%d after remove rev6 = %v, want ErrStaleRevision", rev, err)
		}
		if _, err := tm.ReplaceListener(stale); !errors.Is(err, ErrStaleRevision) {
			t.Fatalf("replace rev%d after remove rev6 = %v, want ErrStaleRevision", rev, err)
		}
	}

	newer := base.Clone()
	newer.Revision = 7
	// The old listener drains asynchronously after Remove. Use a different
	// physical port here so this test isolates revision fencing rather than the
	// existing kernel-level drain/reuse timing contract.
	newer.IngressPort = freePort(t)
	if _, err := tm.ReplaceListener(newer); err != nil {
		t.Fatalf("newer replace rev7 should clear tombstone: %v", err)
	}
	if got, ok := tm.Get(id); !ok || got.Revision != 7 {
		t.Fatalf("newer runtime not restored: got=%+v ok=%v", got, ok)
	}
}

func TestRemoveUnknownRuntimeStillFencesOlderSnapshot(t *testing.T) {
	up := freePort(t)
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	id := "remove-absent"

	if err := tm.RemoveAtRevision(id, 8); err != nil {
		t.Fatalf("remove absent rev8: %v", err)
	}
	stale := directCfg(id, freePort(t), addrFor(up), 7)
	if _, err := tm.Apply(stale); !errors.Is(err, ErrStaleRevision) {
		t.Fatalf("stale apply after absent remove = %v, want ErrStaleRevision", err)
	}

	newer := stale.Clone()
	newer.Revision = 9
	if _, err := tm.Apply(newer); err != nil {
		t.Fatalf("newer rev9 after tombstone: %v", err)
	}
}

// A hook that mutates the manager (the cache writer reads the registry) must not
// deadlock: the notification happens outside every lock.
func TestMutationHookRunsOutsideTheLock(t *testing.T) {
	up := freePort(t)
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	observed := -1
	tm.SetMutationHook(func() { observed = tm.Len() })

	if _, err := tm.Apply(directCfg("mut-b", freePort(t), addrFor(up), 1)); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if observed != 1 {
		t.Fatalf("the hook must observe the post-mutation state, got len=%d", observed)
	}
}

// ReplaceListener is the production path for online apply commands, so it must
// notify too — otherwise a control-plane apply would leave the cache behind.
func TestReplaceListenerNotifies(t *testing.T) {
	up := freePort(t)
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	fired := 0
	tm.SetMutationHook(func() { fired++ })

	cfg := directCfg("mut-c", freePort(t), addrFor(up), 1)
	if _, err := tm.ReplaceListener(cfg); err != nil {
		t.Fatalf("replace listener: %v", err)
	}
	if fired != 1 {
		t.Fatalf("ReplaceListener must notify on change, got %d", fired)
	}
	if _, err := tm.ReplaceListener(cfg); err != nil {
		t.Fatalf("idempotent replace: %v", err)
	}
	if fired != 1 {
		t.Fatalf("an idempotent ReplaceListener must stay silent, got %d", fired)
	}
}

// Removing the hook is supported (a runtime that has no cache must not be forced
// to wire one).
func TestMutationHookCanBeCleared(t *testing.T) {
	up := freePort(t)
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	calls := 0
	tm.SetMutationHook(func() { calls++ })
	tm.SetMutationHook(nil)
	if _, err := tm.Apply(directCfg("mut-d", freePort(t), addrFor(up), 1)); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if calls != 0 {
		t.Fatalf("a cleared hook must not run, got %d", calls)
	}
}

var _ = forwarder.ModeDirect
