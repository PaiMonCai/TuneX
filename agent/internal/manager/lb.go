// The egress target-pool load balancer. Lives in package manager (
// "manager/lb.go — 轮询/随机"), so TunnelManager and EgressManager can share the
// port guard with it.
//
// The contract the egress forwarder depends on is forwarder.TargetSelector;
// LoadBalancer satisfies it and adds atomic snapshot replacement so a
// PATCH /node/targets can retarget every new connection instantly without
// restarting the listener (target snapshot hot update).
package manager

import (
	"hash/fnv"
	"net"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/logx"
)

// Strategy identifies a selection policy.
type Strategy string

const (
	// RoundRobin walks the pool in order, one connection per target.
	RoundRobin Strategy = "ROUND_ROBIN"
	// Random picks a uniformly weighted random target per connection.
	Random Strategy = "RANDOM"
	// Fallback selects the first target in the best admissible health rank.
	Fallback Strategy = "FALLBACK"
	// IPHash maps a trusted client IP onto the best admissible health rank.
	IPHash Strategy = "IP_HASH"

	// WeightedRoundRobin spreads connections over the pool proportionally
	// to each target's weight: a target with weight 3 gets three times the
	// connections of a weight-1 target. Listed twice on purpose — the panel
	// has sent both spellings for the same policy.
	WeightedRoundRobin Strategy = "WEIGHTED_ROUND_ROBIN"
	// WeightedRound is the canonical spelling of the same policy
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
//     WEIGHTED_ROUND_ROBIN) — the persisted form, and what TunnelConfig
//     JSON carries;
//   - the short, lower-case EgressPool names (round / rand / weighted_round) —
//     the Prisma `LBStrategy` enum and the legacy gost selector names
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
	case string(Fallback):
		return Fallback, true
	case string(IPHash):
		return IPHash, true
	default:
		return "", false
	}
}

// String renders the strategy for logs, /health and the heartbeat payload.
func (s Strategy) String() string {
	switch s {
	case RoundRobin, Random, WeightedRoundRobin, Fallback, IPHash:
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

	// Health-aware state. health is nil until a payload carries a `target_health`
	// array: nil is the structural form of "no health signal", and Select takes
	// the ordinary no-health path verbatim while it is nil. bounds are the breaker's
	// injectable bounds/clock (the zero value is the frozen default).
	//
	// forcedPicks counts the connections served while no target was admissible
	// (all open or mid-probe); §7.3 requires that trade to be recorded rather
	// than hidden.
	health      *healthTable
	bounds      BreakerBounds
	forcedPicks uint64
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

// slotCount is how many "connection turns" one target occupies under a
// strategy: exactly the expansion `canonical` applies. Keeping it a function of
// the strategy and the weight — rather than a second table — is what lets the
// health-rank picker reproduce the strategy's distribution inside a rank without
// the two ever drifting apart.
//
// ROUND_ROBIN and RANDOM get one slot per target regardless of weight (round
// robin means every target in turn; random is uniform by definition).
// WEIGHTED_ROUND_ROBIN expands a target into its weight worth of slots.
func slotCount(t forwarder.Target, strategy Strategy) int {
	if strategy != WeightedRoundRobin {
		return 1
	}
	n := t.Weight
	if n < 1 {
		n = 1
	}
	if n > maxSlotsPerTarget {
		n = maxSlotsPerTarget
	}
	return n
}

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
//
// With no health signal the ordinary strategy is unchanged. With one,
// the same strategy is applied inside the best admissible health rank
// (internal/manager/health.go): health reorders, it never replaces the policy.
func (l *LoadBalancer) Select() forwarder.Target {
	return l.SelectForClient("")
}

// SelectForClient is the optional client-aware selector. source must identify
// the real client, supplied by a caller that knows its trust boundary; a relay
// peer is not a client identity. IP_HASH without a valid IP returns no target.
// Ports, IPv6 spelling, zones and IPv4-mapped spelling do not affect the
// hash. Existing connections and UDP mappings never call the selector again.
func (l *LoadBalancer) SelectForClient(source string) forwarder.Target {
	l.mu.RLock()
	if l.strategy == IPHash && clientIP(source) == "" {
		l.mu.RUnlock()
		return forwarder.Target{}
	}
	h := l.health
	var (
		target  forwarder.Target
		entered bool
	)
	if l.strategy == Fallback || l.strategy == IPHash {
		if h == nil {
			target = l.pickAffinity(l.targets, source)
		} else {
			target, entered = l.selectAffinity(h, source)
		}
	} else if h == nil {
		target = l.selectPlain()
	} else {
		target, entered = l.selectHealthAware(h)
	}
	l.mu.RUnlock()

	if entered {
		// Logged outside every lock, and once per episode: this line marks a
		// state transition (the pool had nothing admissible to offer), not a
		// per-connection event — one line per connection would be noise that
		// buries the transition, and the counter still counts them all.
		logx.Warn("egress pool served the least-bad target: nothing is admissible",
			"target", target.Addr(),
			"reason", "every target is open or waiting for a half-open probe result")
	}
	return target
}

// SelectForClient exposes the capability on the Pool actually injected into
// forwarders, without extending forwarder.TargetSelector.
func (p *Pool) SelectForClient(source string) forwarder.Target {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.balancer.SelectForClient(source)
}

// RequiresClientIP lets a runtime reject an unsupported source scope before
// binding its listener. It also covers target-pool policy changes after startup.
func (l *LoadBalancer) RequiresClientIP() bool {
	return l.Strategy() == IPHash
}

func (p *Pool) RequiresClientIP() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.balancer.RequiresClientIP()
}

// clientIP accepts IP literals and socket endpoints, never hostnames or opaque
// relay/mapping keys. Canonicalising before hashing makes affinity depend only
// on the IP, not on the transport connection's ephemeral source port.
func clientIP(source string) string {
	host := strings.TrimSpace(source)
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return ""
	}
	return ip.Unmap().WithZone("").String()
}

