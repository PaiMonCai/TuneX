package manager

import (
	"errors"
	"fmt"
	"io"
	"net"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

// ---------------------------------------------------------------------------
// helpers: real TCP endpoints
// ---------------------------------------------------------------------------

// freePort reserves a TCP port by binding and releasing it. Tests skip rather
// than fail when the kernel reuses the number mid-test (an inherent race).
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("reserve port: %v", err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func addrFor(port int) string { return fmt.Sprintf("127.0.0.1:%d", port) }

// echoServer echoes everything back. It is the stand-in for a real target: a
// connection through the relay proves the data plane, which no mock can
// (DEVELOPMENT.md §9 "WP5 起的数据平面能力必须增加真实网络测试").
func echoServer(t *testing.T) (addr string, stop func()) {
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
	return ln.Addr().String(), func() { ln.Close() }
}

// labeledServer accepts connections and answers with one line identifying
// itself, then keeps the connection open until the client goes away. The label
// is how a test tells WHICH target served a connection.
func labeledServer(t *testing.T, name string) (port int, served func() int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("listen: %v", err)
	}
	var mu sync.Mutex
	n := 0
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				mu.Lock()
				n++
				mu.Unlock()
				_, _ = c.Write([]byte("srv:" + name + "\n"))
				_, _ = io.Copy(io.Discard, c)
			}(conn)
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return ln.Addr().(*net.TCPAddr).Port, func() int {
		mu.Lock()
		defer mu.Unlock()
		return n
	}
}

// dialRetry retries until the accept listener is really up.
func dialRetry(t *testing.T, addr string) (net.Conn, error) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		c, err := net.DialTimeout("tcp", addr, time.Second)
		if err == nil {
			return c, nil
		}
		if time.Now().After(deadline) {
			return nil, err
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// echoRoundTrip drives one connection through addr and checks the payload came
// back byte-identical (a real two-way transfer, in both directions).
func echoRoundTrip(t *testing.T, addr string, msg []byte) {
	t.Helper()
	conn, err := dialRetry(t, addr)
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Write(msg); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buf) != string(msg) {
		t.Fatalf("payload mangled in transit: got %q want %q", buf, msg)
	}
}

// bulkRoundTrip streams size bytes through addr and verifies the echo.
func bulkRoundTrip(t *testing.T, addr string, size int) {
	t.Helper()
	payload := make([]byte, size)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	conn, err := dialRetry(t, addr)
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(60 * time.Second))
	go func() {
		_, _ = conn.Write(payload)
		_ = conn.(*net.TCPConn).CloseWrite()
	}()
	got := make([]byte, size)
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatalf("bulk read through %s: %v", addr, err)
	}
	if string(got) != string(payload) {
		t.Fatalf("bulk payload corrupted through %s", addr)
	}
}

// readFirstLabel opens one connection and returns the first line the peer
// sends, so a test can tell which target served it.
func readFirstLabel(t *testing.T, addr string) string {
	t.Helper()
	conn, err := dialRetry(t, addr)
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	line, err := readLine(conn)
	if err != nil {
		t.Fatalf("read label from %s: %v", addr, err)
	}
	return line
}

func readLine(r io.Reader) (string, error) {
	var b strings.Builder
	buf := make([]byte, 1)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if buf[0] == '\n' {
				return b.String(), nil
			}
			b.WriteByte(buf[0])
		}
		if err != nil {
			return b.String(), err
		}
		if b.Len() > 512 {
			return b.String(), fmt.Errorf("line too long")
		}
	}
}

// waitFor polls until cond holds, so a test never races a relay goroutine.
func waitFor(t *testing.T, what string, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	if cond() {
		return true
	}
	t.Logf("timed out waiting for %s", what)
	return false
}

func waitForPortClosed(t *testing.T, port int) {
	t.Helper()
	if !waitFor(t, fmt.Sprintf("port %d released", port), 5*time.Second, func() bool {
		ln, err := net.Listen("tcp", addrFor(port))
		if err != nil {
			return false
		}
		ln.Close()
		return true
	}) {
		t.Fatalf("port %d was not released", port)
	}
}

func ids(list []forwarder.TunnelConfig) []string {
	out := make([]string, 0, len(list))
	for _, c := range list {
		out = append(out, c.ID)
	}
	return out
}

