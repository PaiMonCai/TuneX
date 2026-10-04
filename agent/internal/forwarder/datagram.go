// Datagram (UDP) ingress runtime — V5.1b WP5-B1, DIRECT only.
//
// Contract: docs/v5-1b-datagram-contract-draft.md (§1-§4, §6, §8). Read that
// document before changing anything here; the short version is:
//
//	client ══ UDP ══> ingress socket ── mapping(client addr) ──> target (UDP)
//	client <══ UDP ══  ingress socket <─ reply on the mapping's own socket ── target
//
// The unit of work is a MAPPING, not a connection: one ingress socket per
// Forward, one entry per client address, one socket to the target per entry. A
// mapping lives until it has been idle in BOTH directions for the idle timeout
// (§2.3①) — UDP has no FIN/RST, so "the client hung up" is not an event that
// exists and must never be treated as the cleanup path (§2.3②).
//
// This file is a sibling of base.go/singhop.go, not a variant of them. The stream
// path's pipeTracker exists to accept connections, pipe bytes and drain them;
// forcing a datagram through it would require inventing connections that do not
// exist. What is shared is everything the manager owns — one registry, one
// revision ledger, one port guard — plus the A3 diagnostics channel and the
// WP11A shutdown primitives, which this type implements honestly (see
// CloseListener and Shutdown).
package forwarder

import (
	"errors"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// defaultDatagramIdleTimeout is how long a mapping survives without traffic
	// in either direction before it is recycled (§2.3①).
	//
	// The NUMBER is a product decision (§9.2 — there is no per-Forward column
	// yet), which is exactly why it is a named default a builder can override
	// rather than a literal inside the loop. 30s is the same order as a stateful
	// NAT's UDP timeout, which is the behaviour clients already expect to be
	// behind.
	defaultDatagramIdleTimeout = 30 * time.Second

	// defaultDatagramMaxMappings is the ingress mapping ceiling (§2.4).
	//
	// The ceiling is not optional: a UDP source address is forgeable, so "one
	// mapping per source address" without a bound is a memory-exhaustion
	// primitive pointed at the agent. The VALUE is a product decision (§9.3);
	// what is not a decision is that its worst case must be affordable. Each live
	// mapping holds one connected target socket, one reply goroutine and one
	// read buffer, so a ceiling of 1024 bounds a single tunnel at roughly
	// 64 MiB of buffers plus goroutine stacks — bounded, which is the property
	// the contract actually freezes.
	//
	// Over the ceiling, datagrams from sources with no mapping are DROPPED. The
	// alternatives are worse in this direction: evicting a live mapping to make
	// room would break a working client in favour of a source nobody has
	// verified, and accepting without a bound is the attack above. The refusal is
	// counted (drops + mappings_rejected), so the ceiling is observable instead
	// of silent.
	defaultDatagramMaxMappings = 1024

	// datagramMaxPayload is the largest payload a UDP datagram can carry (65535
	// minus its 8-byte header). Reading with a buffer this size means a datagram
	// is never truncated: the alternative is a silent per-datagram cap that looks
	// like a working tunnel until the one large response that matters arrives.
	datagramMaxPayload = 65535 - 8

	// datagramDialTimeout bounds one mapping's dial, name resolution included.
	//
	// It is tighter than the stream path's dialTimeout (10s) because of WHERE it
	// runs: a stream dial happens inside the connection's own goroutine, while a
	// mapping is created inline in the ingress loop — there is no per-client
	// goroutine yet — so everything the listener is doing waits behind this
	// lookup. Only a NEW mapping pays it, never a packet of an existing one.
	datagramDialTimeout = 3 * time.Second

	// datagramSweepMin/Max bound the idle sweeper's tick, which is derived from
	// the idle timeout so a shortened timeout (tests, or a future per-Forward
	// column) stays accurate without a second knob to keep in sync.
	datagramSweepMin = 20 * time.Millisecond
	datagramSweepMax = time.Second

	// datagramReadErrorBackoff spaces out repeated read errors that are not
	// "socket closed". A UDP read error is transient by construction (the buffer
	// is the protocol maximum, so truncation cannot be the cause); the backoff
	// exists so a permanently broken socket cannot turn this loop into a CPU
	// burn, while still keeping the listener receiving.
	datagramReadErrorBackoff = 20 * time.Millisecond
)

