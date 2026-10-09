// Datagram egress runtime — UDP RELAY exit side.
//
// The datagram relay contract defines the hop framing and exit semantics;
// §12. The exit half of a datagram relay:
//
//	ingress ──[16-byte hop header + payload]──> egress listener (this file) ──> target
//	ingress <──[same header, echoed back]───── egress listener <── target
//
// Three properties make this runtime different from the DIRECT one (datagram.go)
// and are the reason it is a separate type rather than a mode flag on that one:
//
//  1. **The destination never arrives on the wire.** The target is chosen from
//     this node's own pool, exactly as the stream egress does it. A hop packet
//     carries no address, so a forged source (trivial over UDP, unlike TCP)
//     cannot turn this listener into an open relay — it can only ever reach the
//     targets the panel already configured for this tunnel.
//  2. **The peer is attested.** Only the paired ingress node may feed this
//     listener; anything else is dropped and counted. TCP gets this for free from
//     the handshake; UDP does not, so it has to be explicit.
//  3. **Replies are routed by the hop header.** The mapping is the demultiplexing
//     key, because every client of one ingress arrives from the same address (the
//     ingress keeps a single socket toward us).
//
// The unit of work is still a MAPPING, not a connection: one entry per
// (generation, mapping id), one connected UDP socket to one target, expiring on
// idle in both directions. UDP has no FIN/RST, so "the client hung up" is not an
// event this runtime can observe (contract §2.3②) — the idle sweeper is the only
// ending it produces.
package forwarder

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// DatagramEgressOptions tunes one datagram exit runtime.
type DatagramEgressOptions struct {
	// IdleTimeout is the mapping idle window. <= 0 uses the package default,
	// which is the same default the DIRECT runtime uses — the contract freezes
	// one value for both so RELAY and DIRECT cannot drift apart (contract §9.2).
	IdleTimeout time.Duration
	// MaxMappings is the mapping ceiling. <= 0 uses the package default (§9.3).
	MaxMappings int
	// Observer receives per-target connect failures. Nil is a no-op; failures are
	// counted either way.
	Observer TargetObserver
}

// datagramEgressMapping is one exit-side mapping: the hop identity it answers to,
// the peer it answers, and a socket CONNECTED to one target.
//
// The socket is connected (not a shared unconnected one) for the same reason the
// ingress mapping's is: it pins the mapping to the target it was created with, so
// "a target change only affects NEW mappings" (contract §3.4) is a property of
// the socket rather than a promise this code has to remember to keep.
type datagramEgressMapping struct {
	// generation is the ingress incarnation that owns this mapping id. A packet
	// carrying a different generation TAKES OVER the id (see handlePacket): ids
	// restart when the ingress restarts, so the newer incarnation is the one that
	// must receive the replies.
	generation uint32
	// peer is the immutable source endpoint that CREATED this mapping generation.
	// The configured attestation deliberately pins only the ingress IP because a
	// runtime restart chooses a new ephemeral source port; that restart also gets a
	// new generation. Inside one generation, however, the hop socket endpoint must
	// stay stable. Pinning IP+port here prevents a same-IP/different-port sender
	// from stealing the reply path and makes replyLoop's lock-free read race-free.
	peer *net.UDPAddr
	// conn is the connected target socket for this mapping.
	conn net.Conn
	// target is the address conn is connected to, kept for diagnostics.
	target   string
	selected Target
	// feedback records only the first real outcome. DialUDP alone proves no
	// reachability, so a half-open probe succeeds only on a target reply.
	feedback atomic.Bool
	// lastActivity is the idle clock in unix nanoseconds, refreshed on traffic in
	// EITHER direction.
	lastActivity atomic.Int64
	// closed makes the mapping's teardown idempotent.
	closed atomic.Bool
}