// ---------------------------------------------------------------------------
// the real RELAY data plane: ingress relay -> egress pool -> target
// ---------------------------------------------------------------------------

// relayTopology wires the v3 RELAY chain the way a real node pair does:
//
//	client -> RelayForwarder(ingress) -> EgressForwarder -> target
//
// The two forwarders are separate listeners (as on separate nodes) but run in
// one process, which keeps the test hermetic while still exercising two real
// TCP hops, a real target pool and a real hot update.
type relayTopology struct {
	ingress string // "host:port" the client dials
	tm      *TunnelManager
	em      *EgressManager
}

func newRelayTopology(t *testing.T, strategy Strategy, targets ...forwarder.Target) *relayTopology {
	t.Helper()
	em := NewEgressManager()
	egressPort := freePort(t)
	em.SetPool("eg", strategy, targets)
	tm := NewTunnelManager(em, "127.0.0.1")
	ingressPort := freePort(t)
	if _, err := tm.Apply(forwarder.TunnelConfig{
		ID: "eg", Mode: forwarder.ModeEgress, EgressPort: egressPort, Protocol: "tcp",
	}); err != nil {
		t.Fatalf("apply egress: %v", err)
	}
	if _, err := tm.Apply(forwarder.TunnelConfig{
		ID: "ing", Mode: forwarder.ModeRelay, IngressPort: ingressPort,
		NextHop: addrFor(egressPort), Protocol: "tcp",
	}); err != nil {
		t.Fatalf("apply ingress: %v", err)
	}
	t.Cleanup(tm.StopAll)
	return &relayTopology{ingress: addrFor(ingressPort), tm: tm, em: em}
}

func TestRelayChainSmallTraffic(t *testing.T) {
	up, stopUp := echoServer(t)
	defer stopUp()
	upHost, upPort := splitPort(t, up)
	tp := newRelayTopology(t, WeightedRoundRobin, forwarder.Target{
		Host: upHost, Port: upPort, Weight: 1,
	})

	echoRoundTrip(t, tp.ingress, []byte("tiny"))

	// Both directions through BOTH hops are counted.
	want := int64(2 * len("tiny"))
	if !waitFor(t, "ingress stats", 5*time.Second, func() bool {
		return tp.tm.Stats("ing") == want
	}) {
		t.Fatalf("ingress Stats = %d, want %d", tp.tm.Stats("ing"), want)
	}
	if !waitFor(t, "egress stats", 5*time.Second, func() bool {
		return tp.tm.Stats("eg") == want
	}) {
		t.Fatalf("egress Stats = %d, want %d", tp.tm.Stats("eg"), want)
	}
}

func TestRelayChainLargeTrafficBothDirections(t *testing.T) {
	up, stopUp := echoServer(t)
	defer stopUp()
	upHost, upPort := splitPort(t, up)
	tp := newRelayTopology(t, WeightedRoundRobin, forwarder.Target{
		Host: upHost, Port: upPort, Weight: 1,
	})

	// 4 MiB each way: many 32 KiB relay-loop iterations in both directions
	// through both hops. This is the WP5 "双向大流量" case.
	bulkRoundTrip(t, tp.ingress, 4<<20)

	want := int64(2 * 4 << 20)
	if !waitFor(t, "ingress bulk stats", 20*time.Second, func() bool {
		return tp.tm.Stats("ing") >= want
	}) {
		t.Fatalf("ingress Stats = %d, want >= %d", tp.tm.Stats("ing"), want)
	}
	if !waitFor(t, "egress bulk stats", 20*time.Second, func() bool {
		return tp.tm.Stats("eg") >= want
	}) {
		t.Fatalf("egress Stats = %d, want >= %d", tp.tm.Stats("eg"), want)
	}
}

