// Datagram relay ingress runtime — UDP RELAY ingress side.
//
// The datagram relay contract defines the hop framing and ingress semantics;
// §12. This is the half that carries CLIENT mappings across the hop:
//
//	client ══UDP══> ingress listener (this file) ──[hop header + payload]──> egress
//	client <══UDP══  ingress listener <──[hop header, echoed back]────────── egress
//
// Two structural differences from the DIRECT runtime (datagram.go), and both are
// consequences of one fact — the hop is a hop:
//
//  1. **Every mapping shares ONE socket toward the egress.** A DIRECT mapping owns
//     a socket connected to its target; here a per-mapping socket would be a
//     per-client socket on the wire, which the contract rejected (the hop is one
//     link, not N). That is exactly why the hop header must carry a mapping id:
//     with one socket there is nothing else to demultiplex replies by.
//  2. **The destination is not a local decision.** The ingress never resolves a
//     target and never dials one; it hands datagrams to the exit, which picks from
//     its own pool. So there is no per-mapping "target" here to retarget — a
//     change of the hop address is a change of the whole link (see Retarget).
//
// The generation check on the return path is the safety property that makes
// mapping-id reuse harmless: ids restart when this runtime restarts, so a reply
// belonging to a previous incarnation must be dropped rather than delivered to
// whichever client happened to get the same numeric id.
package forwarder

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// DatagramRelayOptions tunes one relay ingress runtime.
type DatagramRelayOptions struct {
	// IdleTimeout is the mapping idle window; same default as DIRECT (§9.2).
	IdleTimeout time.Duration
	// MaxMappings is the mapping ceiling (§9.3).
	MaxMappings int
}

// datagramRelayMapping is one client mapping on the ingress side.
//
// It holds no socket: the datagram to the exit goes out over the shared hop
// socket, addressed by this mapping's id. What a mapping IS here is therefore
// just "one client address, one id, and when we last heard from either side".
type datagramRelayMapping struct {
	// id is this mapping's hop id, allocated from the runtime's identity. It is
	// never reused inside one runtime's lifetime (contract §9.1).
	id uint32
	// client is the address replies go back to.
	client *net.UDPAddr
	// lastActivity is the idle clock in unix nanoseconds, refreshed on traffic in
	// EITHER direction.
	lastActivity atomic.Int64
	pending      atomic.Int32
	ctx          context.Context
	cancel       context.CancelFunc
	release      func()
}

// DatagramRelay is the ingress-side datagram runtime (RELAY mode, udp protocol).
type DatagramRelay struct {
	cfg          TunnelConfig
	identity     *datagramHopIdentity
	policy       *DataPlanePolicy
	policyCtx    context.Context
	policyCancel context.CancelFunc
	loopWG       sync.WaitGroup

	idleTimeout time.Duration
	maxMappings int

	// hopAddr is the resolved address of the paired egress.
	hopAddr *net.UDPAddr
	// hopLocalAddr is THIS node's endpoint on the hop (`ip:port`), recorded once the
	// hop socket exists. It is published through ProtocolDiagnostics so the panel can
	// hand it to the exit: the exit has to attest this ingress by address, and the
	// address the kernel actually uses is the only one that is true — see the field's
	// comment in diagnostics.go for the two measurements that settled it.
	hopLocalAddr string

	mu       sync.Mutex
	listener *net.UDPConn
	hop      *net.UDPConn
	running  bool
	stopping bool
	stopped  bool
	// byClient keys mappings by normalised client address (§2.2.2): one client,
	// one mapping.
	byClient map[string]*datagramRelayMapping
	// byID is the return-path index: the hop header carries an id, not an address.
	byID map[uint32]*datagramRelayMapping

	stopOnce sync.Once

	packetsIn          atomic.Int64
	bytesIn            atomic.Int64
	packetsOut         atomic.Int64
	bytesOut           atomic.Int64
	mappingsCreated    atomic.Int64
	mappingsExpired    atomic.Int64
	mappingsRejected   atomic.Int64
	drops              atomic.Int64
	dropsUnknownSource atomic.Int64
	dropsCeiling       atomic.Int64
	dropsSendError     atomic.Int64
	dropsMalformed     atomic.Int64
	lastActivityAt     atomic.Int64
}

