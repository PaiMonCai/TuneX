package forwarder

import (
	"net"
	"time"
)

// ShutdownResult reports what one forwarder's shutdown had to do. ForcedConns
// is non-zero only when the deadline expired with connections still open: they
// were closed rather than left to outlive the process.
type ShutdownResult struct {
	// ClosedListener is true when this call closed a bound listener (and with
	// it made new TCP connections fail immediately instead of queueing).
	ClosedListener bool
	// ForcedConns counts connections closed after the shared deadline.
	ForcedConns int
	// RemainingConns is what was still open when shutdown returned. A non-zero
	// value is a truth worth reporting; it is not hidden by a nil error.
	RemainingConns int
}

// Shutdowner is the WP11A shutdown primitive. It is deliberately separate from
// Forwarder: Drain keeps the listener bound (rollout needs the port to stay
// reserved), while a shutdown must close it so the port stops accepting new
// connections. Implementing it optionally keeps the frozen WP4 contract intact.
type Shutdowner interface {
	// Shutdown closes the listener first, then waits for in-flight connections
	// up to timeout, then force-closes whatever is left. It never returns
	// before the deadline, and it is safe to call after Stop or Drain.
	Shutdown(timeout time.Duration) ShutdownResult
}

// CloseListener closes only the listener: new TCP connections are refused from
// that instant, while the connections already being proxied keep working.
//
// It exists because a shutdown has two phases with different urgency (WP11A):
// stopping the node accepting new work must not wait for anything, but draining
// what is already connected is bounded work that happens afterwards. Doing both
// in one call made "when do new connections start failing?" depend on how long
// the drain took.
func (t *pipeTracker) CloseListener() bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	ln := t.ln
	t.ln = nil
	t.mu.Unlock()
	if ln == nil {
		return false
	}
	// Closing it ends the accept loop (Accept returns an error) and makes the
	// kernel answer new connections with RST instead of queueing them.
	_ = ln.Close()
	return true
}

// ListenerCloser is implemented by forwarders that can stop accepting without
// touching live connections.
type ListenerCloser interface {
	CloseListener() bool
}

// trackConn registers a proxied connection so a shutdown can close it.
func (t *pipeTracker) trackConn(c net.Conn) {
	if c == nil {
		return
	}
	t.mu.Lock()
	if t.live == nil {
		t.live = make(map[net.Conn]struct{})
	}
	t.live[c] = struct{}{}
	// A shutdown may have begun between Accept and here; it already closed the
	// listener, so this connection must not be proxied. Closing it is the same
	// answer the accept loop gives a connection that lost the race.
	if t.stopped {
		delete(t.live, c)
		t.mu.Unlock()
		_ = c.Close()
		return
	}
	t.mu.Unlock()
}

// untrackConn forgets a finished connection.
func (t *pipeTracker) untrackConn(c net.Conn) {
	if c == nil {
		return
	}
	t.mu.Lock()
	delete(t.live, c)
	t.mu.Unlock()
}

// forceCloseConns closes every connection still being proxied and returns how
// many were closed. The listener is already closed by then, so the accept loop
// cannot add new ones.
//
// Both ENDS of each pair are tracked and closed. Closing only the client was not
// enough: PipeConns copies in both directions, and a peer that ignores the FIN
// (or simply never sends anything again) leaves the upstream read blocked, so the
// handler goroutine outlives the deadline it was supposed to be bounded by.
func (t *pipeTracker) forceCloseConns() int {
	t.mu.Lock()
	conns := make([]net.Conn, 0, len(t.live))
	for c := range t.live {
		conns = append(conns, c)
	}
	t.live = nil
	t.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
	return len(conns)
}

// Shutdown implements Shutdowner.
//
// Order is the contract, not an implementation detail:
//  1. close the listener — after this a new TCP connection is refused instead
//     of sitting in the backlog, which is what distinguishes a node shutdown
//     from a rollout Drain;
//  2. wait for in-flight connections, bounded by timeout (a shared deadline:
//     callers pass the same value to every forwarder);
//  3. force-close whatever survived the deadline, then give the pipes a short
//     bounded moment to unwind before reporting.
//
// timeout <= 0 means "close now, wait for nothing".
func (t *pipeTracker) Shutdown(timeout time.Duration) ShutdownResult {
	// Phase 1 is idempotent: a caller that already closed listeners (the two
	// phase shutdown) finds nothing to close here and goes straight to draining.
	listenerClosed := t.CloseListener()

	t.mu.Lock()
	if t.stopped {
		// Already stopped or drained by an earlier teardown. Idempotent for the
		// listener, but still bounded-close whatever an earlier 3s Stop left
		// behind: a shutdown deadline must not be silently unenforced.
		t.mu.Unlock()
		forced := t.forceCloseConns()
		for i := 0; i < 20 && t.liveConns() > 0; i++ {
			time.Sleep(5 * time.Millisecond)
		}
		return ShutdownResult{ForcedConns: forced, RemainingConns: t.liveConns()}
	}
	t.stopped = true
	t.draining = true
	t.up.markStale()
	// The listener itself was already closed by CloseListener above (either by
	// this call or by an earlier CloseListeners phase).
	t.ln = nil
	t.mu.Unlock()
	t.up.markDrained()

	result := ShutdownResult{ClosedListener: listenerClosed}
	if timeout > 0 {
		deadline := time.Now().Add(timeout)
		for t.liveConns() > 0 {
			remaining := time.Until(deadline)
			if remaining <= 0 {
				break
			}
			if remaining > 25*time.Millisecond {
				remaining = 25 * time.Millisecond
			}
			time.Sleep(remaining)
		}
	}
	result.ForcedConns = t.forceCloseConns()
	// The closers run in their own goroutines; give them a bounded moment so
	// RemainingConns describes reality instead of a transient.
	for i := 0; i < 20 && t.liveConns() > 0; i++ {
		time.Sleep(5 * time.Millisecond)
	}
	result.RemainingConns = t.liveConns()
	return result
}

var _ Shutdowner = (*pipeTracker)(nil)