func TestRelayChainHotUpdateSwitchesTarget(t *testing.T) {
	aPort, aServed := labeledServer(t, "a")
	bPort, bServed := labeledServer(t, "b")
	tp := newRelayTopology(t, WeightedRoundRobin, forwarder.Target{
		Host: "127.0.0.1", Port: aPort, Weight: 1,
	})

	if got := readFirstLabel(t, tp.ingress); got != "srv:a" {
		t.Fatalf("first connection served by %q, want srv:a", got)
	}
	if aServed() != 1 {
		t.Fatalf("the original target served %d, want exactly 1", aServed())
	}

	// The hot update changes what the NEXT connection gets, without
	// touching either listener (devmap §5.3).
	if err := tp.em.UpdateTargets("eg", WeightedRoundRobin, []forwarder.Target{
		{Host: "127.0.0.1", Port: bPort, Weight: 1},
	}); err != nil {
		t.Fatalf("UpdateTargets: %v", err)
	}
	got := readFirstLabel(t, tp.ingress)
	if got != "srv:b" {
		t.Fatalf("after hot update the connection was served by %q, want srv:b", got)
	}
	if bServed() < 1 {
		t.Fatalf("the new target %d never saw a connection", bServed())
	}
	// The old target must not have been re-selected for the new connection.
	if aServed() != 1 {
		t.Fatalf("the old target kept receiving connections after the hot update: %d", aServed())
	}
	// Neither listener restarted: the same manager still holds both tunnels.
	if len(tp.tm.List()) != 2 {
		t.Fatalf("tunnel count changed during hot update: %d", len(tp.tm.List()))
	}
}

func TestRelayChainHotUpdateUnderLoadKeepsConnections(t *testing.T) {
	up, stopUp := echoServer(t)
	defer stopUp()
	upHost, upPort := splitPort(t, up)
	tp := newRelayTopology(t, WeightedRoundRobin, forwarder.Target{
		Host: upHost, Port: upPort, Weight: 1,
	})

	// Connections that are ALREADY OPEN when the pool is replaced must keep
	// working to completion: the hot update must not disturb them.
	go func() {
		for i := 0; i < 20; i++ {
			tp.em.UpdateTargets("eg", RoundRobin, []forwarder.Target{
				{Host: upHost, Port: upPort, Weight: 1},
			})
			tp.em.UpdateTargets("eg", WeightedRoundRobin, []forwarder.Target{
				{Host: upHost, Port: upPort, Weight: 1},
			})
		}
	}()
	for i := 0; i < 10; i++ {
		echoRoundTrip(t, tp.ingress, []byte(fmt.Sprintf("during-hot-update-%d", i)))
	}
}

func TestRelayChainWeightedDistribution(t *testing.T) {
	aPort, aServed := labeledServer(t, "a")
	bPort, bServed := labeledServer(t, "b")
	tp := newRelayTopology(t, WeightedRoundRobin, []forwarder.Target{
		{Host: "127.0.0.1", Port: aPort, Weight: 3},
		{Host: "127.0.0.1", Port: bPort, Weight: 1},
	}...)

	for i := 0; i < 40; i++ {
		readFirstLabel(t, tp.ingress)
	}
	if !waitFor(t, "targets served", 3*time.Second, func() bool {
		return aServed() > 0 && bServed() > 0
	}) {
		t.Fatalf("a=%d b=%d", aServed(), bServed())
	}
	// weighted_round over 40 connections must be 30/10.
	if aServed() != 30 || bServed() != 10 {
		t.Fatalf("weighted distribution over the relay chain: a=%d b=%d, want 30/10", aServed(), bServed())
	}
}

func TestRelayChainTargetFailureObservableAndDropsConn(t *testing.T) {
	// A target that accepts nothing (free, closed port): every dial fails.
	dead := freePort(t)
	tp := newRelayTopology(t, WeightedRoundRobin, forwarder.Target{
		Host: "127.0.0.1", Port: dead, Weight: 1,
	})

	conn, err := dialRetry(t, tp.ingress)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	if _, err := conn.Read(make([]byte, 8)); err == nil {
		t.Fatal("a dead target must not serve the connection")
	}

	// The failure must be observable on the egress forwarder.
	stats, ok := tp.em.Targets("eg")
	if !ok {
		t.Fatal("pool vanished")
	}
	if len(stats) != 1 {
		t.Fatalf("pool ledger = %v, want one entry", stats)
	}
	// A target-level failure is observable via the egress manager's ledger.
	ledger := tp.em.TargetStats("eg")
	if len(ledger) != 1 {
		t.Fatalf("TargetStats = %v, want one entry", ledger)
	}
	if ledger[0].DialFailed == 0 || ledger[0].LastErr == "" {
		t.Fatalf("target failure not observable: %+v", ledger[0])
	}
	if ledger[0].Healthy() {
		t.Fatalf("a target whose only dial failed is reported healthy: %+v", ledger[0])
	}
}