// NewDatagramRelay builds the relay ingress runtime.
//
// The hop identity is seeded here, once per runtime: its generation is what every
// packet this runtime sends carries, and what every reply must match. Seeding at
// construction (not at Start) keeps "a runtime has one identity for its whole
// life" true even across a Stop/Start pair.
func NewDatagramRelay(cfg TunnelConfig, opts DatagramRelayOptions) (*DatagramRelay, error) {
	if cfg.Mode != ModeRelay {
		return nil, errModeNot(ModeRelay, cfg.Mode)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	hop, err := resolveHopAddress(cfg.NextHop)
	if err != nil {
		return nil, err
	}
	identity, err := newDatagramHopIdentity()
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
	policy, err := NewDataPlanePolicy(cfg)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &DatagramRelay{
		cfg:          cfg,
		identity:     identity,
		idleTimeout:  idle,
		maxMappings:  ceiling,
		hopAddr:      hop,
		byClient:     make(map[string]*datagramRelayMapping),
		byID:         make(map[uint32]*datagramRelayMapping),
		policy:       policy,
		policyCtx:    ctx,
		policyCancel: cancel,
	}, nil
}

// resolveHopAddress normalises the configured next hop (egress node IP : port).
//
// A relay ingress without a reachable hop has nowhere to send anything, so this
// is a construction failure rather than a first-packet surprise.
func resolveHopAddress(nextHop string) (*net.UDPAddr, error) {
	raw := strings.TrimSpace(nextHop)
	if raw == "" {
		return nil, errors.New("forwarder: udp RELAY requires next_hop (the egress node address)")
	}
	if _, _, err := net.SplitHostPort(raw); err != nil {
		return nil, fmt.Errorf("forwarder: udp RELAY next_hop %q must be host:port: %w", raw, err)
	}
	addr, err := net.ResolveUDPAddr("udp", raw)
	if err != nil {
		return nil, fmt.Errorf("forwarder: udp RELAY cannot resolve next_hop %q: %w", raw, err)
	}
	if addr.Port <= 0 {
		return nil, fmt.Errorf("forwarder: udp RELAY next_hop %q has no usable port", raw)
	}
	return addr, nil
}

// Start binds the ingress port and opens the single socket toward the egress.
func (r *DatagramRelay) Start() error {
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		return nil
	}
	if r.stopped || r.stopping {
		r.mu.Unlock()
		return errors.New("forwarder: datagram RELAY has been stopped")
	}
	port := r.cfg.IngressPort
	if !validPort(port) {
		r.mu.Unlock()
		return fmt.Errorf("forwarder: datagram RELAY needs a valid ingress_port (got %d)", port)
	}
	var bindIP net.IP
	if host := strings.TrimSpace(r.cfg.ListenHost); host != "" {
		bindIP = net.ParseIP(host)
		if bindIP == nil {
			addrs, err := net.LookupIP(host)
			if err != nil || len(addrs) == 0 {
				r.mu.Unlock()
				return fmt.Errorf("forwarder: datagram RELAY cannot resolve listen_host %q", host)
			}
			bindIP = addrs[0]
		}
	}
	listener, err := net.ListenUDP("udp", &net.UDPAddr{IP: bindIP, Port: port})
	if err != nil {
		r.mu.Unlock()
		return fmt.Errorf("forwarder: datagram RELAY listen %d: %w", port, err)
	}
	// A CONNECTED hop socket: the kernel then refuses datagrams from anyone but
	// the exit, which is the ingress-side half of the attestation the exit does
	// for its own peers.
	hop, err := net.DialUDP("udp", nil, r.hopAddr)
	if err != nil {
		_ = listener.Close()
		r.mu.Unlock()
		return fmt.Errorf("forwarder: datagram RELAY dial next_hop %s: %w", r.hopAddr, err)
	}
	r.listener = listener
	r.hop = hop
	// Record the endpoint the kernel actually chose for the hop. This is the fact the
	// panel needs to tell the exit who may feed it; on a multi-homed node it is NOT the
	// node's configured `connect_ip`, which is exactly how the first real run failed.
	if local := hop.LocalAddr(); local != nil {
		r.hopLocalAddr = local.String()
	}
	r.running = true
	r.loopWG.Add(3)
	r.mu.Unlock()

	go func() { defer r.loopWG.Done(); r.clientLoop(listener) }()
	go func() { defer r.loopWG.Done(); r.hopLoop(hop) }()
	go func() { defer r.loopWG.Done(); r.sweepLoop() }()
	return nil
}

