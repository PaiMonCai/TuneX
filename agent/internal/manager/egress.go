package manager

import (
	"errors"
	"fmt"
	"sort"
	"sync"

	"github.com/tunex/agent/internal/forwarder"
)

// ErrPoolNotFound is returned when a tunnel id has no egress target pool.
var ErrPoolNotFound = errors.New("manager: no egress target pool for tunnel")

// Pool is one tunnel's egress target pool: the strategy plus the balancer the
// forwarder reads. The balancer is what makes hot updates invisible to live
// listeners (devmap §5.3): SwapTargets mutates the pool, and the next connection
// of the already-running forwarder picks the new target.
//
// ledger is the optional per-target health view the WP5 "target fail 可观测"
// requirement asks for. The running EgressForwarder owns the counters (it is
// the thing that dials targets), so the pool keeps only a reference: whoever
// builds the forwarder hands the reference back with SetLedger, and TargetStats
// reads through it. A pool without a ledger reports nothing rather than lying.
type Pool struct {
	tunnelID string
	mu       sync.RWMutex
	balancer *LoadBalancer
	ledger   func() []forwarder.TargetStats
}

// newPool builds a pool. An empty target list is allowed so an egress forwarder
// can start before the panel has pushed the pool in.
func newPool(tunnelID string, strategy Strategy, targets []forwarder.Target) *Pool {
	return &Pool{
		tunnelID: tunnelID,
		balancer: New(strategy, targets),
	}
}

// SetLedger attaches the connected forwarder's target-health view. It is called
// right after the forwarder is built (the manager knows both objects at that
// point); passing nil detaches it.
func (p *Pool) SetLedger(ledger func() []forwarder.TargetStats) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ledger = ledger
}

// Select implements forwarder.TargetSelector.
func (p *Pool) Select() forwarder.Target {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.balancer.Select()
}

// SwapTargets replaces the pool contents under the write lock. An empty/invalid
// target list is ignored rather than clearing the pool: losing the pool would
// black-hole every egress tunnel on the node.
func (p *Pool) SwapTargets(strategy Strategy, targets []forwarder.Target) {
	p.mu.Lock()
	defer p.mu.Unlock()
	// The empty-list guard lives inside UpdateTargets; passing it straight
	// through keeps the balancer the single owner of the validation rules.
	p.balancer.UpdateTargets(strategy, targets)
}

// Targets returns a copy of the pool (for /health and tests).
func (p *Pool) Targets() []forwarder.Target {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.balancer.Targets()
}

// TargetStats returns the connected forwarder's per-target health ledger. Empty
// (not nil) when no forwarder reported in yet, so a caller can tell "no data"
// from "the forwarder died".
func (p *Pool) TargetStats() []forwarder.TargetStats {
	p.mu.RLock()
	ledger := p.ledger
	p.mu.RUnlock()
	if ledger == nil {
		return []forwarder.TargetStats{}
	}
	return ledger()
}

// Strategy returns the active strategy.
func (p *Pool) Strategy() Strategy {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.balancer.Strategy()
}

// Addrs returns the pool as "host:port" strings (for /health and tests).
func (p *Pool) Addrs() []string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.balancer.Addrs()
}

// PoolSnapshot is the reported view of one target pool.
type PoolSnapshot struct {
	TunnelID string   `json:"tunnel_id"`
	Strategy string   `json:"strategy"`
	Targets  []string `json:"targets"`
}

// EgressManager owns the egress side of the node: the target pools of the EGRESS
// tunnels running here and the balancers those tunnels read.
type EgressManager struct {
	mu    sync.RWMutex
	pools map[string]*Pool
}

// NewEgressManager builds an egress manager.
func NewEgressManager() *EgressManager {
	return &EgressManager{pools: make(map[string]*Pool)}
}

// SetPool creates or replaces the pool for tunnelID. Used when an EGRESS tunnel
// is applied and when the panel pushes PATCH /node/targets.
func (e *EgressManager) SetPool(tunnelID string, strategy Strategy, targets []forwarder.Target) *Pool {
	e.mu.Lock()
	defer e.mu.Unlock()
	p := newPool(tunnelID, strategy, targets)
	e.pools[tunnelID] = p
	return p
}

