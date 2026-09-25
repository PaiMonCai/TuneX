package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tunex/agent/internal/manager"
)

// ---------------------------------------------------------------------------
// WP2 — the admin API is the second apply surface, and it must honour the
// same §13.3.4 edit semantics the panel's apply_tunnel command gets
// (DEVELOPMENT.md §13.3.4 / §13.3.5). Both surfaces route through the same
// manager entry point (TunnelManager.ReplaceListener), so these tests assert
// the observables that distinguish a hot swap from a rebuild: the listener
// does not move, the held connection keeps relaying, and the running config
// ends up describing the revision that was just applied.
// ---------------------------------------------------------------------------

// echoTarget answers every connection with what it receives, so a round trip
// through the tunnel proves the data plane.
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

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("reserve port: %v", err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func loopback(port int) string { return net.JoinHostPort("127.0.0.1", itoa(port)) }

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

// relayPayload is a RELAY tunnel config as the wire spells it.
type relayPayload struct {
	ID          string `json:"id"`
	Mode        string `json:"mode"`
	IngressPort int    `json:"ingress_port"`
	NextHop     string `json:"next_hop"`
	Protocol    string `json:"protocol"`
	Revision    int64  `json:"revision"`
}

// applyTunnel POSTs one tunnel config to the admin API and returns the status.
func applyTunnel(t *testing.T, srv *Server, body any) int {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/tunnel", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec.Code
}

func newTestServer(t *testing.T, tunnels *manager.TunnelManager) *Server {
	t.Helper()
	srv, err := New(Options{ListenHost: "127.0.0.1", Token: "test-token"}, tunnels, nil, nil)
	if err != nil {
		t.Fatalf("api.New: %v", err)
	}
	return srv
}

// roundTrip writes msg through conn and reads the same number of bytes back.
func roundTrip(t *testing.T, conn net.Conn, msg string) {
	t.Helper()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Write([]byte(msg)); err != nil {
		t.Fatalf("write %q: %v", msg, err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read echo of %q: %v", msg, err)
	}
	if string(buf) != msg {
		t.Fatalf("relay = %q, want %q", buf, msg)
	}
}

// TestAdminApplyTunnelTargetOnlyIsHotSwap is the §13.3.4 "Target Host / Port"
// row on the admin surface. A target-only edit must retarget the running
// forwarder in place: the listener keeps serving, the held connection keeps
// relaying, and the byte counter survives. Routing it through Apply instead
// (stop old, then start new) would drain the held connection — exactly the
// outage the row forbids.
func TestAdminApplyTunnelTargetOnlyIsHotSwap(t *testing.T) {
	upA, stopA := echoTarget(t)
	defer stopA()
	upB, stopB := echoTarget(t)
	defer stopB()

	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")
	defer tunnels.StopAll()
	srv := newTestServer(t, tunnels)
	port := freePort(t)

	if code := applyTunnel(t, srv, relayPayload{
		ID: "t", Mode: "RELAY", IngressPort: port, NextHop: upA, Protocol: "tcp", Revision: 1,
	}); code != http.StatusOK {
		t.Fatalf("initial apply status = %d, want 200", code)
	}

	held, err := net.DialTimeout("tcp", loopback(port), 2*time.Second)
	if err != nil {
		t.Fatalf("dial tunnel: %v", err)
	}
	defer held.Close()
	roundTrip(t, held, "before\n")
	if tunnels.Stats("t") == 0 {
		t.Fatal("forwarded bytes stayed 0 after a completed round trip")
	}
	bytesBefore := tunnels.Stats("t")

	// Only the target moves.
	if code := applyTunnel(t, srv, relayPayload{
		ID: "t", Mode: "RELAY", IngressPort: port, NextHop: upB, Protocol: "tcp", Revision: 2,
	}); code != http.StatusOK {
		t.Fatalf("target-only apply status = %d, want 200", code)
	}

	if tunnels.Stats("t") < bytesBefore {
		t.Fatalf("forwarded bytes went %d -> %d, want the surviving forwarder's counter", bytesBefore, tunnels.Stats("t"))
	}
	roundTrip(t, held, "after\n")
	if tunnels.LiveConns("t") < 1 {
		t.Fatal("LiveConns dropped the held connection during a target-only swap")
	}

	// A new connection reaches the new target on the SAME listener.
	fresh, err := net.DialTimeout("tcp", loopback(port), 2*time.Second)
	if err != nil {
		t.Fatalf("dial after swap: %v", err)
	}
	defer fresh.Close()
	roundTrip(t, fresh, "post\n")

	cfg, ok := tunnels.Get("t")
	if !ok || cfg.Revision != 2 {
		t.Fatalf("registered config after target swap = %+v ok=%v, want revision 2", cfg, ok)
	}
	if cfg.IngressPort != port {
		t.Fatalf("registered listen port = %d, want the unchanged %d", cfg.IngressPort, port)
	}
	if cfg.UpstreamAddr() != upB {
		t.Fatalf("registered upstream = %q, want %q", cfg.UpstreamAddr(), upB)
	}
}

// TestAdminApplyTunnelPortMoveKeepsOldInstanceTemporarily is the listener row
// through the admin API: the new port binds first and serves, and the old
// instance is drained (its connections still relay) rather than dropped.
func TestAdminApplyTunnelPortMoveKeepsOldInstanceTemporarily(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()

	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")
	defer tunnels.StopAll()
	srv := newTestServer(t, tunnels)

	oldPort := freePort(t)
	newPort := freePort(t)
	if code := applyTunnel(t, srv, relayPayload{
		ID: "t", Mode: "RELAY", IngressPort: oldPort, NextHop: up, Protocol: "tcp", Revision: 1,
	}); code != http.StatusOK {
		t.Fatalf("initial apply status = %d, want 200", code)
	}

	held, err := net.DialTimeout("tcp", loopback(oldPort), 2*time.Second)
	if err != nil {
		t.Fatalf("dial tunnel: %v", err)
	}
	defer held.Close()
	roundTrip(t, held, "before\n")

	if code := applyTunnel(t, srv, relayPayload{
		ID: "t", Mode: "RELAY", IngressPort: newPort, NextHop: up, Protocol: "tcp", Revision: 2,
	}); code != http.StatusOK {
		t.Fatalf("port-move apply status = %d, want 200", code)
	}

	// The new port serves.
	fresh, err := net.DialTimeout("tcp", loopback(newPort), 2*time.Second)
	if err != nil {
		t.Fatalf("dial new port: %v", err)
	}
	defer fresh.Close()
	roundTrip(t, fresh, "new-port\n")

	// The held connection keeps relaying: the old instance was drained, not
	// torn down before the new listener was live.
	roundTrip(t, held, "after\n")

	// The old port reservation was released (a later apply may reuse it).
	if tunnels.UsedPorts()[oldPort] {
		t.Fatal("old port is still reserved after a listener move")
	}
	if !tunnels.UsedPorts()[newPort] {
		t.Fatal("new port is not reserved after a listener move")
	}
}

// TestAdminApplyTunnelStaleRevisionIsConflict keeps the HTTP contract: an
// older revision is a 409 the panel must not retry.
func TestAdminApplyTunnelStaleRevisionIsConflict(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()

	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")
	defer tunnels.StopAll()
	srv := newTestServer(t, tunnels)

	if code := applyTunnel(t, srv, relayPayload{
		ID: "t", Mode: "RELAY", IngressPort: freePort(t), NextHop: up, Protocol: "tcp", Revision: 5,
	}); code != http.StatusOK {
		t.Fatalf("initial apply status = %d, want 200", code)
	}
	if code := applyTunnel(t, srv, relayPayload{
		ID: "t", Mode: "RELAY", IngressPort: freePort(t), NextHop: up, Protocol: "tcp", Revision: 4,
	}); code != http.StatusConflict {
		t.Fatalf("stale apply status = %d, want 409", code)
	}
	if cfg, ok := tunnels.Get("t"); !ok || cfg.Revision != 5 {
		t.Fatalf("running revision after a 409 = %+v ok=%v, want 5", cfg, ok)
	}
}

// TestAdminApplyTunnelFirstApplyIsNotAListenerMove guards the routing: a
// first-ever apply must not be classified as a listener replacement (there is
// no running instance to diff against), which would bypass Apply's port
// guard. Occupying the target port makes the bind fail, so a misroute shows
// up as a silent success where a port conflict belongs.
func TestAdminApplyTunnelFirstApplyRespectsPortGuard(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()

	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, "127.0.0.1")
	defer tunnels.StopAll()
	srv := newTestServer(t, tunnels)

	port := freePort(t)
	blocker, err := net.Listen("tcp", loopback(port))
	if err != nil {
		t.Skipf("cannot occupy the port: %v", err)
	}
	defer blocker.Close()

	code := applyTunnel(t, srv, relayPayload{
		ID: "t", Mode: "RELAY", IngressPort: port, NextHop: up, Protocol: "tcp", Revision: 1,
	})
	if code == http.StatusOK {
		t.Fatal("a first apply succeeded on a port held by a foreign process; the port guard was bypassed")
	}
	if _, ok := tunnels.Get("t"); ok {
		t.Fatal("a failed first apply still registered the tunnel")
	}
	// Neither port reservation was taken by us.
	if tunnels.UsedPorts()[port] {
		t.Fatal("the failed apply reserved a port it does not own")
	}
}