// DatagramOptions tunes one datagram runtime. The zero value means "the package
// defaults", so a caller with nothing to say passes nothing.
type DatagramOptions struct {
	// IdleTimeout is the §2.3① idle window. <= 0 uses the package default.
	IdleTimeout time.Duration
	// MaxMappings is the §2.4 ceiling. <= 0 uses the package default.
	MaxMappings int
}

// datagramMapping is one entry in the ingress mapping table (§2.1). The table
// key is the mapping key (listener identity + normalised client address, and
// never the target); the entry itself holds the two things a mapping IS:
//
//   - the client address replies go back to, and
//   - a socket CONNECTED to one target. That connection is what pins this
//     mapping to the target it was created with: a single unconnected upstream
//     socket could not say which client a reply belonged to, and Retarget could
//     not promise "new mappings only" (§3.4) because nothing would remember
//     which target an existing mapping was using.
//
// Closing conn is what ends the mapping: it releases the reply goroutine, and
// there is no other ending to wait for — UDP has no FIN/RST (§2.3②).
type datagramMapping struct {
	// client is the normalised client address replies go back to.
	client *net.UDPAddr
	// conn is the connected target socket for this mapping.
	conn net.Conn
	// lastActivity is the mapping's idle clock, refreshed on traffic in EITHER
	// direction (§2.1). Nanoseconds since the epoch; read by the sweeper.
	lastActivity atomic.Int64
}

// DatagramForwarder is the datagram runtime for one DIRECT tunnel.
//
// It implements DatagramRuntime, Diagnostician (V5-WP5-A3), Shutdowner and
// ListenerCloser, but NOT StreamRuntime: Drain and SetUpstream are stream-only
// notions and are deliberately absent, so no caller can mistake this for a
// runtime whose connections could be drained (§4.1).
type DatagramForwarder struct {
	cfg  TunnelConfig
	opts DatagramOptions

	// diag is this tunnel's protocol diagnostics (V5-WP5-A3). It is the single
	// ledger behind both Stats() and the state report's diag object.
	diag *diagRecorder

	mu sync.Mutex
	// conn is the ingress socket: ONE per Forward, carrying BOTH directions
	// (§4.3). That single object is why "stop accepting" here cannot mean
	// "close the socket".
	conn      *net.UDPConn
	started   bool
	stopped   bool
	admitting bool
	// mappings is the ingress mapping table. Its size IS "work in flight" for
	// this transport, and it is the reason LiveMappings exists instead of
	// LiveConns. The table is runtime state only: it is never persisted, never
	// restored, and empty after a restart is the expected outcome, not a fault
	// (§2.2④).
	mappings map[string]*datagramMapping
	// target is where NEW mappings dial. Retarget swaps it; a mapping already in
	// the table keeps the socket it was created with, so the swap cannot reach it.
	target string

	// sweepStop ends the idle sweeper. Closed exactly once, by whichever
	// teardown runs first.
	sweepStop chan struct{}
	sweepOnce sync.Once
	// mappingWG tracks the reply goroutines so a teardown can report that they
	// really unwound.
	mappingWG sync.WaitGroup
}

// Compile-time proof of the four contracts this runtime answers. The absence of
// StreamRuntime in this list is deliberate: it is not satisfied, by design.
var (
	_ DatagramRuntime = (*DatagramForwarder)(nil)
	_ Diagnostician   = (*DatagramForwarder)(nil)
	_ Shutdowner      = (*DatagramForwarder)(nil)
	_ ListenerCloser  = (*DatagramForwarder)(nil)
)

