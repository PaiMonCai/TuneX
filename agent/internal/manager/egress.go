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
// forwarder reads from. The balancer is what makes hot updates invisible to live
// listeners (devmap §5.3): SwapTargets mutates the pool, and the next connection
// of the already-running forwarder picks the new target.
type Pool struct {
	tunnelID string
	mu       sync.RWMutex
	balancer *LoadBalancer
}

// newPool builds a pool. An empty target list is allowed so an egress forwarder
// can start before the panel has pushed the pool in.
func newPool(tunnelID string, strategy Strategy, targets []forwarder.Target) *Pool {
	return &Pool{
		tunnelID: tunnelID,
		balancer: New(strategy, targets),
	}
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
