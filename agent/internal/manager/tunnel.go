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

// entry is one running tunnel: the config it was built from plus its Forwarder.
type entry struct {
	cfg forwarder.TunnelConfig
	fwd forwarder.Forwarder
}

// TunnelManager is the concurrency-safe registry of running tunnels.
type TunnelManager struct {
	mu       sync.RWMutex
	tunnels  map[string]*entry
	usedPort map[string]bool // "tcp:<port>" guard shared with EgressManager

	egress *EgressManager
	// listenHost is the interface ingress/egress tunnels bind when the config
	// does not pin one. Empty means all interfaces.
	listenHost string
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
func portGuardKey(port int) string { return "tcp:" + strconv.Itoa(port) }

// New builds the Forwarder for cfg without starting it. It is exported so the
// API layer / tests can inspect what a config would produce.
func (m *TunnelManager) New(cfg forwarder.TunnelConfig) (forwarder.Forwarder, error) {
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

// attachLedger links an egress forwarder's per-target health view to its pool,
// so EgressManager.TargetStats can report what the running forwarder observed.
// A non-egress tunnel (or a pool-less one) is a no-op.
func (m *TunnelManager) attachLedger(cfg forwarder.TunnelConfig, fwd forwarder.Forwarder) {
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
func (m *TunnelManager) Apply(cfg forwarder.TunnelConfig) (forwarder.Forwarder, error) {
	normalized := cfg.Clone()
	if normalized.ListenHost == "" {
		normalized.ListenHost = m.listenHost
	}
	if err := normalized.Validate(); err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

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
	fwd, err := m.buildLocked(normalized)
	if err != nil {
		return nil, err
	}
	m.attachLedger(normalized, fwd)
	if err := m.startLocked(normalized, fwd); err != nil {
		return nil, err
	}
	if old, ok := m.tunnels[normalized.ID]; ok {
		if old.cfg.ListenPort() != normalized.ListenPort() {
			// A different port: the old one is genuinely freed. On the
			// same port startLocked already stopped the old forwarder and
			// dropped the guard key, so both paths end with the old port
			// unreserved and the new tunnel owning it.
			m.releasePortLocked(old.cfg)
		}
		// The new listener is bound (or the old one already stopped for the
		// same-port replace), so tearing the old one down is safe. The port
		// bookkeeping above happened under this lock, so the async Stop
		// never touches the guard map.
		defer m.stopEntry(old)
	}
	m.tunnels[normalized.ID] = &entry{cfg: normalized, fwd: fwd}
	m.markPortUsedLocked(normalized)
	logx.Info("tunnel applied", "id", normalized.ID, "mode", string(normalized.Mode),
		"port", normalized.ListenPort(), "revision", normalized.Revision)
	return fwd, nil
}

// buildLocked builds the Forwarder. Caller must hold m.mu.
func (m *TunnelManager) buildLocked(cfg forwarder.TunnelConfig) (forwarder.Forwarder, error) {
	switch cfg.Mode {
	case forwarder.ModeDirect, forwarder.ModeRelay:
		// DIRECT and RELAY are both one-hop tunnels: the only difference is
		// where UpstreamAddr() points. One implementation carries both.
		return forwarder.NewSingleHop(cfg)
	case forwarder.ModeEgress:
		sel, err := m.egress.SelectorFor(cfg.ID)
		if err != nil {
			return nil, err
		}
		// egressObserver is nil-safe, so a mode-only build loses nothing but
		// the log line; tests can leave the observer unset.
		return forwarder.NewEgressWithHealth(cfg, sel, egressObserver(cfg.ID))
	default:
		return nil, fmt.Errorf("manager: unsupported tunnel mode %q", cfg.Mode)
	}
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
// forwarder must already have released it: Apply then does the replace in two
// steps (release the old port, bind the new one) rather than failing on a port
// the node itself holds. Same-port replacement is exactly the hot-update case
// the panel hits when it re-sends a tunnel with a new revision.
func (m *TunnelManager) startLocked(cfg forwarder.TunnelConfig, fwd forwarder.Forwarder) error {
	port := cfg.ListenPort()
	if port <= 0 {
		return fwd.Start()
	}
	key := portGuardKey(port)
	if !m.usedPort[key] {
		return fwd.Start()
	}
	// The port is taken. If the taker is the entry this Apply replaces, the
	// port is genuinely available to us: the old forwarder is stopped first
	// and its listener closed, and only then does the new one bind it.
	if old, ok := m.tunnels[cfg.ID]; ok && old.cfg.ListenPort() == port {
		_ = old.fwd.Stop()
		delete(m.usedPort, key)
		return fwd.Start()
	}
	return fmt.Errorf("manager: port %d is already used by another tunnel", port)
}

// markPortUsedLocked records the port of a now-running tunnel. Caller must hold
// m.mu.
func (m *TunnelManager) markPortUsedLocked(cfg forwarder.TunnelConfig) {
	if p := cfg.ListenPort(); p > 0 {
		m.usedPort[portGuardKey(p)] = true
	}
}

// releasePortLocked frees the ports held by cfg. Caller must hold m.mu.
func (m *TunnelManager) releasePortLocked(cfg forwarder.TunnelConfig) {
	if p := cfg.ListenPort(); p > 0 {
		delete(m.usedPort, portGuardKey(p))
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
func (m *TunnelManager) stopEntry(e *entry) {
	go func() {
		if err := e.fwd.Stop(); err != nil {
			logx.Warn("tunnel stop failed", "id", e.cfg.ID, "err", err.Error())
			return
		}
		logx.Info("tunnel removed", "id", e.cfg.ID, "mode", string(e.cfg.Mode), "port", e.cfg.ListenPort())
	}()
}

// isStale reports whether next is older than current.
func isStale(next, current int64) bool {
	return current != revisionUnknown && next != revisionUnknown && next < current
}

// Remove stops and forgets the tunnel with the given id. It is a no-op returning
// nil when the id is unknown, so a duplicate remove_tunnel command from the
// panel cannot erase a tunnel that was legitimately recreated.
func (m *TunnelManager) Remove(id string) error {
	m.mu.Lock()
	e, ok := m.tunnels[id]
	if !ok {
		m.mu.Unlock()
		return nil
	}
	delete(m.tunnels, id)
	m.releasePortLocked(e.cfg)
	m.mu.Unlock()

	m.stopEntry(e)
	return nil
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
func (m *TunnelManager) Stats(id string) int64 {
	m.mu.RLock()
	e, ok := m.tunnels[id]
	m.mu.RUnlock()
	if !ok {
		return 0
	}
	return e.fwd.Stats()
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

// LiveConns returns how many client connections the tunnel is relaying right
// now (0 when unknown). It is the observable the disconnect-cleanup guard
// needs: after every client hangs up the count must fall back to zero.
func (m *TunnelManager) LiveConns(id string) int {
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

// StopAll tears down every tunnel, draining connections. Used on shutdown.
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
func (m *TunnelManager) UsedPorts() map[int]bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[int]bool, len(m.usedPort))
	for k := range m.usedPort {
		if p, err := strconv.Atoi(k[len("tcp:"):]); err == nil {
			out[p] = true
		}
	}
	return out
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
	Apply(forwarder.TunnelConfig) (forwarder.Forwarder, error)
	Remove(string) error
	Get(string) (forwarder.TunnelConfig, bool)
	List() []forwarder.TunnelConfig
} = (*TunnelManager)(nil)
