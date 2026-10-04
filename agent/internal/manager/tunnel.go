// Package manager owns the v3 tunnel lifecycle: what runs, on which ports, at
// which revision.
//
// TunnelManager is the map[id]Forwarder registry plus the revision rules
// ("newer revision atomic apply, equal revision idempotent, older revision
// stale-reject"). EgressManager owns the target pools and hands out the
// (swappable) load balancers the egress forwarders use. LoadBalancer itself
// lives here too (devmap §7.2 "manager/lb.go").
//
// Ports: the v3 design notes that a BOTH node runs ingress and egress tunnels in
// one process and the two pools can overlap numerically, so a single shared
// usedPorts guard owns every port this manager binds (skill note: agent-side
// TunnelManager and EgressManager must share one usedPorts map). This guard is
// the only port ownership in the process since WP15 removed the old engine's
// private usedPorts map.
package manager

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/logx"
)

// Revision rules (WP6 §hard rules, enforced by the manager so the command layer
// stays transport-specific):
//
//	cfg.Revision >  current -> apply
//	cfg.Revision == current -> idempotent no-op (return the running forwarder)
//	cfg.Revision <  current -> ErrStaleRevision
//
// A Revision of 0 means "source does not track revisions" and always applies.
const (
	revisionUnknown = int64(0)
)

// ErrStaleRevision is returned when a command carries a revision older than
// the applied one. The command must be rejected by the caller, not applied.
var ErrStaleRevision = fmt.Errorf("manager: stale revision")

// ErrTunnelNotFound is returned by Remove/Get for an unknown tunnel id.
var ErrTunnelNotFound = fmt.Errorf("manager: tunnel not found")

// entry is one running tunnel: the config it was built from plus its runtime.
//
// The runtime is forwarder.Runtime (start/stop/running), NOT forwarder.Forwarder:
// since V5.1b there is more than one transport contract behind a tunnel, and a
// datagram runtime must not be forced to implement stream-only methods
// (SetUpstream/Drain) to sit in this registry — forwarder.StreamRuntime's own
// doc comment and the datagram contract §4.1 both forbid that. Everything
// transport-specific is an interface assertion at the call site.
type entry struct {
	cfg forwarder.TunnelConfig
	fwd forwarder.Runtime
}

// TunnelManager is the concurrency-safe registry of running tunnels.
type TunnelManager struct {
	mu       sync.RWMutex
	tunnels  map[string]*entry
	usedPort map[string]bool // "<socket namespace>:<port>" guard shared with EgressManager

	egress *EgressManager
	// listenHost is the interface ingress/egress tunnels bind when the config
	// does not pin one. Empty means all interfaces.
	listenHost string

	// targetDial is the dialer EGRESS pools dial their targets with (V5.3-WP8).
	// nil keeps Go's own dialer, i.e. the pre-WP8 behaviour, which is also what
	// every existing test and a build without the resolver wired gets.
	targetDial forwarder.DialFunc

	// closing is the WP11A shutdown latch: once set, Apply refuses new work so a
	// config arriving mid-teardown cannot rebind a port that was just closed.
	closing bool
	// shutdownMu guards the running shutdown tallies (written from one
	// goroutine per tunnel).
	shutdownMu      sync.Mutex
	lastShutdown    ShutdownReport
	lastShutdownIDs []string

	// mutationHook is notified — outside every lock — after a mutation actually
	// changed the running registry. It exists so the durable last-known-good
	// cache (WP11A/A3) is refreshed by an event rather than only by a periodic
	// sample: "ACK durable success but cache the previous state" is exactly the
	// window this closes. One hook here covers the control loop, the local admin
	// API and startup restore, which is why it lives in the manager rather than
	// in each caller.
	mutationHook func()

	// ownership is the V5.3 WP9 activation gate (ownership.Guard): the epoch
	// fence plus the lease clock. It runs on BOTH activation entries, before any
	// lock or listener, so every path that can start serving a tunnel — the
	// control dispatch, the reconnect snapshot, startup restore and the local
	// admin plane — is fenced by one implementation instead of four. nil means
	// "this node does not fence" (an older build, or a test).
	ownership OwnershipGuard
}