// NewDatagram builds the datagram runtime for a DIRECT tunnel. It binds nothing:
// Start() is the only place that binds, so an unusable config fails before a
// socket exists — the same ordering rule BuildStream enforces.
func NewDatagram(cfg TunnelConfig, opts DatagramOptions) (*DatagramForwarder, error) {
	if cfg.Mode != ModeDirect {
		// Unreachable through Validate for udp (RELAY/EGRESS are refused there),
		// kept so a direct constructor call cannot produce a listener whose role
		// the datagram runtime does not implement.
		return nil, errModeNot(ModeDirect, cfg.Mode)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if opts.IdleTimeout <= 0 {
		opts.IdleTimeout = defaultDatagramIdleTimeout
	}
	if opts.MaxMappings <= 0 {
		opts.MaxMappings = defaultDatagramMaxMappings
	}
	return &DatagramForwarder{
		cfg:       cfg,
		opts:      opts,
		diag:      &diagRecorder{protocol: ProtocolUDP},
		mappings:  make(map[string]*datagramMapping),
		target:    cfg.UpstreamAddr(),
		sweepStop: make(chan struct{}),
	}, nil
}

// Start binds the ingress socket and begins receiving. Returns ErrAlreadyStarted
// when the runtime is already running.
//
// A stopped runtime is consumed (errStoppedForwarder): rebinding is a new
// runtime's job, exactly like the stream path.
func (d *DatagramForwarder) Start() error {
	d.mu.Lock()
	if d.stopped {
		d.mu.Unlock()
		return errStoppedForwarder
	}
	if d.started {
		d.mu.Unlock()
		return ErrAlreadyStarted
	}
	// ListenHost keeps its meaning from the stream path: empty means all
	// interfaces. ResolveUDPAddr is the UDP spelling of the same bind decision
	// (§9.6 leaves dual-stack policy to the product; this follows the address the
	// config names, and the key normalisation below makes a v4 client one mapping
	// either way).
	addr, err := net.ResolveUDPAddr("udp", d.cfg.ListenAddr())
	if err != nil {
		d.mu.Unlock()
		return err
	}
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		d.mu.Unlock()
		return err
	}
	d.conn = conn
	d.started = true
	d.admitting = true
	d.mu.Unlock()

	// Two goroutines, no accept loop: "accept" here is turning a datagram's
	// source address into a mapping, which happens per packet in ingressLoop.
	go d.sweepLoop()
	go d.ingressLoop(conn)
	return nil
}

// Stop releases the ingress port and drops every mapping. Safe before Start and
// more than once (both are no-ops returning nil).
//
// The stream contract's "tears down live connections" becomes "drops every
// mapping" (§4.1): there is no close handshake to send, so the target sockets are
// closed and the clients simply stop receiving replies. Nothing about that is
// graceful, and pretending otherwise would mean waiting for an idle timeout that
// does not end the tunnel.
func (d *DatagramForwarder) Stop() error {
	d.mu.Lock()
	if d.stopped {
		d.mu.Unlock()
		return nil
	}
	d.stopped = true
	d.admitting = false
	conn := d.conn
	d.conn = nil
	mappings := d.detachMappingsLocked()
	d.mu.Unlock()

	if conn != nil {
		_ = conn.Close()
	}
	d.closeMappings(mappings)
	d.closeSweeper()
	// Every socket a reply goroutine could be blocked on is closed by now, so
	// this is normally instant; the bound is the same one the stream Stop uses so
	// a pathological socket cannot hold the caller.
	d.waitMappings(drainTimeout)
	// The ingress loop is not waited for: it may be inside a bounded mapping dial
	// (datagramDialTimeout), after which its next read on the closed socket ends it
	// immediately. Waiting would make Stop as slow as a DNS lookup for no fact it
	// could report.
	return nil
}

// Running reports whether the ingress socket is bound.
func (d *DatagramForwarder) Running() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.started && !d.stopped
}

// Stats reports the datagram facts (§6.1). Note the shape: it is not the stream
// contract's single byte total, because that total cannot tell "many tiny
// packets" (a scan or an amplification attempt) from "few large packets".
func (d *DatagramForwarder) Stats() DatagramStats {
	return d.diag.datagramStats(int64(d.LiveMappings()))
}