// DatagramEgress is the exit-side datagram runtime (EGRESS mode, udp protocol).
type DatagramEgress struct {
	cfg TunnelConfig
	sel TargetSelector
	obs TargetObserver

	idleTimeout time.Duration
	maxMappings int

	// peerIPs is the attested ingress address. It is an IP (not IP:port) on
	// purpose: the ingress's SOURCE PORT is ephemeral and changes when the
	// ingress runtime restarts, so pinning it would turn a normal restart into a
	// permanent outage. The property we actually need — "only the paired node may
	// feed this exit" — is a property of the address.
	peerIPs []net.IP

	mu       sync.Mutex
	listener *net.UDPConn
	running  bool
	mappings map[uint32]*datagramEgressMapping
	stopping bool
	stopped  bool

	startedAt atomic.Int64
	stopOnce  sync.Once

	// counters (see DatagramStats for the frozen meaning of each)
	packetsIn        atomic.Int64
	bytesIn          atomic.Int64
	packetsOut       atomic.Int64
	bytesOut         atomic.Int64
	mappingsCreated  atomic.Int64
	mappingsExpired  atomic.Int64
	mappingsRejected atomic.Int64
	drops            atomic.Int64
	dropsUnknownSrc  atomic.Int64
	dropsCeiling     atomic.Int64
	dropsSendError   atomic.Int64
	dropsMalformed   atomic.Int64
	lastActivityAt   atomic.Int64
}

// NewDatagramEgress builds the exit-side datagram runtime.
//
// Everything that can make this runtime unusable is refused HERE, before any
// socket exists — the factory's rule. In particular an empty or unparseable
// HopPeer is a hard error rather than "accept anyone": a datagram exit that
// cannot tell its ingress from an arbitrary source is not a partially working
// tunnel, it is a relay to the configured targets for whoever finds the port.
func NewDatagramEgress(cfg TunnelConfig, sel TargetSelector, opts DatagramEgressOptions) (*DatagramEgress, error) {
	if cfg.Mode != ModeEgress {
		return nil, errModeNot(ModeEgress, cfg.Mode)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if sel == nil {
		return nil, errors.New("forwarder: datagram EGRESS requires a target selector")
	}
	if selectorRequiresClientIP(sel, cfg) {
		return nil, ErrClientIPRequired
	}
	peers, err := parseHopPeer(cfg.HopPeer)
	if err != nil {
		return nil, err
	}
	idle := opts.IdleTimeout
	if idle <= 0 {
		idle = defaultDatagramIdleTimeout
	}
	ceiling := opts.MaxMappings
	if ceiling <= 0 {
		ceiling = defaultDatagramMaxMappings
	}
	return &DatagramEgress{
		cfg:         cfg,
		sel:         sel,
		obs:         opts.Observer,
		idleTimeout: idle,
		maxMappings: ceiling,
		peerIPs:     peers,
		mappings:    make(map[uint32]*datagramEgressMapping),
	}, nil
}

// parseHopPeer turns the configured hop peer into the IP set this exit accepts.
//
// A host name is resolved ONCE, at construction: an exit whose attestation
// silently follows a re-resolved name would accept a different host after a DNS
// change, which is exactly the kind of implicit widening the contract forbids.
// The port is parsed but deliberately ignored (see peerIPs).
func parseHopPeer(raw string) ([]net.IP, error) {
	if raw == "" {
		return nil, errors.New("forwarder: datagram EGRESS requires hop_peer (the paired ingress address); refusing to accept an unattested source")
	}
	host, _, err := net.SplitHostPort(raw)
	if err != nil {
		// A bare IP is accepted for hand-written configs; a bare name is not,
		// because SplitHostPort failing on "host:port" is how a typo shows up.
		host = raw
	}
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	addrs, err := net.LookupIP(host)
	if err != nil {
		return nil, fmt.Errorf("forwarder: resolve hop_peer %q: %w", host, err)
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("forwarder: hop_peer %q resolved to no address", host)
	}
	return addrs, nil
}

// attested reports whether a datagram source may feed this exit.
//
// IP only, and the comparison normalises v4-mapped addresses on both sides so a
// dual-stack listener cannot be tricked into seeing the peer as a stranger.
func (e *DatagramEgress) attested(addr *net.UDPAddr) bool {
	if addr == nil {
		return false
	}
	src := addr.IP
	if v4 := src.To4(); v4 != nil {
		src = v4
	}
	for _, want := range e.peerIPs {
		if v4 := want.To4(); v4 != nil {
			want = v4
		}
		if src.Equal(want) {
			return true
		}
	}
	return false
}

// Start binds the exit port and begins forwarding.
func (e *DatagramEgress) Start() error {
	if selectorRequiresClientIP(e.sel, e.cfg) {
		return ErrClientIPRequired
	}
	e.mu.Lock()
	if e.running {
		e.mu.Unlock()
		return nil
	}
	if e.stopped || e.stopping {
		e.mu.Unlock()
		return errors.New("forwarder: datagram EGRESS has been stopped")
	}
	port := e.cfg.EgressPort
	if port <= 0 {
		e.mu.Unlock()
		return fmt.Errorf("forwarder: datagram EGRESS port %d is not usable", port)
	}
	host := e.cfg.ListenHost
	var bindIP net.IP
	if host != "" {
		bindIP = net.ParseIP(host)
		if bindIP == nil {
			addrs, err := net.LookupIP(host)
			if err != nil || len(addrs) == 0 {
				e.mu.Unlock()
				return fmt.Errorf("forwarder: datagram EGRESS cannot resolve listen_host %q", host)
			}
			bindIP = addrs[0]
		}
	}
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: bindIP, Port: port})
	if err != nil {
		e.mu.Unlock()
		return fmt.Errorf("forwarder: datagram EGRESS listen %d: %w", port, err)
	}
	e.listener = conn
	e.running = true
	e.startedAt.Store(time.Now().UnixNano())
	e.mu.Unlock()

	go e.readLoop(conn)
	go e.sweepLoop()
	return nil
}

