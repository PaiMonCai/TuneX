package control

import (
	"net"
	"testing"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/manager"
)

func freeTCPPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}

func egressCommand(port int) *QueuedCommand {
	return &QueuedCommand{
		Envelope: Envelope{
			CommandID:  "cmd-egress-1",
			ResourceID: "tunex-1-egress",
			Revision:   1,
			Action:     "apply_tunnel",
		},
		Config: &forwarder.TunnelConfig{
			ID:          "tunex-1-egress",
			Mode:        forwarder.ModeEgress,
			EgressPort:  port,
			Targets:     []forwarder.Target{{Host: "127.0.0.1", Port: 9, Weight: 1}},
			LBStrategy:  forwarder.LBRoundRobin,
			Protocol:    "tcp",
			Revision:    1,
		},
	}
}

func TestExecuteEgressStagesPoolBeforeApply(t *testing.T) {
	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")
	client := New(Config{}, tunnels, egress)

	cmd := egressCommand(freeTCPPort(t))
	ack := client.execute(cmd)
	if !ack.OK {
		t.Fatalf("expected successful EGRESS apply, got code=%s err=%s", ack.ErrorCode, ack.Error)
	}
	targets, ok := egress.Targets(cmd.Config.ID)
	if !ok || len(targets) != 1 {
		t.Fatalf("expected staged target pool, ok=%v targets=%v", ok, targets)
	}
	if got := tunnels.Len(); got != 1 {
		t.Fatalf("expected one running tunnel, got %d", got)
	}

	if err := tunnels.Remove(cmd.Config.ID); err != nil {
		t.Fatal(err)
	}
	egress.DropPool(cmd.Config.ID)
}

func TestExecuteEgressRollsBackNewPoolWhenListenerApplyFails(t *testing.T) {
	// Hold a port externally so TunnelManager.Apply fails after the pool has
	// been staged. The command client must remove that new pool again.
	blocker, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Close()
	port := blocker.Addr().(*net.TCPAddr).Port

	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")
	client := New(Config{}, tunnels, egress)

	cmd := egressCommand(port)
	ack := client.execute(cmd)
	if ack.OK {
		t.Fatal("expected EGRESS apply to fail while port is occupied")
	}
	if _, ok := egress.Targets(cmd.Config.ID); ok {
		t.Fatal("new target pool must be rolled back when listener apply fails")
	}
	if got := tunnels.Len(); got != 0 {
		t.Fatalf("expected no running tunnel after failed apply, got %d", got)
	}
}