// Stop releases both sockets and drops every mapping.
func (r *DatagramRelay) Stop() error {
	r.stopOnce.Do(func() {
		r.mu.Lock()
		r.stopping = true
		listener, hop := r.listener, r.hop
		r.listener, r.hop = nil, nil
		r.running = false
		for _, m := range r.byID {
			m.cancel()
			m.release()
		}
		r.byClient = make(map[string]*datagramRelayMapping)
		r.byID = make(map[uint32]*datagramRelayMapping)
		r.mu.Unlock()
		r.policyCancel()
		if listener != nil {
			_ = listener.Close()
		}
		if hop != nil {
			_ = hop.Close()
		}
		r.mu.Lock()
		r.stopped = true
		r.stopping = false
		r.mu.Unlock()
		done := make(chan struct{})
		go func() { r.loopWG.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(drainTimeout):
		}
	})
	return nil
}

// Running reports whether the ingress listener is currently bound.
func (r *DatagramRelay) Running() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.running
}

// clientLoop is the client-facing half: key the mapping, frame, send to the exit.
func (r *DatagramRelay) clientLoop(listener *net.UDPConn) {
	// Read at the full UDP datagram size, not at the hop budget: truncating here
	// would hide the fact that a client sent more than the hop can carry, and the
	// contract's ceiling is supposed to be COUNTED, not quietly applied.
	buf := make([]byte, datagramMaxPayload)
	for {
		n, client, err := listener.ReadFromUDP(buf)
		if err != nil {
			if r.isShuttingDown() {
				return
			}
			time.Sleep(datagramReadErrorBackoff)
			continue
		}
		if !usableClientAddr(client) {
			r.drop(&r.dropsMalformed)
			continue
		}
		if n > datagramHopMaxPayload {
			// The hop cannot carry this datagram (§9.1): dropped and counted, so
			// "why did my big response vanish" has an answer in the facts.
			r.drop(&r.dropsCeiling)
			continue
		}
		m := r.mappingFor(client)
		if m == nil {
			continue // dropped and counted inside
		}
		m.pending.Add(1)
		if err := r.policy.WaitIn(m.ctx, n); err != nil {
			m.pending.Add(-1)
			continue
		}
		r.forwardToHop(m, buf[:n])
		m.pending.Add(-1)
	}
}

// mappingFor returns the mapping for a client, creating one if the ceiling allows.
func (r *DatagramRelay) mappingFor(client *net.UDPAddr) *datagramRelayMapping {
	key := normalizeClientAddr(client)

	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped || r.hop == nil {
		r.drop(&r.dropsSendError)
		return nil
	}
	if m := r.byClient[key]; m != nil {
		return m
	}
	if r.stopping {
		r.drop(&r.dropsUnknownSource)
		return nil
	}
	if len(r.byClient) >= r.maxMappings {
		// Over the ceiling: dropped, never granted capacity by evicting a live
		// mapping — eviction would break a working client for an unverified one.
		r.drop(&r.dropsCeiling)
		r.mappingsRejected.Add(1)
		return nil
	}
	release, err := r.policy.Acquire(client)
	if err != nil {
		r.drop(&r.dropsCeiling)
		r.mappingsRejected.Add(1)
		return nil
	}
	id, ok := r.identity.nextMappingID()
	if !ok {
		release()
		// The id space is exhausted. Refusing is bounded and countable; wrapping
		// would silently break "an id is never reused" and with it the return path.
		r.drop(&r.dropsCeiling)
		r.mappingsRejected.Add(1)
		return nil
	}
	ctx, cancel := context.WithCancel(r.policyCtx)
	m := &datagramRelayMapping{id: id, client: client, ctx: ctx, cancel: cancel, release: release}
	m.lastActivity.Store(time.Now().UnixNano())
	r.byClient[key] = m
	r.byID[id] = m
	r.mappingsCreated.Add(1)
	return m
}

// forwardToHop frames one client datagram and writes it to the exit.
func (r *DatagramRelay) forwardToHop(m *datagramRelayMapping, payload []byte) {
	wire, err := appendDatagramHop(nil, datagramHopHeader{
		MappingID:  m.id,
		Generation: r.identity.generation,
	}, payload)
	if err != nil {
		r.drop(&r.dropsMalformed)
		return
	}
	r.mu.Lock()
	hop := r.hop
	r.mu.Unlock()
	if hop == nil {
		r.drop(&r.dropsSendError)
		return
	}
	if _, err := hop.Write(wire); err != nil {
		r.drop(&r.dropsSendError)
		r.removeMapping(m)
		return
	}
	m.lastActivity.Store(time.Now().UnixNano())
	r.packetsIn.Add(1)
	r.bytesIn.Add(int64(len(payload)))
	r.lastActivityAt.Store(time.Now().Unix())
}