// OwnershipGuard is the V5.3 WP9 gate an activation must pass before anything is
// bound. It is an interface (not ownership.Guard) so the manager keeps knowing
// nothing about epochs and leases: it asks one question and reports the answer.
//
// The returned error is expected to be a typed refusal (ownership.Refusal) whose
// code the control path carries back to the panel; the manager only propagates
// it.
type OwnershipGuard interface {
	Admit(cfg forwarder.TunnelConfig) error
}

// SetOwnershipGuard installs the activation gate. It is safe to call at any time
// and passing nil removes the gate. It is a setter rather than a constructor
// argument because the guard is built after the managers (it needs their
// registry) and because every existing caller of NewTunnelManager keeps working
// unfenced.
func (m *TunnelManager) SetOwnershipGuard(g OwnershipGuard) {
	m.mu.Lock()
	m.ownership = g
	m.mu.Unlock()
}

// AdmitActivation runs the V5.3 WP9 activation gate WITHOUT applying anything.
//
// The manager already gates its own apply entries (so no caller can bypass it);
// this exported form exists for a caller that mutates something else first. The
// control path stages an EGRESS target pool before it can build the forwarder,
// and staging it for an activation that is about to be refused would briefly
// rewrite a RUNNING pool's targets — a mutation of a fenced tunnel, which is
// exactly what "the refusal happens before any mutation" forbids. Calling this
// first makes the refusal free of side effects; the gate inside Apply then
// re-checks under the same monotone rules.
func (m *TunnelManager) AdmitActivation(cfg forwarder.TunnelConfig) error {
	return m.admitOwnership(cfg)
}

// admitOwnership runs the activation gate outside the manager's lock: the guard
// may write a durable file, and holding m.mu across an fsync would stall every
// other tunnel operation behind one activation.
func (m *TunnelManager) admitOwnership(cfg forwarder.TunnelConfig) error {
	m.mu.RLock()
	guard := m.ownership
	m.mu.RUnlock()
	if guard == nil {
		return nil
	}
	return guard.Admit(cfg)
}

// SetMutationHook installs the post-mutation observer. It is safe to call at any
// time; passing nil removes it.
func (m *TunnelManager) SetMutationHook(fn func()) {
	m.mu.Lock()
	m.mutationHook = fn
	m.mu.Unlock()
}

// fingerprint summarises the running registry (id, revision, bound port). It is
// compared before/after a mutation so an idempotent apply — same revision, no
// listener churn — does not wake the hook.
func (m *TunnelManager) fingerprint() string {
	m.mu.RLock()
	parts := make([]string, 0, len(m.tunnels))
	for id, e := range m.tunnels {
		parts = append(parts, fmt.Sprintf("%s:%d:%d", id, e.cfg.Revision, e.cfg.ListenPort()))
	}
	m.mu.RUnlock()
	sort.Strings(parts)
	return strings.Join(parts, ",")
}

// notifyIfChanged fires the hook when the registry really changed.
func (m *TunnelManager) notifyIfChanged(before string) {
	if before == m.fingerprint() {
		return
	}
	m.mu.RLock()
	hook := m.mutationHook
	m.mu.RUnlock()
	if hook != nil {
		hook()
	}
}

// NewTunnelManager builds a manager. egress may be nil on a pure ingress node;
// EGRESS tunnels are then rejected. listenHost may be empty.
func NewTunnelManager(egress *EgressManager, listenHost string) *TunnelManager {
	return &TunnelManager{
		tunnels:    make(map[string]*entry),
		usedPort:   make(map[string]bool),
		egress:     egress,
		listenHost: listenHost,
	}
}

