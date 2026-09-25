package forwarder

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Fake connections, so the relay's EOF handling is observable. net.Pipe cannot
// express a half-close and ends both directions at once, which would hide the
// "wait for the second direction" bug these guards exist for.
// ---------------------------------------------------------------------------

type dummyAddr struct{}

func (dummyAddr) Network() string { return "dummy" }
func (dummyAddr) String() string  { return "dummy" }

// blockingReader blocks on Read until unblock is closed, then reports EOF.
type blockingReader struct{ unblock chan struct{} }

func (r blockingReader) Read(p []byte) (int, error) {
	<-r.unblock
	return 0, io.EOF
}

// blockingConn never finishes a read until unblock closes.
type blockingConn struct {
	r blockingReader
}

func (c blockingConn) Read(p []byte) (int, error)       { return c.r.Read(p) }
func (c blockingConn) Write(p []byte) (int, error)      { return len(p), nil }
func (c blockingConn) Close() error                     { return nil }
func (c blockingConn) LocalAddr() net.Addr              { return dummyAddr{} }
func (c blockingConn) RemoteAddr() net.Addr             { return dummyAddr{} }
func (c blockingConn) SetDeadline(time.Time) error      { return nil }
func (c blockingConn) SetReadDeadline(time.Time) error  { return nil }
func (c blockingConn) SetWriteDeadline(time.Time) error { return nil }

// fastConn ends its read direction as soon as closed is closed.
type fastConn struct {
	closed   chan struct{}
	closeOne sync.Once
}

func (c *fastConn) Read(p []byte) (int, error) {
	<-c.closed
	return 0, io.EOF
}
func (c *fastConn) Write(p []byte) (int, error)      { return len(p), nil }
func (c *fastConn) Close() error                     { c.closeOne.Do(func() { close(c.closed) }); return nil }
func (c *fastConn) LocalAddr() net.Addr              { return dummyAddr{} }
func (c *fastConn) RemoteAddr() net.Addr             { return dummyAddr{} }
func (c *fastConn) SetDeadline(time.Time) error      { return nil }
func (c *fastConn) SetReadDeadline(time.Time) error  { return nil }
func (c *fastConn) SetWriteDeadline(time.Time) error { return nil }

// halfCloseConn wraps fastConn and counts CloseWrite calls, so a test can
// assert the relay half-closes (once) instead of aborting.
type halfCloseConn struct {
	inner       *fastConn
	writeClosed int64
}

func (c *halfCloseConn) Read(p []byte) (int, error)       { return c.inner.Read(p) }
func (c *halfCloseConn) Write(p []byte) (int, error)      { return len(p), nil }
func (c *halfCloseConn) Close() error                     { return c.inner.Close() }
func (c *halfCloseConn) CloseWrite() error                { atomic.AddInt64(&c.writeClosed, 1); return nil }
func (c *halfCloseConn) LocalAddr() net.Addr              { return dummyAddr{} }
func (c *halfCloseConn) RemoteAddr() net.Addr             { return dummyAddr{} }
func (c *halfCloseConn) SetDeadline(time.Time) error      { return nil }
func (c *halfCloseConn) SetReadDeadline(time.Time) error  { return nil }
func (c *halfCloseConn) SetWriteDeadline(time.Time) error { return nil }

// freePort binds an ephemeral TCP port, closes it and returns the number. There
// is an inherent TOCTOU race; every test re-checks failures and skips rather
// than failing when the kernel reuses the number mid-test.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// echoTarget starts a listener that echoes everything back, returning its
// address and a stop function.
func echoTarget(t *testing.T) (addr string, stop func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	done := make(chan struct{})
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
	return ln.Addr().String(), func() {
		ln.Close()
		close(done)
	}
}

// dialRetry tries to reach addr until it succeeds or the deadline passes.
// Accept listeners are asynchronous, so an immediate dial can lose the race.
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
		time.Sleep(10 * time.Millisecond)
	}
}

