// The egress target-pool load balancer. Lives in package manager (devmap §7.2
// "manager/lb.go — 轮询/随机"), so TunnelManager and EgressManager can share the
// port guard with it.
//
// The contract the egress forwarder depends on is forwarder.TargetSelector;
// LoadBalancer satisfies it and adds atomic snapshot replacement so a
// PATCH /node/targets can retarget every new connection instantly without
// restarting the listener ("Target snapshot hot update", devmap §5.3).
package manager

import (
	"math/rand"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/tunex/agent/internal/forwarder"
)

// Strategy identifies a selection policy.
type Strategy string

const (
	// RoundRobin walks the pool in order, one connection per target.
	RoundRobin Strategy = "ROUND_ROBIN"
	// Random picks a uniformly weighted random target per connection.
	Random Strategy = "RANDOM"

	// WeightedRoundRobin is accepted from the wire and dispatched to a
	// weighted implementation. WP4 ships the equal-weight variant only;
	// the smooth/weighted variant is a later work package.
	WeightedRoundRobin Strategy = "WEIGHTED_ROUND_ROBIN"
)

// ParseStrategy normalises a wire value (case- and underscore-insensitive).
func ParseStrategy(s string) (Strategy, bool) {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case string(RoundRobin):
		return RoundRobin, true
	case string(Random):
		return Random, true
	case string(WeightedRoundRobin):
		return WeightedRoundRobin, true
	default:
		return "", false
	}
}

// LoadBalancer selects the upstream for each egress connection. The zero value
// is unusable; use New.
type LoadBalancer struct {
	mu       sync.RWMutex
	strategy Strategy
	targets  []forwarder.Target // clean pool, for reporting
	slots    []forwarder.Target // selection table (weight-expanded)
	cursor   uint64             // round-robin position, atomic to dodge the hot lock
}

// New builds a LoadBalancer. An empty target pool is valid (every Select fails
// until UpdateTargets fills it) so an egress forwarder can start before the
// panel pushes the pool.
func New(strategy Strategy, targets []forwarder.Target) *LoadBalancer {
	s, ok := ParseStrategy(string(strategy))
	if !ok {
		s = RoundRobin
	}
	l := &LoadBalancer{strategy: s}
	l.targets, l.slots = canonical(targets, s)
	return l
}

// maxSlotsPerTarget caps how many expanded slots one target may occupy, so a
// typo like weight=1000000 cannot allocate a huge slice.
const maxSlotsPerTarget = 1024

// canonical validates a pool and expands it into the selection table `slots`.
// For ROUND_ROBIN / RANDOM every target occupies exactly one slot regardless of
// weight (weight only affects the reported pool order); WEIGHTED_ROUND_ROBIN
// expands weight into that many slots, weight < 1 counting as one.
func canonical(in []forwarder.Target, strategy Strategy) (clean, slots []forwarder.Target) {
	clean = make([]forwarder.Target, 0, len(in))
	for _, t := range in {
		if strings.TrimSpace(t.Host) == "" || t.Port <= 0 || t.Port > 65535 {
			continue
		}
		t.Host = strings.TrimSpace(t.Host)
		if t.Weight < 0 {
			t.Weight = 0
		}
		clean = append(clean, t)

		n := 1
		if strategy == WeightedRoundRobin {
			n = t.Weight
			if n < 1 {
				n = 1
			}
			if n > maxSlotsPerTarget {
				n = maxSlotsPerTarget
			}
		}
		for i := 0; i < n; i++ {
			slots = append(slots, t)
		}
	}
	return clean, slots
}

// Select returns the next target, or a zero Target when the pool is empty.
// It satisfies forwarder.TargetSelector; a zero Target's Addr() is "" and the
// caller treats that as "no upstream".
func (l *LoadBalancer) Select() forwarder.Target {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if len(l.slots) == 0 {
		return forwarder.Target{}
	}
	switch l.strategy {
	case Random:
		// math/rand's global source is safe for concurrent use.
		return l.slots[rand.Intn(len(l.slots))]
	case RoundRobin, WeightedRoundRobin:
		idx := int(atomic.AddUint64(&l.cursor, 1)-1) % len(l.slots)
		return l.slots[idx]
	default:
		return l.slots[0]
	}
}

// UpdateTargets atomically replaces the pool and the strategy. Already-open
// connections keep their upstream; every following connection of every
// forwarder using this balancer sees the new pool. The pool is never cleared by
// a bad payload: an empty/invalid target list is ignored rather than installed.
func (l *LoadBalancer) UpdateTargets(strategy Strategy, targets []forwarder.Target) {
	s, ok := ParseStrategy(string(strategy))
	if !ok {
		s = l.rawStrategy()
	}
	clean, slots := canonical(targets, s)
	if len(clean) == 0 {
		return
	}

	l.mu.Lock()
	l.strategy = s
	l.targets = clean
	l.slots = slots
	l.mu.Unlock()
	// Reset the cursor so round robin restarts at the head of the new pool
	// instead of resuming mid-way through an unrelated ordering.
	atomic.StoreUint64(&l.cursor, 0)
}

// rawStrategy reads the active strategy without holding the write lock.
func (l *LoadBalancer) rawStrategy() Strategy {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.strategy
}

// Targets returns a copy of the current pool (for /health and tests).
func (l *LoadBalancer) Targets() []forwarder.Target {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := make([]forwarder.Target, len(l.targets))
	copy(out, l.targets)
	return out
}

// Strategy returns the active strategy.
func (l *LoadBalancer) Strategy() Strategy {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.strategy
}

// Addrs returns the pool as "host:port" strings (for /health and tests).
func (l *LoadBalancer) Addrs() []string {
	targets := l.Targets()
	out := make([]string, 0, len(targets))
	for _, t := range targets {
		if a := t.Addr(); a != "" {
			out = append(out, a)
		}
	}
	return out
}

var _ interface {
	Select() forwarder.Target
} = (*LoadBalancer)(nil)
