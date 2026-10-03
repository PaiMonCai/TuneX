package forwarder

import (
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

// The WP11A shutdown primitive differs from Drain in exactly two ways, and both
// are asserted here: the listener is CLOSED (so a new connection is refused
// instead of queued), and a connection that outlives the deadline is force
// closed instead of being waited on indefinitely.

// errRefused is the "the node stopped accepting" fact: a fresh dial must fail
// rather than hang in the backlog.
func TestShutdownClosesListenerForNewConnections(t *testing.T) {
	target, stop := echoTarget(t)
	defer stop()
	upPort := portOf(target)

	live := freePort(t)
	fwd, err := NewSingleHop(directConfig("sd-close", live, "127.0.0.1", upPort))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if err := fwd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	addr := net.JoinHostPort("127.0.0.1", itoa(live))

	// A working connection first, so the test proves shutdown changes behaviour
	// rather than that nothing ever worked.
	c1, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatalf("pre-shutdown dial must succeed: %v", err)
	}
	defer c1.Close()

	result := fwd.Shutdown(time.Second)
	if !result.ClosedListener {
		t.Fatalf("shutdown must report the listener it closed: %+v", result)
	}

	// The listener is gone: the OS refuses (or resets) the new connection.
	failed := false
	for i := 0; i < 3 && !failed; i++ {
		c2, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
		if err != nil {
			failed = true
			break
		}
		_ = c2.Close()
		time.Sleep(50 * time.Millisecond)
	}
	if !failed {
		t.Fatal("a new connection was still accepted after shutdown closed the listener")
	}
	if fwd.Running() {
		t.Fatal("shutdown must leave the forwarder not running")
	}
	if _, err := NewSingleHop(directConfig("sd-close", live, "127.0.0.1", upPort)); err != nil {
		t.Fatalf("rebuild: %v", err)
	}
}

// A connection that finishes inside the deadline is allowed to finish: shutdown
// is not a kill.
func TestShutdownWaitsForInFlightConnection(t *testing.T) {
	target, stop := echoTarget(t)
	defer stop()
	upPort := portOf(target)

	live := freePort(t)
	fwd, err := NewSingleHop(directConfig("sd-wait", live, "127.0.0.1", upPort))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if err := fwd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	addr := net.JoinHostPort("127.0.0.1", itoa(live))

	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("hello")); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 5)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("echo read: %v", err)
	}

	go func() {
		time.Sleep(150 * time.Millisecond)
		_ = conn.Close()
	}()

	start := time.Now()
	result := fwd.Shutdown(3 * time.Second)
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("shutdown waited %v, beyond its own deadline", elapsed)
	}
	if result.ForcedConns != 0 {
		t.Fatalf("a connection that closed in time must not be forced: %+v", result)
	}
	if result.RemainingConns != 0 {
		t.Fatalf("no connection should remain: %+v", result)
	}
}

// A connection that ignores the deadline is force-closed, and the result says
// so instead of pretending the drain was clean.
func TestShutdownForceClosesAfterDeadline(t *testing.T) {
	target, stop := echoTarget(t)
	defer stop()
	upPort := portOf(target)

	live := freePort(t)
	fwd, err := NewSingleHop(directConfig("sd-force", live, "127.0.0.1", upPort))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if err := fwd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	addr := net.JoinHostPort("127.0.0.1", itoa(live))

	// An idle connection: nothing is in flight, so it will never finish on its
	// own. This is exactly the case a bounded shutdown must resolve.
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("x")); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 1)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("echo read: %v", err)
	}

	start := time.Now()
	result := fwd.Shutdown(300 * time.Millisecond)
	elapsed := time.Since(start)
	if elapsed > 5*time.Second {
		t.Fatalf("shutdown took %v; the deadline was not enforced", elapsed)
	}
	if result.ForcedConns == 0 {
		t.Fatalf("an idle connection past the deadline must be forced: %+v", result)
	}
	// The client observes the close rather than hanging.
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Read(buf); err == nil {
		t.Fatal("the client should see the forced close")
	} else if !errors.Is(err, io.EOF) {
		var ne net.Error
		if !errors.As(err, &ne) {
			t.Fatalf("unexpected read error after force close: %v", err)
		}
	}
}

// Shutdown is idempotent, safe on a forwarder that never started, and terminal:
// a shutdown that happened before Start must refuse the later Start rather than
// let a closing node bind a fresh port.
func TestShutdownIsIdempotent(t *testing.T) {
	neverStarted, err := NewSingleHop(directConfig("sd-idem-0", freePort(t), "127.0.0.1", 9))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if result := neverStarted.Shutdown(time.Second); result.ClosedListener {
		t.Fatalf("nothing was bound, so nothing was closed: %+v", result)
	}
	if err := neverStarted.Start(); err == nil {
		t.Fatal("Start after Shutdown must be refused: a closing node must not bind a new port")
	}

	fwd, err := NewSingleHop(directConfig("sd-idem", freePort(t), "127.0.0.1", 9))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if err := fwd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	first := fwd.Shutdown(time.Second)
	if !first.ClosedListener {
		t.Fatalf("the running listener must be closed: %+v", first)
	}
	second := fwd.Shutdown(time.Second)
	if second.ClosedListener {
		t.Fatalf("a second shutdown must not claim to close a listener again: %+v", second)
	}
	// Stop after Shutdown stays a no-op, not a panic.
	if err := fwd.Stop(); err != nil {
		t.Fatalf("stop after shutdown: %v", err)
	}
}