// Stop releases the port and tears down every mapping. Safe to call twice.
func (e *DatagramEgress) Stop() error {
	e.stopOnce.Do(func() {
		e.mu.Lock()
		e.stopping = true
		conn := e.listener
		e.listener = nil
		e.running = false
		e.mu.Unlock()
		if conn != nil {
			_ = conn.Close()
		}
		e.closeAllMappings()
		e.mu.Lock()
		e.stopped = true
		e.stopping = false
		e.mu.Unlock()
	})
	return nil
}

// Running reports whether the listener is currently bound.
func (e *DatagramEgress) Running() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.running
}

// readLoop is the exit's only reader: attest, parse, route.
func (e *DatagramEgress) readLoop(conn *net.UDPConn) {
	// One byte more than the hop budget: a datagram larger than the budget is
	// then TRUNCATED and refused by the framing check instead of being silently
	// accepted at the wrong size.
	buf := make([]byte, datagramHopMTU+1)
	for {
		n, src, err := conn.ReadFromUDP(buf)
		if err != nil {
			if e.isShuttingDown() {
				return
			}
			// A UDP read error is transient by construction (the buffer exceeds
			// any datagram we accept), so backing off keeps a broken socket from
			// turning this loop into a CPU burn.
			time.Sleep(datagramReadErrorBackoff)
			continue
		}
		if !e.attested(src) {
			// Not the paired ingress: dropped and counted. This is the datagram
			// analogue of "the TCP handshake did not come from the peer".
			e.drops.Add(1)
			e.dropsUnknownSrc.Add(1)
			continue
		}
		header, payload, err := parseDatagramHop(buf[:n])
		if err != nil {
			e.drops.Add(1)
			e.dropsMalformed.Add(1)
			continue
		}
		e.handlePacket(conn, header, payload, src)
	}
}

// handlePacket routes one attested, well-formed hop packet.
func (e *DatagramEgress) handlePacket(conn *net.UDPConn, header datagramHopHeader, payload []byte, src *net.UDPAddr) {
	m := e.mappingFor(conn, header, src)
	if m == nil {
		return // dropped and counted inside mappingFor
	}
	if _, err := m.conn.Write(payload); err != nil {
		if m.feedback.CompareAndSwap(false, true) {
			e.reportTargetOutcome(m.selected, false)
		}
		e.drops.Add(1)
		e.dropsSendError.Add(1)
		return
	}
	m.lastActivity.Store(time.Now().UnixNano())
	e.packetsIn.Add(1)
	e.bytesIn.Add(int64(len(payload)))
	e.lastActivityAt.Store(time.Now().Unix())
}

