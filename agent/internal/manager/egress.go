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
// ledger is the optional per-target health view used for target-failure observability
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
//
// It carries no health, so it clears the pool's health view (see
// LoadBalancer.UpdateTargets): a target-only update says nothing about how the
// panel judges the pool.
func (p *Pool) SwapTargets(strategy Strategy, targets []forwarder.Target) {
	p.mu.Lock()
	defer p.mu.Unlock()
	// The empty-list guard lives inside UpdateTargets; passing it straight
	// through keeps the balancer the single owner of the validation rules.
	p.balancer.UpdateTargets(strategy, targets)
}

// SwapTargetsAndHealth installs both parallel arrays of one egress dispatch
// payload: the desired targets and the panel's health facts (§7.3). Keeping
// them one call makes it hard to apply half a payload by accident, and it is
// the call the command path uses for an EGRESS apply.
func (p *Pool) SwapTargetsAndHealth(strategy Strategy, targets []forwarder.Target, health []forwarder.TargetHealth) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.balancer.UpdateTargetsAndHealth(strategy, targets, health)
}

// SetHealth installs the panel's health facts for this pool without touching
// the desired targets. nil/empty means "no health signal" and switches the
// health-aware selection off for the pool.
func (p *Pool) SetHealth(health []forwarder.TargetHealth) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.balancer.UpdateHealth(health)
}

// ReportDial implements forwarder.TargetReporter: the running egress forwarder
// hands back the outcome of the dial it just made, which is the only evidence
// that can resolve a half-open probe. A pool without health facts has no
// breaker, so the outcome is dropped (the target-health ledger still records it).
func (p *Pool) ReportDial(t forwarder.Target, ok bool) {
	p.mu.RLock()
	balancer := p.balancer
	p.mu.RUnlock()
	balancer.reportDial(t, ok)
}

// ForcedPicks returns how many connections this pool served while nothing was
// admissible (every target open or mid-probe) — the §7.3 "still pick the
// least-bad, and record it" fact.
func (p *Pool) ForcedPicks() uint64 {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.balancer.ForcedPicks()
}

// BreakerStates reports the pool's per-target breaker view (empty when the pool
// has never received health).
func (p *Pool) BreakerStates() []BreakerState {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.balancer.BreakerStates()
}

// SetBreakerBounds installs the breaker bounds and clock of this pool's
// balancer. Production uses the frozen defaults; the seam exists for tests and
// for an operator deliberately deviating from §7.3.
func (p *Pool) SetBreakerBounds(bounds BreakerBounds) {
	p.mu.RLock()
	balancer := p.balancer
	p.mu.RUnlock()
	balancer.SetBreakerBounds(bounds)
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
	// ForcedPicks counts cases where nothing was admissible, so the least-bad target
	// was served anyway" count (§7.3 requires that trade to be recorded). A
	// non-zero value is not an error — refusing to pick anything is the worse
	// failure — but it is the number an operator wants when a pool looks slow.
	ForcedPicks uint64 `json:"forced_picks,omitempty"`
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

// UpdateTargetsAndHealth hot-updates one tunnel's pool from a dispatch payload
// that carried both parallel arrays (§7.3): the desired targets and the panel's
// health facts. It is the health-aware sibling of UpdateTargets, and the one the
// EGRESS command path uses.
func (e *EgressManager) UpdateTargetsAndHealth(tunnelID string, strategy Strategy, targets []forwarder.Target, health []forwarder.TargetHealth) error {
	e.mu.RLock()
	p, ok := e.pools[tunnelID]
	e.mu.RUnlock()
	if !ok {
		return fmt.Errorf("%w: %s", ErrPoolNotFound, tunnelID)
	}
	p.SwapTargetsAndHealth(strategy, targets, health)
	return nil
}

// SetPoolAndHealth creates or replaces the pool for tunnelID together with the
// health facts that arrived in the same payload. It is SetPool plus SetHealth,
// kept as one call so a dispatch cannot install the desired targets and forget
// the health that came with them.
func (e *EgressManager) SetPoolAndHealth(tunnelID string, strategy Strategy, targets []forwarder.Target, health []forwarder.TargetHealth) *Pool {
	p := e.SetPool(tunnelID, strategy, targets)
	p.SetHealth(health)
	return p
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

// DesiredTargets returns every target of every egress pool this node serves,
// ordered by tunnel id and then by the pool's own order, so two cycles over an
// unchanged desired state enumerate identically.
//
// It is the single accessor the target observer enumerates from
// (internal/targetobs): "observe only the targets of this node's desired state"
// (§7 row 2) is enforced by making this the only window the observer has. It
// reports desired state only — never observation results, never a peer's
// targets — and nothing can write through it.
func (e *EgressManager) DesiredTargets() []forwarder.Target {
	e.mu.RLock()
	defer e.mu.RUnlock()
	ids := make([]string, 0, len(e.pools))
	for id := range e.pools {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]forwarder.Target, 0)
	for _, id := range ids {
		out = append(out, e.pools[id].Targets()...)
	}
	return out
}

// TargetStats returns the per-target failure/throughput ledger of one tunnel
// (the target-failure observability surface). It reports what the node's own
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
			TunnelID:    id,
			Strategy:    string(p.balancer.Strategy()),
			Targets:     p.balancer.Addrs(),
			ForcedPicks: p.balancer.ForcedPicks(),
		}
	}
	return out
}

// BreakerStates returns the health-aware breaker view of one tunnel's pool, ordered by
// target. It is empty for an unknown tunnel and for a tunnel whose pool has
// never received health — "no data" is the honest answer in both cases.
func (e *EgressManager) BreakerStates(tunnelID string) []BreakerState {
	e.mu.RLock()
	p, ok := e.pools[tunnelID]
	e.mu.RUnlock()
	if !ok {
		return []BreakerState{}
	}
	return p.BreakerStates()
}

// Compile-time proof that a pool is a forwarder.TargetSelector.
var _ forwarder.TargetSelector = (*Pool)(nil)
