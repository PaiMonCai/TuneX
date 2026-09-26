package manager

import (
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

// ---------------------------------------------------------------------------
// WP2 — manager-layer hot reload primitives: the swap decision, the
// listener-safe replacement, and drain (DEVELOPMENT.md §13.3.4 / §13.3.5).
//
// Everything here uses real loopback sockets. The claim under test is about
// observable behaviour ("this port stopped accepting", "this connection kept
// relaying", "the replaced tunnel's bytes counter survived"), which no stub
// forwarder can express.
// ---------------------------------------------------------------------------

func relayCfg(id string, port int, upstream string, revision int64) forwarder.TunnelConfig {
	host, portStr, err := net.SplitHostPort(upstream)
	if err != nil {
		host, portStr = upstream, "0"
	}
	var p int
	for _, ch := range portStr {
		if ch < '0' || ch > '9' {
			p = 0
			break
		}
		p = p*10 + int(ch-'0')
	}
	return forwarder.TunnelConfig{
		ID:          id,
		Mode:        forwarder.ModeRelay,
		IngressPort: port,
		NextHop:     upstream,
		Protocol:    "tcp",
		Revision:    revision,
		RemoteHost:  host,
		RemotePort:  p,
	}
}

// portFreedWithin waits until the manager's port guard no longer reserves port.
// The reservation release is sequenced after the old forwarder has stopped, so a
// read immediately after the move is racy by design; what must hold is that the
// release still happens, promptly, and never leaks.
func portFreedWithin(t *testing.T, ports func() map[int]bool, port int, timeout time.Duration) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !ports()[port] {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return !ports()[port]
}

// readOneLine reads a single line from conn, so a test can see which upstream
// served it.
func readOneLine(t *testing.T, conn net.Conn) string {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 256)
	var sb strings.Builder
	for !strings.Contains(sb.String(), "\n") {
		n, err := conn.Read(buf)
		if n > 0 {
			sb.Write(buf[:n])
		}
		if err != nil {
			if err == io.EOF {
				break
			}
			t.Fatalf("read line: %v", err)
		}
	}
	return strings.TrimSpace(sb.String())
}

// servedLabel dials addr through a relay and returns the target's label.
func servedLabel(t *testing.T, addr string) string {
	t.Helper()
	c, err := dialRetry(t, addr)
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	defer c.Close()
	return readOneLine(t, c)
}

// ---------------------------------------------------------------------------
// PlanForwardSwap — the WP3 plan input, asserted row by row against §13.3.4
// ---------------------------------------------------------------------------

func TestPlanForwardSwapDecisionTable(t *testing.T) {
	base := relayCfg("t", 10000, "10.0.0.1:9000", 1)

	cases := []struct {
		name         string
		mutate       func(c *forwarder.TunnelConfig)
		wantStrategy SwapStrategy
		wantDrain    bool
		wantFreePort bool
	}{
		{
			name:         "identical config is a no-op",
			mutate:       func(c *forwarder.TunnelConfig) {},
			wantStrategy: SwapNoop,
		},
		{
			name:         "same everything is metadata at worst",
			mutate:       func(c *forwarder.TunnelConfig) { c.SpeedLimit = 4096 },
			wantStrategy: SwapMetadata,
		},
		{
			name:         "upstream only is a target hot swap",
			mutate:       func(c *forwarder.TunnelConfig) { c.NextHop = "10.0.0.2:9000" },
			wantStrategy: SwapTargetSwap,
		},
		{
			name:         "listen port moved needs a new listener",
			mutate:       func(c *forwarder.TunnelConfig) { c.IngressPort = 10001 },
			wantStrategy: SwapListener,
			wantDrain:    true,
			wantFreePort: true,
		},
		{
			name: "mode change on the same port stays on one listener",
			mutate: func(c *forwarder.TunnelConfig) {
				c.Mode = forwarder.ModeDirect
			},
			wantStrategy: SwapTargetSwap,
		},
		{
			name: "egress configs are recreated, never hot-swapped",
			mutate: func(c *forwarder.TunnelConfig) {
				c.Mode = forwarder.ModeEgress
				c.EgressPort = 10002
				c.IngressPort = 0
				c.NextHop = ""
			},
			wantStrategy: SwapRecreate,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cand := base.Clone()
			tc.mutate(&cand)
			plan := PlanForwardSwap(base, cand)
			if plan.Strategy != tc.wantStrategy {
				t.Fatalf("strategy = %q, want %q (%s)", plan.Strategy, tc.wantStrategy, plan.Reason)
			}
			if plan.DrainOld != tc.wantDrain {
				t.Fatalf("DrainOld = %v, want %v", plan.DrainOld, tc.wantDrain)
			}
			if plan.FreeOldPort != tc.wantFreePort {
				t.Fatalf("FreeOldPort = %v, want %v", plan.FreeOldPort, tc.wantFreePort)
			}
		})
	}
}