// LiveMappings reports how much work is in flight. This is what a caller must
// ask instead of LiveConns (§4.4.1): a datagram tunnel has no connections, and
// answering "0" to a connection question would report an idle tunnel for one
// that is relaying.
func (d *DatagramForwarder) LiveMappings() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.mappings)
}

// Retarget moves where NEW mappings are dialled. It never touches the listener
// and never rewrites a live mapping: existing mappings keep sending to (and
// receiving from) the target they were created with until they expire — the
// frozen §13.3.4 semantics translated to datagrams (§3.4).
//
// It is refused on a runtime with no live listener or with admission closed: a
// target no future mapping can reach is a lie about what the client will see.
func (d *DatagramForwarder) Retarget(target string) error {
	host, port, err := splitHostPort(target)
	if err != nil {
		return err
	}
	clean := net.JoinHostPort(host, strconv.Itoa(port))

	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.started || d.stopped || !d.admitting {
		return ErrForwarderNotRunning
	}
	if clean == d.target {
		return nil
	}
	d.target = clean
	logUpstreamSwap(d.cfg.ID, clean)
	return nil
}

// DrainMappings stops admitting NEW mappings and waits, bounded, for the live
// ones to end. The listener stays bound and its socket stays OPEN, which is the
// one place the datagram drain must differ from the stream one (§4.3): the
// ingress socket carries the replies of every live mapping, so closing it here
// would kill exactly the in-flight work this call promises to keep serving.
//
// Existing mappings are fully served while draining — forward AND return
// direction — because a mapping that is still alive is, by definition, work that
// was already admitted. Only sources with no mapping are refused, and those
// datagrams are counted (drops).
//
// Like the stream Drain it is irreversible and bounded by the package ceiling: a
// mapping whose idle timeout is longer than the window is still live when this
// returns, and that is a fact the caller can see in Stats(), not a failure.
// timeout <= 0 means "stop admitting, wait for nothing".
func (d *DatagramForwarder) DrainMappings(timeout time.Duration) error {
	d.stopAdmitting()
	if timeout <= 0 {
		return nil
	}
	if timeout > drainCeiling {
		timeout = drainCeiling
	}
	deadline := time.Now().Add(timeout)
	for {
		if d.LiveMappings() == 0 {
			return nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil
		}
		// Poll on a short tick rather than blocking on the table: mappings end
		// from the sweeper's goroutine, so a bounded re-check is how "no work in
		// flight" is observed without a second synchronization path (§base.drainFor
		// uses the same shape for connections).
		if remaining > 25*time.Millisecond {
			remaining = 25 * time.Millisecond
		}
		time.Sleep(remaining)
	}
}

// CloseListener is phase 1 of the two-phase shutdown for a datagram tunnel
// (§4.4.3): it stops admitting NEW mappings and leaves the socket open. It
// returns true only when it actually changed the admission state.
//
// It must NOT close the socket. The ingress socket carries the return path of
// every live mapping as well as new requests (§4.3), so "close the listener"
// here would silently destroy the in-flight work phase 1 promises not to touch —
// and the closing report would then say "0 remaining" for a tunnel that had just
// lost its mappings. Closing is Stop/Shutdown's job, in the phase that is allowed
// to force work.
func (d *DatagramForwarder) CloseListener() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.started || d.stopped || !d.admitting {
		return false
	}
	d.admitting = false
	return true
}

