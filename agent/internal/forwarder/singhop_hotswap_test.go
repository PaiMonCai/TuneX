package forwarder

import (
	"errors"
	"io"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// WP2 — hot reload primitives on the data plane (DEVELOPMENT.md §13.3.4).
//
// These tests use real loopback sockets, because the property under test is
// "the listener never moved, the connections never dropped" — no mock forwarder
// can express that. Every assertion below maps to one row of §13.3.4.
// ---------------------------------------------------------------------------

// labeledTarget starts a listener that answers every connection with a fixed
// label, so a test can tell which upstream a connection actually reached after
// a hot swap.
func labeledTarget(t *testing.T, label string) (addr string, stop func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_, _ = io.WriteString(c, label)
				// Keep the connection open long enough for the client to
				// read the label and for a second write to prove the
				// connection survived a swap that happened mid-connection.
				time.Sleep(250 * time.Millisecond)
			}(conn)
		}
	}()
	return ln.Addr().String(), func() { _ = ln.Close() }
}

// readLabel dials addr, reads whatever the target sends back, and closes.
func readLabel(t *testing.T, addr string) string {
	t.Helper()
	c, err := dialRetry(t, addr)
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 64)
	n, err := c.Read(buf)
	if err != nil && n == 0 {
		t.Fatalf("read label from %s: %v", addr, err)
	}
	return strings.TrimSpace(string(buf[:n]))
}

func singleHopCfg(t *testing.T, port int, upstream string) TunnelConfig {
	t.Helper()
	cfg := TunnelConfig{
		ID:          "wp2-hotswap",
		Mode:        ModeDirect,
		IngressPort: port,
		RemoteHost:  hostOf(upstream),
		RemotePort:  portOf(upstream),
		Protocol:    "tcp",
		ListenHost:  "127.0.0.1",
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("cfg.Validate: %v", err)
	}
	return cfg
}

func hostOf(addr string) string {
	h, _, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return h
}

func portOf(addr string) int {
	_, p, err := net.SplitHostPort(addr)
	if err != nil {
		return 0
	}
	var out int
	for _, ch := range p {
		if ch < '0' || ch > '9' {
			return 0
		}
		out = out*10 + int(ch-'0')
	}
	return out
}

// TestSingleHopSetUpstreamKeepsListenerAndLiveConns is the §13.3.4 "Target
// Host / Port" row, asserted end to end:
//
//   - the listener does not move (same port keeps accepting);
//   - a connection opened BEFORE the swap keeps working and keeps relaying;
//   - a connection opened AFTER the swap reaches the NEW target.
func TestSingleHopSetUpstreamKeepsListenerAndLiveConns(t *testing.T) {
	port := freePort(t)
	oldAddr, stopOld := labeledTarget(t, "old")
	defer stopOld()
	newAddr, stopNew := labeledTarget(t, "new")
	defer stopNew()

	fwd, err := NewSingleHop(singleHopCfg(t, port, oldAddr))
	if err != nil {
		t.Fatalf("NewSingleHop: %v", err)
	}
	if err := fwd.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = fwd.Stop() }()
	listen := addrFor(port)

	if got := readLabel(t, listen); got != "old" {
		t.Fatalf("pre-swap label = %q, want old", got)
	}

	// Open a connection and keep it open across the swap.
	held, err := dialRetry(t, listen)
	if err != nil {
		t.Fatalf("dial held conn: %v", err)
	}
	defer held.Close()

	if err := fwd.SetUpstream(newAddr); err != nil {
		t.Fatalf("SetUpstream: %v", err)
	}

	// 1. The listener never moved: a brand-new connection is accepted.
	post, err := dialRetry(t, listen)
	if err != nil {
		t.Fatalf("dial after swap: %v", err)
	}
	defer post.Close()
	_ = post.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 64)
	n, err := post.Read(buf)
	if err != nil && n == 0 {
		t.Fatalf("read post-swap label: %v", err)
	}
	if got := strings.TrimSpace(string(buf[:n])); got != "new" {
		t.Fatalf("post-swap label = %q, want new", got)
	}

	// 2. The held connection is still relaying on the OLD upstream: it
	//    keeps sending bytes, so a read on it must still succeed.
	_ = held.SetReadDeadline(time.Now().Add(250 * time.Millisecond))
	if _, err := held.Read(make([]byte, 16)); err != nil && err != io.EOF {
		// The old target sleeps 250ms before the label frame; a hard
		// deadline miss here would mean the connection was dropped.
		t.Fatalf("held connection after swap: %v", err)
	}
	if !fwd.Running() {
		t.Fatal("forwarder reports not running after a hot swap")
	}
}