func TestPlanForwardSwapIsPure(t *testing.T) {
	old := relayCfg("t", 10000, "10.0.0.1:9000", 1)
	newer := relayCfg("t", 10001, "10.0.0.2:9000", 2)
	first := PlanForwardSwap(old, newer)
	second := PlanForwardSwap(old, newer)
	if first != second {
		t.Fatalf("PlanForwardSwap is not deterministic:\n%+v\n%+v", first, second)
	}
	if old.IngressPort != 10000 || newer.IngressPort != 10001 {
		t.Fatal("PlanForwardSwap mutated its inputs")
	}
}

// ---------------------------------------------------------------------------
// HotSwapUpstream
// ---------------------------------------------------------------------------

func TestHotSwapUpstreamKeepsListenerAndSwitchesTarget(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	aPort, aServed := labeledServer(t, "a")
	defer aServed()
	bPort, bServed := labeledServer(t, "b")
	defer bServed()
	port := freePort(t)

	cfg := relayCfg("hot", port, addrFor(aPort), 7)
	if _, err := tm.Apply(cfg); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	if got := servedLabel(t, addrFor(port)); got != "srv:a" {
		t.Fatalf("pre-swap target = %q, want srv:a", got)
	}

	if err := tm.HotSwapUpstream("hot", addrFor(bPort)); err != nil {
		t.Fatalf("HotSwapUpstream: %v", err)
	}

	// Same listener, new target.
	if got := servedLabel(t, addrFor(port)); got != "srv:b" {
		t.Fatalf("post-swap target = %q, want srv:b", got)
	}
	// The old target never saw a second connection.
	if got := aServed(); got != 1 {
		t.Fatalf("old target served %d connections, want exactly 1 (the pre-swap probe)", got)
	}
	if got := bServed(); got != 1 {
		t.Fatalf("new target served %d connections, want exactly 1", got)
	}
	// The registered config still describes the tunnel the node reports on.
	if got, ok := tm.Get("hot"); !ok || got.IngressPort != port {
		t.Fatalf("tunnel config drifted after a hot swap: %+v ok=%v", got, ok)
	}
}

func TestHotSwapUpstreamKeepsLiveConnectionAlive(t *testing.T) {
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	up, stopUp := echoServer(t)
	defer stopUp()
	port := freePort(t)

	if _, err := tm.Apply(relayCfg("live", port, up, 1)); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	// Prove the connection works end to end first (a real two-way transfer).
	echoRoundTrip(t, addrFor(port), []byte("before-swap"))

	held, err := dialRetry(t, addrFor(port))
	if err != nil {
		t.Fatalf("dial held conn: %v", err)
	}
	defer held.Close()

	if err := tm.HotSwapUpstream("live", up); err != nil {
		t.Fatalf("HotSwapUpstream: %v", err)
	}

	// The held connection is still relaying: a write travels and the echo
	// comes back on the SAME connection.
	_ = held.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := held.Write([]byte("still-here\n")); err != nil {
		t.Fatalf("write on held conn after swap: %v", err)
	}
	buf := make([]byte, len("still-here\n"))
	if _, err := io.ReadFull(held, buf); err != nil {
		t.Fatalf("held conn stopped relaying after the swap: %v", err)
	}
	if string(buf) != "still-here\n" {
		t.Fatalf("held conn relayed %q", buf)
	}
	if tm.LiveConns("live") < 1 {
		t.Fatal("LiveConns dropped the held connection during a hot swap")
	}
}