// portGuardKey is the usedPorts key for a bound port.
//
// The key is namespaced by the OS socket family the listener actually binds
// ("tcp:" / "udp:") because the key is also a REPORTED FACT: labelling a UDP
// bind "tcp:" would say the node owns a TCP listener it does not (§5.3 of the
// datagram contract). tls/ws are TCP sockets, so all three stream protocols
// share one namespace; only a datagram runtime gets "udp:".
func portGuardKey(cfg forwarder.TunnelConfig) string {
	return portKey(socketNamespace(cfg.Protocol), cfg.ListenPort())
}

// portKey renders one namespaced guard key.
func portKey(namespace string, port int) string {
	return namespace + strconv.Itoa(port)
}

// socketNamespace is the OS socket family a protocol's listener binds in.
func socketNamespace(protocol forwarder.ForwardProtocol) string {
	if transport, ok := forwarder.TransportForProtocol(protocol); ok && transport == forwarder.TransportDatagram {
		return "udp:"
	}
	return "tcp:"
}

// portBoundLocked reports whether this node already owns the port number in ANY
// namespace.
//
// The kernel would happily take TCP 19000 and UDP 19000 at the same time, but the
// port lease above this manager does not: NodePortLease's unique key is
// (node_id, port), protocol-free, and §5.2 of the datagram contract freezes that
// stricter rule rather than expanding the lease. So a namespaced key must never
// be the ONLY exclusion check, or the guard would allow a pair the panel's port
// pool treats as one port — the exact "two owners for one number" failure the
// guard exists to prevent.
//
// Caller must hold m.mu.
func (m *TunnelManager) portBoundLocked(port int) bool {
	return m.usedPort[portKey("tcp:", port)] || m.usedPort[portKey("udp:", port)]
}

// New builds the runtime for cfg without starting it. It is exported so the
// API layer / tests can inspect what a config would produce.
func (m *TunnelManager) New(cfg forwarder.TunnelConfig) (forwarder.Runtime, error) {
	normalized := cfg.Clone()
	if normalized.ListenHost == "" {
		normalized.ListenHost = m.listenHost
	}
	if err := normalized.Validate(); err != nil {
		return nil, err
	}
	fwd, err := m.buildLocked(normalized)
	if err != nil {
		return nil, err
	}
	m.attachLedger(normalized, fwd)
	return fwd, nil
}

// DiagnosticsByTunnel returns the protocol-specific facts of every running tunnel
// that has any (V5-WP5-A3).
//
// A tunnel whose protocol has nothing to report is simply absent from the map,
// not present with zeroed counters: the panel must be able to say "this protocol
// has no such facts" rather than "nothing went wrong yet" — the same
// absent-versus-empty rule the capability facts follow.
func (m *TunnelManager) DiagnosticsByTunnel() map[string]forwarder.ProtocolDiagnostics {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]forwarder.ProtocolDiagnostics, len(m.tunnels))
	for id, e := range m.tunnels {
		report, ok := e.fwd.(forwarder.Diagnostician)
		if !ok {
			continue
		}
		diag, present := report.ProtocolDiagnostics()
		if !present {
			continue
		}
		out[id] = diag
	}
	return out
}

// attachLedger links an egress forwarder's per-target health view to its pool,
// so EgressManager.TargetStats can report what the running forwarder observed.
// A non-egress tunnel (or a pool-less one) is a no-op.
func (m *TunnelManager) attachLedger(cfg forwarder.TunnelConfig, fwd forwarder.Runtime) {
	if cfg.Mode != forwarder.ModeEgress || m.egress == nil {
		return
	}
	reader, ok := fwd.(interface {
		TargetStats() []forwarder.TargetStats
	})
	if !ok {
		return
	}
	if pool, err := m.egress.poolFor(cfg.ID); err == nil {
		pool.SetLedger(reader.TargetStats)
	}
}

// Apply creates or replaces the tunnel described by cfg, applying the revision
// rules. On success the tunnel is running and cfg.ID is owned by this manager.
//
// Equal revision returns (nil, nil) after a read-only check; the caller can
// ACK it as an idempotent no-op.
//
// The revision gate and the port guard live here (and in ReplaceListener,
// which shares applyLocked); the ordering inside is applyLocked's job, and it
// is the same sequence for both entry points so the two cannot drift.
func (m *TunnelManager) Apply(cfg forwarder.TunnelConfig) (forwarder.Runtime, error) {
	before := m.fingerprint()
	fwd, err := m.applyInner(cfg)
	if err == nil {
		m.notifyIfChanged(before)
	}
	return fwd, err
}

