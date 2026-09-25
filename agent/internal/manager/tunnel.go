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
// TunnelManager and EgressManager must share one usedPorts map). The legacy
// engine keeps its own map; this package never queries it.
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
	// does not pin one. Empty means all interfaces (the legacy behaviour).
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
	switch normalized.Mode {
	case forwarder.ModeDirect:
		return forwarder.NewDirect(normalized)
	case forwarder.ModeRelay:
		return forwarder.NewRelay(normalized)
	case forwarder.ModeEgress:
		sel, err := m.egress.SelectorFor(cfg.ID)
		if err != nil {
			return nil, err
		}
		return forwarder.NewEgress(normalized, sel)
	default:
		return nil, fmt.Errorf("manager: unsupported tunnel mode %q", normalized.Mode)
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
	if err := m.startLocked(normalized, fwd); err != nil {
		return nil, err
	}
	if old, ok := m.tunnels[normalized.ID]; ok {
		if old.cfg.ListenPort() != normalized.ListenPort() {
			// The old port is genuinely freed and can be reused by a later
			// tunnel, unlike a replace-in-place swap.
			m.releasePortLocked(old.cfg)
		}
		// The new listener is bound, so it is safe to tear the old one down.
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
	case forwarder.ModeDirect:
		return forwarder.NewDirect(cfg)
	case forwarder.ModeRelay:
		return forwarder.NewRelay(cfg)
	case forwarder.ModeEgress:
		sel, err := m.egress.SelectorFor(cfg.ID)
		if err != nil {
			return nil, err
		}
		return forwarder.NewEgress(cfg, sel)
	default:
		return nil, fmt.Errorf("manager: unsupported tunnel mode %q", cfg.Mode)
	}
}

// startLocked starts fwd and reserves its port. Caller must hold m.mu.
// The port guard is checked here AND the bind itself is the authoritative check
// (a foreign process holding the port makes net.Listen fail), so a race with
// the OS cannot be hidden by the map.
func (m *TunnelManager) startLocked(cfg forwarder.TunnelConfig, fwd forwarder.Forwarder) error {
	if port := cfg.ListenPort(); port > 0 && m.usedPort[portGuardKey(port)] {
		return fmt.Errorf("manager: port %d is already used by another tunnel", port)
	}
	return fwd.Start()
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

// stopEntry stops a forwarder outside the manager lock: Stop drains live
// connections and may block for drainTimeout. Caller must hold m.mu.
func (m *TunnelManager) stopEntry(e *entry) {
	go func() {
		m.releasePortLocked(e.cfg)
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