func TestHotSwapUpstreamErrorsLeaveTheTunnelRunning(t *testing.T) {
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	aPort, _ := labeledServer(t, "a")
	port := freePort(t)

	if _, err := tm.Apply(relayCfg("err", port, addrFor(aPort), 1)); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	for _, bad := range []string{"", "not-an-address", "host:0", "host:99999"} {
		if err := tm.HotSwapUpstream("err", bad); err == nil {
			t.Fatalf("HotSwapUpstream(%q) = nil, want an error", bad)
		}
	}
	if err := tm.HotSwapUpstream("ghost", addrFor(aPort)); !errors.Is(err, ErrTunnelNotFound) {
		t.Fatalf("HotSwapUpstream(unknown) = %v, want ErrTunnelNotFound", err)
	}
	// The tunnel survived every rejection on its original upstream.
	if got := servedLabel(t, addrFor(port)); got != "srv:a" {
		t.Fatalf("target after rejected swaps = %q, want srv:a", got)
	}
}

func TestHotSwapUpstreamEgressIsNotSwappable(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	aPort, _ := labeledServer(t, "a")
	em.SetPool("eg", RoundRobin, []forwarder.Target{tg("127.0.0.1", aPort)})
	ePort := freePort(t)
	if _, err := tm.Apply(forwarder.TunnelConfig{
		ID: "eg", Mode: forwarder.ModeEgress, EgressPort: ePort, Protocol: "tcp",
	}); err != nil {
		t.Fatalf("Apply egress: %v", err)
	}
	defer tm.StopAll()

	err := tm.HotSwapUpstream("eg", addrFor(freePort(t)))
	if !errors.Is(err, forwarder.ErrUpstreamNotSwappable) {
		t.Fatalf("HotSwapUpstream on EGRESS = %v, want ErrUpstreamNotSwappable", err)
	}
}

// ---------------------------------------------------------------------------
// ReplaceListener — the §13.3.5 PREPARE/CUTOVER/DRAIN ordering
// ---------------------------------------------------------------------------