// mappingFor returns the mapping for a hop identity, creating or taking one over
// as needed, or nil when the packet must be dropped.
//
// Take-over rule (contract §9.1): a packet whose generation differs from the live
// mapping's OWNS that id from now on — the previous incarnation's mapping is
// closed so its late replies cannot be forwarded with a header the ingress would
// have to reject anyway. Ids restart when the ingress restarts; refusing the
// take-over instead would leave the exit permanently deaf to the new ingress.
func (e *DatagramEgress) mappingFor(conn *net.UDPConn, header datagramHopHeader, src *net.UDPAddr) *datagramEgressMapping {
	e.mu.Lock()
	if e.stopping || e.stopped {
		e.mu.Unlock()
		e.drops.Add(1)
		e.dropsSendError.Add(1)
		return nil
	}
	existing := e.mappings[header.MappingID]
	if existing != nil && existing.generation == header.Generation {
		// A mapping generation is bound to the hop socket endpoint that created it.
		// A legitimate ingress restart changes both source port AND generation; a
		// same-generation packet from a different endpoint is therefore not a
		// migration signal — it is an unauthorised attempt to reuse live state.
		if src == nil || existing.peer == nil ||
			existing.peer.Port != src.Port ||
			existing.peer.Zone != src.Zone ||
			!existing.peer.IP.Equal(src.IP) {
			e.mu.Unlock()
			e.drops.Add(1)
			e.dropsUnknownSrc.Add(1)
			return nil
		}
		e.mu.Unlock()
		return existing
	}
	if existing != nil {
		// Same id, older generation: the newer incarnation takes over.
		delete(e.mappings, header.MappingID)
		e.mu.Unlock()
		existing.close()
		e.mu.Lock()
	}
	if len(e.mappings) >= e.maxMappings {
		e.mu.Unlock()
		// Over the ceiling: a datagram from an identity that holds no mapping is
		// DROPPED, never granted capacity by evicting a live mapping — eviction
		// would break a working client in favour of one nobody has verified.
		e.drops.Add(1)
		e.dropsCeiling.Add(1)
		e.mappingsRejected.Add(1)
		return nil
	}
	if selectorRequiresClientIP(e.sel, e.cfg) {
		e.mu.Unlock()
		e.drops.Add(1)
		e.mappingsRejected.Add(1)
		return nil
	}
	// The legacy hop header has no original client IP. src is the attested
	// ingress endpoint, not a client identity; mapping IDs are not IPs either.
	// Client-aware selectors therefore receive an unknown source. Selection is
	// performed only here, when creating a mapping, so live mappings stay pinned.
	target := selectTargetForClient(e.sel, "")
	if target.Host == "" || target.Port <= 0 {
		e.mu.Unlock()
		e.drops.Add(1)
		e.dropsCeiling.Add(1)
		e.mappingsRejected.Add(1)
		return nil
	}
	addr := net.JoinHostPort(target.Host, strconv.Itoa(target.Port))
	raddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		e.mu.Unlock()
		e.reportTargetOutcome(target, false)
		e.reportTargetFailure(TargetStats{Host: target.Host, Port: target.Port, LastErr: err.Error()})
		e.drops.Add(1)
		e.dropsSendError.Add(1)
		return nil
	}
	// A connected socket pins this mapping to this target (§3.4).
	c, err := net.DialUDP("udp", nil, raddr)
	if err != nil {
		e.mu.Unlock()
		e.reportTargetOutcome(target, false)
		e.reportTargetFailure(TargetStats{Host: target.Host, Port: target.Port, LastErr: err.Error()})
		e.drops.Add(1)
		e.dropsSendError.Add(1)
		return nil
	}
	// Copy the source address: the mapping owns this immutable endpoint for the
	// lifetime of the generation, independent of any address object returned by
	// later ReadFromUDP calls.
	peer := &net.UDPAddr{IP: append(net.IP(nil), src.IP...), Port: src.Port, Zone: src.Zone}
	m := &datagramEgressMapping{
		generation: header.Generation,
		peer:       peer,
		conn:       c,
		target:     addr,
		selected:   target,
	}
	m.lastActivity.Store(time.Now().UnixNano())
	e.mappings[header.MappingID] = m
	e.mappingsCreated.Add(1)
	e.mu.Unlock()

	go e.replyLoop(conn, header.MappingID, m)
	return m
}

