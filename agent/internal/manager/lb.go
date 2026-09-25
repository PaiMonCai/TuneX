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

	// WeightedRoundRobin spreads connections over the pool proportionally
	// to each target's weight: a target with weight 3 gets three times the
	// connections of a weight-1 target. Listed twice on purpose — the panel
	// has sent both spellings for the same policy.
	WeightedRoundRobin Strategy = "WEIGHTED_ROUND_ROBIN"
	// WeightedRound is the DEVELOPMENT.md §2.2 spelling of the same policy
	// ("第一版负载均衡支持 round / rand / weighted_round"). Both values are
	// accepted so a hand-written or older panel payload still works; they
	// are aliases, not two policies.
	WeightedRound Strategy = "WEIGHTED_ROUND"
)

// ParseStrategy normalises a wire value.
//
// Two families of spellings are accepted, because both are live on the wire:
//
//   - the long, upper-case enum names (ROUND_ROBIN / RANDOM /
//     WEIGHTED_ROUND_ROBIN) — the devmap §3 form, and what the v3 TunnelConfig
//     JSON carries;
//   - the short, lower-case EgressPool names (round / rand / weighted_round) —
//     the Prisma `LBStrategy` enum from WP1 and the legacy gost selector names
//     (control-protocol.ts LOAD_BALANCE_TYPES), which the panel passes through
//     verbatim.
//
// Everything is folded to upper case first, so the comparison is effectively
// case- and hyphen-insensitive; both spellings of a policy resolve to the same
// internal value rather than to two behaviours.
func ParseStrategy(s string) (Strategy, bool) {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case string(RoundRobin), "ROUND":
		return RoundRobin, true
	case string(Random), "RAND":
		return Random, true
	case string(WeightedRoundRobin), string(WeightedRound), "WEIGHTED":
		return WeightedRoundRobin, true
	default:
		return "", false
	}
}

// String renders the strategy for logs, /health and the heartbeat payload.
func (s Strategy) String() string {
	switch s {
	case RoundRobin, Random, WeightedRoundRobin:
		return string(s)
	case "":
		// A pool built before the first strategy arrived reports the
		// fallback rather than an empty string.
		return string(RoundRobin)
	default:
		return string(s)
	}
}

// LoadBalancer selects the upstream for each egress connection. The zero value
// is unusable; use New.
type LoadBalancer struct {
	mu       sync.RWMutex
	strategy Strategy
	targets  []forwarder.Target // clean pool, for reporting
	slots    []forwarder.Target // selection table (weight-expanded)
	// weighted holds the accumulated weight boundary table, used only when
	// strategy is WeightedRoundRobin. It is the "which target does slot i
	// belong to" answer, so Select stays O(log n) even with thousands of
	// connections and a handful of heavy targets.
	weighted []weightSlot
	cursor   uint64 // round-robin position, atomic to dodge the hot lock
}

// weightSlot maps a range of the round-robin cursor onto one target.
type weightSlot struct {
	target forwarder.Target
	upto   uint64 // exclusive upper bound (cumulative weight)
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
	l.targets, l.slots, l.weighted = canonical(targets, s)
	return l
}

// maxSlotsPerTarget caps how many expanded slots one target may occupy, so a
// typo like weight=1000000 cannot allocate a huge slice.
const maxSlotsPerTarget = 1024

// canonical validates a pool and expands it into the selection tables.
//
//	clean    the reported pool (used by Addrs / Targets / Snapshot)
//	slots    one entry per "connection turn" the pool should hand out
//	weighted the same information as (start, end] weight boundaries for
//	         WEIGHTED_ROUND_ROBIN
//
// ROUND_ROBIN and RANDOM get exactly one slot per target regardless of weight
// (round robin means every target in turn; random is uniform by definition).
// WEIGHTED_ROUND_ROBIN expands each target into its weight worth of slots —
// equal weights therefore degrade to plain round robin, which is the sane
// reading of "weighted round robin with all weights equal".
func canonical(in []forwarder.Target, strategy Strategy) (clean, slots []forwarder.Target, weighted []weightSlot) {
	clean = make([]forwarder.Target, 0, len(in))
	var cum uint64
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
			cum += uint64(n)
			weighted = append(weighted, weightSlot{target: t, upto: cum})
		}
		for i := 0; i < n; i++ {
			slots = append(slots, t)
		}
	}
	return clean, slots, weighted
}

// Select returns the next target, or a zero Target when the pool is empty.
// It satisfies forwarder.TargetSelector; a zero Target's Addr() is "" and the
// caller treats that as "no upstream".
func (l *LoadBalancer) Select() forwarder.Target {
	l.mu.RLock()
	defer l.mu.RUnlock()
	switch l.strategy {
	case Random:
		// math/rand's global source is safe for concurrent use.
		if len(l.slots) == 0 {
			return forwarder.Target{}
		}
		return l.slots[rand.Intn(len(l.slots))]
	case WeightedRoundRobin:
		if len(l.weighted) == 0 {
			return forwarder.Target{}
		}
		// Walk the cursor modulo the total weight and binary-search the
		// boundary: the distribution matches the weights exactly, and O(log
		// n) keeps a pool with many targets cheap.
		total := l.weighted[len(l.weighted)-1].upto
		idx := atomic.AddUint64(&l.cursor, 1)
		want := idx % total
		lo := 0
		for hi := len(l.weighted) - 1; lo < hi; {
			mid := int(uint(lo+hi) >> 1)
			if l.weighted[mid].upto > want {
				hi = mid
			} else {
				lo = mid + 1
			}
		}
		return l.weighted[lo].target
	default: // RoundRobin and any unknown strategy degrade to in-turn order.
		if len(l.slots) == 0 {
			return forwarder.Target{}
		}
		idx := int(atomic.AddUint64(&l.cursor, 1)-1) % len(l.slots)
		return l.slots[idx]
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
	clean, slots, weighted := canonical(targets, s)
	if len(clean) == 0 {
		return
	}

	l.mu.Lock()
	l.strategy = s
	l.targets = clean
	l.slots = slots
	l.weighted = weighted
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