// waitForPortClosed verifies the port can be rebound (i.e. the listener really
// released it), bounded by a deadline.
func waitForPortClosed(t *testing.T, port int, timeout time.Duration) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			ln.Close()
			// Close it and try again immediately: the previous bind proves the
			// port was free at that instant.
			time.Sleep(5 * time.Millisecond)
			ln2, err2 := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
			if err2 == nil {
				ln2.Close()
				return true
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// ---------------------------------------------------------------------------
// interface.go: config validation
// ---------------------------------------------------------------------------

func TestTunnelConfigValidateModes(t *testing.T) {
	base := func() TunnelConfig {
		return TunnelConfig{ID: "t1", Protocol: "tcp"}
	}

	t.Run("direct ok", func(t *testing.T) {
		c := base()
		c.Mode = ModeDirect
		c.IngressPort = 30000
		c.RemoteHost = "10.0.0.1"
		c.RemotePort = 443
		if err := c.Validate(); err != nil {
			t.Fatalf("valid config rejected: %v", err)
		}
		if c.Mode != ModeDirect || c.Protocol != "tcp" {
			t.Fatalf("validation mutated fields: %+v", c)
		}
	})

	t.Run("direct missing remote", func(t *testing.T) {
		c := base()
		c.Mode = ModeDirect
		c.IngressPort = 30000
		if err := c.Validate(); err == nil {
			t.Fatal("expected an error for a DIRECT tunnel without remote")
		}
	})

	t.Run("direct bad ingress port", func(t *testing.T) {
		c := base()
		c.Mode = ModeDirect
		c.IngressPort = 70000
		c.RemoteHost = "10.0.0.1"
		c.RemotePort = 443
		if err := c.Validate(); err == nil {
			t.Fatal("expected an error for ingress_port out of range")
		}
	})

	t.Run("relay ok", func(t *testing.T) {
		c := base()
		c.Mode = ModeRelay
		c.IngressPort = 30000
		c.NextHop = "10.0.0.2:31000"
		if err := c.Validate(); err != nil {
			t.Fatalf("valid config rejected: %v", err)
		}
	})

	t.Run("relay bad next hop", func(t *testing.T) {
		c := base()
		c.Mode = ModeRelay
		c.IngressPort = 30000
		c.NextHop = "not-an-addr"
		if err := c.Validate(); err == nil {
			t.Fatal("expected an error for a malformed next_hop")
		}
	})

	t.Run("egress ok with empty pool", func(t *testing.T) {
		c := base()
		c.Mode = ModeEgress
		c.EgressPort = 31000
		if err := c.Validate(); err != nil {
			t.Fatalf("an empty pool is legal before the first PATCH: %v", err)
		}
	})

	t.Run("egress invalid target", func(t *testing.T) {
		c := base()
		c.Mode = ModeEgress
		c.EgressPort = 31000
		c.Targets = []Target{{Host: "", Port: 80}}
		if err := c.Validate(); err == nil {
			t.Fatal("expected an error for an unusable target")
		}
	})

	t.Run("unknown mode", func(t *testing.T) {
		c := base()
		c.Mode = "BRIDGE"
		if err := c.Validate(); err == nil {
			t.Fatal("expected an error for an unknown mode")
		}
	})

	t.Run("unsupported protocol rejected loudly", func(t *testing.T) {
		c := base()
		c.Mode = ModeDirect
		c.IngressPort = 30000
		c.RemoteHost = "10.0.0.1"
		c.RemotePort = 443
		c.Protocol = "udp"
		if err := c.Validate(); err == nil {
			t.Fatal("UDP must not silently run over TCP")
		}
	})

	t.Run("empty id rejected", func(t *testing.T) {
		c := base()
		c.Mode = ModeDirect
		c.IngressPort = 30000
		c.RemoteHost = "10.0.0.1"
		c.RemotePort = 443
		c.ID = "  "
		if err := c.Validate(); err == nil {
			t.Fatal("expected an error for an empty id")
		}
	})
}

func TestTunnelModeAndStrategyParsing(t *testing.T) {
	for _, in := range []string{"direct", "DIRECT", " Direct "} {
		got, err := ParseTunnelMode(in)
		if err != nil || got != ModeDirect {
			t.Fatalf("ParseTunnelMode(%q) = %q, %v", in, got, err)
		}
	}
	if _, err := ParseTunnelMode("nope"); err == nil {
		t.Fatal("expected an error for an unknown mode")
	}
	for _, in := range []string{"round_robin", "ROUND_ROBIN"} {
		got, err := ParseLBStrategy(in)
		if err != nil || got != LBRoundRobin {
			t.Fatalf("ParseLBStrategy(%q) = %q, %v", in, got, err)
		}
	}
	if _, err := ParseLBStrategy("least_conn"); err == nil {
		t.Fatal("WP4 ships round/rand only; unknown strategies must be reported")
	}
}

func TestTunnelConfigHelpersAndClone(t *testing.T) {
	d := TunnelConfig{ID: "d", Mode: ModeDirect, IngressPort: 10000, RemoteHost: "h", RemotePort: 80}
	if got := d.ListenAddr(); got != ":10000" {
		t.Fatalf("ListenAddr = %q", got)
	}
	if got := d.UpstreamAddr(); got != "h:80" {
		t.Fatalf("UpstreamAddr = %q", got)
	}
	e := TunnelConfig{ID: "e", Mode: ModeEgress, EgressPort: 20000}
	if got := e.ListenPort(); got != 20000 {
		t.Fatalf("ListenPort = %d", got)
	}

	orig := TunnelConfig{ID: "c", Mode: ModeEgress, EgressPort: 1, Targets: []Target{{Host: "a", Port: 80}}}
	cp := orig.Clone()
	cp.Targets[0].Host = "mutated"
	if orig.Targets[0].Host != "a" {
		t.Fatal("Clone must deep-copy the target slice")
	}
}

// ---------------------------------------------------------------------------
// pipe.go
// ---------------------------------------------------------------------------

// waitForCounter polls until c reaches want or the deadline passes, so a test
// never races the relay goroutine.
func waitForCounter(t *testing.T, c *byteCounter, want int64, timeout time.Duration) int64 {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if got := c.load(); got == want {
			return got
		} else if time.Now().After(deadline) {
			return c.load()
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// connPair dials ln from a fresh listener and returns the two ends, so a test
// has two INDEPENDENT connections. Relaying the two ends of a single
// connection to each other must not be used here: the kernel short-circuits
// the loopback and the payload never enters the relay, so the counter stays 0
// and the test proves nothing.
func connPair(t *testing.T) (dialed, accepted net.Conn, stop func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	ch := make(chan net.Conn, 1)
	go func() {
		if c, err := ln.Accept(); err == nil {
			ch <- c
		}
	}()
	dialed, err = net.Dial("tcp", ln.Addr().String())
	if err != nil {
		ln.Close()
		t.Fatalf("dial: %v", err)
	}
	select {
	case accepted = <-ch:
	case <-time.After(3 * time.Second):
		dialed.Close()
		ln.Close()
		t.Fatal("accept never completed")
	}
	return dialed, accepted, func() { ln.Close() }
}

// TestPipeConnsCountsBothDirections checks that bytes flowing from a into b are
// counted. PipeConns waits for BOTH directions to finish: the first EOF
// half-closes the peer's write side while the source stays writable, so the
// test must also end the second direction before the relay returns.
func TestPipeConnsCountsBothDirections(t *testing.T) {
	// Two independent connection pairs: a<->aPeer and b<->bPeer. The relay
	// sits between a and b; the peers on either side drive it, exactly like
	// the client and upstream in a real forwarder.
	a, aPeer, stopA := connPair(t)
	defer stopA()
	b, bPeer, stopB := connPair(t)
	defer stopB()

	var counter byteCounter
	relayDone := make(chan struct{})
	go func() { PipeConns(a, b, &counter); close(relayDone) }()

	// client -> relay -> server.
	msg := []byte("hello")
	if _, err := aPeer.Write(msg); err != nil {
		t.Fatalf("client write: %v", err)
	}
	buf := make([]byte, len(msg))
	bPeer.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := io.ReadFull(bPeer, buf); err != nil {
		t.Fatalf("server read: %v", err)
	}
	if string(buf) != string(msg) {
		t.Fatalf("payload mangled in transit: %q", buf)
	}
	// Wait until the payload is actually counted before shutting anything
	// down, so the assertion is about delivered bytes, not a timing race.
	// (read success proves the bytes arrived; the counter lags by one poll.)
	waitForCounter(t, &counter, int64(len(msg)), 3*time.Second)

	// End BOTH directions cleanly, otherwise the relay (correctly) keeps
	// waiting for the other one: the last bytes written into a are not an
	// EOF signal for the relay, so the peer must half-close its write side.
	if err := aPeer.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatalf("client CloseWrite: %v", err)
	}
	if err := bPeer.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatalf("server CloseWrite: %v", err)
	}
	select {
	case <-relayDone:
	case <-time.After(3 * time.Second):
		t.Fatal("PipeConns did not return after both directions finished")
	}

	if got := counter.load(); got != int64(len(msg)) {
		t.Fatalf("counted %d bytes, want %d", got, len(msg))
	}
	aPeer.Close()
	bPeer.Close()
}

// TestPipeConnsCountsServerToClient is the second direction: bytes the peer
// sends back must be counted too.
func TestPipeConnsCountsServerToClient(t *testing.T) {
	a, aPeer, stopA := connPair(t)
	defer stopA()
	b, bPeer, stopB := connPair(t)
	defer stopB()

	var counter byteCounter
	relayDone := make(chan struct{})
	go func() { PipeConns(a, b, &counter); close(relayDone) }()

	// server -> relay -> client.
	msg := []byte("world")
	go func() { _, _ = bPeer.Write(msg) }()
	buf := make([]byte, len(msg))
	aPeer.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := io.ReadFull(aPeer, buf); err != nil {
		t.Fatalf("client read: %v", err)
	}
	if string(buf) != string(msg) {
		t.Fatalf("payload mangled in transit: %q", buf)
	}
	waitForCounter(t, &counter, int64(len(msg)), 3*time.Second)

	// Same discipline: end both directions with the peers' own write sides,
	// then wait on the relay.
	if err := aPeer.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatalf("client CloseWrite: %v", err)
	}
	if err := bPeer.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatalf("server CloseWrite: %v", err)
	}
	select {
	case <-relayDone:
	case <-time.After(3 * time.Second):
		t.Fatal("PipeConns did not return after both directions finished")
	}

	if got := counter.load(); got != int64(len(msg)) {
		t.Fatalf("counted %d bytes, want %d", got, len(msg))
	}
	aPeer.Close()
	bPeer.Close()
}