// hopLoop is the return path: parse, verify the generation, route to the client.
func (r *DatagramRelay) hopLoop(hop *net.UDPConn) {
	// One byte over the budget so an oversized reply is truncated and REFUSED by
	// the framing check instead of being delivered as a shorter answer.
	buf := make([]byte, datagramHopMTU+1)
	for {
		n, _, err := hop.ReadFromUDP(buf)
		if err != nil {
			if r.isShuttingDown() {
				return
			}
			time.Sleep(datagramReadErrorBackoff)
			continue
		}
		header, payload, err := parseDatagramHop(buf[:n])
		if err != nil {
			r.drop(&r.dropsMalformed)
			continue
		}
		if header.Generation != r.identity.generation {
			// A reply from a previous incarnation of this runtime. Ids restart, so
			// delivering it could hand one client another client's data — this is
			// the check that makes id reuse safe (§9.1).
			r.drop(&r.dropsUnknownSource)
			continue
		}
		r.mu.Lock()
		m := r.byID[header.MappingID]
		listener := r.listener
		r.mu.Unlock()
		if m == nil || listener == nil {
			// A late reply for a mapping that already expired: nothing to deliver
			// to, so it is dropped rather than guessed at.
			r.drop(&r.dropsUnknownSource)
			continue
		}
		m.pending.Add(1)
		if err := r.policy.WaitOut(m.ctx, len(payload)); err != nil {
			m.pending.Add(-1)
			continue
		}
		if _, err := listener.WriteToUDP(payload, m.client); err != nil {
			m.pending.Add(-1)
			r.drop(&r.dropsSendError)
			r.removeMapping(m)
			continue
		}
		m.lastActivity.Store(time.Now().UnixNano())
		m.pending.Add(-1)
		r.packetsOut.Add(1)
		r.bytesOut.Add(int64(len(payload)))
		r.lastActivityAt.Store(time.Now().Unix())
	}
}

func (r *DatagramRelay) sweepLoop() {
	tick := r.idleTimeout / 4
	if tick < datagramSweepMin {
		tick = datagramSweepMin
	}
	if tick > datagramSweepMax {
		tick = datagramSweepMax
	}
	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	for {
		select {
		case <-r.policyCtx.Done():
			return
		case <-ticker.C:
			r.sweep(time.Now())
		}
	}
}

func (r *DatagramRelay) sweep(now time.Time) {
	r.mu.Lock()
	var expired []*datagramRelayMapping
	for id, m := range r.byID {
		last := m.lastActivity.Load()
		if last <= 0 {
			continue
		}
		if m.pending.Load() == 0 && now.Sub(time.Unix(0, last)) >= r.idleTimeout {
			delete(r.byID, id)
			delete(r.byClient, normalizeClientAddr(m.client))
			m.cancel()
			m.release()
			expired = append(expired, m)
		}
	}
	r.mu.Unlock()
	r.mappingsExpired.Add(int64(len(expired)))
}

func (r *DatagramRelay) isShuttingDown() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.stopped || r.listener == nil
}

func (r *DatagramRelay) removeMapping(m *datagramRelayMapping) {
	r.mu.Lock()
	if r.byID[m.id] == m {
		delete(r.byID, m.id)
		delete(r.byClient, normalizeClientAddr(m.client))
	}
	r.mu.Unlock()
	m.cancel()
	m.release()
}

// drop counts one drop under a reason-specific counter as well as the total.
func (r *DatagramRelay) drop(reason *atomic.Int64) {
	r.drops.Add(1)
	reason.Add(1)
}