// SelectorFor returns the TargetSelector the forwarder for tunnelID will read.
// A missing pool is an error: the control plane must deliver a target pool
// (possibly empty) together with the EGRESS tunnel, rather than let the agent
// invent one.
func (e *EgressManager) SelectorFor(tunnelID string) (forwarder.TargetSelector, error) {
	p, err := e.poolFor(tunnelID)
	if err != nil {
		return nil, err
	}
	return p, nil
}

// poolFor returns the pool for tunnelID, or an error wrapping ErrPoolNotFound.
// It is the internal accessor the manager uses when it already holds the id.
func (e *EgressManager) poolFor(tunnelID string) (*Pool, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	p, ok := e.pools[tunnelID]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrPoolNotFound, tunnelID)
	}
	return p, nil
}

// UpdateTargets hot-updates the pool of one tunnel without touching listeners.
// Returns an error wrapping ErrPoolNotFound for an unknown tunnel id.
func (e *EgressManager) UpdateTargets(tunnelID string, strategy Strategy, targets []forwarder.Target) error {
	e.mu.RLock()
	p, ok := e.pools[tunnelID]
	e.mu.RUnlock()
	if !ok {
		return fmt.Errorf("%w: %s", ErrPoolNotFound, tunnelID)
	}
	p.SwapTargets(strategy, targets)
	return nil
}

// DropPool removes a tunnel's pool (called when the tunnel is removed).
func (e *EgressManager) DropPool(tunnelID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.pools, tunnelID)
}

// Targets returns the pool for one tunnel.
func (e *EgressManager) Targets(tunnelID string) ([]forwarder.Target, bool) {
	e.mu.RLock()
	p, ok := e.pools[tunnelID]
	e.mu.RUnlock()
	if !ok {
		return nil, false
	}
	return p.Targets(), true
}

// TargetStats returns the per-target failure/throughput ledger of one tunnel
// (the WP5 "target fail 可观测" surface). It reports what the node's own
// forwarder observed — dial successes/failures and relayed bytes — so a silent
// or broken target is visible without a probe from the panel.
//
// The result is empty for an unknown tunnel id: "no data" is the honest answer
// when no forwarder has reported in.
func (e *EgressManager) TargetStats(tunnelID string) []forwarder.TargetStats {
	e.mu.RLock()
	p, ok := e.pools[tunnelID]
	e.mu.RUnlock()
	if !ok {
		return []forwarder.TargetStats{}
	}
	return p.TargetStats()
}

// TargetStatsAll returns every pooled tunnel's ledger, keyed by tunnel id.
// It is the shape /health and a state_request reply want.
func (e *EgressManager) TargetStatsAll() map[string][]forwarder.TargetStats {
	e.mu.RLock()
	ids := make([]string, 0, len(e.pools))
	for id := range e.pools {
		ids = append(ids, id)
	}
	pools := make(map[string]*Pool, len(e.pools))
	for id, p := range e.pools {
		pools[id] = p
	}
	e.mu.RUnlock()

	out := make(map[string][]forwarder.TargetStats, len(pools))
	for _, id := range ids {
		out[id] = pools[id].TargetStats()
	}
	return out
}

// TargetLedger is an alias for forwarder.TargetStats kept next to the manager
// API that returns it, so call sites read well without a second import.
type TargetLedger = forwarder.TargetStats

// Len returns the number of pooled tunnels.
func (e *EgressManager) Len() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return len(e.pools)
}

// IDs returns every pooled tunnel id, sorted.
func (e *EgressManager) IDs() []string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make([]string, 0, len(e.pools))
	for id := range e.pools {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Snapshot renders the node's egress state for /health and the state_request
// reply: every pooled tunnel with its strategy and target addresses.
func (e *EgressManager) Snapshot() map[string]PoolSnapshot {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make(map[string]PoolSnapshot, len(e.pools))
	for id, p := range e.pools {
		out[id] = PoolSnapshot{
			TunnelID: id,
			Strategy: string(p.balancer.Strategy()),
			Targets:  p.balancer.Addrs(),
		}
	}
	return out
}

// Compile-time proof that a pool is a forwarder.TargetSelector.
var _ forwarder.TargetSelector = (*Pool)(nil)
