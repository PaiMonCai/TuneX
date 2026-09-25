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

// drainCeiling is the hard upper bound every Drain honours, whatever timeout
// the caller asks for. A drain is a teardown step, not a wait-forever: the
// manager holds no lock while draining, but the next phase of a rollout still
// has to be reachable.
const drainCeiling = 15 * time.Second

// upstream is the swappable dial address a forwarder hands to its pick
// function. It exists so the §13.3.4 "Target Host / Port" hot swap can
// replace where new connections go WITHOUT touching the listener: a
// pipeTracker keeps dialing through whatever value is current, and the
// swap only changes what "current" means from then on.
//
// A closed forwarder refuses swaps (its listener is gone; a new dial address
// would be a lie about what the client sees).
type upstream struct {
	mu    sync.RWMutex
	addr  string
	stale bool
	// armed is the "listener exists" flag: it flips on start() and clears
	// on stop(). A swap before the first Start is refused — installing an
	// address on a forwarder with no listener would tell the caller a hot
	// swap happened while the OS would refuse every new connection.
	armed bool
}

func (u *upstream) get() string {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.addr
}

// swap installs addr and returns false when the forwarder has no live listener
// (never started, or already stopped).
func (u *upstream) swap(addr string) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.stale || !u.armed {
		return false
	}
	u.addr = addr
	return true
}

// pipeTracker is the shared lifecycle of every TCP forwarder: it binds the
// listener once, hands every accepted connection to pick(), and owns the
// started/stopped state, the byte counter and the connection wait group that
// lets Stop drain what is in flight.
type pipeTracker struct {
	cfg TunnelConfig

	up upstream

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
	t.up.arm()
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
	t.up.markStale()
	ln := t.ln
	t.mu.Unlock()

	if ln != nil {
		_ = ln.Close()
	}
	t.drain()
	return nil
}

// markStale records that the forwarder is finished, so a late SetUpstream is
// refused instead of silently installing an address nobody can dial.
func (u *upstream) markStale() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.stale = true
	u.armed = false
}

// arm records that the forwarder has a live listener, which is what makes a
// hot swap legitimate. It runs after the bind succeeded.
func (u *upstream) arm() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.armed = true
}

// drainFor waits for in-flight connections, bounded by the smaller of d and
// the package's hard ceiling. It does NOT close the listener: the caller
// (manager) owns the port lifecycle across a drain.
//
// The counter is re-read under the wait rather than snapshotted once: a
// connection accepted while the drain is running still counts, so "drain"
// means "nothing is in flight any more" and not "nothing was in flight when
// I looked".
func (t *pipeTracker) drainFor(d time.Duration) {
	if d <= 0 || d > drainCeiling {
		d = drainCeiling
	}
	deadline := time.Now().Add(d)
	for {
		live := t.liveConns()
		if live == 0 {
			return
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return
		}
		// Re-check on a short tick instead of blocking on the WaitGroup:
		// a fresh connection that lands between two polls keeps the drain
		// waiting, and the deadline still wins eventually.
		if remaining > 50*time.Millisecond {
			remaining = 50 * time.Millisecond
		}
		time.Sleep(remaining)
	}
}

// drain waits for in-flight connections, bounded by drainTimeout.
func (t *pipeTracker) drain() {
	t.drainFor(drainTimeout)
}

func (t *pipeTracker) stats() int64   { return t.bytes.load() }
func (t *pipeTracker) liveConns() int { return int(atomic.LoadInt32(&t.conns)) }

// running reports whether the listener is bound.
func (t *pipeTracker) running() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.started && !t.stopped
}