// applyInner is Apply's locked body. Splitting it out keeps the fingerprint
// comparison on the outside of the lock: the hook must never run while m.mu is
// held, because it re-reads the registry.
func (m *TunnelManager) applyInner(cfg forwarder.TunnelConfig) (forwarder.Runtime, error) {
	// V5.3 WP9: the ownership gate runs before the lock and before anything can
	// bind, so a refused activation is never half-applied.
	if err := m.admitOwnership(cfg); err != nil {
		return nil, err
	}
	normalized := cfg.Clone()
	if normalized.ListenHost == "" {
		normalized.ListenHost = m.listenHost
	}
	if err := normalized.Validate(); err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// WP11A: refuse work once shutdown has begun. Checked before the revision
	// gate so a config cannot "win" by carrying a newer revision.
	if m.closing {
		return nil, ErrNodeShuttingDown
	}

	if cur, ok := m.tunnels[normalized.ID]; ok {
		if isStale(normalized.Revision, cur.cfg.Revision) {
			return nil, ErrStaleRevision
		}
		if normalized.Revision == cur.cfg.Revision && normalized.Revision != revisionUnknown {
			// Idempotent: the very same revision is already live. Do not
			// churn listeners or reassign ports.
			return cur.fwd, nil
		}
	}
	return m.applyLocked(normalized)
}

// buildLocked builds the data-plane runtime. Caller must hold m.mu.
//
// V5-WP2: construction goes through the forwarder's runtime factory, which
// resolves protocol + transport FIRST and fails closed for anything this binary
// has not opened. The manager keeps owning desired state, revisions, the port
// guard and the single registry; only the "which runtime class" question moved
// into the factory, and it is asked before anything can bind.
//
// Since V5.1b the factory answers for BOTH transports (forwarder.BuildRuntime):
// the manager does not branch on the protocol, so opening a datagram protocol
// cannot silently land in the stream builder — or the other way round.
//
// The egress selector is passed as a lazy closure rather than resolved here, so
// the factory decides whether this build needs a pool at all (DIRECT/RELAY must
// not be made to fail because EgressManager is absent in a mode-only build).
func (m *TunnelManager) buildLocked(cfg forwarder.TunnelConfig) (forwarder.Runtime, error) {
	return forwarder.BuildRuntime(cfg, forwarder.BuildDeps{
		StreamBuildDeps: forwarder.StreamBuildDeps{
			// V5.3-WP8: the target resolver's dialer, when the runtime wired one.
			Dial: m.targetDial,
			SelectorFor: func(tunnelID string) (forwarder.TargetSelector, error) {
				if m.egress == nil {
					return nil, fmt.Errorf("manager: EGRESS tunnel %s has no egress manager wired", tunnelID)
				}
				return m.egress.SelectorFor(tunnelID)
			},
			// egressObserver is nil-safe, so a mode-only build loses nothing but
			// the log line; tests can leave the observer unset.
			Observer: egressObserver(cfg.ID),
			ReportCertError: func(err error) {
				// A failed certificate rotation must be visible: the tunnel keeps
				// serving the last good certificate, so the only symptom is this line
				// plus a certificate that never changes.
				logx.Error("tls certificate rotation failed", "tunnel", cfg.ID, "err", err.Error())
			},
		},
		// Datagram options stay at the package defaults: the idle timeout and the
		// mapping ceiling are product decisions (§9.2/§9.3) with no per-Forward
		// column yet, so inventing values here would put a second, invisible copy
		// of them in the control plane's way.
		Datagram: forwarder.DatagramBuildDeps{},
	})
}