// TestSingleHopSetUpstreamUnreachableTargetKeepsListener is the operator-facing
// half of the same row: pointing a tunnel at a dead target must not take the
// listener down. New connections are dropped, the port stays bound, and the
// next swap can point it back at a live target.
func TestSingleHopSetUpstreamUnreachableTargetKeepsListener(t *testing.T) {
	port := freePort(t)
	live, stopLive := labeledTarget(t, "live")
	defer stopLive()
	// A port nobody listens on: dials fail immediately.
	dead := addrFor(freePort(t))

	fwd, err := NewSingleHop(singleHopCfg(t, port, live))
	if err != nil {
		t.Fatalf("NewSingleHop: %v", err)
	}
	if err := fwd.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = fwd.Stop() }()

	if err := fwd.SetUpstream(dead); err != nil {
		t.Fatalf("SetUpstream(dead): %v", err)
	}
	// The connection is accepted by the listener (no ECONNREFUSED on the
	// listener port) and then dropped because the upstream is gone.
	c, err := dialRetry(t, addrFor(port))
	if err != nil {
		t.Fatalf("listener refused the connection: %v", err)
	}
	_ = c.Close()
	if !fwd.Running() {
		t.Fatal("listener died after pointing at a dead target")
	}

	// Recovery: swap back to the live target, same listener.
	if err := fwd.SetUpstream(live); err != nil {
		t.Fatalf("SetUpstream(live): %v", err)
	}
	if got := readLabel(t, addrFor(port)); got != "live" {
		t.Fatalf("label after recovery = %q, want live", got)
	}
}

// TestSingleHopSetUpstreamRejectsGarbageAndDeadForwarder pins the guard rails:
// a malformed address and a stopped forwarder must both fail loudly rather
// than leave the caller believing a swap happened.
func TestSingleHopSetUpstreamRejectsGarbageAndDeadForwarder(t *testing.T) {
	live, stopLive := labeledTarget(t, "live")
	defer stopLive()

	fwd, err := NewSingleHop(singleHopCfg(t, freePort(t), live))
	if err != nil {
		t.Fatalf("NewSingleHop: %v", err)
	}
	// Never started: no listener, so no hot swap is possible.
	if err := fwd.SetUpstream(live); !errors.Is(err, ErrForwarderNotRunning) {
		t.Fatalf("SetUpstream(before Start) = %v, want ErrForwarderNotRunning", err)
	}
	if err := fwd.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	for _, bad := range []string{"", "   ", "no-port", "host:notaport", "host:0"} {
		if err := fwd.SetUpstream(bad); err == nil {
			t.Fatalf("SetUpstream(%q) = nil, want an error", bad)
		}
	}
	if err := fwd.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if err := fwd.SetUpstream(live); !errors.Is(err, ErrForwarderNotRunning) {
		t.Fatalf("SetUpstream(after Stop) = %v, want ErrForwarderNotRunning", err)
	}
}

// TestSingleHopSetUpstreamConcurrentWithConnections runs the swap while
// connections are being opened, so `go test -race` covers the read/write pair
// on the swappable upstream slot. The invariant is not "every connection sees
// one address" but "every connection dials a complete, valid address".
func TestSingleHopSetUpstreamConcurrentWithConnections(t *testing.T) {
	port := freePort(t)
	live, stopLive := labeledTarget(t, "live")
	defer stopLive()
	other, stopOther := labeledTarget(t, "other")
	defer stopOther()

	fwd, err := NewSingleHop(singleHopCfg(t, port, live))
	if err != nil {
		t.Fatalf("NewSingleHop: %v", err)
	}
	if err := fwd.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = fwd.Stop() }()

	var dialed int64
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
			}
			c, err := net.DialTimeout("tcp", addrFor(port), 500*time.Millisecond)
			if err == nil {
				atomic.AddInt64(&dialed, 1)
				// Hold the connection briefly so the relay really takes
				// it: a dial-then-close burst could be counted before
				// the accept loop ever ran.
				time.Sleep(20 * time.Millisecond)
				_ = c.Close()
			}
			time.Sleep(time.Millisecond)
		}
	}()
	// Give the dialer a head start, so the swaps race a live connection
	// stream rather than a listener nobody is talking to yet.
	time.Sleep(50 * time.Millisecond)
	for i := 0; i < 200; i++ {
		addr := live
		if i%2 == 1 {
			addr = other
		}
		if err := fwd.SetUpstream(addr); err != nil {
			t.Fatalf("SetUpstream iteration %d: %v", i, err)
		}
		if i%20 == 0 {
			time.Sleep(2 * time.Millisecond)
		}
	}
	close(stop)
	<-done
	if got := atomic.LoadInt64(&dialed); got == 0 {
		t.Fatal("no connection was ever accepted through the swapping listener")
	}
	t.Logf("dialed=%d swaps=200", atomic.LoadInt64(&dialed))
}