// Shutdown implements Shutdowner.
//
// A UDP mapping cannot finish on its own inside a shutdown window: it ends by
// idle expiry (30s by default) or by its socket closing (§2.3③). Waiting for
// idle expiry would spend the entire shared deadline — the budget the node's
// other tunnels need — and still end in force-close, so this follows the frozen
// rule literally: stop admitting, close the sockets, drop the mappings.
//
// What it does NOT do is pretend that was free. The dropped mappings are
// reported in ForcedMappings so the final shutdown report can state "N mappings
// were dropped", instead of the "0 remaining, 0 forced" a runtime that cannot
// answer LiveConns would otherwise produce (§4.4.2).
func (d *DatagramForwarder) Shutdown(timeout time.Duration) ShutdownResult {
	result := ShutdownResult{ClosedListener: d.CloseListener()}

	d.mu.Lock()
	if d.stopped {
		// Already torn down by an earlier Stop/Shutdown: nothing is in flight,
		// and claiming to have dropped work would be a different lie.
		d.mu.Unlock()
		return result
	}
	d.stopped = true
	d.admitting = false
	conn := d.conn
	d.conn = nil
	mappings := d.detachMappingsLocked()
	d.mu.Unlock()

	if conn != nil {
		_ = conn.Close()
	}
	d.closeMappings(mappings)
	d.closeSweeper()
	result.ForcedMappings = len(mappings)
	d.waitMappings(timeout)
	// Every mapping's sockets were closed above, so nothing is left open. The
	// dropped work is reported in ForcedMappings, not hidden here.
	result.RemainingConns = 0
	return result
}

// ProtocolDiagnostics implements Diagnostician (V5-WP5-A3) for a datagram front.
//
// Two facts are filled here rather than by the recorder, because neither is a
// counter: the live mapping count lives in the runtime's locked table, and the
// effective idle timeout is configuration. Letting the recorder leave them at 0
// would report "no mappings, no timeout" for a tunnel that is relaying.
func (d *DatagramForwarder) ProtocolDiagnostics() (ProtocolDiagnostics, bool) {
	diag := d.diag.ProtocolDiagnostics()
	diag.Mappings = int64(d.LiveMappings())
	diag.IdleTimeoutSeconds = int64(d.opts.IdleTimeout / time.Second)
	return diag, true
}

// ── the ingress path ────────────────────────────────────────────────────────

// ingressLoop reads the ingress socket and forwards each datagram through its
// mapping. It is the only creator of mappings, so the table has one writer.
func (d *DatagramForwarder) ingressLoop(conn *net.UDPConn) {
	buf := make([]byte, datagramMaxPayload)
	consecutiveErrors := 0
	for {
		n, client, err := conn.ReadFromUDP(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				// Stop/Shutdown closed the socket. The loop is done.
				return
			}
			// Any other error is transient by construction (the buffer is the
			// protocol maximum, so a truncated datagram is impossible). Count the
			// fact and keep receiving: a listener that exits on one odd error is
			// a tunnel that dies quietly. The backoff keeps a permanently broken
			// socket from spinning this loop.
			consecutiveErrors++
			d.diag.noteDatagramMalformed()
			if consecutiveErrors > 1 {
				time.Sleep(datagramReadErrorBackoff)
			}
			continue
		}
		consecutiveErrors = 0
		d.handleDatagram(client, buf[:n])
	}
}

// handleDatagram forwards one datagram, creating the client's mapping on first
// contact. Payload bytes are opaque: the tunnel never parses them, so "garbage
// content" is forwarded like any other payload — the only drops are the ones
// this function can name.
func (d *DatagramForwarder) handleDatagram(client *net.UDPAddr, payload []byte) {
	if !usableClientAddr(client) {
		// A source that cannot key a mapping (a forged zero port) must not create
		// state: the entry could never receive a reply, and it would count as
		// live work forever.
		d.diag.noteDatagramMalformed()
		return
	}
	m, ok := d.mappingFor(client)
	if !ok {
		return // the reason was counted where it was decided
	}
	if _, err := m.conn.Write(payload); err != nil {
		if errors.Is(err, net.ErrClosed) {
			// The mapping expired or was torn down between the lookup and this
			// write. Normal race, already accounted for by whoever closed it.
			return
		}
		d.diag.noteDatagramSendError()
		return
	}
	m.lastActivity.Store(time.Now().UnixNano())
	d.diag.noteDatagramDeliveredToTarget(len(payload))
}

