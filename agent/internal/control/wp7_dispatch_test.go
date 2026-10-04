package control

import (
	"context"
	"testing"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/manager"
)

// V5.2-WP7: the `target_health` array travels in the SAME dispatch payload as
// `targets`, so the command path must install both. These tests assert the fact
// end-to-end at the seam the panel actually uses — a config applied through
// `execute` — rather than at the manager API the config is passed to.

// oneBreaker returns the single reported breaker of a pool, or fails.
func oneBreaker(t *testing.T, egress *manager.EgressManager, tunnelID string) manager.BreakerState {
	t.Helper()
	states := egress.BreakerStates(tunnelID)
	if len(states) != 1 {
		t.Fatalf("breaker states of %s = %+v, want exactly one", tunnelID, states)
	}
	return states[0]
}

func TestExecuteEgressCarriesParallelTargetHealth(t *testing.T) {
	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")
	client := New(Config{}, tunnels, egress)

	cmd := egressCommand(freeTCPPort(t))
	cmd.Config.TargetHealth = []forwarder.TargetHealth{
		{Host: "127.0.0.1", Port: 9, State: "unhealthy", LatencyMs: 12, AgeMs: 4000, Evidence: true},
	}
	ack := client.execute(context.Background(), cmd)
	if !ack.OK {
		t.Fatalf("apply failed: code=%s err=%s", ack.ErrorCode, ack.Error)
	}
	defer func() {
		_ = tunnels.Remove(cmd.Config.ID)
		egress.DropPool(cmd.Config.ID)
	}()

	got := oneBreaker(t, egress, cmd.Config.ID)
	if got.Breaker != "open" || got.Health != "unhealthy" {
		t.Fatalf("breaker after the dispatch = %+v, want open/unhealthy", got)
	}
	// And the desired pool is what the payload said, untouched by the health
	// that came with it.
	targets, ok := egress.Targets(cmd.Config.ID)
	if !ok || len(targets) != len(cmd.Config.Targets) {
		t.Fatalf("desired targets = %+v (ok=%v), want the dispatched pool", targets, ok)
	}
	for i := range targets {
		if targets[i] != cmd.Config.Targets[i] {
			t.Fatalf("target %d = %+v, want %+v", i, targets[i], cmd.Config.Targets[i])
		}
	}
}

// A dispatch without `target_health` (an older panel) must leave no mechanism
// behind: no breaker, no reordering, nothing to report.
func TestExecuteEgressWithoutTargetHealthLeavesNoBreaker(t *testing.T) {
	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")
	client := New(Config{}, tunnels, egress)

	cmd := egressCommand(freeTCPPort(t))
	ack := client.execute(context.Background(), cmd)
	if !ack.OK {
		t.Fatalf("apply failed: code=%s err=%s", ack.ErrorCode, ack.Error)
	}
	defer func() {
		_ = tunnels.Remove(cmd.Config.ID)
		egress.DropPool(cmd.Config.ID)
	}()

	if got := egress.BreakerStates(cmd.Config.ID); len(got) != 0 {
		t.Fatalf("breaker states = %+v, want none without a health signal", got)
	}
	if got := egress.Snapshot()[cmd.Config.ID].ForcedPicks; got != 0 {
		t.Fatalf("forced picks = %d without a health signal, want 0", got)
	}
}

// A later dispatch that stops sending health switches the mechanism off rather
// than leaving a stale breaker running the pool.
func TestExecuteEgressHealthlessRedispatchTurnsTheMechanismOff(t *testing.T) {
	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")
	client := New(Config{}, tunnels, egress)

	cmd := egressCommand(freeTCPPort(t))
	cmd.Config.TargetHealth = []forwarder.TargetHealth{{Host: "127.0.0.1", Port: 9, State: "unhealthy"}}
	if ack := client.execute(context.Background(), cmd); !ack.OK {
		t.Fatalf("first apply failed: code=%s err=%s", ack.ErrorCode, ack.Error)
	}
	defer func() {
		_ = tunnels.Remove(cmd.Config.ID)
		egress.DropPool(cmd.Config.ID)
	}()
	if got := egress.BreakerStates(cmd.Config.ID); len(got) != 1 {
		t.Fatalf("breaker states after the health-carrying apply = %+v, want one", got)
	}

	cmd2 := egressCommand(cmd.Config.EgressPort)
	cmd2.Envelope.Revision = 2
	cmd2.Config.Revision = 2
	cmd2.Config.TargetHealth = nil
	if ack := client.execute(context.Background(), cmd2); !ack.OK {
		t.Fatalf("second apply failed: code=%s err=%s", ack.ErrorCode, ack.Error)
	}
	if got := egress.BreakerStates(cmd.Config.ID); len(got) != 0 {
		t.Fatalf("breaker states after a health-less apply = %+v, want none", got)
	}
}