func TestRelayChainRecoversWhenTargetComesBack(t *testing.T) {
	// Start dead, heal the target, and the pool keeps working — the ledger
	// must clear the remembered failure once a dial succeeds again.
	dead := freePort(t)
	tp := newRelayTopology(t, WeightedRoundRobin, forwarder.Target{
		Host: "127.0.0.1", Port: dead, Weight: 1,
	})

	conn, err := dialRetry(t, tp.ingress)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _ = conn.Read(make([]byte, 1))
	conn.Close()
	// The dead target's entry must record the failure.
	if got := tp.em.TargetStats("eg"); len(got) != 1 || got[0].DialFailed == 0 {
		t.Fatalf("expected a recorded failure, got %+v", got)
	}

	// Point the pool at a live target: the ledger must show that target
	// healthy while the dead one keeps its own history.
	up, stopUp := echoServer(t)
	defer stopUp()
	upHost, upPort := splitPort(t, up)
	live := forwarder.Target{Host: upHost, Port: upPort, Weight: 1}
	if err := tp.em.UpdateTargets("eg", WeightedRoundRobin, []forwarder.Target{live}); err != nil {
		t.Fatalf("UpdateTargets: %v", err)
	}
	echoRoundTrip(t, tp.ingress, []byte("recovered"))
	if !waitFor(t, "live target healthy", 3*time.Second, func() bool {
		for _, s := range tp.em.TargetStats("eg") {
			if s.Addr() == live.Addr() && s.DialOK > 0 && s.LastErr == "" {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("the healthy target never reported a successful dial: %+v", tp.em.TargetStats("eg"))
	}
	// Every previous target keeps its own record; the history is per target.
	deadSeen := false
	for _, s := range tp.em.TargetStats("eg") {
		if s.Addr() == fmt.Sprintf("127.0.0.1:%d", dead) && s.DialFailed > 0 {
			deadSeen = true
		}
	}
	if !deadSeen {
		t.Fatalf("the dead target's history was lost: %+v", tp.em.TargetStats("eg"))
	}
}

// ---------------------------------------------------------------------------
// disconnect cleanup
// ---------------------------------------------------------------------------

func TestDisconnectCleanupReleasesRelayPair(t *testing.T) {
	up, stopUp := echoServer(t)
	defer stopUp()
	upHost, upPort := splitPort(t, up)
	tp := newRelayTopology(t, WeightedRoundRobin, forwarder.Target{
		Host: upHost, Port: upPort, Weight: 1,
	})

	conn, err := dialRetry(t, tp.ingress)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	// Confirm the connection really is being relayed (bytes both ways).
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read echo: %v", err)
	}

	// Disconnect from the client side. The relay must notice and release the
	// relayed pair rather than pinning goroutines forever (WP5 DoD).
	conn.Close()
	if !waitFor(t, "relay pair released", 10*time.Second, func() bool {
		return tp.tm.LiveConns("ing") == 0 && tp.tm.LiveConns("eg") == 0
	}) {
		t.Fatalf("live conns after disconnect: ingress=%d egress=%d, want 0/0",
			tp.tm.LiveConns("ing"), tp.tm.LiveConns("eg"))
	}
}

func TestDisconnectCleanupOnManyParallelConns(t *testing.T) {
	up, stopUp := echoServer(t)
	defer stopUp()
	upHost, upPort := splitPort(t, up)
	tp := newRelayTopology(t, WeightedRoundRobin, forwarder.Target{
		Host: upHost, Port: upPort, Weight: 1,
	})

	const clients = 30
	var wg sync.WaitGroup
	conns := make(chan net.Conn, clients)
	for i := 0; i < clients; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c, err := dialRetry(t, tp.ingress)
			if err != nil {
				t.Errorf("client %d dial: %v", i, err)
				return
			}
			c.SetDeadline(time.Now().Add(10 * time.Second))
			msg := []byte(fmt.Sprintf("client-%02d-payload", i))
			if _, err := c.Write(msg); err != nil {
				t.Errorf("client %d write: %v", i, err)
				c.Close()
				return
			}
			buf := make([]byte, len(msg))
			if _, err := io.ReadFull(c, buf); err != nil {
				t.Errorf("client %d read: %v", i, err)
			}
			conns <- c
		}(i)
	}
	wg.Wait()
	close(conns)

	// All clients are connected and echoed. Tear them all down at once and
	// require the relay to release every pair.
	for c := range conns {
		c.Close()
	}
	if !waitFor(t, "all relay pairs released", 15*time.Second, func() bool {
		return tp.tm.LiveConns("ing") == 0 && tp.tm.LiveConns("eg") == 0
	}) {
		t.Fatalf("live conns after mass disconnect: ingress=%d egress=%d",
			tp.tm.LiveConns("ing"), tp.tm.LiveConns("eg"))
	}
}

