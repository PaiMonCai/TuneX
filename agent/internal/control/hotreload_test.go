package control

import (
	"io"
	"net"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/manager"
)

// ---------------------------------------------------------------------------
// WP2 — the command path must honour the panel's edit semantics
// (DEVELOPMENT.md §13.3.4), not just the manager primitives in isolation.
//
// A panel that moves a listen port sends ONE apply_tunnel command with a new
// revision. The agent must not drop the live connections while it does so,
// which is why the command routes through the listener-safe primitive.
// ---------------------------------------------------------------------------

func relayCommand(t *testing.T, id string, port int, upstream string, revision int64) *QueuedCommand {
	t.Helper()
	return &QueuedCommand{
		Envelope: Envelope{
			CommandID:  "cmd-" + id,
			ResourceID: id,
			Revision:   revision,
			Action:     "apply_tunnel",
		},
		Config: &forwarder.TunnelConfig{
			ID:          id,
			Mode:        forwarder.ModeRelay,
			IngressPort: port,
			NextHop:     upstream,
			Protocol:    "tcp",
			Revision:    revision,
		},
	}
}

// echoTarget is a minimal upstream that answers with the payload it receives.
func echoTarget(t *testing.T) (addr string, stop func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("listen: %v", err)
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}(conn)
		}
	}()
	return ln.Addr().String(), func() { _ = ln.Close() }
}

func TestExecuteApplyTunnelPortMoveKeepsConnectionAlive(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()

	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")
	client := New(Config{}, tunnels, egress)
	defer tunnels.StopAll()

	oldPort := freeTCPPort(t)
	newPort := freeTCPPort(t)

	ack := client.execute(relayCommand(t, "cmd-move", oldPort, up, 1))
	if !ack.OK {
		t.Fatalf("initial apply failed: code=%s err=%s", ack.ErrorCode, ack.Error)
	}

	// A client connection through the tunnel, established before the move.
	held, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", itoa(oldPort)), 2*time.Second)
	if err != nil {
		t.Fatalf("dial tunnel: %v", err)
	}
	defer held.Close()
	_ = held.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := held.Write([]byte("before-move\n")); err != nil {
		t.Fatalf("write before move: %v", err)
	}
	first := make([]byte, len("before-move\n"))
	if _, err := io.ReadFull(held, first); err != nil {
		t.Fatalf("read before move: %v", err)
	}

	// The panel moves the listen port: one command, new revision.
	ack = client.execute(relayCommand(t, "cmd-move", newPort, up, 2))
	if !ack.OK {
		t.Fatalf("port-move apply failed: code=%s err=%s", ack.ErrorCode, ack.Error)
	}

	// The new port serves traffic immediately.
	fresh, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", itoa(newPort)), 2*time.Second)
	if err != nil {
		t.Fatalf("dial new port: %v", err)
	}
	defer fresh.Close()
	_ = fresh.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := fresh.Write([]byte("new-port\n")); err != nil {
		t.Fatalf("write through new port: %v", err)
	}
	echoed := make([]byte, len("new-port\n"))
	if _, err := io.ReadFull(fresh, echoed); err != nil {
		t.Fatalf("new port did not relay: %v", err)
	}

	// The held connection keeps relaying on the OLD listener: the old
	// instance is drained, not torn down before the new one is live.
	if _, err := held.Write([]byte("after-move\n")); err != nil {
		t.Fatalf("held connection broke during the port move: %v", err)
	}
	after := make([]byte, len("after-move\n"))
	if _, err := io.ReadFull(held, after); err != nil {
		t.Fatalf("held connection stopped relaying during the port move: %v", err)
	}
	if string(after) != "after-move\n" {
		t.Fatalf("held connection relayed %q", after)
	}
}

func TestExecuteApplyTunnelIdempotentRevisionIsNoop(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()

	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")
	client := New(Config{}, tunnels, egress)
	defer tunnels.StopAll()

	port := freeTCPPort(t)
	cmd := relayCommand(t, "cmd-idem", port, up, 4)
	if ack := client.execute(cmd); !ack.OK {
		t.Fatalf("first apply: code=%s err=%s", ack.ErrorCode, ack.Error)
	}

	// The same revision again (the reconciler's resend-same-revision path):
	// idempotent, no listener churn.
	if ack := client.execute(cmd); !ack.OK {
		t.Fatalf("replay apply: code=%s err=%s", ack.ErrorCode, ack.Error)
	}
	cfg, ok := tunnels.Get("cmd-idem")
	if !ok {
		t.Fatal("the tunnel vanished after an idempotent replay")
	}
	if cfg.Revision != 4 {
		t.Fatalf("revision after replay = %d, want 4", cfg.Revision)
	}
	if got := tunnels.Len(); got != 1 {
		t.Fatalf("running tunnels = %d after an idempotent replay, want 1", got)
	}

	// An older revision is rejected, and the running instance survives it.
	older := relayCommand(t, "cmd-idem", port, up, 3)
	ack := client.execute(older)
	if ack.OK || ack.ErrorCode != "stale_revision" {
		t.Fatalf("stale revision ack = %+v, want a stale_revision rejection", ack)
	}
	if cfg, ok = tunnels.Get("cmd-idem"); !ok || cfg.Revision != 4 {
		t.Fatalf("running revision changed after a stale reject: %+v ok=%v", cfg, ok)
	}
}

// itoa keeps the test free of a strconv import for one conversion.
func itoa(p int) string {
	if p == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for p > 0 {
		i--
		buf[i] = byte('0' + p%10)
		p /= 10
	}
	return string(buf[i:])
}