// mappingFor returns the live mapping for a client, creating one when this is a
// new client and admission is open. The bool reports whether the caller may
// forward; false means the datagram was dropped and counted here.
func (d *DatagramForwarder) mappingFor(client *net.UDPAddr) (*datagramMapping, bool) {
	key := d.mappingKey(client)

	d.mu.Lock()
	if m, ok := d.mappings[key]; ok {
		d.mu.Unlock()
		return m, true
	}
	if !d.admitting {
		d.mu.Unlock()
		d.diag.noteUnknownSource()
		return nil, false
	}
	if len(d.mappings) >= d.opts.MaxMappings {
		d.mu.Unlock()
		d.diag.noteMappingRejected()
		return nil, false
	}
	target := d.target
	d.mu.Unlock()

	// Dial outside the lock: the ingress loop is the only creator, so there is no
	// herd to serialise, and holding the lock across a name lookup would freeze
	// LiveMappings, Retarget and the drain for as long as the resolver takes.
	//
	// Dialing here is also what pins this mapping to `target`: the socket is
	// connected to the address the runtime had when the mapping was created, so a
	// later Retarget cannot move it.
	conn, err := net.DialTimeout("udp", target, datagramDialTimeout)
	if err != nil {
		// The target could not even be dialled (unresolvable name, no route).
		// UDP gives no synchronous signal for an unreachable peer, so this is
		// counted as a failed send and NOT as a delivered packet.
		d.diag.noteDatagramSendError()
		return nil, false
	}

	m := &datagramMapping{client: client, conn: conn}
	m.lastActivity.Store(time.Now().UnixNano())

	d.mu.Lock()
	// Re-check admission after the dial: CloseListener/Stop may have run while we
	// were resolving, and creating work after the caller was told new work stops
	// would break the phase-1 promise.
	if d.stopped || !d.admitting {
		d.mu.Unlock()
		_ = conn.Close()
		d.diag.noteUnknownSource()
		return nil, false
	}
	d.mappings[key] = m
	d.mu.Unlock()

	d.diag.noteMappingCreated()
	d.mappingWG.Add(1)
	go func() {
		defer d.mappingWG.Done()
		d.replyLoop(conn, m)
	}()
	return m, true
}

// replyLoop carries TARGET → CLIENT replies for one mapping.
//
// It is per mapping because a reply's source address is the target, not the
// client: only the mapping's own connected socket can say which client it
// belongs to. It exits when that socket is closed, which is exactly how a mapping
// ends (§2.3).
func (d *DatagramForwarder) replyLoop(conn net.Conn, m *datagramMapping) {
	listener := d.listenerSocket()
	if listener == nil {
		// The runtime was stopped between the mapping being created and this
		// goroutine starting. Nothing to serve.
		return
	}
	buf := make([]byte, datagramMaxPayload)
	for {
		n, err := conn.Read(buf)
		if err != nil {
			return
		}
		// The reply leaves through the INGRESS socket, so the client sees it from
		// the address it sent to. A zero-length reply is a legal datagram and is
		// forwarded as such.
		if _, err := listener.WriteToUDP(buf[:n], m.client); err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			d.diag.noteDatagramSendError()
			return
		}
		m.lastActivity.Store(time.Now().UnixNano())
		d.diag.noteDatagramDeliveredToClient(n)
	}
}

// ── idle expiry ─────────────────────────────────────────────────────────────

// sweepLoop recycles idle mappings. One goroutine per tunnel, ticking at a
// fraction of the idle timeout so expiry is accurate without a timer per mapping
// (a timer per mapping would be one more unbounded resource, which is what the
// ceiling exists to avoid).
func (d *DatagramForwarder) sweepLoop() {
	tick := d.opts.IdleTimeout / 4
	if tick < datagramSweepMin {
		tick = datagramSweepMin
	}
	if tick > datagramSweepMax {
		tick = datagramSweepMax
	}
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		select {
		case <-d.sweepStop:
			return
		case <-t.C:
			d.expireIdle()
		}
	}
}