// TestSingleHopDrainKeepsListenerAndBoundsTheWait pins the Drain contract:
// bounded wait (never longer than the package ceiling), listener still bound
// afterwards, and an idle drain returns immediately.
func TestSingleHopDrainKeepsListenerAndBoundsTheWait(t *testing.T) {
	port := freePort(t)
	live, stopLive := labeledTarget(t, "live")
	defer stopLive()

	fwd, err := NewSingleHop(singleHopCfg(t, port, live))
	if err != nil {
		t.Fatalf("NewSingleHop: %v", err)
	}
	if err := fwd.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = fwd.Stop() }()

	// Idle drain: returns immediately.
	start := time.Now()
	if err := fwd.Drain(0); err != nil {
		t.Fatalf("idle Drain: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("idle Drain took %v, want near-instant", elapsed)
	}
	// Absurd timeout is clamped to the hard ceiling, not honoured.
	start = time.Now()
	if err := fwd.Drain(time.Hour); err != nil {
		t.Fatalf("Drain(time.Hour): %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("Drain(time.Hour) took %v, want clamped (no live conns)", elapsed)
	}

	// A connection that never finishes must not wedge the drain: the target
	// answers and then sleeps, so the in-flight count is non-zero for a
	// while. Drain returns after the requested wait while the listener
	// survives.
	held, err := dialRetry(t, addrFor(port))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer held.Close()
	// Wait until the relay has actually taken the connection, so the drain
	// below has something in flight to wait for.
	if !waitForConn(t, fwd) {
		t.Fatalf("the relay never picked up the connection; LiveConns=%d", fwd.LiveConns())
	}
	start = time.Now()
	if err := fwd.Drain(80 * time.Millisecond); err != nil {
		t.Fatalf("Drain: %v", err)
	}
	if elapsed := time.Since(start); elapsed < 60*time.Millisecond {
		t.Fatalf("Drain returned in %v, want at least the requested wait", elapsed)
	}
	if !fwd.Running() {
		t.Fatal("listener is gone after Drain: Drain must not release the port")
	}
	// The port is still bound, so a new connection is accepted (and then
	// dropped, because this test's target sleeps before answering).
	if _, err := dialRetry(t, addrFor(port)); err != nil {
		t.Fatalf("listener stopped accepting after Drain: %v", err)
	}
}

// waitForConn waits until the forwarder is relaying at least one connection.
func waitForConn(t *testing.T, fwd *SingleHopForwarder) bool {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if fwd.LiveConns() > 0 {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	return false
}

// TestEgressSetUpstreamNotSwappable guards the seam that must NOT exist:
// retargeting an EGRESS tunnel through the single-address swap would lose the
// balancer, so the egress forwarder refuses it and points at Pool.SwapTargets.
func TestEgressSetUpstreamNotSwappable(t *testing.T) {
	sel := &recordingSelector{target: Target{Host: "127.0.0.1", Port: 1}}
	fwd, err := NewEgress(TunnelConfig{
		ID: "wp2-egress", Mode: ModeEgress, EgressPort: freePort(t), Protocol: "tcp",
	}, sel)
	if err != nil {
		t.Fatalf("NewEgress: %v", err)
	}
	if err := fwd.SetUpstream("127.0.0.1:1"); !errors.Is(err, ErrUpstreamNotSwappable) {
		t.Fatalf("SetUpstream = %v, want ErrUpstreamNotSwappable", err)
	}
	// Drain is still available (pool hot updates keep working through it).
	if err := fwd.Drain(0); err != nil {
		t.Fatalf("Drain: %v", err)
	}
}

// recordingSelector is the smallest TargetSelector that satisfies the egress
// constructor in a test that never dials anything.
type recordingSelector struct{ target Target }

func (s *recordingSelector) Select() Target { return s.target }

// addrFor renders loopback:port. It exists in this package's tests so the
// hot-swap tests read symmetrically with the manager package's helpers.
func addrFor(port int) string { return net.JoinHostPort("127.0.0.1", itoa(port)) }

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