// egressObserver builds the target-failure observer for one egress tunnel.
// It logs every failed dial (the WP5 "target fail 可观测" requirement) so a
// broken target is visible in the agent log the moment it breaks, while the
// per-target ledger stays the machine-readable source of truth.
func egressObserver(tunnelID string) forwarder.TargetObserver {
	return func(stats forwarder.TargetStats) {
		logx.Warn("egress target dial failed",
			"tunnel", tunnelID,
			"target", stats.Addr(),
			"dial_ok", stats.DialOK,
			"dial_failed", stats.DialFailed,
			"err", stats.LastErr,
		)
	}
}

// startLocked starts fwd and reserves its port. Caller must hold m.mu.
// The port guard is checked here AND the bind itself is the authoritative check
// (a foreign process holding the port makes net.Listen fail), so a race with
// the OS cannot be hidden by the map.
//
// When this Apply replaces the tunnel that currently owns the port, the old
// runtime must already have released it: Apply then does the replace in two
// steps (release the old port, bind the new one) rather than failing on a port
// the node itself holds. Same-port replacement is exactly the hot-update case
// the panel hits when it re-sends a tunnel with a new revision — including the
// case where the new revision changes the listener's TRANSPORT (a udp binding
// replaced by a tcp one on the same number), which is why the takeover below
// frees the key under the OLD runtime's namespace, not the new one's.
func (m *TunnelManager) startLocked(cfg forwarder.TunnelConfig, fwd forwarder.Runtime) error {
	port := cfg.ListenPort()
	if port <= 0 {
		return fwd.Start()
	}
	if !m.portBoundLocked(port) {
		return fwd.Start()
	}
	// The port is taken. If the taker is the entry this Apply replaces, the
	// port is genuinely available to us: the old runtime is stopped first
	// and its listener closed, and only then does the new one bind it.
	if old, ok := m.tunnels[cfg.ID]; ok && old.cfg.ListenPort() == port {
		_ = old.fwd.Stop()
		delete(m.usedPort, portGuardKey(old.cfg))
		return fwd.Start()
	}
	return fmt.Errorf("manager: port %d is already used by another tunnel", port)
}

// markPortUsedLocked records the port of a now-running tunnel. Caller must hold
// m.mu.
func (m *TunnelManager) markPortUsedLocked(cfg forwarder.TunnelConfig) {
	if p := cfg.ListenPort(); p > 0 {
		m.usedPort[portGuardKey(cfg)] = true
	}
}

// releasePortLocked frees the port held by cfg. Caller must hold m.mu.
func (m *TunnelManager) releasePortLocked(cfg forwarder.TunnelConfig) {
	if p := cfg.ListenPort(); p > 0 {
		delete(m.usedPort, portGuardKey(cfg))
	}
}

// stopEntry stops a forwarder in the background. Stop drains live connections
// and may block for drainTimeout, so it must never run while m.mu is held or
// the whole manager stalls behind one tunnel's teardown.
//
// The port guard is deliberately NOT touched here: a goroutine reaching into
// m.usedPort would race every Apply/StopAll that reads it (the -race detector
// flags this exact pair). Callers release the port under the lock instead —
// see releasePortLocked — which also makes "Remove frees the port" hold the
// instant Remove returns rather than "eventually".
//
// onStopped runs after Stop returned, i.e. after the old listener is really
// closed and its port is reclaimable at the OS level. Releasing a reservation
// before that point would let the guard advertise a port the kernel still has
// bound, and the next Apply would fail its bind on a port the map says is free.
// It is nil on the teardown paths that release under the lock themselves.
func (m *TunnelManager) stopEntry(e *entry) {
	m.stopEntryAsync(e, nil)
}