// TestPipeHalfClosePreservesUpstreamReply is the regression guard for closing
// both ends the moment one direction hits EOF: a client that shut down its
// write side must still receive the upstream's remaining data.
func TestPipeHalfClosePreservesUpstreamReply(t *testing.T) {
	// net.Pipe cannot express a half-close, so use real TCP connections.
	agentLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer agentLn.Close()
	upLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upLn.Close()

	agentCh := make(chan net.Conn, 1)
	go func() {
		if c, err := agentLn.Accept(); err == nil {
			agentCh <- c
		}
	}()
	upCh := make(chan net.Conn, 1)
	go func() {
		if c, err := upLn.Accept(); err == nil {
			upCh <- c
		}
	}()

	client, err := net.Dial("tcp", agentLn.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	agentSide := <-agentCh
	upstream, err := net.Dial("tcp", upLn.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	upstreamSide := <-upCh

	var counter byteCounter
	done := make(chan struct{})
	go func() { PipeConns(agentSide, upstream, &counter); close(done) }()

	// The client sends the request then half-closes its write side.
	go func() {
		_, _ = client.Write([]byte("REQ"))
		_ = client.(*net.TCPConn).CloseWrite()
	}()
	buf := make([]byte, 8)
	n, err := upstreamSide.Read(buf)
	if err != nil {
		t.Fatalf("upstream read: %v", err)
	}
	if string(buf[:n]) != "REQ" {
		t.Fatalf("upstream got %q", buf[:n])
	}
	// Give the relay a moment to notice the EOF and half-close its side.
	time.Sleep(100 * time.Millisecond)
	if _, err := upstreamSide.Write([]byte("REPLY")); err != nil {
		t.Fatalf("upstream write: %v", err)
	}

	client.SetReadDeadline(time.Now().Add(3 * time.Second))
	reply := make([]byte, 5)
	if _, err := io.ReadFull(client, reply); err != nil {
		t.Fatalf("reply never reached the client after half-close: %v", err)
	}
	if string(reply) != "REPLY" {
		t.Fatalf("unexpected payload %q", reply)
	}
	client.Close()
	upstreamSide.Close()
	<-done
	if got := counter.load(); got != 8 {
		t.Fatalf("counted %d bytes, want 8 (REQ + REPLY)", got)
	}
}

// TestPipeWaitsForBothDirections guards against the classic proxy bug where a
// single EOF tears down the connection mid-stream: Pipe must not return until
// BOTH copy directions have finished, even though the first direction finished
// immediately. It uses controllable fake connections (net.Pipe would let the
// second direction end too, hiding the bug).
func TestPipeWaitsForBothDirections(t *testing.T) {
	unblock := make(chan struct{})
	slow := blockingConn{r: blockingReader{unblock: unblock}}
	fast := &fastConn{closed: make(chan struct{})}

	var counter byteCounter
	done := make(chan struct{})
	go func() { Pipe(slow, fast, &counter); close(done) }()

	// The fast peer's direction ends first.
	fast.Close()

	// Pipe must still be waiting on the slow direction.
	select {
	case <-done:
		t.Fatal("Pipe returned before the second direction drained")
	case <-time.After(150 * time.Millisecond):
	}

	// Now let the slow direction finish; Pipe must return.
	close(unblock)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Pipe never returned after both directions finished")
	}
}

// TestPipeConnsHalfClosesAndDrains is the same guard for PipeConns: the first
// EOF must half-close (not abort), and the relay must keep draining the other
// direction until it really finishes.
func TestPipeConnsHalfClosesAndDrains(t *testing.T) {
	unblock := make(chan struct{})
	slow := blockingConn{r: blockingReader{unblock: unblock}}
	fast := &halfCloseConn{inner: &fastConn{closed: make(chan struct{})}}

	var counter byteCounter
	done := make(chan struct{})
	go func() { PipeConns(slow, fast, &counter); close(done) }()

	// a=fast, b=slow. fast's read side returning EOF ends dirA (a -> b), so
	// the ONE destination of that direction, b, is the only side that gets
	// CloseWrite. a stays writable because dirB still owes it bytes; closing
	// a here would truncate the upstream's own reply.
	fast.inner.Close()
	time.Sleep(150 * time.Millisecond)

	if n := atomic.LoadInt64(&fast.writeClosed); n != 0 {
		t.Fatalf("CloseWrite called on the source side %d times, want 0", n)
	}
	select {
	case <-done:
		t.Fatal("PipeConns returned before the second direction drained")
	default:
	}

	// The slow peer then finishes: dirB (b -> a) ends with EOF on b, and only
	// its destination, a, is half-closed.
	close(unblock)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("PipeConns never returned after the second direction finished")
	}
	if n := atomic.LoadInt64(&fast.writeClosed); n != 1 {
		t.Fatalf("CloseWrite called %d times, want exactly 1 (on the destination of the finished direction)", n)
	}
}

