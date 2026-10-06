// Health-aware egress selection is the Agent-side mechanism that sits
// on top of the panel's health model.
//
// What this file is, and what it deliberately is NOT:
//
//   - The health model lives on the panel (target observation → health synthesis,
//     five states, thresholds, hysteresis, staleness). The agent receives those
//     conclusions as the parallel `target_health` array and never invents a
//     second definition of "healthy" (§7.3: "状态模型只有一个"). Nothing here
//     computes a state; it only reads one.
//   - What lives here is a three-state circuit breaker per (pool, target) plus
//     the routing preference order. It changes WHICH target the existing strategy
//     hands out. It never changes the strategy, never rewrites the desired
//     target list, never deletes a target and never persists anything —
//     desired state and this table never touch.
//   - The ONE entry condition is the panel saying `unhealthy`. A local single
//     dial failure never opens a breaker ("单次超时永不判死" holds on this side
//     too); a local outcome is only allowed to resolve a breaker that is
//     already half-open, because that is the only way a probe can ever end.
//
// Everything is bounded, and every bound says WHY at its constant: an unbounded
// cooldown is "remove the target forever" arrived at by arithmetic, and the
// no-health behavior forbids exactly that.
package manager

import (
	"math/rand"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

const (
	// BreakerCooldown is how long a target the panel called `unhealthy` is
	// skipped before the agent may let one connection through to probe it.
	//
	// It protects two things at once: the broken upstream (it is not offered
	// every new connection while it is down) and the pool's recoverability
	// (§7.3 forbids "单次失败永久摘除" — a skipped target must always come back
	// under observation, never disappear). 30s matches the observation/report
	// cadence (targetobs.DefaultInterval), so a target cannot be skipped for
	// much longer than one panel cycle without the agent trying it once itself.
	BreakerCooldown = 30 * time.Second

	// BreakerMaxCooldown caps the doubling backoff after repeated failed
	// probes.
	//
	// It protects recoverability: without a ceiling a target that failed a few
	// probes would be skipped for hours, which is the permanent removal §7.3
	// forbids — reached by arithmetic instead of by a delete, but with the same
	// result. Five minutes keeps a target that is genuinely still broken from
	// being probed constantly, while guaranteeing it is re-examined at a
	// bounded rate forever.
	BreakerMaxCooldown = 5 * time.Minute

	// BreakerHalfOpenAllowance is how many connections a half-open target may
	// have in flight at once. The frozen mechanics fix it at exactly one (a
	// half-open target is being probed, not re-admitted), and it is a named
	// constant so the number appears once, with the thing it protects: a
	// target nobody has evidence about must not be handed the pool's full
	// connection rate on the strength of a cooldown expiring.
	BreakerHalfOpenAllowance = 1

	// BreakerHalfOpenProbeTimeout releases the half-open allowance when the
	// outcome of the probe was never reported back.
	//
	// It protects the target from being wedged out of the pool by a lost
	// outcome — a selector driven without a forwarder that reports, or a dial
	// that never returns. It is deliberately longer than the forwarder's own
	// dialTimeout (10s), so a probe that is still legitimately dialing is never
	// mistaken for a lost one and doubled up on.
	BreakerHalfOpenProbeTimeout = 30 * time.Second
)

// healthRank maps the panel's five states onto the routing preference order
// `healthy > recovering > degraded > unknown > unhealthy`; lower is better.
//
// This is deliberately NOT the synthesis severity order (`unknown < healthy <
// recovering < degraded < unhealthy`). Health synthesis uses severity to merge several
// observers' conclusions, where a real bad conclusion must outrank "no
// evidence". Routing is choosing where to send the NEXT connection, and there "no
// evidence" is worse than "recovering" but better than "the panel just told us
// it is broken" — §7.3 spells that out ("unknown 排在 degraded 之后、unhealthy
// 之前 —— 没有证据不等于好，但也不等于已证实故障"). Both orders are correct for
// their own question, so the routing mapping lives here, in one place, instead of
// being re-derived at each use.
func healthRank(s forwarder.TargetHealthState) int {
	switch s {
	case forwarder.TargetHealthHealthy:
		return 0
	case forwarder.TargetHealthRecovering:
		return 1
	case forwarder.TargetHealthDegraded:
		return 2
	case forwarder.TargetHealthUnhealthy:
		return 4
	default:
		// unknown, and anything the agent could not parse.
		return 3
	}
}

// BreakerBounds are the four mechanism bounds plus the clock, injectable so a
// test can drive cooldown expiry without sleeping and an operator can deviate
// from the frozen defaults deliberately.
//
// The zero value means "use the constants above": production wiring passes the
// zero value, and only a test (or a deliberate decision) sets a field.
type BreakerBounds struct {
	Cooldown     time.Duration
	MaxCooldown  time.Duration
	ProbeTimeout time.Duration
	Allowance    int
	Now          func() time.Time
}

func (b BreakerBounds) cooldown() time.Duration {
	if b.Cooldown > 0 {
		return b.Cooldown
	}
	return BreakerCooldown
}

func (b BreakerBounds) maxCooldown() time.Duration {
	if b.MaxCooldown > 0 {
		return b.MaxCooldown
	}
	return BreakerMaxCooldown
}

func (b BreakerBounds) probeTimeout() time.Duration {
	if b.ProbeTimeout > 0 {
		return b.ProbeTimeout
	}
	return BreakerHalfOpenProbeTimeout
}

func (b BreakerBounds) allowance() int {
	if b.Allowance > 0 {
		return b.Allowance
	}
	return BreakerHalfOpenAllowance
}

func (b BreakerBounds) now() time.Time {
	if b.Now != nil {
		return b.Now()
	}
	return time.Now()
}

// breakerClock is the local mechanism's state, unrelated to the panel's states:
// it says whether this target is currently being skipped, not how the panel
// judges it.
type breakerClock uint8

const (
	// breakerClosed admits the target to selection.
	breakerClosed breakerClock = iota
	// breakerOpen skips the target until its cooldown elapses.
	breakerOpen
	// breakerHalfOpen admits one probing connection.
	breakerHalfOpen
)

func (c breakerClock) String() string {
	switch c {
	case breakerOpen:
		return "open"
	case breakerHalfOpen:
		return "half_open"
	default:
		return "closed"
	}
}

// targetBreaker is the per-(pool, target) record: the panel's last conclusion
// plus the local mechanism state.
type targetBreaker struct {
	// health is the panel's word, last received. It is never computed here.
	health forwarder.TargetHealthState
	clock  breakerClock
	// cooldown is the current backoff while open; it doubles on every failed
	// probe and is reset when the breaker closes.
	cooldown time.Duration
	// since is when the breaker entered open, i.e. the cooldown's origin.
	since time.Time
	// probes counts the half-open connections currently in flight. Anything at
	// or above the allowance means the breaker is waiting for a real result.
	probes  int
	probeAt time.Time
}

// open enters the open state with d as the cooldown origin value.
func (b *targetBreaker) open(now time.Time, d time.Duration) {
	b.clock = breakerOpen
	b.since = now
	b.cooldown = d
	b.probes = 0
}

// close returns the target to normal selection: the next independent
// `unhealthy` starts over from the base cooldown, so a target that recovered
// and broke again is not punished for the previous episode.
func (b *targetBreaker) close(base time.Duration) {
	b.clock = breakerClosed
	b.cooldown = base
	b.probes = 0
}

// refresh advances an expired open breaker to half-open. It is called from
// selection rather than from a timer goroutine: a pool nobody is dialing needs
// no state change, and a per-target timer would be a goroutine per target for a
// fact selection can compute in a comparison.
func (b *targetBreaker) refresh(now time.Time) {
	if b.clock == breakerOpen && now.Sub(b.since) >= b.cooldown {
		b.clock = breakerHalfOpen
		b.probes = 0
	}
}

// admits reports whether the breaker currently lets a connection through.
func (b *targetBreaker) admits(bounds BreakerBounds, now time.Time) bool {
	switch b.clock {
	case breakerClosed:
		return true
	case breakerHalfOpen:
		if b.probes < bounds.allowance() {
			return true
		}
		// The allowance is held by a probe whose outcome never came back.
		// Release it after the bound so a lost result cannot wedge the target
		// out of the pool for the life of the process.
		return now.Sub(b.probeAt) >= bounds.probeTimeout()
	default:
		return false
	}
}

// healthTable is the per-pool join between the panel's health facts and the
// local mechanism. It is owned by one LoadBalancer and protected by its own
// lock, so a dial outcome (reported from the forwarding hot path) never has to
// take the pool's selection lock.
type healthTable struct {
	mu      sync.Mutex
	bounds  BreakerBounds
	entries map[string]*targetBreaker // keyed by forwarder.TargetKey
	// forcedLogged records that the current "nothing is admissible" episode has
	// already produced its log line. The counter counts every forced pick; the
	// log line marks the transition, because one line per connection would be
	// noise that hides the fact it is meant to announce.
	forcedLogged bool
}

func newHealthTable(bounds BreakerBounds) *healthTable {
	return &healthTable{bounds: bounds}
}

// setBounds replaces the bounds. Callers do this before the pool serves, so an
// in-flight selection never sees a half-applied change of both the clock and
// the ceiling.
func (h *healthTable) setBounds(bounds BreakerBounds) {
	h.mu.Lock()
	h.bounds = bounds
	h.mu.Unlock()
}

// install replaces the table's contents with one payload's health array.
//
// Records are CARRIED OVER by target address, not rebuilt: the panel repeats
// its conclusion every cycle, and a breaker whose cooldown restarted on every
// report would never reach half-open — the target would stay skipped forever,
// which is the permanent removal §7.3 forbids. Only the panel's conclusion is
// updated here; the local mechanism state survives it.
func (h *healthTable) install(facts []forwarder.TargetHealth) {
	h.mu.Lock()
	defer h.mu.Unlock()
	next := make(map[string]*targetBreaker, len(facts))
	for _, f := range facts {
		key := f.Key()
		if key == "" {
			// An entry that cannot name a target says nothing about any target.
			continue
		}
		b := next[key]
		if b == nil {
			if prev := h.entries[key]; prev != nil {
				b = prev
			} else {
				b = &targetBreaker{clock: breakerClosed, cooldown: h.bounds.cooldown()}
			}
			next[key] = b
		}
		state := f.StateValue()
		b.health = state
		// The ONE entry condition: the panel's `unhealthy`. A target already
		// open (or mid-probe) keeps its timer; `degraded`/`recovering`/`unknown`
		// never open it, and — deliberately — a later non-unhealthy conclusion
		// does not close it either: §7.3 gives exactly one exit from open (a
		// successful probe), and letting the panel's label close it would make
		// the breaker a second, quieter health model instead of a mechanism.
		//
		// The wire's `evidence` field is NOT consulted. Under the health-synthesis contract
		// evidence=false implies state=unknown ("false ⇒ 结论必然是 unknown"),
		// so it cannot say anything the state has not already said, and reading
		// it as a second gate would add a rule the frozen mechanics do not have.
		if state == forwarder.TargetHealthUnhealthy && b.clock == breakerClosed {
			b.open(h.bounds.now(), h.bounds.cooldown())
		}
	}
	h.entries = next
}

// admit returns the target's routing preference rank and whether the breaker lets
// it through right now. A target the payload did not mention is `unknown` with
// a closed breaker: absence of evidence is not evidence of failure.
func (h *healthTable) admit(t forwarder.Target, now time.Time) (rank int, ok bool) {
	b := h.entries[t.Key()]
	if b == nil {
		return healthRank(forwarder.TargetHealthUnknown), true
	}
	b.refresh(now)
	return healthRank(b.health), b.admits(h.bounds, now)
}

// markProbe consumes the half-open allowance for a connection that is about to
// leave the selector, when that connection really is the probe.
//
// isProbe distinguishes the two ways a half-open target can be chosen: the
// breaker admitting it (a probe) and the all-open fallback (availability
// serving it anyway). A forced pick must NOT touch the clock, or a busy pool
// would keep postponing the release of a probe whose outcome never came back —
// the target would never be probed again.
func (h *healthTable) markProbe(t forwarder.Target, now time.Time, isProbe bool) {
	if !isProbe {
		return
	}
	b := h.entries[t.Key()]
	if b == nil || b.clock != breakerHalfOpen {
		return
	}
	if b.probes < h.bounds.allowance() {
		b.probes++
	}
	// Also refreshed when the previous probe had timed out: this connection is
	// the one holding the allowance now.
	b.probeAt = now
}

// report resolves a probe with the outcome of a real dial.
//
// It only ever touches a HALF-OPEN breaker: a local failure against a closed
// target changes nothing at all (the panel owns "is it broken"), and an outcome
// while open changes nothing either — a connection that was served because
// nothing else was available is not a probe, and must not silently re-admit the
// target the breaker is still holding back.
//
// While the breaker IS half-open, any real outcome resolves it, including one
// carried by a connection the all-open fallback handed out: a dial that reached
// the target is evidence either way, and refusing it because of which code path
// requested it would keep the breaker waiting on a result that never comes.
func (h *healthTable) report(t forwarder.Target, ok bool, now time.Time) {
	key := t.Key()
	if key == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	b := h.entries[key]
	if b == nil || b.clock != breakerHalfOpen {
		return
	}
	if b.probes > 0 {
		b.probes--
	}
	if ok {
		b.close(h.bounds.cooldown())
		return
	}
	next := b.cooldown * 2
	// A doubling that overflows or passes the ceiling lands on the ceiling:
	// §7.3 caps the backoff, because the alternative is removing the target.
	if next <= 0 || next > h.bounds.maxCooldown() {
		next = h.bounds.maxCooldown()
	}
	b.open(now, next)
}

// BreakerState is the reported view of one (pool, target) breaker. Target is
// the normalised identity both arrays are joined on (forwarder.TargetKey), not
// necessarily the spelling the pool happens to carry.
type BreakerState struct {
	Target     string `json:"target"`
	Health     string `json:"health"`
	Breaker    string `json:"breaker"`
	CooldownMs int64  `json:"cooldown_ms,omitempty"`
}

// snapshot renders the table ordered by target address, so two reads of an
// unchanged state are byte-identical and a diff means a real change.
//
// Pending cooldown expiries are applied first: the transition into half-open is
// time-based, and a reported view that still said `open` after the cooldown had
// elapsed would be telling an operator the target is being skipped when it is
// actually about to be probed.
func (h *healthTable) snapshot() []BreakerState {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.bounds.now()
	out := make([]BreakerState, 0, len(h.entries))
	for key, b := range h.entries {
		b.refresh(now)
		out = append(out, BreakerState{
			Target:     key,
			Health:     string(b.health),
			Breaker:    b.clock.String(),
			CooldownMs: b.cooldown.Milliseconds(),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Target < out[j].Target })
	return out
}

// ForcedPicks returns how many connections this pool served while the breaker
// had no admissible target at all (every target open or mid-probe).
//
// The counter exists because §7.3 requires that fact to be observably recorded:
// "refusing to pick anything" would be a worse failure than serving the
// least-bad target, and an operator must be able to see how often this node had
// to make that trade.
func (l *LoadBalancer) ForcedPicks() uint64 {
	return atomic.LoadUint64(&l.forcedPicks)
}

// BreakerStates reports the per-target breaker view of this pool, or an empty
// slice when the pool has never received health (no health signal ⇒ no
// mechanism ⇒ nothing to report, rather than a table of fake `closed`s).
func (l *LoadBalancer) BreakerStates() []BreakerState {
	l.mu.RLock()
	h := l.health
	l.mu.RUnlock()
	if h == nil {
		return []BreakerState{}
	}
	return h.snapshot()
}

// SetBreakerBounds installs the breaker bounds and clock.
//
// Production wiring uses the frozen defaults (the zero value). It is injectable
// so a test can advance time to a cooldown boundary without sleeping; changing
// a bound in production is a deliberate deviation from §7.3, which is why the
// unit each field protects is documented on BreakerBounds and at the constants
// above.
func (l *LoadBalancer) SetBreakerBounds(bounds BreakerBounds) {
	l.mu.Lock()
	l.bounds = bounds
	h := l.health
	l.mu.Unlock()
	if h != nil {
		h.setBounds(bounds)
	}
}

// UpdateHealth installs the panel's parallel health array for this pool.
//
// nil/empty means "this payload carried no health signal" (an older panel, a
// failed health read): the mechanism is switched OFF and its state dropped
// rather than left to rot, so the pool then behaves exactly as it did before
// No health signal means no breaker and no reordering. Keeping a breaker the panel no longer
// describes would mean the agent holding a health conclusion nobody is
// asserting any more.
//
// This method touches ONLY the health view: the desired target list, its order
// and its weights are not read and not written.
func (l *LoadBalancer) UpdateHealth(facts []forwarder.TargetHealth) {
	if len(facts) == 0 {
		l.mu.Lock()
		l.health = nil
		l.mu.Unlock()
		return
	}
	l.mu.Lock()
	h := l.health
	if h == nil {
		h = newHealthTable(l.bounds)
		l.health = h
	}
	l.mu.Unlock()
	h.install(facts)
}

// reportDial is the dial outcome path used by Pool.ReportDial. A pool that has
// never received health has no breaker to resolve, so the outcome is dropped.
func (l *LoadBalancer) reportDial(t forwarder.Target, ok bool) {
	l.mu.RLock()
	h := l.health
	now := l.bounds.now()
	l.mu.RUnlock()
	if h == nil {
		return
	}
	h.report(t, ok, now)
}

// selectPlain is the ordinary selection used without health signals: the strategy over the whole pool,
// untouched by health. It is kept verbatim so "no target_health ⇒ behave
// exactly as today" is a property of the code, not of a careful review.
func (l *LoadBalancer) selectPlain() forwarder.Target {
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

// selectHealthAware is the health-aware reordering. It returns the chosen target and
// whether this call ENTERED an "nothing is admissible" episode (the caller logs
// that outside the locks).
//
// The caller holds l.mu for reading. Only the health table is mutated here, and
// only through its own lock.
func (l *LoadBalancer) selectHealthAware(h *healthTable) (forwarder.Target, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	// now is sampled under the lock: the clock is part of the bounds, and
	// setBounds may be replacing them concurrently.
	now := h.bounds.now()

	// Pass 1: the best rank that is both present and admissible, and the best
	// rank that is merely present. Walking the pool in its own order keeps the
	// result independent of map iteration order.
	bestAdmissible, bestAny := -1, -1
	for i := range l.targets {
		rank, ok := h.admit(l.targets[i], now)
		if bestAny < 0 || rank < bestAny {
			bestAny = rank
		}
		if ok && (bestAdmissible < 0 || rank < bestAdmissible) {
			bestAdmissible = rank
		}
	}
	if bestAny < 0 {
		// Empty pool: the zero Target is the "no upstream" answer the forwarder
		// already knows how to drop a connection for.
		return forwarder.Target{}, false
	}

	entered := false
	if bestAdmissible < 0 {
		// Every target is open or mid-probe. §7.3 is explicit that refusing to
		// pick anything is worse than picking the worst — "一个都不选" 等于把
		// 可用性判死 —— so serve the least-bad target and record the fact. This
		// is NOT a probe: no half-open allowance is consumed, because the
		// breaker did not choose this connection, availability forced it.
		entered = !h.forcedLogged
		h.forcedLogged = true
		atomic.AddUint64(&l.forcedPicks, 1)
		return l.pickRankLocked(h, bestAny, false, now), entered
	}
	h.forcedLogged = false
	return l.pickRankLocked(h, bestAdmissible, true, now), false
}

// pickRankLocked applies the pool's existing strategy to the members of one
// rank, in pool order. eligibleOnly excludes targets the breaker is holding
// back; the all-open fallback passes false to pick the least-bad anyway — and
// it also marks the difference between "the breaker let this through as a
// probe" and "availability served it anyway".
//
// The distribution inside a rank is the same one the strategy gives over the
// whole pool: round-robin and random get one turn per member, weighted
// round-robin gets one turn per weight unit. Health decides WHICH rank is
// eligible, never how the strategy spreads connections inside it.
func (l *LoadBalancer) pickRankLocked(h *healthTable, rank int, eligibleOnly bool, now time.Time) forwarder.Target {
	inRank := func(t forwarder.Target) (forwarder.Target, bool) {
		r, ok := h.admit(t, now)
		if r != rank {
			return forwarder.Target{}, false
		}
		if eligibleOnly && !ok {
			return forwarder.Target{}, false
		}
		return t, true
	}

	// Count first: the cursor can only be mapped onto a member once the size
	// (and, for weighted, the total weight) of the chosen rank is known.
	count, total := 0, 0
	for i := range l.targets {
		if _, ok := inRank(l.targets[i]); !ok {
			continue
		}
		count++
		total += slotCount(l.targets[i], l.strategy)
	}
	if count == 0 {
		return forwarder.Target{}
	}

	weighted := l.strategy == WeightedRoundRobin
	var want int
	switch {
	case l.strategy == Random:
		want = rand.Intn(count)
	case weighted:
		// The cursor arithmetic mirrors selectPlain's weighted branch exactly
		// (including the fact that it starts one slot in), so a health array
		// that says nothing reproduces the ordinary no-health sequence instead of merely
		// the same distribution.
		idx := atomic.AddUint64(&l.cursor, 1)
		want = int(idx % uint64(total))
	default:
		idx := atomic.AddUint64(&l.cursor, 1) - 1
		want = int(idx % uint64(count))
	}

	seen := 0
	for i := range l.targets {
		t, ok := inRank(l.targets[i])
		if !ok {
			continue
		}
		if weighted {
			n := slotCount(t, l.strategy)
			if want < seen+n {
				h.markProbe(t, now, eligibleOnly)
				return t
			}
			seen += n
			continue
		}
		if seen == want {
			h.markProbe(t, now, eligibleOnly)
			return t
		}
		seen++
	}
	return forwarder.Target{}
}