// stopEntryAsync is stopEntry with a post-stop hook. Caller must not hold m.mu
// (Stop blocks for drainTimeout); onStopped is invoked from the goroutine, after
// Stop returned. A nil hook is the plain "Stop and log" case.
func (m *TunnelManager) stopEntryAsync(e *entry, onStopped func()) {
	go func() {
		if err := e.fwd.Stop(); err != nil {
			logx.Warn("tunnel stop failed", "id", e.cfg.ID, "err", err.Error())
			// Fall through anyway: the forwarder is out of the registry, so
			// the port is ours to keep or free whatever Stop managed to do.
		}
		if onStopped != nil {
			onStopped()
		}
		logx.Info("tunnel removed", "id", e.cfg.ID, "mode", string(e.cfg.Mode), "port", e.cfg.ListenPort())
	}()
}

// releasePortAfterStop releases the ports held by cfg once the forwarder that
// still owns them has actually stopped. The reservation lives under m.mu, so
// the release takes the write lock rather than being dispatched at teardown
// time: the guard is manager state, never the teardown goroutine's.
//
// The release is owner-aware and therefore safe to run late. A listener move
// back onto the port being drained is legal (X -> Y, then Y -> X), and by the
// time the drained forwarder's Stop returns, the newer entry may already have
// reserved that port. Blindly deleting the key would hand a live tunnel's port
// to whoever asks next, so the key is dropped only while no registered tunnel
// holds it.
func (m *TunnelManager) releasePortAfterStop(cfg forwarder.TunnelConfig) func() {
	return func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		for _, e := range m.tunnels {
			if e.cfg.ID != cfg.ID && e.cfg.ListenPort() == cfg.ListenPort() {
				return
			}
		}
		m.releasePortLocked(cfg)
	}
}

// isStale reports whether next is older than current.
func isStale(next, current int64) bool {
	return current != revisionUnknown && next != revisionUnknown && next < current
}

// Remove stops and forgets the tunnel with the given id. It is a no-op returning
// nil when the id is unknown, so a duplicate remove_tunnel command from the
// panel cannot erase a tunnel that was legitimately recreated.
func (m *TunnelManager) Remove(id string) error {
	_, err := m.RemoveIf(id, nil)
	return err
}

// RemoveIf removes a tunnel only while cond still holds for its live config.
//
// It exists for the V5.3 WP9 lease clock: the ownership guard observes "this
// tunnel's authorisation has lapsed", but between that observation and the stop
// a renewal may have arrived. Evaluating cond under the manager's lock turns
// check-then-act into check-and-act, so a tunnel that was just renewed is not
// killed by a decision made on a stale read.
//
// It returns whether the tunnel was actually removed. cond runs while the
// manager's lock is held, so it must be pure and must never call back into the
// manager (a nil cond always removes, which is exactly Remove).
func (m *TunnelManager) RemoveIf(id string, cond func(forwarder.TunnelConfig) bool) (bool, error) {
	before := m.fingerprint()
	removed, err := m.removeInnerIf(id, cond)
	if err == nil && removed {
		m.notifyIfChanged(before)
	}
	return removed, err
}

func (m *TunnelManager) removeInner(id string) error {
	_, err := m.removeInnerIf(id, nil)
	return err
}

// removeInnerIf is the locked body of Remove/RemoveIf. Caller must not hold m.mu.
func (m *TunnelManager) removeInnerIf(id string, cond func(forwarder.TunnelConfig) bool) (bool, error) {
	m.mu.Lock()
	e, ok := m.tunnels[id]
	if !ok {
		m.mu.Unlock()
		return false, nil
	}
	if cond != nil && !cond(e.cfg) {
		// The tunnel changed under us (renewed or replaced): leave it alone.
		m.mu.Unlock()
		return false, nil
	}
	delete(m.tunnels, id)
	m.releasePortLocked(e.cfg)
	m.mu.Unlock()

	m.stopEntry(e)
	return true, nil
}

// Get returns the live cfg for a tunnel.
func (m *TunnelManager) Get(id string) (forwarder.TunnelConfig, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.tunnels[id]
	if !ok {
		return forwarder.TunnelConfig{}, false
	}
	return e.cfg.Clone(), true
}

