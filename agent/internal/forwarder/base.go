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
// would be a lie about what the client sees). So does a drained one: the
// listener is still bound, but its accept loop is finished, so a swap would
// install an address no future connection can ever reach.
type upstream struct {
	mu    sync.RWMutex
	addr  string
	stale bool
	// armed is the "listener exists" flag: it flips on start() and clears
	// on stop(). A swap before the first Start is refused — installing an
	// address on a forwarder with no listener would tell the caller a hot
	// swap happened while the OS would refuse every new connection.
	armed bool
	// drained is the "listener exists but is done accepting" flag: it flips
	// on the drain step and is never cleared. The port stays reserved until
	// Stop/Remove, but no new connection will ever be dialled through this
	// forwarder, so a swap has nothing left to describe.
	drained bool
}

func (u *upstream) get() string {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.addr
}

// swap installs addr and returns false when the forwarder has no live listener
// (never started, or already stopped), or when it is drained: its accept loop
// has finished, so a swap would describe a dial no connection can reach.
func (u *upstream) swap(addr string) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.stale || !u.armed || u.drained {
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
	// draining is the Drain state: the listener is still bound (the port
	// stays reserved for whoever owns it next), but the accept loop has
	// finished, so no NEW connection is taken from the kernel backlog.
	draining bool
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
//
// A stopped forwarder is consumed (errStoppedForwarder: the caller must build a
// new one to rebind the port). A drained one is still started, so it answers
// ErrAlreadyStarted for the same reason: the drain decided this forwarder takes
// no more work, and neither start nor Drain can undo that.
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
		// Drain ends the accept loop without closing the listener: the
		// kernel keeps the connections that already arrived in its
		// backlog, and the port stays reserved for the owner that comes
		// next (§13.3.5 "a drained tunnel keeps its port reserved").
		// Leave them to that owner rather than answering here.
		if t.isDraining() {
			return
		}
		conn, err := ln.Accept()
		if err != nil {
			// A closed listener (Stop) ends the loop here. So does the
			// closed-on-purpose wake-up range: Drain does not touch the
			// listener, so an accept stuck in the backlog would otherwise
			// sit blocked until a connection arrives.
			//
			// Any other accept error (EMFILE, ECONNABORTED) also ends it:
			// looping forever on a resource error would burn CPU in the
			// agent log.
			return
		}
		if t.isDraining() {
			// A connection landed in the instant before the drain
			// started. It was accepted by the kernel but the drain had
			// already decided to stop taking new work, so hand it back
			// instead of counting it as one more connection to wait for.
			// It is also the one place a race between "conn accepted"
			// and "drain flag set" is resolved in the drain's favour.
			_ = conn.Close()
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

// isDraining reports whether a Drain has ended this forwarder's accept loop.
// It is set once and never cleared, so a stopped forwarder reads it as false
// (stop() clears the running state before draining).
func (t *pipeTracker) isDraining() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.draining
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
//
// stop is the terminal state: nothing downstream of it can bring the listener
// back, because the port is released on the way out. A Drain is NOT terminal —
// it only ends accepting, and the port reservation outlives it — so the two
// must not be reachable from each other's entry points. `start` refuses a
// stopped forwarder, and a drained one must be stopped (never restarted), so
// drain never calls stop and stop never clears drain.
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
// refused instead of silently installing an address nobody can dial. It also
// clears armed: from here on the port belongs to nobody.
func (u *upstream) markStale() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.stale = true
	u.armed = false
}

// markDrained records that the accept loop has finished while the listener is
// still bound. A swap after that point would install an address no future
// connection can reach, so it is refused; the listener itself is untouched.
func (u *upstream) markDrained() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.drained = true
}

// arm records that the forwarder has a live listener, which is what makes a
// hot swap legitimate. It runs after the bind succeeded.
func (u *upstream) arm() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.armed = true
}

// drainFor stops accepting new connections and waits for the in-flight
// connections to finish, bounded by the smaller of d and the package's hard
// ceiling. It does NOT close the listener: the caller (manager) owns the port
// lifecycle across a drain, so a drained-but-still-registered tunnel keeps its
// reservation until Remove or a replacement says otherwise.
//
// The drain is IRREVERSIBLE. There is deliberately no un-drain: the accept
// loop has ended and the backlog connections have been handed back to the
// kernel, so restarting it would accept work for a configuration the caller
// has already moved on from. A drained forwarder is finished; teardown is
// stop()'s job (Remove / the replacement path / StopAll), and it is safe to
// call stop() at any point after a drain — stop() closes the still-bound
// listener and drains whatever is in flight. start() cannot resurrect one
// either (the drain leaves started set, so it answers ErrAlreadyStarted):
// rebinding is a genuinely new forwarder's job.
//
// The counter is re-read under the wait rather than snapshotted once: a
// connection accepted while the drain is running still counts, so "drain"
// means "nothing is in flight any more" and not "nothing was in flight when
// I looked".
func (t *pipeTracker) drainFor(d time.Duration) {
	// d <= 0 is "do not wait", not "wait forever" (and certainly not
	// drainCeiling): an idle forwarder has nothing to wait for, so the
	// caller that asks for zero must get zero back.
	if d <= 0 {
		t.beginDrain()
		return
	}
	if d > drainCeiling {
		d = drainCeiling
	}
	// Flip the flag BEFORE waiting: it is what ends the accept loop, and a
	// drain that waited first would keep accepting for the whole window.
	t.beginDrain()
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

// beginDrain ends the accept loop while leaving the listener bound. Safe to
// call more than once (the flag is idempotent), which is what makes Drain,
// Stop and a concurrent Drain/Stop safe to interleave.
func (t *pipeTracker) beginDrain() {
	t.mu.Lock()
	t.draining = true
	t.mu.Unlock()
	t.up.markDrained()
}

// drain waits for in-flight connections, bounded by drainTimeout.
func (t *pipeTracker) drain() {
	t.drainFor(drainTimeout)
}

func (t *pipeTracker) stats() int64   { return t.bytes.load() }
func (t *pipeTracker) liveConns() int { return int(atomic.LoadInt32(&t.conns)) }

// running reports whether the listener is bound.
//
// A drained forwarder still reports true on purpose: the listener IS bound,
// the port IS reserved, and that is the truth the manager needs to decide
// whether a drain has already happened. What has changed is that it takes no
// new connections — which is what drained() reports, not running().
func (t *pipeTracker) running() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.started && !t.stopped
}

// drained reports whether this forwarder's drain has ended its accept loop.
// The listener stays bound and Running() keeps reporting true; the difference
// is that nothing new can arrive, so the caller must go through stop() to
// finish and through a new forwarder to resume.
func (t *pipeTracker) drained() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.draining
}