// ---------------------------------------------------------------------------
// BOTH port conflict
// ---------------------------------------------------------------------------

func TestBOTHPortConflictIngressVsEgress(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	shared := freePort(t)
	up, stopUp := echoServer(t)
	defer stopUp()

	// The BOTH-node rule: ingress and egress ranges share one physical
	// namespace, so the two tunnels of the same node cannot both bind it.
	if _, err := tm.Apply(forwarder.TunnelConfig{
		ID: "ingress", Mode: forwarder.ModeRelay, IngressPort: shared,
		NextHop: up, Protocol: "tcp",
	}); err != nil {
		t.Fatalf("apply ingress: %v", err)
	}
	defer tm.StopAll()
	used := tm.UsedPorts()
	if !used[shared] {
		t.Fatalf("UsedPorts = %v, want %d", used, shared)
	}

	// The egress tunnel's pool must exist first, so the failure we assert
	// below is really about the port and not a missing pool.
	em.SetPool("egress", RoundRobin, []forwarder.Target{tg("127.0.0.1", 1)})
	_, err := tm.Apply(forwarder.TunnelConfig{
		ID: "egress", Mode: forwarder.ModeEgress, EgressPort: shared, Protocol: "tcp",
	})
	if err == nil {
		t.Fatal("the egress tunnel took a port the ingress tunnel owns")
	}
	if !strings.Contains(err.Error(), fmt.Sprintf("port %d", shared)) {
		t.Fatalf("err = %v, want a message naming port %d", err, shared)
	}
	// The rejected tunnel must not have disturbed the running one.
	echoRoundTrip(t, addrFor(shared), []byte("still-here"))
}

func TestBOTHPortConflictEgressVsIngress(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	shared := freePort(t)
	em.SetPool("egress", RoundRobin, []forwarder.Target{tg("127.0.0.1", 1)})
	if _, err := tm.Apply(forwarder.TunnelConfig{
		ID: "egress", Mode: forwarder.ModeEgress, EgressPort: shared, Protocol: "tcp",
	}); err != nil {
		t.Fatalf("apply egress: %v", err)
	}
	defer tm.StopAll()

	_, err := tm.Apply(forwarder.TunnelConfig{
		ID: "ingress", Mode: forwarder.ModeRelay, IngressPort: shared,
		NextHop: "127.0.0.1:1", Protocol: "tcp",
	})
	if err == nil {
		t.Fatal("the relay tunnel took a port the egress tunnel owns")
	}
}

func TestPortConflictAcrossDifferentTunnels(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	port := freePort(t)
	up, stopUp := echoServer(t)
	defer stopUp()

	if _, err := tm.Apply(forwarder.TunnelConfig{
		ID: "one", Mode: forwarder.ModeRelay, IngressPort: port,
		NextHop: up, Protocol: "tcp",
	}); err != nil {
		t.Fatalf("apply one: %v", err)
	}
	defer tm.StopAll()
	// A different tunnel id asking for the same port is a real conflict.
	if _, err := tm.Apply(forwarder.TunnelConfig{
		ID: "two", Mode: forwarder.ModeRelay, IngressPort: port,
		NextHop: up, Protocol: "tcp",
	}); err == nil {
		t.Fatal("a second tunnel must not take an owned port")
	}
	// Same id + same port + newer revision is a REPLACE, not a conflict.
	cfg := forwarder.TunnelConfig{
		ID: "one", Mode: forwarder.ModeRelay, IngressPort: port,
		NextHop: up, Protocol: "tcp", Revision: 9,
	}
	if _, err := tm.Apply(cfg); err != nil {
		t.Fatalf("same-port replace: %v", err)
	}
}