// List returns every running tunnel, ordered by id for deterministic output.
func (m *TunnelManager) List() []forwarder.TunnelConfig {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]forwarder.TunnelConfig, 0, len(m.tunnels))
	for _, e := range m.tunnels {
		out = append(out, e.cfg.Clone())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// IDs returns the running tunnel ids.
func (m *TunnelManager) IDs() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]string, 0, len(m.tunnels))
	for id := range m.tunnels {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Len returns the number of running tunnels.
func (m *TunnelManager) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.tunnels)
}

// Stats returns the forwarded bytes for one tunnel (0 when unknown).
//
// A stream runtime answers with its own bidirectional byte counter. A datagram
// runtime is asked for the DELIVERED byte total of both directions instead
// (bytes_in + bytes_out): the value means the same thing, and returning 0 just
// because the transport's Stats() has a different shape would report an idle
// tunnel for one that is relaying. Callers that need the datagram facts
// separately (packets, mappings, drops) use DatagramStats.
func (m *TunnelManager) Stats(id string) int64 {
	m.mu.RLock()
	e, ok := m.tunnels[id]
	m.mu.RUnlock()
	if !ok {
		return 0
	}
	type byteCounter interface{ Stats() int64 }
	if c, ok := e.fwd.(byteCounter); ok {
		return c.Stats()
	}
	if d, ok := e.fwd.(forwarder.DatagramRuntime); ok {
		s := d.Stats()
		return s.BytesIn + s.BytesOut
	}
	return 0
}

// DatagramStats returns the structured datagram facts of a tunnel, and whether
// this tunnel is a datagram one at all. The second return value is the
// absent-versus-empty flag: a stream tunnel is not a datagram tunnel that is
// currently idle, and a caller must be able to tell those apart.
func (m *TunnelManager) DatagramStats(id string) (forwarder.DatagramStats, bool) {
	m.mu.RLock()
	e, ok := m.tunnels[id]
	m.mu.RUnlock()
	if !ok {
		return forwarder.DatagramStats{}, false
	}
	d, ok := e.fwd.(forwarder.DatagramRuntime)
	if !ok {
		return forwarder.DatagramStats{}, false
	}
	return d.Stats(), true
}

// MaxRevision returns the newest config revision among the running tunnels
// (0 when none or when the source does not track revisions). It is what the
// WP7 state report sends as reported_revision so the panel can tell
// "this node is behind" (revision < tunnel.config_revision) from "no data".
func (m *TunnelManager) MaxRevision() int64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var max int64
	for _, e := range m.tunnels {
		if e.cfg.Revision > max {
			max = e.cfg.Revision
		}
	}
	return max
}

// LiveConns returns how much work the tunnel has in flight right now (0 when
// unknown). For a stream tunnel that is its live connections — the observable
// the disconnect-cleanup guard needs: after every client hangs up the count must
// fall back to zero.
//
// A datagram tunnel has no connections and must NOT be answered with a silent 0
// (§4.4.1): 0 would read as "nothing in flight" for a tunnel that is relaying,
// which is the failure mode this project treats as the worst kind. Its in-flight
// work is its mappings, so that is what is returned, and LiveMappings is the
// explicit form callers should prefer when they know the transport.
func (m *TunnelManager) LiveConns(id string) int {
	live, ok := m.LiveMappings(id)
	if ok {
		return live
	}
	m.mu.RLock()
	e, ok := m.tunnels[id]
	m.mu.RUnlock()
	if !ok {
		return 0
	}
	type counter interface{ LiveConns() int }
	if c, ok := e.fwd.(counter); ok {
		return c.LiveConns()
	}
	return 0
}

// LiveMappings returns the number of ingress mappings a datagram tunnel is
// holding, and whether this tunnel is a datagram one. Report the second value:
// "0 mappings" and "this transport has no mappings" are different facts.
func (m *TunnelManager) LiveMappings(id string) (int, bool) {
	m.mu.RLock()
	e, ok := m.tunnels[id]
	m.mu.RUnlock()
	if !ok {
		return 0, false
	}
	d, ok := e.fwd.(forwarder.DatagramRuntime)
	if !ok {
		return 0, false
	}
	return d.LiveMappings(), true
}