// Stats reports the frozen datagram facts (§6.1). There is deliberately no
// connection count: a relay counts mappings.
func (r *DatagramRelay) Stats() DatagramStats {
	r.mu.Lock()
	mappings := int64(len(r.byID))
	r.mu.Unlock()
	return DatagramStats{
		Mappings:           mappings,
		MappingsCreated:    r.mappingsCreated.Load(),
		MappingsExpired:    r.mappingsExpired.Load(),
		MappingsRejected:   r.mappingsRejected.Load(),
		PacketsIn:          r.packetsIn.Load(),
		BytesIn:            r.bytesIn.Load(),
		PacketsOut:         r.packetsOut.Load(),
		BytesOut:           r.bytesOut.Load(),
		Drops:              r.drops.Load(),
		DropsUnknownSource: r.dropsUnknownSource.Load(),
		DropsCeiling:       r.dropsCeiling.Load(),
		DropsSendError:     r.dropsSendError.Load(),
		DropsMalformed:     r.dropsMalformed.Load(),
		LastActivityAt:     r.lastActivityAt.Load(),
	}
}

// Retarget answers what a change of the HOP address means for this runtime.
//
// A no-op (the panel sent the same next_hop again) succeeds. A real change is
// answered with ErrUpstreamNotSwappable, which the manager treats as "this needs
// a rebuild" — and rebuilding is the honest answer here: every mapping shares the
// one socket toward the exit, so "live mappings keep the old hop, new ones use the
// new one" is not a promise a single shared socket can keep. Pretending otherwise
// would either silently move in-flight client traffic to a different exit or
// silently keep sending to the old one.
func (r *DatagramRelay) Retarget(target string) error {
	next, err := resolveHopAddress(target)
	if err != nil {
		return err
	}
	r.mu.Lock()
	current := r.hopAddr
	running := r.running && !r.stopping && !r.stopped
	r.mu.Unlock()
	if !running {
		return errors.New("forwarder: datagram RELAY cannot retarget without a live listener")
	}
	if current != nil && next.IP.Equal(current.IP) && next.Port == current.Port {
		return nil
	}
	return ErrUpstreamNotSwappable
}

// DrainMappings stops admitting new mappings and waits, bounded, for the live ones
// to end. Both sockets stay open so existing mappings keep their replies (§4.3).
func (r *DatagramRelay) DrainMappings(timeout time.Duration) error {
	r.mu.Lock()
	r.stopping = true
	r.mu.Unlock()
	if timeout <= 0 {
		return nil
	}
	if timeout > drainCeiling {
		timeout = drainCeiling
	}

	deadline := time.Now().Add(timeout)
	for {
		r.mu.Lock()
		live := len(r.byID)
		r.mu.Unlock()
		if live == 0 {
			return nil
		}
		if timeout > 0 && time.Now().After(deadline) {
			return fmt.Errorf("forwarder: datagram RELAY drain timed out with %d live mappings", live)
		}
		time.Sleep(datagramSweepMin)
	}
}

// CloseListener is the two-phase shutdown's phase 1 (§4.4.3): stop admitting new
// mappings without closing either socket, because the return path of every live
// mapping goes through them.
func (r *DatagramRelay) CloseListener() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.running {
		return false
	}
	r.stopping = true
	return true
}

// LiveMappings reports how much work is in flight (never a "connection count").
func (r *DatagramRelay) LiveMappings() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.byID)
}

// compiled guard: the relay must satisfy the datagram runtime contract.
var _ DatagramRuntime = (*DatagramRelay)(nil)

// compiled diagnostics guard: the manager collects per-tunnel facts by asking for
// this interface, so a runtime that does not implement it reports NOTHING — the
// tunnel looks healthy and invisible at the same time. The DIRECT runtime has had
// this assertion since B1; the relay half gets it with its facts.
var _ Diagnostician = (*DatagramRelay)(nil)

// ProtocolDiagnostics reports this tunnel's frozen datagram facts (§6.1).
//
// The names are a wire contract (the panel stores the object
// as-is), so they are not free to be renamed — and there is deliberately no
// connection count: a datagram front counts mappings.
func (r *DatagramRelay) ProtocolDiagnostics() (ProtocolDiagnostics, bool) {
	r.mu.Lock()
	hopLocal := r.hopLocalAddr
	r.mu.Unlock()
	return ProtocolDiagnostics{
		Protocol:           string(ProtocolUDP),
		Mappings:           int64(r.LiveMappings()),
		MappingsExpired:    r.mappingsExpired.Load(),
		PacketsIn:          r.packetsIn.Load(),
		PacketsOut:         r.packetsOut.Load(),
		BytesIn:            r.bytesIn.Load(),
		BytesOut:           r.bytesOut.Load(),
		Drops:              r.drops.Load(),
		IdleTimeoutSeconds: int64(r.idleTimeout / time.Second),
		HopLocalAddr:       hopLocal,
	}, true
}