// ---------------------------------------------------------------------------
// SingleHopForwarder — DIRECT mode (upstream is the remote_host:remote_port)
// ---------------------------------------------------------------------------

func directConfig(id string, ingress int, host string, remote int) TunnelConfig {
	return TunnelConfig{
		ID:          id,
		Mode:        ModeDirect,
		IngressPort: ingress,
		RemoteHost:  host,
		RemotePort:  remote,
		Protocol:    "tcp",
		ListenHost:  "127.0.0.1",
	}
}

func TestSingleHopDirectStartForwardsAndCounts(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()
	upHost, upPortS, _ := net.SplitHostPort(up)
	var upPort int
	fmt.Sscanf(upPortS, "%d", &upPort)

	port := freePort(t)
	f, err := NewSingleHop(directConfig("d1", port, upHost, upPort))
	if err != nil {
		t.Fatalf("NewSingleHop: %v", err)
	}
	if err := f.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer f.Stop()
	if !f.Running() {
		t.Fatal("Running() should be true after Start")
	}

	conn, err := dialRetry(t, fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	msg := []byte("ping-through-relay")
	if _, err := conn.Write(msg); err != nil {
		t.Fatalf("write: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !bytes.Equal(buf, msg) {
		t.Fatalf("echo mismatch: %q", buf)
	}
	// Close the client connection so the relay pair drains and stats settle.
	conn.Close()

	// Poll until the counter settles at the expected total: a single
	// Stats==0 check can observe the echo mid-flight (half the bytes in each
	// direction), which is a timing artefact, not a bug.
	deadline := time.Now().Add(5 * time.Second)
	for f.Stats() != int64(2*len(msg)) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	// msg travels in both directions.
	if got := f.Stats(); got != int64(2*len(msg)) {
		t.Fatalf("Stats = %d, want %d", got, 2*len(msg))
	}
}

func TestSingleHopDirectStartIsIdempotent(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()
	upHost, upPortS, _ := net.SplitHostPort(up)
	var upPort int
	fmt.Sscanf(upPortS, "%d", &upPort)

	port := freePort(t)
	f, err := NewSingleHop(directConfig("d2", port, upHost, upPort))
	if err != nil {
		t.Fatalf("NewSingleHop: %v", err)
	}
	if err := f.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer f.Stop()

	err = f.Start()
	if !errors.Is(err, ErrAlreadyStarted) {
		t.Fatalf("second Start = %v, want ErrAlreadyStarted", err)
	}
}

func TestSingleHopDirectStopFreesPort(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()
	upHost, upPortS, _ := net.SplitHostPort(up)
	var upPort int
	fmt.Sscanf(upPortS, "%d", &upPort)

	port := freePort(t)
	f, err := NewSingleHop(directConfig("d3", port, upHost, upPort))
	if err != nil {
		t.Fatalf("NewSingleHop: %v", err)
	}
	if err := f.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := f.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if f.Running() {
		t.Fatal("Running() should be false after Stop")
	}
	// Stop is idempotent: a second call must not error.
	if err := f.Stop(); err != nil {
		t.Fatalf("second Stop: %v", err)
	}
	// Stop before Start is also a no-op (the manager reuses instances).
	g, err := NewSingleHop(directConfig("d4", freePort(t), upHost, upPort))
	if err != nil {
		t.Fatalf("NewSingleHop: %v", err)
	}
	if err := g.Stop(); err != nil {
		t.Fatalf("Stop before Start: %v", err)
	}
	// After Stop the forwarder is consumed: a restart needs a new instance.
	if err := f.Start(); !errors.Is(err, errStoppedForwarder) {
		t.Fatalf("Start after Stop = %v, want errStoppedForwarder", err)
	}
	if !waitForPortClosed(t, port, 3*time.Second) {
		t.Fatal("port was not released by Stop")
	}
}

// TestSingleHopDirectPortConflictRejected: two tunnels asking for the same port
// cannot both bind; the OS enforces it even if the manager's guard misses.
func TestSingleHopDirectPortConflictRejected(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()
	upHost, upPortS, _ := net.SplitHostPort(up)
	var upPort int
	fmt.Sscanf(upPortS, "%d", &upPort)

	port := freePort(t)
	a, err := NewSingleHop(directConfig("a", port, upHost, upPort))
	if err != nil {
		t.Fatalf("NewSingleHop: %v", err)
	}
	if err := a.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer a.Stop()

	b, err := NewSingleHop(directConfig("b", port, upHost, upPort))
	if err != nil {
		t.Fatalf("NewSingleHop: %v", err)
	}
	err = b.Start()
	if err == nil {
		b.Stop()
		t.Fatal("expected the second bind on the same port to fail")
	}
}

func TestSingleHopDirectDropsUnreachableUpstream(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()
	_, upPortS, _ := net.SplitHostPort(up)

	// Find a port that is certainly closed by binding then releasing it.
	dead := freePort(t)
	_ = upPortS

	port := freePort(t)
	f, err := NewSingleHop(directConfig("d5", port, "127.0.0.1", dead))
	if err != nil {
		t.Fatalf("NewSingleHop: %v", err)
	}
	if err := f.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer f.Stop()

	conn, err := dialRetry(t, fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 8)
	if _, err := conn.Read(buf); err == nil {
		t.Fatal("the client should have been dropped, not served")
	}
}

// ---------------------------------------------------------------------------
// SingleHopForwarder in RELAY mode
// ---------------------------------------------------------------------------

func TestSingleHopRelayForwardsToNextHop(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()

	port := freePort(t)
	f, err := NewSingleHop(TunnelConfig{
		ID: "r1", Mode: ModeRelay, IngressPort: port, NextHop: up,
		Protocol: "tcp", ListenHost: "127.0.0.1",
	})
	if err != nil {
		t.Fatalf("NewSingleHop: %v", err)
	}
	if err := f.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer f.Stop()

	conn, err := dialRetry(t, fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	msg := []byte("hop")
	_, _ = conn.Write(msg)
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if !bytes.Equal(buf, msg) {
		t.Fatalf("echo mismatch: %q", buf)
	}
	conn.Close()

	// Poll to the exact total instead of a bare "not zero yet" check: the
	// relay pair drains asynchronously, so a Stats observed mid-flight is a
	// timing artefact, not a bug. Both directions carry len(msg) bytes.
	want := int64(2 * len(msg))
	deadline := time.Now().Add(5 * time.Second)
	for f.Stats() != want && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := f.Stats(); got != want {
		t.Fatalf("Stats = %d, want %d", got, want)
	}
}

// TestSingleHopForwarderRejectsEgressConfig pins the one boundary WP15 left:
// the one-hop implementation covers DIRECT and RELAY, and must refuse an
// EGRESS config (that mode has its own forwarder and its own semantics).
func TestSingleHopForwarderRejectsEgressConfig(t *testing.T) {
	_, err := NewSingleHop(TunnelConfig{
		ID:          "x",
		Mode:        ModeEgress,
		EgressPort:  40000,
		IngressPort: 40000,
		Targets:     []Target{{Host: "127.0.0.1", Port: 80, Weight: 1}},
		Protocol:    "tcp",
		ListenHost:  "127.0.0.1",
	})
	if err == nil {
		t.Fatal("NewSingleHop must reject an EGRESS config")
	}
}

// TestDirectAndRelayShareOneImplementation is the WP15 DoD "同一套 v3 runtime
// 同时承载 DIRECT 与 RELAY" at the forwarder level: both modes build the same
// type, so there is no second implementation to keep in sync (or to fall back
// to). The distinction is only where UpstreamAddr() points.
func TestDirectAndRelayShareOneImplementation(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()
	upHost, upPortS, _ := net.SplitHostPort(up)
	var upPort int
	fmt.Sscanf(upPortS, "%d", &upPort)

	for _, tc := range []struct {
		name string
		cfg  func(port int) TunnelConfig
	}{
		{"direct", func(port int) TunnelConfig {
			return directConfig("d-share", port, upHost, upPort)
		}},
		{"relay", func(port int) TunnelConfig {
			c := directConfig("r-share", port, upHost, upPort)
			c.Mode = ModeRelay
			c.NextHop = net.JoinHostPort(upHost, strconv.Itoa(upPort))
			return c
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, err := NewSingleHop(tc.cfg(freePort(t)))
			if err != nil {
				t.Fatalf("NewSingleHop: %v", err)
			}
			defer f.Stop()
			if err := f.Start(); err != nil {
				t.Fatalf("Start: %v", err)
			}
			if _, ok := any(f).(*SingleHopForwarder); !ok {
				t.Fatalf("expected *SingleHopForwarder, got %T", f)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// EgressForwarder
// ---------------------------------------------------------------------------

// countingSelector hands out targets in a fixed order and records the picks, so
// an egress forwarder's behaviour is observable without a real balancer.
type countingSelector struct {
	mu    sync.Mutex
	seq   []Target
	idx   int
	calls int
	empty bool
}

func (s *countingSelector) Select() Target {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.empty || len(s.seq) == 0 {
		return Target{}
	}
	t := s.seq[s.idx%len(s.seq)]
	s.idx++
	return t
}

func (s *countingSelector) callsSoFar() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func TestEgressForwarderUsesSelector(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()
	_, upPortS, _ := net.SplitHostPort(up)
	var upPort int
	fmt.Sscanf(upPortS, "%d", &upPort)

	sel := &countingSelector{seq: []Target{{Host: "127.0.0.1", Port: upPort}}}
	port := freePort(t)
	f, err := NewEgress(TunnelConfig{
		ID: "e1", Mode: ModeEgress, EgressPort: port, Protocol: "tcp", ListenHost: "127.0.0.1",
	}, sel)
	if err != nil {
		t.Fatalf("NewEgress: %v", err)
	}
	if err := f.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer f.Stop()

	conn, err := dialRetry(t, fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_, _ = conn.Write([]byte("egress"))
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 6)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(buf) != "egress" {
		t.Fatalf("echo mismatch: %q", buf)
	}

	if sel.callsSoFar() == 0 {
		t.Fatal("the selector was never consulted")
	}
}

func TestEgressForwarderEmptyPoolDropsConnections(t *testing.T) {
	sel := &countingSelector{empty: true}
	port := freePort(t)
	f, err := NewEgress(TunnelConfig{
		ID: "e2", Mode: ModeEgress, EgressPort: port, Protocol: "tcp", ListenHost: "127.0.0.1",
	}, sel)
	if err != nil {
		t.Fatalf("NewEgress: %v", err)
	}
	if err := f.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer f.Stop()

	conn, err := dialRetry(t, fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 8)
	if _, err := conn.Read(buf); err == nil {
		t.Fatal("connection should be dropped while the pool is empty")
	}
}

func TestEgressForwarderRequiresSelector(t *testing.T) {
	_, err := NewEgress(TunnelConfig{ID: "e3", Mode: ModeEgress, EgressPort: 1}, nil)
	if err == nil {
		t.Fatal("a nil selector must be rejected")
	}
	_, err = NewEgress(directConfig("e4", 1, "h", 80), &countingSelector{})
	if err == nil {
		t.Fatal("NewEgress must reject a non-EGRESS config")
	}
}

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------

// TestSingleHopDirectConcurrentConnections stresses the accept loop and the
// atomic counter with many simultaneous clients. Run with -race it is the
// guard against a data race in the shared byteCounter / conns bookkeeping.
func TestSingleHopDirectConcurrentConnections(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()
	upHost, upPortS, _ := net.SplitHostPort(up)
	var upPort int
	fmt.Sscanf(upPortS, "%d", &upPort)

	port := freePort(t)
	f, err := NewSingleHop(directConfig("cc", port, upHost, upPort))
	if err != nil {
		t.Fatalf("NewSingleHop: %v", err)
	}
	if err := f.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer f.Stop()

	const clients = 24
	var wg sync.WaitGroup
	errCh := make(chan error, clients)
	for i := 0; i < clients; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			conn, err := dialRetry(t, fmt.Sprintf("127.0.0.1:%d", port))
			if err != nil {
				errCh <- err
				return
			}
			defer conn.Close()
			msg := strings.Repeat(fmt.Sprintf("c%02d", i), 16)
			if _, err := conn.Write([]byte(msg)); err != nil {
				errCh <- err
				return
			}
			conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			buf := make([]byte, len(msg))
			if _, err := io.ReadFull(conn, buf); err != nil {
				errCh <- err
				return
			}
			if string(buf) != msg {
				errCh <- fmt.Errorf("echo mismatch at client %d", i)
			}
		}(i)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatalf("client failed: %v", err)
	}

	// Every client has read its echo, so both directions of every pair have
	// been delivered. Poll to the exact total: a Stats==0 check can observe
	// the aggregate mid-flight, which is a timing artefact, not a bug.
	// Each client echoes its payload back: 2 x (clients x len(msg)).
	want := int64(2 * clients * 48)
	deadline := time.Now().Add(5 * time.Second)
	for f.Stats() != want && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := f.Stats(); got != want {
		t.Fatalf("Stats = %d, want %d", got, want)
	}
}

// TestPipeTrackerDrainsOnStop verifies Stop waits for live connections instead
// of yanking the listener and abandoning the relay pairs.
func TestPipeTrackerDrainsOnStop(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()
	upHost, upPortS, _ := net.SplitHostPort(up)
	var upPort int
	fmt.Sscanf(upPortS, "%d", &upPort)

	port := freePort(t)
	f, err := NewSingleHop(directConfig("drain", port, upHost, upPort))
	if err != nil {
		t.Fatalf("NewSingleHop: %v", err)
	}
	if err := f.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}

	conn, err := dialRetry(t, fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	// Keep the connection open; Stop must return within drainTimeout.
	done := make(chan error, 1)
	go func() { done <- f.Stop() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Stop: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Stop blocked far longer than drainTimeout")
	}
	conn.Close()
	if !waitForPortClosed(t, port, 3*time.Second) {
		t.Fatal("port was not released after Stop")
	}
}