// StopAll tears down every tunnel. A stream tunnel drains its connections; a
// datagram tunnel drops its mappings (there is nothing to drain, §4.1). Used on
// shutdown.
func (m *TunnelManager) StopAll() {
	m.mu.Lock()
	entries := make([]*entry, 0, len(m.tunnels))
	for id, e := range m.tunnels {
		entries = append(entries, e)
		delete(m.tunnels, id)
	}
	m.usedPort = make(map[string]bool)
	m.mu.Unlock()

	var wg sync.WaitGroup
	for _, e := range entries {
		wg.Add(1)
		go func(e *entry) {
			defer wg.Done()
			_ = e.fwd.Stop()
		}(e)
	}
	wg.Wait()
	logx.Info("all tunnels stopped", "count", len(entries))
}

// UsedPorts returns a copy of the shared port guard (for /health and tests).
//
// The flat number set is still the correct answer to "is this port really bound
// on this node" because §5.2 freezes the one-number-one-binding rule: TCP and UDP
// may not share a number here, so a number present in either namespace means the
// same thing. What the flat view cannot say is WHICH protocol owns it — a caller
// that needs that (or the reporter projection that has to stop flattening two
// namespaces) reads UsedPortsByProtocol instead; neither view lies about the
// other.
func (m *TunnelManager) UsedPorts() map[int]bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[int]bool, len(m.usedPort))
	for k := range m.usedPort {
		namespace, port := splitPortGuardKey(k)
		if port > 0 {
			_ = namespace
			out[port] = true
		}
	}
	return out
}

// UsedPortsByProtocol returns the guard grouped by OS socket family ("tcp" /
// "udp"), the protocol-dimension view of the same facts (§5.3: the namespaces
// must be preserved somewhere, not flattened away everywhere).
func (m *TunnelManager) UsedPortsByProtocol() map[string]map[int]bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := map[string]map[int]bool{"tcp": {}, "udp": {}}
	for k := range m.usedPort {
		namespace, port := splitPortGuardKey(k)
		if port <= 0 {
			continue
		}
		name := strings.TrimSuffix(namespace, ":")
		if out[name] == nil {
			out[name] = map[int]bool{}
		}
		out[name][port] = true
	}
	return out
}

// splitPortGuardKey parses a "tcp:<port>" / "udp:<port>" guard key. An
// unparseable key returns a zero port, which every caller treats as "not a
// binding" rather than as port 0 being taken.
func splitPortGuardKey(key string) (namespace string, port int) {
	namespace, portStr, ok := strings.Cut(key, ":")
	if !ok {
		return "", 0
	}
	p, err := strconv.Atoi(portStr)
	if err != nil {
		return "", 0
	}
	return namespace + ":", p
}

// SetTargetDialer installs the dialer EGRESS pools use for their upstreams.
//
// It is a setter rather than a constructor argument for the same reason
// SetOwnershipGuard is: the resolver is built after the managers (it is wired
// into the runtime) and every existing caller keeps working undialed. It only
// affects egress forwarders BUILT AFTER the call — an already-running pool keeps
// the dialer it was built with, which is the honest behaviour: swapping the
// dialer under a live forwarder would change how in-flight retries resolve
// without anything recording that it happened.
func (m *TunnelManager) SetTargetDialer(dial forwarder.DialFunc) {
	m.mu.Lock()
	m.targetDial = dial
	m.mu.Unlock()
}

// SetListenHost overrides the interface tunnels bind. Running tunnels keep
// their listener until the next Apply of that tunnel; callers that want the
// change live should use it before the first Apply.
func (m *TunnelManager) SetListenHost(host string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.listenHost = host
}

// compile-time check that the manager satisfies what the API layer needs.
var _ interface {
	Apply(forwarder.TunnelConfig) (forwarder.Runtime, error)
	Remove(string) error
	Get(string) (forwarder.TunnelConfig, bool)
	List() []forwarder.TunnelConfig
} = (*TunnelManager)(nil)