// TestReplaceListenerOldPortGuardFollowsTheOldListener is the guard window the
// review flagged: the old port's reservation used to be dropped BEFORE the old
// forwarder's listener was closed, so the guard advertised a port the kernel
// still had bound. A concurrent Apply could then take that port and fail its
// bind, on a port the manager had just called free.
//
// What must hold is a strict ordering: while the old listener is still bound,
// the guard still reserves the port; only once the old instance has really
// stopped does the reservation go, and then the port is immediately rebindable.
func TestReplaceListenerOldPortGuardFollowsTheOldListener(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	aPort, aServed := labeledServer(t, "a")
	defer aServed()
	oldPort := freePort(t)
	newPort := freePort(t)

	base := relayCfg("guard", oldPort, addrFor(aPort), 5)
	if _, err := tm.Apply(base); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	// A connection held across the replacement: it keeps the old forwarder's
	// Stop blocking for the whole drain window, which widens the window in
	// which a wrong release would be observable.
	held, err := dialRetry(t, addrFor(oldPort))
	if err != nil {
		t.Fatalf("dial held: %v", err)
	}
	defer held.Close()
	if !waitFor(t, "relay picks up the connection", 2*time.Second, func() bool {
		return tm.LiveConns("guard") > 0
	}) {
		t.Fatal("the relay never took the held connection")
	}

	next := base.Clone()
	next.IngressPort = newPort
	next.Revision = 6
	if _, err := tm.ReplaceListener(next); err != nil {
		t.Fatalf("ReplaceListener: %v", err)
	}

	// While the old instance is still stopping, the guard must keep the old
	// port reserved. That is the observable that matters to a concurrent
	// Apply: it reads the guard, not the kernel, and a reservation dropped
	// early would let it take a port whose listener is still bound.
	//
	// (The OS side is not a usable oracle here: a probe bind can succeed on
	// a port whose listener has just closed and fail on a port about to be
	// released, so it would flake for reasons unrelated to the ordering.)
	sawReserved := false
	for i := 0; i < 40; i++ {
		if tm.UsedPorts()[oldPort] {
			sawReserved = true
		} else if sawReserved {
			// Previously reserved, now free: the teardown released it.
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !sawReserved {
		t.Fatal("the old port reservation was released before the old instance stopped")
	}

	// And it IS released afterwards, with the port immediately reusable: no
	// permanent leak.
	if !portFreedWithin(t, tm.UsedPorts, oldPort, 5*time.Second) {
		t.Fatal("the old port reservation was never released")
	}
	waitForPortClosed(t, oldPort)
}

// TestReplaceListenerMovesPortAndDrainsTheOldOne is the happy path: the new
// port serves the same target on the new listener, the old port stops
// accepting, the old port reservation is released (after the old instance
// stops), and the new port stays reserved.
func TestReplaceListenerMovesPortAndDrainsTheOldOne(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	aPort, aServed := labeledServer(t, "a")
	defer aServed()
	oldPort := freePort(t)
	newPort := freePort(t)

	base := relayCfg("move", oldPort, addrFor(aPort), 5)
	if _, err := tm.Apply(base); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	// A connection held across the replacement.
	held, err := dialRetry(t, addrFor(oldPort))
	if err != nil {
		t.Fatalf("dial held: %v", err)
	}
	defer held.Close()
	_ = readOneLine(t, held)

	next := base.Clone()
	next.IngressPort = newPort
	next.Revision = 6
	fwd, err := tm.ReplaceListener(next)
	if err != nil {
		t.Fatalf("ReplaceListener: %v", err)
	}
	if !fwd.Running() {
		t.Fatal("the replacement forwarder is not running")
	}

	// The new port serves the same target on the new listener.
	if got := servedLabel(t, addrFor(newPort)); got != "srv:a" {
		t.Fatalf("new port served %q, want srv:a", got)
	}
	// The port guard releases the old port once the old instance has
	// actually stopped, which is what keeps the guard from advertising a
	// port the kernel still has bound. It must still be released, not
	// leaked, and the new port stays ours.
	if !portFreedWithin(t, tm.UsedPorts, oldPort, 5*time.Second) {
		t.Fatal("the old port reservation was never released after a listener move")
	}
	if !tm.UsedPorts()[newPort] {
		t.Fatal("new port is not marked used after a listener move")
	}
	// The old port must stop accepting (the old listener is being drained
	// and torn down).
	if !waitFor(t, "old port stops accepting", 5*time.Second, func() bool {
		ln, err := net.Listen("tcp", addrFor(oldPort))
		if err != nil {
			return false
		}
		_ = ln.Close()
		return true
	}) {
		t.Fatal("the old port kept accepting after a listener move")
	}
}

// TestReplaceListenerBindFailureKeepsTheOldInstanceRunning is the §13.3.5
// PREPARE-failure rule on the listener path: the new port cannot be bound, so
// the old applied revision keeps running and its port reservation stays.
//
// The failure must come from a listener move. The previous construction
// occupied the tunnel's CURRENT port, which only pinned the universal
// gateway, so it collapsed into a no-op that exercised nothing.
func TestReplaceListenerBindFailureKeepsTheOldInstanceRunning(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	aPort, aServed := labeledServer(t, "a")
	defer aServed()
	port := freePort(t)

	if _, err := tm.Apply(relayCfg("safe", port, addrFor(aPort), 1)); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	// Hold the port the replacement wants to MOVE TO, with a foreign
	// process, so the new bind must fail.
	newPort := freePort(t)
	blocker, err := net.Listen("tcp", addrFor(newPort))
	if err != nil {
		t.Skipf("cannot occupy the target port: %v", err)
	}
	defer blocker.Close()

	next := relayCfg("safe", newPort, addrFor(aPort), 9)
	if _, err := tm.ReplaceListener(next); err == nil {
		t.Fatal("ReplaceListener succeeded on a port held by a foreign process")
	}

	// §13.3.5: PREPARE failed → the old applied revision keeps running.
	cfg, ok := tm.Get("safe")
	if !ok {
		t.Fatal("the old tunnel vanished after a failed replacement")
	}
	if cfg.Revision != 1 {
		t.Fatalf("running revision = %d, want the old 1", cfg.Revision)
	}
	if cfg.IngressPort != port {
		t.Fatalf("running listen port = %d, want the old %d", cfg.IngressPort, port)
	}
	// The old instance still serves traffic on the old port: it is the
	// tunnel, not the blocker (which never answers).
	if got := servedLabel(t, addrFor(port)); got != "srv:a" {
		t.Fatalf("the old instance stopped serving after a failed replacement: %q", got)
	}
	// Neither port reservation was lost or leaked: the old one stays taken,
	// and the blocked one was never ours.
	if !tm.UsedPorts()[port] {
		t.Fatal("the failed replacement released the old tunnel's port reservation")
	}
	if tm.UsedPorts()[newPort] {
		t.Fatal("the failed replacement reserved a port it does not own")
	}
}

func TestReplaceListenerSamePortKeepsServing(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	aPort, _ := labeledServer(t, "a")
	bPort, bServed := labeledServer(t, "b")
	defer bServed()
	port := freePort(t)

	base := relayCfg("same", port, addrFor(aPort), 3)
	if _, err := tm.Apply(base); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	next := base.Clone()
	next.NextHop = addrFor(bPort)
	next.Revision = 4
	if _, err := tm.ReplaceListener(next); err != nil {
		t.Fatalf("ReplaceListener (same port, new upstream): %v", err)
	}
	if got := servedLabel(t, addrFor(port)); got != "srv:b" {
		t.Fatalf("target after same-port replacement = %q, want srv:b", got)
	}
	if !tm.UsedPorts()[port] {
		t.Fatal("the port reservation was lost by a same-port replacement")
	}
}

// TestReplaceListenerSamePortTargetSwapKeepsLiveConnections is the manager's
// side of the §13.3.4 "Target Host / Port" row: an upstream-only change must
// retarget the RUNNING forwarder in place. Going through applyLocked instead
// (Apply's same-port path stops the old forwarder first) would drain the held
// connection and reset the byte counter, which is the silent outage the row
// exists to prevent — so this test fails on observables a rebuild cannot fake:
// the very same forwarder pointer, a byte counter that survives, and a held
// connection that keeps relaying.
func TestReplaceListenerSamePortTargetSwapKeepsLiveConnections(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	aPort, aServed := labeledServer(t, "a")
	defer aServed()
	bPort, bServed := labeledServer(t, "b")
	defer bServed()
	port := freePort(t)

	base := relayCfg("swap", port, addrFor(aPort), 3)
	before, err := tm.Apply(base)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	// A held connection through the running forwarder, plus bytes on the
	// counter, so a rebuild is detectable.
	held, err := dialRetry(t, addrFor(port))
	if err != nil {
		t.Fatalf("dial held: %v", err)
	}
	defer held.Close()
	if got := readOneLine(t, held); got != "srv:a" {
		t.Fatalf("pre-swap label = %q, want srv:a", got)
	}
	if _, err := held.Write([]byte("live\n")); err != nil {
		t.Fatalf("write on held conn: %v", err)
	}
	if bytes := tm.Stats("swap"); bytes == 0 {
		t.Fatal("forwarded bytes stayed 0 after a completed round trip")
	}
	bytesBefore := tm.Stats("swap")

	next := base.Clone()
	next.NextHop = addrFor(bPort)
	next.Revision = 4
	got, err := tm.ReplaceListener(next)
	if err != nil {
		t.Fatalf("ReplaceListener (same port, new upstream): %v", err)
	}
	if got != before {
		t.Fatal("an upstream-only change must retarget the running forwarder, not build a new one")
	}
	if tm.Stats("swap") < bytesBefore {
		t.Fatalf("forwarded bytes went %d -> %d, want the surviving forwarder's counter", bytesBefore, tm.Stats("swap"))
	}
	if tm.LiveConns("swap") < 1 {
		t.Fatal("LiveConns dropped the held connection during a target swap")
	}

	// The new target serves new connections, on the same listener.
	if got := servedLabel(t, addrFor(port)); got != "srv:b" {
		t.Fatalf("target after target swap = %q, want srv:b", got)
	}
	// The registered config describes the revision the node now runs.
	if cfg, ok := tm.Get("swap"); !ok || cfg.Revision != 4 {
		t.Fatalf("registered revision after target swap = %+v ok=%v, want 4", cfg, ok)
	}
	if !tm.UsedPorts()[port] {
		t.Fatal("the port reservation was lost by a target swap")
	}
}

// TestReplaceListenerPortAndTargetChangeRoutesThroughTheListenerPath is the
// port-move case carrying an upstream change with it: PlanForwardSwap answers
// SwapListener (the port moved, so there is no one-listener swap to perform),
// the new listener binds first, and the node ends up serving the requested
// target on the requested port.
//
// This is NOT the in-place-swap fallback (see
// TestReplaceListenerTargetSwapAfterDrainFallsBackToRebuild for that): the
// routing decision here is the plan's listener class, not a refused swap.
func TestReplaceListenerPortAndTargetChangeRoutesThroughTheListenerPath(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	aPort, aServed := labeledServer(t, "a")
	defer aServed()
	bPort, _ := labeledServer(t, "b")
	port := freePort(t)

	base := relayCfg("move-and-target", port, addrFor(aPort), 2)
	if _, err := tm.Apply(base); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	// The port moved AND the target moved.
	next := base.Clone()
	next.IngressPort = freePort(t)
	next.NextHop = addrFor(bPort)
	next.Revision = 3
	if _, err := tm.ReplaceListener(next); err != nil {
		t.Fatalf("ReplaceListener (port + target): %v", err)
	}
	if got := servedLabel(t, addrFor(next.IngressPort)); got != "srv:b" {
		t.Fatalf("target after port+target change = %q, want srv:b", got)
	}
	if cfg, ok := tm.Get("move-and-target"); !ok || cfg.Revision != 3 || cfg.IngressPort != next.IngressPort {
		t.Fatalf("registered config after port+target change = %+v ok=%v", cfg, ok)
	}
}

// TestReplaceListenerTargetSwapAfterDrainFallsBackToRebuild is the REAL
// defensive exit of hotSwapUpstreamLocked, which the old
// "TestReplaceListenerTargetSwapFallback..." never reached: it built a port +
// target change, which PlanForwardSwap classifies as SwapListener, so the
// fallback branch (SetUpstream refused) was dead code under test.
//
// The reachable case is a DRAINED tunnel. A drain ends the accept loop, so
// SetUpstream on that forwarder answers ErrForwarderNotRunning; a revision
// that then moves only the upstream still classifies as target_hot_swap, and
// the manager must rebuild through Apply rather than fail the command and
// leave the node running a config the panel no longer believes in.
func TestReplaceListenerTargetSwapAfterDrainFallsBackToRebuild(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	aPort, aServed := labeledServer(t, "a")
	defer aServed()
	bPort, _ := labeledServer(t, "b")
	port := freePort(t)

	base := relayCfg("fallback", port, addrFor(aPort), 2)
	if _, err := tm.Apply(base); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	// Drain first: the forwarder keeps its port reservation but takes no
	// new work, so it must refuse the in-place swap that follows.
	if err := tm.DrainTunnel("fallback", time.Second); err != nil {
		t.Fatalf("DrainTunnel: %v", err)
	}
	// Sanity: the direct swap really is refused on a drained forwarder,
	// which is what forces the manager down its fallback.
	if err := tm.HotSwapUpstream("fallback", addrFor(bPort)); err == nil {
		t.Fatal("HotSwapUpstream on a drained tunnel succeeded: the fallback below would never be reached")
	}

	// Upstream-only change on the same listener: still a target swap by
	// classification, but the forwarder cannot take it.
	next := base.Clone()
	next.NextHop = addrFor(bPort)
	next.Revision = 3
	rebuilt, err := tm.ReplaceListener(next)
	if err != nil {
		t.Fatalf("ReplaceListener after a refused swap: %v", err)
	}
	if !rebuilt.Running() {
		t.Fatal("the rebuilt forwarder is not serving")
	}
	// The node ended up on the requested target and revision, on the same
	// port, through the Apply rebuild.
	if got := servedLabel(t, addrFor(port)); got != "srv:b" {
		t.Fatalf("target after the fallback = %q, want srv:b", got)
	}
	if cfg, ok := tm.Get("fallback"); !ok || cfg.Revision != 3 || cfg.IngressPort != port {
		t.Fatalf("registered config after the fallback = %+v ok=%v, want revision 3 on port %d", cfg, ok, port)
	}
	if cfg, _ := tm.Get("fallback"); cfg.UpstreamAddr() != addrFor(bPort) {
		t.Fatalf("registered upstream = %q, want %q", cfg.UpstreamAddr(), addrFor(bPort))
	}
	if !tm.UsedPorts()[port] {
		t.Fatal("the rebuild lost the port reservation")
	}
}

func TestReplaceListenerIdempotentAndStaleRevisions(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	aPort, aServed := labeledServer(t, "a")
	defer aServed()
	port := freePort(t)

	base := relayCfg("rev", port, addrFor(aPort), 10)
	first, err := tm.Apply(base)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	// Equal revision: idempotent, the very same forwarder instance.
	again, err := tm.ReplaceListener(base)
	if err != nil {
		t.Fatalf("ReplaceListener(same revision): %v", err)
	}
	if again != first {
		t.Fatal("an equal revision must return the running forwarder, not a new one")
	}

	// Older revision: rejected, and the running instance is untouched.
	stale := base.Clone()
	stale.NextHop = addrFor(freePort(t))
	stale.Revision = 9
	if _, err := tm.ReplaceListener(stale); !errors.Is(err, ErrStaleRevision) {
		t.Fatalf("stale revision err = %v, want ErrStaleRevision", err)
	}
	if got := servedLabel(t, addrFor(port)); got != "srv:a" {
		t.Fatalf("target changed after a rejected stale revision: %q", got)
	}

	// Newer revision on a moved port applies.
	newer := base.Clone()
	newer.IngressPort = freePort(t)
	newer.Revision = 11
	if _, err := tm.ReplaceListener(newer); err != nil {
		t.Fatalf("newer revision: %v", err)
	}
}

// ---------------------------------------------------------------------------
// DrainTunnel / DrainAll
// ---------------------------------------------------------------------------

func TestDrainTunnelKeepsPortReservedAndIsBounded(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	aPort, _ := labeledServer(t, "a")
	port := freePort(t)

	if _, err := tm.Apply(relayCfg("drain", port, addrFor(aPort), 1)); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	if err := tm.DrainTunnel("ghost", time.Millisecond); !errors.Is(err, ErrTunnelNotFound) {
		t.Fatalf("DrainTunnel(unknown) = %v, want ErrTunnelNotFound", err)
	}

	// The idle forwarder first: neither d <= 0 nor an absurd timeout waits
	// at all. d == 0 means "do not wait" (never "no preference"), and a
	// huge timeout is clamped by the forwarder's ceiling rather than
	// honoured. This runs before the live connection because a drain is
	// irreversible by design.
	var start time.Time
	for _, d := range []time.Duration{0, -time.Second, time.Hour} {
		start = time.Now()
		if err := tm.DrainTunnel("drain", d); err != nil {
			t.Fatalf("idle DrainTunnel(%v): %v", d, err)
		}
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Fatalf("idle DrainTunnel(%v) took %v, want instant", d, elapsed)
		}
	}

	// The tunnel is still registered and still owns its port: drain is not
	// teardown, and an idle drain must not release the reservation either.
	if _, ok := tm.Get("drain"); !ok {
		t.Fatal("the tunnel was removed by a drain")
	}
	if !tm.UsedPorts()[port] {
		t.Fatal("the port reservation was released by an idle drain")
	}
}

// TestDrainTunnelWaitsForTheInFlightConnections is the live-connection half.
// The connection is opened BEFORE the drain, because a drain ends the accept
// loop: work started after it would never be relayed, which is the point of
// the §13.3.5 DRAIN phase rather than a side effect.
func TestDrainTunnelWaitsForTheInFlightConnections(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	aPort, _ := labeledServer(t, "a")
	port := freePort(t)

	if _, err := tm.Apply(relayCfg("drain", port, addrFor(aPort), 1)); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	c, err := dialRetry(t, addrFor(port))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	if !waitFor(t, "relay picks up the connection", 2*time.Second, func() bool {
		return tm.LiveConns("drain") > 0
	}) {
		t.Fatal("the relay never took the connection")
	}
	// Bounded by the caller's timeout, not by the connection finishing: the
	// label server holds the connection open until the client goes away.
	start := time.Now()
	if err := tm.DrainTunnel("drain", 100*time.Millisecond); err != nil {
		t.Fatalf("DrainTunnel: %v", err)
	}
	if elapsed := time.Since(start); elapsed < 80*time.Millisecond {
		t.Fatalf("drain returned in %v with a live connection, want ~100ms", elapsed)
	}
}

func TestDrainAllTunnelsSkipsForwardersWithoutListener(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	aPort, _ := labeledServer(t, "a")
	port := freePort(t)

	if _, err := tm.Apply(relayCfg("one", port, addrFor(aPort), 1)); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	skipped := tm.DrainAllTunnels(50 * time.Millisecond)
	if len(skipped) != 0 {
		t.Fatalf("DrainAllTunnels skipped %v, want none (the tunnel is running)", skipped)
	}
	// Everything is still registered.
	if _, ok := tm.Get("one"); !ok {
		t.Fatal("DrainAllTunnels removed a tunnel")
	}
	if !tm.UsedPorts()[port] {
		t.Fatal("DrainAllTunnels released a port reservation")
	}
}

// TestDrainTunnelStopsAcceptingButKeepsThePort is the §13.3.5 DRAIN phase as
// the manager exposes it: after a drain the port is still RESERVED (so a
// concurrent Apply cannot steal it while the last connections fade) but the
// tunnel no longer answers a new connection. A listener-move replacement that
// lands on the drained tunnel's port must then find the old listener already
// out of the way.
func TestDrainTunnelStopsAcceptingButKeepsThePort(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	aPort, _ := labeledServer(t, "a")
	port := freePort(t)

	if _, err := tm.Apply(relayCfg("drainy", port, addrFor(aPort), 1)); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	// A connection that IS in flight when the drain starts keeps relaying.
	held, err := dialRetry(t, addrFor(port))
	if err != nil {
		t.Fatalf("dial held: %v", err)
	}
	defer held.Close()
	if !waitFor(t, "relay picks up the connection", 2*time.Second, func() bool {
		return tm.LiveConns("drainy") > 0
	}) {
		t.Fatal("the relay never took the connection")
	}
	if err := tm.DrainTunnel("drainy", time.Second); err != nil {
		t.Fatalf("DrainTunnel: %v", err)
	}

	// Still registered, port still reserved: a drain is not a removal.
	if _, ok := tm.Get("drainy"); !ok {
		t.Fatal("the tunnel was removed by a drain")
	}
	if !tm.UsedPorts()[port] {
		t.Fatal("the port reservation was released by a drain")
	}
	// And no new connection is answered.
	fresh, err := dialRetry(t, addrFor(port))
	if err != nil {
		t.Fatalf("dial after drain: %v", err)
	}
	defer fresh.Close()
	_ = fresh.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	if n, err := fresh.Read(make([]byte, 16)); n != 0 || err == nil {
		t.Fatalf("a drained tunnel still relayed %d bytes: the manager drain did not stop accepting", n)
	}

	// Remove is what releases it: the port must become reusable right away,
	// because the old forwarder is stopped with it.
	if err := tm.Remove("drainy"); err != nil {
		t.Fatalf("Remove after drain: %v", err)
	}
	if tm.UsedPorts()[port] {
		t.Fatal("Remove after a drain left the port reserved")
	}
	waitForPortClosed(t, port)
}

// ---------------------------------------------------------------------------
// The §13.3.4 "RELAY Egress" row: the capability already existed; WP2 anchors
// it to the contract with an explicit "old connections survive" assertion.
// ---------------------------------------------------------------------------

func TestEgressTargetSwapKeepsOldConnectionAlive(t *testing.T) {
	aPort, aServed := labeledServer(t, "a")
	bPort, bServed := labeledServer(t, "b")
	topo := newRelayTopology(t, RoundRobin, tg("127.0.0.1", aPort))
	defer topo.tm.StopAll()
	defer aServed()
	defer bServed()

	// One connection through the RELAY chain, established before the swap.
	held, err := dialRetry(t, topo.ingress)
	if err != nil {
		t.Fatalf("dial ingress: %v", err)
	}
	defer held.Close()
	_ = held.SetDeadline(time.Now().Add(5 * time.Second))
	first := readOneLine(t, held)
	if !strings.HasPrefix(first, "srv:") {
		t.Fatalf("relay chain returned %q, want a target label", first)
	}

	// Hot-swap the egress target pool (§13.3.4 RELAY Egress row). The label
	// server discards client writes, so the proof that the connection
	// survived is the write+close succeeding and the manager still counting
	// the connection as live.
	if err := topo.em.UpdateTargets("eg", RoundRobin, []forwarder.Target{tg("127.0.0.1", bPort)}); err != nil {
		t.Fatalf("UpdateTargets: %v", err)
	}

	if _, err := held.Write([]byte("post-swap\n")); err != nil {
		t.Fatalf("held conn write after pool swap: %v", err)
	}
	if topo.tm.LiveConns("ing") < 1 {
		t.Fatal("the ingress relay lost the held connection during the pool swap")
	}
	if got := aServed(); got != 1 {
		t.Fatalf("old target saw %d connections, want 1 (the pre-swap one only)", got)
	}

	// A NEW connection now takes the new target.
	fresh := servedLabel(t, topo.ingress)
	if fresh != "srv:b" {
		t.Fatalf("fresh connection after pool swap = %q, want srv:b", fresh)
	}
}