// ---------------------------------------------------------------------------
// no goroutine leaks
// ---------------------------------------------------------------------------

func TestNoGoroutineLeakAfterRelayTraffic(t *testing.T) {
	up, stopUp := echoServer(t)
	defer stopUp()
	upHost, upPort := splitPort(t, up)
	tp := newRelayTopology(t, WeightedRoundRobin, forwarder.Target{
		Host: upHost, Port: upPort, Weight: 1,
	})

	// Drive traffic, disconnect, and let the manager shut everything down.
	for i := 0; i < 20; i++ {
		echoRoundTrip(t, tp.ingress, []byte("leak-check"))
	}
	conn, err := dialRetry(t, tp.ingress)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_, _ = conn.Write([]byte("open"))
	conn.Close()

	base := runtime.NumGoroutine()
	tp.tm.StopAll()
	// Every listener is closed; the accept loops and relay pairs must exit.
	if !waitFor(t, "goroutines drained", 10*time.Second, func() bool {
		return runtime.NumGoroutine() <= base+2
	}) {
		buf := make([]byte, 1<<16)
		n := runtime.Stack(buf, true)
		t.Fatalf("goroutine leak: base=%d now=%d\n%s", base, runtime.NumGoroutine(), buf[:n])
	}
	// The port guard must be emptied too: StopAll releases every port.
	if len(tp.tm.UsedPorts()) != 0 {
		t.Fatalf("UsedPorts after StopAll = %v, want empty", tp.tm.UsedPorts())
	}
}

func TestNoGoroutineLeakAfterStopWithOpenConns(t *testing.T) {
	up, stopUp := echoServer(t)
	defer stopUp()
	upHost, upPort := splitPort(t, up)
	tp := newRelayTopology(t, WeightedRoundRobin, forwarder.Target{
		Host: upHost, Port: upPort, Weight: 1,
	})

	// Connections still open when StopAll runs: Stop must drain (bounded) and
	// the process must not keep goroutines for them.
	var conns []net.Conn
	for i := 0; i < 8; i++ {
		c, err := dialRetry(t, tp.ingress)
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		_, _ = c.Write([]byte("held-open"))
		conns = append(conns, c)
	}
	base := runtime.NumGoroutine()
	done := make(chan struct{})
	go func() { tp.tm.StopAll(); close(done) }()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("StopAll blocked far longer than drainTimeout")
	}
	for _, c := range conns {
		c.Close()
	}
	if !waitFor(t, "goroutines drained", 10*time.Second, func() bool {
		return runtime.NumGoroutine() <= base
	}) {
		buf := make([]byte, 1<<16)
		n := runtime.Stack(buf, true)
		t.Fatalf("goroutine leak after Stop with open conns: base=%d now=%d\n%s",
			base, runtime.NumGoroutine(), buf[:n])
	}
}

// ---------------------------------------------------------------------------
// manager lifecycle
// ---------------------------------------------------------------------------

