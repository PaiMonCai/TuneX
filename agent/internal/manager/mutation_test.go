package manager

import (
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