// pickAffinity applies only the new policies, preserving input order and
// ignoring weights. The hash matches Forwardx's FNV-1a selection; candidate
// membership/order changes can remap new connections, as with its selector.
// l.mu must be held for reading.
func (l *LoadBalancer) pickAffinity(targets []forwarder.Target, source string) forwarder.Target {
	if len(targets) == 0 {
		return forwarder.Target{}
	}
	if l.strategy == Fallback {
		return targets[0]
	}
	if ip := clientIP(source); ip != "" {
		hash := fnv.New64a()
		_, _ = hash.Write([]byte(ip))
		return targets[hash.Sum64()%uint64(len(targets))]
	}
	return forwarder.Target{}
}

// selectAffinity uses the existing health table's rank, admission and probe
// accounting. It neither derives health from local dial failures nor closes a
// breaker on a panel label: health.go remains the owner of those mechanics.
// l.mu must be held for reading.
func (l *LoadBalancer) selectAffinity(h *healthTable, source string) (forwarder.Target, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.bounds.now()
	bestAdmissible, bestAny := -1, -1
	admissible := make([]forwarder.Target, 0, len(l.targets))
	any := make([]forwarder.Target, 0, len(l.targets))
	for _, t := range l.targets {
		rank, ok := h.admit(t, now)
		if bestAny < 0 || rank < bestAny {
			bestAny = rank
			any = any[:0]
		}
		if rank == bestAny {
			any = append(any, t)
		}
		if !ok {
			continue
		}
		if bestAdmissible < 0 || rank < bestAdmissible {
			bestAdmissible = rank
			admissible = admissible[:0]
		}
		if rank == bestAdmissible {
			admissible = append(admissible, t)
		}
	}
	if bestAny < 0 {
		return forwarder.Target{}, false
	}
	if bestAdmissible < 0 {
		entered := !h.forcedLogged
		h.forcedLogged = true
		atomic.AddUint64(&l.forcedPicks, 1)
		return l.pickAffinity(any, source), entered
	}
	h.forcedLogged = false
	target := l.pickAffinity(admissible, source)
	h.markProbe(target, now, true)
	return target, false
}

// UpdateTargets atomically replaces the pool and the strategy. Already-open
// connections keep their upstream; every following connection of every
// forwarder using this balancer sees the new pool. The pool is never cleared by
// a bad payload: an empty/invalid target list is ignored rather than installed.
//
// A plain target update carries no `target_health`, so it clears the health
// view: the caller is saying what the pool should BE without saying anything
// about how the panel judges it, and the no-health behaviour (no breaker, no
// reordering) is the honest reading of that. Use UpdateTargetsAndHealth for a
// dispatch payload that carries both arrays.
func (l *LoadBalancer) UpdateTargets(strategy Strategy, targets []forwarder.Target) {
	s, ok := ParseStrategy(string(strategy))
	if !ok {
		s = l.rawStrategy()
	}
	clean, slots, weighted := canonical(targets, s)
	if len(clean) == 0 {
		// The payload was ignored, so it says nothing about health either:
		// dropping the breaker here would be a state change from a payload that
		// was refused.
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
	l.UpdateHealth(nil)
}

// UpdateTargetsAndHealth installs BOTH parallel arrays of one egress dispatch
// payload: the desired targets and the panel's health facts.
//
// The two installs are separately locked, and that is enough: a health entry
// only ever speaks about one address, and a target the health array does not
// mention is treated as `unknown` with a closed breaker. So a connection that
// slips between the two installs sees either the old health against the new
// pool (unmentioned targets are unknown, survivors keep a fact that is still
// true of them) or the new health against the new pool — never a wrong pairing
// of a fact with a different target.
func (l *LoadBalancer) UpdateTargetsAndHealth(strategy Strategy, targets []forwarder.Target, health []forwarder.TargetHealth) {
	l.UpdateTargets(strategy, targets)
	l.UpdateHealth(health)
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