func TestTunnelManagerRemoveFreesPort(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	port := freePort(t)
	up, stopUp := echoServer(t)
	defer stopUp()
	if _, err := tm.Apply(forwarder.TunnelConfig{
		ID: "r", Mode: forwarder.ModeRelay, IngressPort: port,
		NextHop: up, Protocol: "tcp",
	}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if err := tm.Remove("r"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if len(tm.List()) != 0 {
		t.Fatal("the tunnel is still listed after Remove")
	}
	waitForPortClosed(t, port)
	// The port must be reusable.
	if _, err := tm.Apply(forwarder.TunnelConfig{
		ID: "r2", Mode: forwarder.ModeRelay, IngressPort: port,
		NextHop: up, Protocol: "tcp",
	}); err != nil {
		t.Fatalf("rebind: %v", err)
	}
	tm.StopAll()
}

func TestTunnelManagerRemoveUnknownIsNoop(t *testing.T) {
	tm := NewTunnelManager(NewEgressManager(), "127.0.0.1")
	if err := tm.Remove("ghost"); err != nil {
		t.Fatalf("Remove(unknown) = %v, want nil", err)
	}
}

func TestTunnelManagerRevisionRules(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	port := freePort(t)
	up, stopUp := echoServer(t)
	defer stopUp()
	cfg := forwarder.TunnelConfig{
		ID: "r", Mode: forwarder.ModeRelay, IngressPort: port,
		NextHop: up, Protocol: "tcp", Revision: 5,
	}
	first, err := tm.Apply(cfg)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	defer tm.StopAll()

	// Older: rejected.
	cfg.Revision = 4
	if _, err := tm.Apply(cfg); !errors.Is(err, ErrStaleRevision) {
		t.Fatalf("stale revision err = %v, want ErrStaleRevision", err)
	}
	// Equal: idempotent no-op returning the same forwarder.
	cfg.Revision = 5
	again, err := tm.Apply(cfg)
	if err != nil {
		t.Fatalf("equal revision err = %v", err)
	}
	if again != first {
		t.Fatal("an equal revision must return the existing forwarder")
	}
	// Newer: applies.
	cfg.Revision = 6
	if _, err := tm.Apply(cfg); err != nil {
		t.Fatalf("newer revision err = %v", err)
	}
	echoRoundTrip(t, addrFor(port), []byte("newer"))
}

func TestTunnelManagerEgressWithoutPoolRejected(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	_, err := tm.Apply(forwarder.TunnelConfig{
		ID: "eg", Mode: forwarder.ModeEgress, EgressPort: freePort(t), Protocol: "tcp",
	})
	if !errors.Is(err, ErrPoolNotFound) {
		t.Fatalf("err = %v, want ErrPoolNotFound", err)
	}
}

func TestTunnelManagerListAndIDsSorted(t *testing.T) {
	em := NewEgressManager()
	tm := NewTunnelManager(em, "127.0.0.1")
	up, stopUp := echoServer(t)
	defer stopUp()
	for _, id := range []string{"cc", "aa", "bb"} {
		if _, err := tm.Apply(forwarder.TunnelConfig{
			ID: id, Mode: forwarder.ModeRelay, IngressPort: freePort(t),
			NextHop: up, Protocol: "tcp",
		}); err != nil {
			t.Fatalf("Apply %s: %v", id, err)
		}
	}
	defer tm.StopAll()
	got := ids(tm.List())
	if len(got) != 3 || got[0] != "aa" || got[1] != "bb" || got[2] != "cc" {
		t.Fatalf("List order = %v", got)
	}
}

func TestEgressManagerSnapshotReflectsHotUpdate(t *testing.T) {
	aPort, aServed := labeledServer(t, "a")
	bPort, bServed := labeledServer(t, "b")
	em := NewEgressManager()
	em.SetPool("eg", RoundRobin, []forwarder.Target{tg("127.0.0.1", aPort)})

	snap := em.Snapshot()
	if snap["eg"].Strategy != string(RoundRobin) {
		t.Fatalf("initial strategy = %q", snap["eg"].Strategy)
	}
	if len(snap["eg"].Targets) != 1 || snap["eg"].Targets[0] != addrFor(aPort) {
		t.Fatalf("initial targets = %v", snap["eg"].Targets)
	}
	if err := em.UpdateTargets("eg", WeightedRoundRobin, []forwarder.Target{
		tg("127.0.0.1", aPort), tg("127.0.0.1", bPort),
	}); err != nil {
		t.Fatalf("UpdateTargets: %v", err)
	}
	snap = em.Snapshot()
	if snap["eg"].Strategy != string(WeightedRoundRobin) {
		t.Fatalf("strategy after hot update = %q", snap["eg"].Strategy)
	}
	if len(snap["eg"].Targets) != 2 {
		t.Fatalf("targets after hot update = %v", snap["eg"].Targets)
	}
	_ = aServed
	_ = bServed
}

func splitPort(t *testing.T, addr string) (string, int) {
	t.Helper()
	h, p, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("split %q: %v", addr, err)
	}
	var port int
	fmt.Sscanf(p, "%d", &port)
	return h, port
}
