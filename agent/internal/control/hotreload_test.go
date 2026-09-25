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
//
// A panel that only moves the target must NOT rebuild the forwarder either:
// Apply's same-port path stops the old forwarder first, which drains every
// live connection for drainTimeout and resets the byte counter. That is the
// silent outage the hot-reload contract exists to prevent, and these tests
// assert on observables that distinguish the two (duration, byte counter,
// live connection count, held-connection liveness).
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

// roundTrip writes msg and reads the same number of bytes back.
func roundTrip(t *testing.T, conn net.Conn, msg string) string {
	t.Helper()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Write([]byte(msg)); err != nil {
		t.Fatalf("write %q: %v", msg, err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read echo of %q: %v", msg, err)
	}
	return string(buf)
}

// waitLiveConns polls until the manager counts at least want connections for id.
func waitLiveConns(t *testing.T, tunnels *manager.TunnelManager, id string, want int) bool {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if tunnels.LiveConns(id) >= want {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	return false
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
	if got := roundTrip(t, held, "before-move\n"); got != "before-move\n" {
		t.Fatalf("pre-move relay = %q", got)
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
	if got := roundTrip(t, fresh, "new-port\n"); got != "new-port\n" {
		t.Fatalf("new port relay = %q", got)
	}

	// The held connection keeps relaying on the OLD listener: the old
	// instance is drained, not torn down before the new one is live.
	if got := roundTrip(t, held, "after-move\n"); got != "after-move\n" {
		t.Fatalf("held connection relay = %q", got)
	}
}

// TestExecuteApplyTunnelTargetOnlySwapKeepsEverything is the §13.3.4 "Target
// Host / Port" row on the path the panel actually drives. It fails if the
// command ever falls back to Apply's same-port rebuild, which stops the old
// forwarder first and thereby drops the held connection for drainTimeout and
// resets Stats to zero.
func TestExecuteApplyTunnelTargetOnlySwapKeepsEverything(t *testing.T) {
	upA, stopA := echoTarget(t)
	defer stopA()
	upB, stopB := echoTarget(t)
	defer stopB()

	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")
	client := New(Config{}, tunnels, egress)
	defer tunnels.StopAll()

	port := freeTCPPort(t)
	if ack := client.execute(relayCommand(t, "cmd-target", port, upA, 1)); !ack.OK {
		t.Fatalf("initial apply failed: code=%s err=%s", ack.ErrorCode, ack.Error)
	}

	held, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", itoa(port)), 2*time.Second)
	if err != nil {
		t.Fatalf("dial tunnel: %v", err)
	}
	defer held.Close()
	if got := roundTrip(t, held, "before-swap\n"); got != "before-swap\n" {
		t.Fatalf("pre-swap relay = %q", got)
	}
	if !waitLiveConns(t, tunnels, "cmd-target", 1) {
		t.Fatalf("LiveConns = %d, want >= 1", tunnels.LiveConns("cmd-target"))
	}
	bytesBefore := tunnels.Stats("cmd-target")
	if bytesBefore == 0 {
		t.Fatal("forwarded bytes stayed 0 after a completed round trip")
	}

	// Only the target moves; port, mode and revision shape are unchanged.
	start := time.Now()
	ack := client.execute(relayCommand(t, "cmd-target", port, upB, 2))
	elapsed := time.Since(start)
	if !ack.OK {
		t.Fatalf("target-only apply failed: code=%s err=%s", ack.ErrorCode, ack.Error)
	}

	// A rebuild blocks for drainTimeout while the old forwarder drains. A
	// hot swap is immediate; allow a generous margin for a loaded CI box
	// but far below the drain window.
	if elapsed > 2*time.Second {
		t.Fatalf("target-only apply took %v, want the in-place hot swap (a same-port rebuild would block for drainTimeout)", elapsed)
	}
	// The byte counter is cumulative over the tunnel's lifetime: a rebuild
	// starts a fresh forwarder and loses it.
	if got := tunnels.Stats("cmd-target"); got < bytesBefore {
		t.Fatalf("forwarded bytes went %d -> %d, want the surviving forwarder's counter", bytesBefore, got)
	}
	// The held connection is still live on the same listener.
	if got := roundTrip(t, held, "after-swap\n"); got != "after-swap\n" {
		t.Fatalf("held connection relay = %q", got)
	}
	if tunnels.LiveConns("cmd-target") < 1 {
		t.Fatal("LiveConns dropped the held connection during a target-only swap")
	}

	// A new connection reaches the NEW target: echoTarget servers both
	// ends, so the observable proof is a round trip plus the fact that the
	// listener never moved (the port above is still the one serving).
	fresh, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", itoa(port)), 2*time.Second)
	if err != nil {
		t.Fatalf("dial after swap: %v", err)
	}
	defer fresh.Close()
	if got := roundTrip(t, fresh, "post-swap\n"); got != "post-swap\n" {
		t.Fatalf("post-swap relay = %q", got)
	}

	// The registered config describes the revision the node now runs.
	cfg, ok := tunnels.Get("cmd-target")
	if !ok {
		t.Fatal("the tunnel vanished after a target-only swap")
	}
	if cfg.Revision != 2 {
		t.Fatalf("registered revision = %d, want 2", cfg.Revision)
	}
	if got := cfg.UpstreamAddr(); got != upB {
		t.Fatalf("registered upstream = %q, want %q", got, upB)
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
