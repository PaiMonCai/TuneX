// Shared accept loop and lifecycle bookkeeping for every TCP forwarder.
package forwarder

import (
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// errStoppedForwarder is returned by Start after Stop has already run: the
// forwarder is consumed and the caller must build a new one to rebind the port.
var errStoppedForwarder = errors.New("forwarder: forwarder already stopped")

func errModeNot(want TunnelMode, got TunnelMode) error {
	return fmt.Errorf("forwarder: mode %q does not support this constructor (want %q)", got, want)
}

// dialTimeout is how long a single upstream dial may take before the client is
// dropped. Long enough for a healthy peer on a WAN link, short enough that a
// black-holed target does not pin a goroutine forever.
const dialTimeout = 10 * time.Second

// drainTimeout bounds Stop: an idle-but-open client connection must not delay
// process shutdown indefinitely.
const drainTimeout = 3 * time.Second

// pipeTracker is the shared lifecycle of every TCP forwarder: it binds the
// listener once, hands every accepted connection to pick(), and owns the
// started/stopped state, the byte counter and the connection wait group that
// lets Stop drain what is in flight.
type pipeTracker struct {
	cfg TunnelConfig

	mu       sync.Mutex
	ln       net.Listener
	started  bool
	stopped  bool
	bytes    byteCounter
	conns    int32
	inFlight sync.WaitGroup
}

// errNotRunning is returned by internal helpers that require a bound listener.
var errNotRunning = errors.New("forwarder: listener not running")

// pick resolves the upstream for one accepted client connection.
type pick func(client net.Conn) (net.Conn, error)

// start binds the listener and spawns the accept loop. Idempotent-safe: a second
// call on a running forwarder returns ErrAlreadyStarted.
func (t *pipeTracker) start(p pick) error {
	t.mu.Lock()
	if t.stopped {
		t.mu.Unlock()
		return errStoppedForwarder
	}
	if t.started {
		t.mu.Unlock()
		return ErrAlreadyStarted
	}
	ln, err := net.Listen("tcp", t.cfg.ListenAddr())
	if err != nil {
		t.mu.Unlock()
		return err
	}
	t.ln = ln
	t.started = true
	t.mu.Unlock()

	go t.acceptLoop(ln, p)
	return nil
}

func (t *pipeTracker) acceptLoop(ln net.Listener, p pick) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			// A closed listener (Stop) ends the loop here. Any other accept
			// error (EMFILE, ECONNABORTED) also ends it: looping forever on a
			// resource error would burn CPU in the agent log.
			return
		}
		atomic.AddInt32(&t.conns, 1)
		t.inFlight.Add(1)
		go func() {
			defer t.inFlight.Done()
			defer atomic.AddInt32(&t.conns, -1)
			defer conn.Close()
			t.handleConn(conn, p)
		}()
	}
}

func (t *pipeTracker) handleConn(conn net.Conn, p pick) {
	upstream, err := p(conn)
	if err != nil {
		// Unreachable target: drop the client immediately rather than
		// leaving it hanging with no upstream.
		return
	}
	defer upstream.Close()
	PipeConns(conn, upstream, &t.bytes)
}

// stop closes the listener and drains live connections. Safe before Start and
// after a previous Stop; both are no-ops returning nil.
func (t *pipeTracker) stop() error {
	t.mu.Lock()
	if t.stopped {
		t.mu.Unlock()
		return nil
	}
	t.stopped = true
	ln := t.ln
	t.mu.Unlock()

	if ln != nil {
		_ = ln.Close()
	}
	t.drain()
	return nil
}

// drain waits for in-flight connections, bounded by drainTimeout.
func (t *pipeTracker) drain() {
	done := make(chan struct{})
	go func() { t.inFlight.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(drainTimeout):
	}
}

func (t *pipeTracker) stats() int64   { return t.bytes.load() }
func (t *pipeTracker) liveConns() int { return int(atomic.LoadInt32(&t.conns)) }

// running reports whether the listener is bound.
func (t *pipeTracker) running() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.started && !t.stopped
}