// replyLoop returns target traffic to the ingress, re-framing it with the hop
// header the mapping answers to.
func (e *DatagramEgress) replyLoop(listener *net.UDPConn, mappingID uint32, m *datagramEgressMapping) {
	// Read a complete UDP payload before applying the hop budget. On Windows,
	// a datagram larger than the read buffer returns WSAEMSGSIZE rather than a
	// successful truncated read, which would bypass the framing check and end
	// this mapping's reply loop without counting the oversized packet.
	buf := make([]byte, datagramMaxPayload)
	wire := make([]byte, 0, datagramHopMTU)
	for {
		n, err := m.conn.Read(buf)
		if err != nil {
			if !m.closed.Load() && !e.isShuttingDown() && m.feedback.CompareAndSwap(false, true) {
				e.reportTargetOutcome(m.selected, false)
			}
			return // the mapping was closed (expiry, take-over or shutdown)
		}
		if m.feedback.CompareAndSwap(false, true) {
			e.reportTargetOutcome(m.selected, true)
		}
		wire, err = appendDatagramHop(wire[:0], datagramHopHeader{
			MappingID:  mappingID,
			Generation: m.generation,
		}, buf[:n])
		if err != nil {
			// A reply larger than the hop budget cannot be carried: dropped and
			// counted rather than truncated (contract §9.1 — the ceiling is a
			// named user-visible boundary, and silent truncation is worse).
			e.drops.Add(1)
			e.dropsMalformed.Add(1)
			continue
		}
		peer := m.peer
		if peer == nil {
			return
		}
		if _, err := listener.WriteToUDP(wire, peer); err != nil {
			e.drops.Add(1)
			e.dropsSendError.Add(1)
			continue
		}
		m.lastActivity.Store(time.Now().UnixNano())
		e.packetsOut.Add(1)
		e.bytesOut.Add(int64(n))
		e.lastActivityAt.Store(time.Now().Unix())
	}
}

// sweepLoop expires idle mappings. A mapping survives only while it has traffic
// in either direction; a socket write that never completes must not keep the
// mapping (and its 64 KiB read buffer) forever.
func (e *DatagramEgress) sweepLoop() {
	tick := e.idleTimeout / 4
	if tick < datagramSweepMin {
		tick = datagramSweepMin
	}
	if tick > datagramSweepMax {
		tick = datagramSweepMax
	}
	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	for range ticker.C {
		if e.isShuttingDown() {
			return
		}
		e.sweep(time.Now())
	}
}

func (e *DatagramEgress) sweep(now time.Time) {
	e.mu.Lock()
	var expired []*datagramEgressMapping
	for id, m := range e.mappings {
		last := m.lastActivity.Load()
		if last <= 0 {
			continue
		}
		if now.Sub(time.Unix(0, last)) >= e.idleTimeout {
			delete(e.mappings, id)
			expired = append(expired, m)
		}
	}
	e.mu.Unlock()
	for _, m := range expired {
		m.close()
		e.mappingsExpired.Add(1)
	}
}

func (e *DatagramEgress) closeAllMappings() {
	e.mu.Lock()
	live := make([]*datagramEgressMapping, 0, len(e.mappings))
	for id, m := range e.mappings {
		delete(e.mappings, id)
		live = append(live, m)
	}
	e.mu.Unlock()
	for _, m := range live {
		m.close()
	}
}

func (e *DatagramEgress) isShuttingDown() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.stopping || e.stopped || e.listener == nil
}

func (e *DatagramEgress) reportTargetFailure(stats TargetStats) {
	if stats.LastErrAt == 0 {
		stats.LastErrAt = time.Now().Unix()
	}
	stats.DialFailed = 1
	if e.obs != nil {
		e.obs(stats)
	}
}

func (e *DatagramEgress) reportTargetOutcome(target Target, ok bool) {
	if reporter, reports := e.sel.(TargetReporter); reports {
		reporter.ReportDial(target, ok)
	}
}