// expireIdle removes every mapping that has been idle in both directions for
// longer than the idle timeout and closes its socket.
func (d *DatagramForwarder) expireIdle() {
	cutoff := time.Now().Add(-d.opts.IdleTimeout).UnixNano()
	var expired []*datagramMapping
	d.mu.Lock()
	for key, m := range d.mappings {
		if m.lastActivity.Load() <= cutoff {
			delete(d.mappings, key)
			expired = append(expired, m)
		}
	}
	d.mu.Unlock()
	if len(expired) == 0 {
		return
	}
	d.closeMappings(expired)
	// Counted after the table change, so a concurrent Stats() reader can never
	// see a mapping that is both "active" and "expired".
	d.diag.noteMappingsExpired(len(expired))
}

// ── lifecycle helpers ───────────────────────────────────────────────────────

// stopAdmitting closes admission without touching the socket. Idempotent.
func (d *DatagramForwarder) stopAdmitting() {
	d.mu.Lock()
	d.admitting = false
	d.mu.Unlock()
}

// detachMappingsLocked removes every mapping from the table and returns them, so
// the caller can close their sockets outside the lock. Removing first is what
// makes "the stats no longer show a mapping that is being torn down" true.
// Caller must hold d.mu.
func (d *DatagramForwarder) detachMappingsLocked() []*datagramMapping {
	out := make([]*datagramMapping, 0, len(d.mappings))
	for key, m := range d.mappings {
		out = append(out, m)
		delete(d.mappings, key)
	}
	return out
}

// closeMappings closes the target sockets of finished mappings. Closing is what
// releases each mapping's reply goroutine; net.Conn.Close is safe to call twice,
// so this needs no "already closed" flag.
func (d *DatagramForwarder) closeMappings(mappings []*datagramMapping) {
	for _, m := range mappings {
		if m.conn != nil {
			_ = m.conn.Close()
		}
	}
}

// listenerSocket returns the bound ingress socket, or nil when there is none.
func (d *DatagramForwarder) listenerSocket() *net.UDPConn {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.conn
}

// closeSweeper ends the idle sweeper. Safe to call more than once.
func (d *DatagramForwarder) closeSweeper() {
	d.sweepOnce.Do(func() { close(d.sweepStop) })
}

// waitMappings waits, bounded, for the reply goroutines to unwind. Everything
// they can block on has already been closed by the caller, so this is normally
// instant; the bound exists so a runtime bug cannot hold a shutdown hostage.
func (d *DatagramForwarder) waitMappings(timeout time.Duration) {
	if timeout <= 0 {
		return
	}
	done := make(chan struct{})
	go func() {
		d.mappingWG.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
	}
}

// ── the mapping key (§2.2) ──────────────────────────────────────────────────

// mappingKey is the §2.2 key: the listener's identity plus the NORMALISED client
// address, and nothing else. It never contains the target, because a target
// change must not rewrite existing keys — otherwise "existing mappings keep the
// old target" (§3.4) would be unrepresentable.
//
// The table is per runtime, so the listener identity is structural already; it is
// in the key anyway because §2.2.1 makes it a property of the key itself, and a
// key that only works because of the container it sits in is a trap for the next
// person who shares the table.
func (d *DatagramForwarder) mappingKey(client *net.UDPAddr) string {
	return d.cfg.ID + "|" + normalizeClientAddr(client)
}

// normalizeClientAddr renders a client address canonically, so one client is one
// mapping (§2.2.2). The v4-mapped form is the one that bites: a dual-stack
// listener hands back ::ffff:127.0.0.1 for a v4 client, and keying that
// differently from 127.0.0.1 splits one client into two mappings — replies only
// half arrive and the mapping count lies. A link-local zone is preserved: the
// same address on two interfaces is not the same client.
func normalizeClientAddr(addr *net.UDPAddr) string {
	ip := addr.IP
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	host := ip.String()
	if addr.Zone != "" {
		host += "%" + addr.Zone
	}
	return net.JoinHostPort(host, strconv.Itoa(addr.Port))
}

// usableClientAddr reports whether an address read off the ingress socket can key
// a mapping at all. Port 0 is not a source a real UDP stack produces; a forged
// one must not create a table entry whose reply nobody can receive.
func usableClientAddr(addr *net.UDPAddr) bool {
	return addr != nil && addr.IP != nil && addr.Port > 0 && addr.Port <= 65535
}