// Stats reports the frozen datagram facts (§6.1).
func (e *DatagramEgress) Stats() DatagramStats {
	e.mu.Lock()
	mappings := int64(len(e.mappings))
	e.mu.Unlock()
	return DatagramStats{
		Mappings:           mappings,
		MappingsCreated:    e.mappingsCreated.Load(),
		MappingsExpired:    e.mappingsExpired.Load(),
		MappingsRejected:   e.mappingsRejected.Load(),
		PacketsIn:          e.packetsIn.Load(),
		BytesIn:            e.bytesIn.Load(),
		PacketsOut:         e.packetsOut.Load(),
		BytesOut:           e.bytesOut.Load(),
		Drops:              e.drops.Load(),
		DropsUnknownSource: e.dropsUnknownSrc.Load(),
		DropsCeiling:       e.dropsCeiling.Load(),
		DropsSendError:     e.dropsSendError.Load(),
		DropsMalformed:     e.dropsMalformed.Load(),
		LastActivityAt:     e.lastActivityAt.Load(),
	}
}

// Retarget replaces the target NEW mappings use (§3.4). Live mappings keep the
// socket they were created with, so a target change never rewrites in-flight
// traffic and never rebinds the listener.
func (e *DatagramEgress) Retarget(target string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.running || e.stopping || e.stopped {
		return errors.New("forwarder: datagram EGRESS cannot retarget without a live listener")
	}
	if e.sel == nil {
		return errors.New("forwarder: datagram EGRESS has no target selector")
	}
	if fixed, ok := e.sel.(interface{ Retarget(string) error }); ok {
		return fixed.Retarget(target)
	}
	return nil
}

// DrainMappings stops admitting new mappings and waits, bounded, for the live
// ones to end. The socket stays open so existing mappings keep receiving replies
// (§4.3).
func (e *DatagramEgress) DrainMappings(timeout time.Duration) error {
	e.mu.Lock()
	e.stopping = true
	e.mu.Unlock()

	deadline := time.Now().Add(timeout)
	for {
		e.mu.Lock()
		live := len(e.mappings)
		e.mu.Unlock()
		if live == 0 {
			return nil
		}
		if timeout > 0 && time.Now().After(deadline) {
			return fmt.Errorf("forwarder: datagram EGRESS drain timed out with %d live mappings", live)
		}
		time.Sleep(datagramSweepMin)
	}
}

// CloseListener is the two-phase shutdown's phase 1: stop admitting new mappings
// WITHOUT closing the socket, because every live mapping's return path goes
// through it (§4.4.3).
func (e *DatagramEgress) CloseListener() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.running {
		return false
	}
	e.stopping = true
	return true
}

// LiveMappings reports how much work is in flight. A caller must ask this
// instead of LiveConns — a datagram runtime has no connections to count (§4.4).
func (e *DatagramEgress) LiveMappings() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.mappings)
}

// close tears one mapping down exactly once.
func (m *datagramEgressMapping) close() {
	if m.closed.CompareAndSwap(false, true) {
		_ = m.conn.Close()
	}
}

// compiled guards: the exit must satisfy both contracts. The DatagramRuntime half is
// what it is built as; the Diagnostician half is what makes its facts REACHABLE —
// without it the manager reports nothing for this tunnel, so an exit that is
// dropping every hop packet looks exactly like an idle one (which is how the
// multi-homed attestation bug hid during the first real G1B run: the control plane
// was green, both legs were "running", and no counter said otherwise).
var (
	_ DatagramRuntime = (*DatagramEgress)(nil)
	_ Diagnostician   = (*DatagramEgress)(nil)
)

// ProtocolDiagnostics reports this tunnel's frozen datagram facts (§6.1).
func (e *DatagramEgress) ProtocolDiagnostics() (ProtocolDiagnostics, bool) {
	return ProtocolDiagnostics{
		Protocol:           string(ProtocolUDP),
		Mappings:           int64(e.LiveMappings()),
		MappingsExpired:    e.mappingsExpired.Load(),
		PacketsIn:          e.packetsIn.Load(),
		PacketsOut:         e.packetsOut.Load(),
		BytesIn:            e.bytesIn.Load(),
		BytesOut:           e.bytesOut.Load(),
		Drops:              e.drops.Load(),
		IdleTimeoutSeconds: int64(e.idleTimeout / time.Second),
	}, true
}
