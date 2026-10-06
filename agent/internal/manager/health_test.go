package manager

import (
	"bytes"
	"encoding/json"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// fakeClock is a manually advanced clock: every boundary in this file (cooldown
// expiry, backoff doubling, probe release) is measured by time, and a test that
// sleeps through them would be slow AND flaky in the same breath.
type fakeClock struct {
	mu sync.Mutex
	at time.Time
}

func newFakeClock() *fakeClock { return &fakeClock{at: time.Unix(1700000000, 0)} }

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.at = c.at.Add(d)
	c.mu.Unlock()
}

// th builds one entry of the parallel target_health array.
func th(host string, port int, state string) forwarder.TargetHealth {
	return forwarder.TargetHealth{
		Host:      host,
		Port:      port,
		State:     state,
		LatencyMs: 12,
		AgeMs:     4000,
		Evidence:  state != string(forwarder.TargetHealthUnknown),
	}
}

// healthPool builds a pool with injectable bounds and clock, then installs the
// health facts the way a dispatch payload would.
func healthPool(t *testing.T, strategy Strategy, targets []forwarder.Target, health []forwarder.TargetHealth, clk *fakeClock, bounds BreakerBounds) *Pool {
	t.Helper()
	bounds.Now = clk.now
	p := newPool("eg", strategy, targets)
	p.SetBreakerBounds(bounds)
	p.SetHealth(health)
	return p
}

// mustPool fetches a pool the manager owns, for tests that need to inject the
// breaker clock into a pool created through the public entry points.
func mustPool(t *testing.T, em *EgressManager, id string) *Pool {
	t.Helper()
	p, err := em.poolFor(id)
	if err != nil {
		t.Fatalf("poolFor(%s): %v", id, err)
	}
	return p
}

// breakerOf returns the reported breaker of one target.
func breakerOf(t *testing.T, states []BreakerState, host string, port int) BreakerState {
	t.Helper()
	want := net.JoinHostPort(host, strconv.Itoa(port))
	for _, s := range states {
		if s.Target == want {
			return s
		}
	}
	t.Fatalf("no breaker state for %s in %+v", want, states)
	return BreakerState{}
}

// addrOf renders a target the way BreakerState does.
func addrOf(t forwarder.Target) string { return t.Addr() }

// ---------------------------------------------------------------------------
// the frozen preference order
// ---------------------------------------------------------------------------

// The routing preference order is a different question from synthesis severity, and both are
// load-bearing. This pins the mapping the agent uses to CHOOSE, not the panel's
// order for merging observers' conclusions.
func TestHealthRankIsTheFrozenWP7PreferenceOrder(t *testing.T) {
	cases := []struct {
		state string
		rank  int
	}{
		{"healthy", 0},
		{"recovering", 1},
		{"degraded", 2},
		{"unknown", 3},
		{"unhealthy", 4},
		// Anything the agent cannot read is "no evidence", never "healthy" and
		// never "broken".
		{"HEALTHY", 0}, // case-insensitive: the panel's spelling is frozen, not its casing
		{"bogus", 3},
		{"", 3},
	}
	prev := -1
	for _, c := range cases[:5] {
		got := healthRank(forwarder.ParseTargetHealthState(c.state))
		if got != c.rank {
			t.Errorf("healthRank(%q) = %d, want %d", c.state, got, c.rank)
		}
		if got <= prev {
			t.Errorf("rank(%q)=%d must be strictly worse than the previous state's %d", c.state, got, prev)
		}
		prev = got
	}
	for _, c := range cases[5:] {
		if got := healthRank(forwarder.ParseTargetHealthState(c.state)); got != c.rank {
			t.Errorf("healthRank(%q) = %d, want %d", c.state, got, c.rank)
		}
	}
}

// The frozen bounds must stay bounded and sane; this is the guard against a
// future edit that makes the ceiling below the floor or releases the frozen
// "exactly one probe".
func TestBreakerDefaultBounds(t *testing.T) {
	if BreakerHalfOpenAllowance != 1 {
		t.Fatalf("BreakerHalfOpenAllowance = %d, want exactly 1 (one probe at a time)", BreakerHalfOpenAllowance)
	}
	if BreakerMaxCooldown <= BreakerCooldown {
		t.Fatalf("max cooldown %s must exceed the base cooldown %s, or the cap is a floor", BreakerMaxCooldown, BreakerCooldown)
	}
	// The probe release must outlast a real dial attempt, or a slow-but-live
	// probe would be treated as a lost one and doubled up on.
	if BreakerHalfOpenProbeTimeout <= 10*time.Second {
		t.Fatalf("probe timeout %s must exceed the forwarder dial budget (10s)", BreakerHalfOpenProbeTimeout)
	}
	// The zero-value bounds must resolve to the constants, so production wiring
	// that passes nothing gets the frozen numbers.
	var zero BreakerBounds
	if zero.cooldown() != BreakerCooldown || zero.maxCooldown() != BreakerMaxCooldown ||
		zero.probeTimeout() != BreakerHalfOpenProbeTimeout || zero.allowance() != BreakerHalfOpenAllowance {
		t.Fatal("the zero BreakerBounds must mean the frozen defaults")
	}
}

// ---------------------------------------------------------------------------
// the entry condition
// ---------------------------------------------------------------------------

// Only the panel's `unhealthy` opens a breaker. Everything else — including
// `unknown`, which is the absence of evidence — leaves the target fully
// selectable, and a local dial failure never opens anything.
func TestOnlyPanelUnhealthyOpensTheBreaker(t *testing.T) {
	for _, state := range []string{"healthy", "recovering", "degraded", "unknown", "bogus", ""} {
		t.Run(state, func(t *testing.T) {
			clk := newFakeClock()
			a, b := tg("10.0.0.1", 443), tg("10.0.0.2", 443)
			p := healthPool(t, RoundRobin, []forwarder.Target{a, b},
				[]forwarder.TargetHealth{th("10.0.0.1", 443, state), th("10.0.0.2", 443, state)}, clk, BreakerBounds{})

			for _, s := range p.BreakerStates() {
				if s.Breaker != "closed" {
					t.Fatalf("state %q opened the breaker: %+v", state, s)
				}
			}
			// A local failure against a closed breaker must change nothing at
			// all: "单次超时永不判死" holds on the agent side too.
			for i := 0; i < 5; i++ {
				p.ReportDial(a, false)
			}
			for _, s := range p.BreakerStates() {
				if s.Breaker != "closed" {
					t.Fatalf("a local failure opened the breaker for state %q: %+v", state, s)
				}
			}
			// Both targets stay reachable: no ranking may delete a target, and
			// with equal ranks the strategy still walks them all.
			seen := map[string]int{}
			for i := 0; i < 4; i++ {
				seen[addrOf(p.Select())]++
			}
			if len(seen) != 2 {
				t.Fatalf("state %q removed a target from selection: %v", state, seen)
			}
			if p.ForcedPicks() != 0 {
				t.Fatalf("state %q forced picks: %d", state, p.ForcedPicks())
			}
		})
	}
}

func TestPanelUnhealthyOpensTheBreakerAndSkipsTheTarget(t *testing.T) {
	clk := newFakeClock()
	a, b := tg("10.0.0.1", 443), tg("10.0.0.2", 443)
	p := healthPool(t, RoundRobin, []forwarder.Target{a, b},
		[]forwarder.TargetHealth{th("10.0.0.1", 443, "unhealthy"), th("10.0.0.2", 443, "healthy")}, clk, BreakerBounds{})

	if got := breakerOf(t, p.BreakerStates(), "10.0.0.1", 443); got.Breaker != "open" || got.Health != "unhealthy" {
		t.Fatalf("unhealthy target breaker = %+v, want open/unhealthy", got)
	}
	if got := breakerOf(t, p.BreakerStates(), "10.0.0.2", 443); got.Breaker != "closed" {
		t.Fatalf("healthy target breaker = %+v, want closed", got)
	}
	// The open target is skipped entirely while a healthy one exists, and that
	// is not a forced pick: there WAS an admissible target.
	for i := 0; i < 6; i++ {
		if got := addrOf(p.Select()); got != "10.0.0.2:443" {
			t.Fatalf("pick %d = %s, want the healthy target 10.0.0.2:443", i, got)
		}
	}
	if p.ForcedPicks() != 0 {
		t.Fatalf("ForcedPicks = %d, want 0 while a healthy target exists", p.ForcedPicks())
	}
}

// The panel repeating `unhealthy` every cycle must not restart the cooldown:
// otherwise the breaker would never reach half-open and the target would be
// removed forever by arithmetic — exactly what §7.3 forbids.
func TestRepeatedUnhealthyPayloadsDoNotRestartTheCooldown(t *testing.T) {
	clk := newFakeClock()
	a := tg("10.0.0.1", 443)
	p := healthPool(t, RoundRobin, []forwarder.Target{a},
		[]forwarder.TargetHealth{th("10.0.0.1", 443, "unhealthy")}, clk, BreakerBounds{Cooldown: time.Minute})

	clk.advance(time.Minute)
	// The panel says the same thing again, as it does every report cycle.
	clk.advance(0)
	p.SetHealth([]forwarder.TargetHealth{th("10.0.0.1", 443, "unhealthy")})

	if got := breakerOf(t, p.BreakerStates(), "10.0.0.1", 443); got.Breaker != "half_open" {
		t.Fatalf("breaker = %+v after the cooldown expired under a repeated payload, want half_open", got)
	}
	// And the half-open state really lets a probe through.
	if got := addrOf(p.Select()); got != "10.0.0.1:443" {
		t.Fatalf("Select = %q, want the half-open target", got)
	}
}

// ---------------------------------------------------------------------------
// the preference order in practice
// ---------------------------------------------------------------------------

// Walking one target at a time through `unhealthy` shows the exact frozen
// order. Each step asserts a property — the pool only ever hands out targets of
// the best rank that is still admissible — rather than a table of picks.
func TestSelectionFollowsHealthyRecoveringDegradedUnknownUnhealthy(t *testing.T) {
	clk := newFakeClock()
	targets := []forwarder.Target{
		tg("10.0.0.1", 443), // healthy
		tg("10.0.0.2", 443), // recovering
		tg("10.0.0.3", 443), // degraded
		tg("10.0.0.4", 443), // unknown
		tg("10.0.0.5", 443), // unhealthy
	}
	health := []forwarder.TargetHealth{
		th("10.0.0.1", 443, "healthy"),
		th("10.0.0.2", 443, "recovering"),
		th("10.0.0.3", 443, "degraded"),
		th("10.0.0.4", 443, "unknown"),
		th("10.0.0.5", 443, "unhealthy"),
	}
	p := healthPool(t, RoundRobin, targets, health, clk, BreakerBounds{})

	// Step 0: healthy wins; step i: the target that won step i-1 is now
	// pronounced unhealthy and must drop out, so the next-best state wins.
	// The last winner (`unknown`) is left in place for the final phase.
	want := []string{"10.0.0.1:443", "10.0.0.2:443", "10.0.0.3:443"}
	for step, wantAddr := range want {
		for i := 0; i < 3; i++ {
			if got := addrOf(p.Select()); got != wantAddr {
				t.Fatalf("step %d pick %d = %q, want %q (the best admissible rank)", step, i, got, wantAddr)
			}
		}
		// Drop the winner out of the running by pronouncing it unhealthy; its
		// breaker must open, which is what makes the next rank the best one.
		health[step].State = "unhealthy"
		p.SetHealth(health)
		host, portStr, _ := net.SplitHostPort(wantAddr)
		port, _ := strconv.Atoi(portStr)
		if got := breakerOf(t, p.BreakerStates(), host, port); got.Breaker != "open" {
			t.Fatalf("step %d: the demoted target's breaker = %+v, want open", step, got)
		}
		if p.ForcedPicks() != 0 {
			t.Fatalf("step %d: ForcedPicks = %d while a better rank is still available", step, p.ForcedPicks())
		}
	}

	// The last target standing is `unknown`, and it is still reachable: unknown
	// is not a reason to skip anything, only to prefer others.
	if got := addrOf(p.Select()); got != "10.0.0.4:443" {
		t.Fatalf("pick = %q, want the unknown target 10.0.0.4:443", got)
	}

	// Now pronounce it unhealthy too: every target is open, so the pool must
	// still serve one — and record that it did.
	health[3].State = "unhealthy"
	p.SetHealth(health)
	if got := addrOf(p.Select()); got == "" {
		t.Fatal("an all-open pool must still yield a target")
	}
	if p.ForcedPicks() == 0 {
		t.Fatal("serving a target while every breaker is open must be recorded")
	}
}

// ---------------------------------------------------------------------------
// cooldown → half-open → probe outcome
// ---------------------------------------------------------------------------

// Cooldown expiry admits the target again — exactly one connection at a time —
// and a successful probe closes the breaker.
func TestHalfOpenAdmitsExactlyOneProbeAndSuccessCloses(t *testing.T) {
	clk := newFakeClock()
	a, b := tg("10.0.0.1", 443), tg("10.0.0.2", 443)
	unhealthy := []forwarder.TargetHealth{th("10.0.0.1", 443, "unhealthy"), th("10.0.0.2", 443, "unhealthy")}
	p := healthPool(t, RoundRobin, []forwarder.Target{a, b}, unhealthy, clk, BreakerBounds{Cooldown: time.Minute})

	// Both open: the pool still serves something, and says so.
	if got := addrOf(p.Select()); got == "" {
		t.Fatal("an all-open pool must still yield a target")
	}
	if p.ForcedPicks() != 1 {
		t.Fatalf("ForcedPicks = %d after one all-open pick, want 1", p.ForcedPicks())
	}

	clk.advance(time.Minute)
	for _, s := range p.BreakerStates() {
		if s.Breaker != "half_open" {
			t.Fatalf("breaker after the cooldown = %+v, want half_open", s)
		}
	}

	// One connection per half-open target: two picks cover both, and a third
	// has nothing admissible left until a probe is resolved.
	first, second := addrOf(p.Select()), addrOf(p.Select())
	if first == second {
		t.Fatalf("half-open handed out %q twice; the allowance is one connection", first)
	}
	if got := addrOf(p.Select()); got == "" {
		t.Fatal("a pool waiting on probe results must still serve a connection")
	}
	if p.ForcedPicks() != 2 {
		t.Fatalf("ForcedPicks = %d, want 2: the third pick had no admissible target", p.ForcedPicks())
	}

	// A successful probe closes that target: it is admissible again while the
	// other still holds its allowance.
	p.ReportDial(a, true)
	states := p.BreakerStates()
	if got := breakerOf(t, states, "10.0.0.1", 443); got.Breaker != "closed" {
		t.Fatalf("breaker after a successful probe = %+v, want closed", got)
	}
	if got := breakerOf(t, states, "10.0.0.2", 443); got.Breaker != "half_open" {
		t.Fatalf("breaker of the still-probing target = %+v, want half_open", got)
	}
	if got := addrOf(p.Select()); got != "10.0.0.1:443" {
		t.Fatalf("pick = %q, want the recovered target (the other has no allowance left)", got)
	}
}

// A failed probe re-opens the breaker with a doubled backoff, and the doubling
// is capped so the target is never removed for good.
func TestHalfOpenFailureReopensWithDoubledCappedBackoff(t *testing.T) {
	clk := newFakeClock()
	a := tg("10.0.0.1", 443)
	p := healthPool(t, RoundRobin, []forwarder.Target{a},
		[]forwarder.TargetHealth{th("10.0.0.1", 443, "unhealthy")}, clk,
		BreakerBounds{Cooldown: time.Minute, MaxCooldown: 4 * time.Minute})

	// probe advances to the end of the CURRENT cooldown, then hands out the one
	// connection the half-open state allows. Reading the cooldown from the
	// reported state is what makes the doubling observable as a duration rather
	// than as a hard-coded sleep.
	probe := func() {
		t.Helper()
		state := breakerOf(t, p.BreakerStates(), "10.0.0.1", 443)
		clk.advance(time.Duration(state.CooldownMs) * time.Millisecond)
		if got := addrOf(p.Select()); got != "10.0.0.1:443" {
			t.Fatalf("Select = %q, want the half-open probe target", got)
		}
		if got := breakerOf(t, p.BreakerStates(), "10.0.0.1", 443); got.Breaker != "half_open" {
			t.Fatalf("breaker = %+v before the probe result, want half_open", got)
		}
	}

	// While the cooldown runs the target is skipped and every connection is a
	// recorded forced pick.
	if got := addrOf(p.Select()); got != "10.0.0.1:443" {
		t.Fatalf("Select = %q while open, want the only (forced) target", got)
	}
	if p.ForcedPicks() != 1 {
		t.Fatalf("ForcedPicks = %d, want 1 while the only target is open", p.ForcedPicks())
	}

	probe()
	p.ReportDial(a, false)
	if got := breakerOf(t, p.BreakerStates(), "10.0.0.1", 443); got.Breaker != "open" || got.CooldownMs != int64(time.Minute*2/time.Millisecond) {
		t.Fatalf("after the first failed probe: %+v, want open with a doubled cooldown", got)
	}

	probe()
	p.ReportDial(a, false)
	if got := breakerOf(t, p.BreakerStates(), "10.0.0.1", 443); got.CooldownMs != int64(4*time.Minute/time.Millisecond) {
		t.Fatalf("after the second failed probe: %+v, want a 4m cooldown", got)
	}

	probe()
	p.ReportDial(a, false)
	if got := breakerOf(t, p.BreakerStates(), "10.0.0.1", 443); got.Breaker != "open" || got.CooldownMs != int64(4*time.Minute/time.Millisecond) {
		t.Fatalf("after the third failed probe: %+v, want the backoff capped at the max", got)
	}

	// A later success closes it and resets the backoff, so one bad episode does
	// not follow the target around.
	probe()
	p.ReportDial(a, true)
	if got := breakerOf(t, p.BreakerStates(), "10.0.0.1", 443); got.Breaker != "closed" || got.CooldownMs != int64(time.Minute/time.Millisecond) {
		t.Fatalf("after a successful probe: %+v, want closed with the base cooldown", got)
	}
	if p.ForcedPicks() != 1 {
		t.Fatalf("ForcedPicks = %d, want the single forced pick from the first open window", p.ForcedPicks())
	}
}

// A probe whose outcome never comes back must not wedge the target out of the
// pool for the life of the process.
func TestLostProbeOutcomeIsReleasedAfterTheProbeTimeout(t *testing.T) {
	clk := newFakeClock()
	a := tg("10.0.0.1", 443)
	p := healthPool(t, RoundRobin, []forwarder.Target{a},
		[]forwarder.TargetHealth{th("10.0.0.1", 443, "unhealthy")}, clk,
		BreakerBounds{Cooldown: time.Minute})

	clk.advance(time.Minute)
	if got := addrOf(p.Select()); got != "10.0.0.1:443" {
		t.Fatalf("Select = %q, want the probe", got)
	}
	// The allowance is held: a second connection is a forced pick, not a probe.
	p.Select()
	if p.ForcedPicks() != 1 {
		t.Fatalf("ForcedPicks = %d, want 1 while the probe allowance is held", p.ForcedPicks())
	}
	// Once the probe outlives the bound, the pool probes again instead of
	// dropping every connection forever.
	clk.advance(BreakerHalfOpenProbeTimeout)
	if got := breakerOf(t, p.BreakerStates(), "10.0.0.1", 443); got.Breaker != "half_open" {
		t.Fatalf("breaker = %+v, want half_open (not wedged)", got)
	}
	if got := p.Select(); addrOf(got) != "10.0.0.1:443" {
		t.Fatalf("Select = %q, want the target again after the probe released", addrOf(got))
	}
}

// A connection served by the all-open fallback is not a probe, so it must not
// restock the half-open allowance. If it did, a busy pool would keep postponing
// the release of a probe whose outcome never came back and the target would
// never be probed again — every connection staying a forced pick forever.
func TestForcedPickDoesNotPostponeTheLostProbeRelease(t *testing.T) {
	clk := newFakeClock()
	a := tg("10.0.0.1", 443)
	p := healthPool(t, RoundRobin, []forwarder.Target{a},
		[]forwarder.TargetHealth{th("10.0.0.1", 443, "unhealthy")}, clk,
		BreakerBounds{Cooldown: time.Minute, ProbeTimeout: 10 * time.Minute})

	clk.advance(time.Minute)
	p.Select() // the probe, handed out at t=1m

	clk.advance(10 * time.Minute)
	p.Select() // t=11m: the lost probe is released, and this becomes the new probe

	clk.advance(6 * time.Minute)
	p.Select() // t=17m: 6m into the allowance — served, but not as a probe

	forced := p.ForcedPicks()
	clk.advance(6 * time.Minute)
	p.Select() // t=23m: 12m since the last real probe, so the allowance is free again
	if got := p.ForcedPicks(); got != forced {
		t.Fatalf("ForcedPicks = %d, want %d: a non-probe pick must not restock the half-open allowance",
			got, forced)
	}

	// A real outcome still resolves the breaker, whichever connection carried
	// it: a dial that reached the target is evidence either way.
	p.ReportDial(a, true)
	if got := breakerOf(t, p.BreakerStates(), "10.0.0.1", 443); got.Breaker != "closed" {
		t.Fatalf("breaker = %+v after a reported success, want closed", got)
	}
}

// ---------------------------------------------------------------------------
// all open: still serve, and record it
// ---------------------------------------------------------------------------

// "Refusing to pick anything" is the worse failure, so an all-open pool serves
// the least-bad target and records the fact. The least-bad target is the one the
// panel judges least badly — not an arbitrary one.
func TestAllOpenStillPicksTheLeastBadAndRecordsIt(t *testing.T) {
	clk := newFakeClock()
	best, worst := tg("10.0.0.1", 443), tg("10.0.0.2", 443)

	// Open both breakers, then let the panel improve one of them. A non-
	// unhealthy conclusion does not close a breaker (§7.3 gives exactly one
	// exit: a successful probe), but it does change the ranking — which is what
	// "least-bad" means.
	p := healthPool(t, RoundRobin, []forwarder.Target{best, worst},
		[]forwarder.TargetHealth{th("10.0.0.1", 443, "unhealthy"), th("10.0.0.2", 443, "unhealthy")}, clk, BreakerBounds{})
	p.SetHealth([]forwarder.TargetHealth{th("10.0.0.1", 443, "degraded"), th("10.0.0.2", 443, "unhealthy")})

	states := p.BreakerStates()
	if got := breakerOf(t, states, "10.0.0.1", 443); got.Breaker != "open" {
		t.Fatalf("a non-unhealthy payload closed an open breaker: %+v", got)
	}
	if got := breakerOf(t, states, "10.0.0.2", 443); got.Breaker != "open" {
		t.Fatalf("breaker = %+v, want open", got)
	}

	for i := 0; i < 3; i++ {
		if got := addrOf(p.Select()); got != "10.0.0.1:443" {
			t.Fatalf("all-open pick %d = %q, want the least-bad target 10.0.0.1:443", i, got)
		}
	}
	if p.ForcedPicks() != 3 {
		t.Fatalf("ForcedPicks = %d, want every all-open connection counted", p.ForcedPicks())
	}
}

// The "we served a target the breaker wanted to skip" fact is observable in the
// reported pool view, not only in the process log: an operator looking at
// /health must be able to see that this node is trading policy for availability.
func TestForcedPicksAreObservableInThePoolSnapshot(t *testing.T) {
	clk := newFakeClock()
	em := NewEgressManager()
	em.SetPoolAndHealth("eg", RoundRobin,
		[]forwarder.Target{tg("10.0.0.1", 443)},
		[]forwarder.TargetHealth{th("10.0.0.1", 443, "unhealthy")})
	p := mustPool(t, em, "eg")
	p.SetBreakerBounds(BreakerBounds{Now: clk.now})

	if got := em.Snapshot()["eg"].ForcedPicks; got != 0 {
		t.Fatalf("ForcedPicks before any connection = %d, want 0", got)
	}
	p.Select()
	p.Select()
	if got := em.Snapshot()["eg"].ForcedPicks; got != 2 {
		t.Fatalf("snapshot ForcedPicks = %d, want 2", got)
	}
	// The reported pool itself is still the desired pool: the counter records a
	// decision, it does not rewrite what this node is supposed to serve.
	snap := em.Snapshot()["eg"]
	if len(snap.Targets) != 1 || snap.Targets[0] != "10.0.0.1:443" || snap.Strategy != string(RoundRobin) {
		t.Fatalf("snapshot = %+v, want the unchanged desired pool", snap)
	}
}

// ---------------------------------------------------------------------------
// no health signal ⇒ exactly the old behaviour
// ---------------------------------------------------------------------------

// A dispatch without `target_health` (an older panel) must behave exactly as it
// does without health input: no breaker, no reordering, no record — the same picks, in the
// same order, as a balancer that has never heard of health.
func TestNoHealthSignalBehavesExactlyAsBeforeTheMechanism(t *testing.T) {
	for _, strategy := range []Strategy{RoundRobin, WeightedRoundRobin} {
		t.Run(string(strategy), func(t *testing.T) {
			targets := []forwarder.Target{
				{Host: "10.0.0.1", Port: 443, Weight: 1},
				{Host: "10.0.0.2", Port: 443, Weight: 3},
				{Host: "10.0.0.3", Port: 443, Weight: 2},
			}
			plain := New(strategy, targets)
			pool := newPool("eg", strategy, targets)
			// A local dial failure, with no health facts, must not invent a
			// breaker either.
			for i := 0; i < 30; i++ {
				want := addrOf(plain.Select())
				got := addrOf(pool.Select())
				if got != want {
					t.Fatalf("pick %d = %q, want %q (identical to the no-health balancer)", i, got, want)
				}
				pool.ReportDial(targets[i%len(targets)], false)
			}
			if pool.ForcedPicks() != 0 {
				t.Fatalf("ForcedPicks = %d without any health signal, want 0", pool.ForcedPicks())
			}
			if got := pool.BreakerStates(); len(got) != 0 {
				t.Fatalf("BreakerStates without any health signal = %+v, want empty", got)
			}

			// A payload that says nothing (`unknown` for everyone) is not a
			// reordering either: equal ranks must reproduce the same sequence.
			clk := newFakeClock()
			p2 := healthPool(t, strategy, targets, []forwarder.TargetHealth{
				th("10.0.0.1", 443, "unknown"),
				th("10.0.0.2", 443, "unknown"),
				th("10.0.0.3", 443, "unknown"),
			}, clk, BreakerBounds{})
			plain2 := New(strategy, targets)
			for i := 0; i < 30; i++ {
				want := addrOf(plain2.Select())
				if got := addrOf(p2.Select()); got != want {
					t.Fatalf("all-unknown pick %d = %q, want %q (a signal that says nothing changes nothing)", i, got, want)
				}
			}
			if p2.ForcedPicks() != 0 {
				t.Fatalf("ForcedPicks = %d with all targets unknown, want 0", p2.ForcedPicks())
			}
		})
	}
}

// A payload without `target_health` also switches the mechanism back off for a
// pool that had received health before: the agent must not keep a health
// conclusion nobody is asserting any more.
func TestAPayloadWithoutHealthTurnsTheMechanismOff(t *testing.T) {
	clk := newFakeClock()
	a, b := tg("10.0.0.1", 443), tg("10.0.0.2", 443)
	p := healthPool(t, RoundRobin, []forwarder.Target{a, b},
		[]forwarder.TargetHealth{th("10.0.0.1", 443, "unhealthy"), th("10.0.0.2", 443, "healthy")}, clk, BreakerBounds{})
	if got := addrOf(p.Select()); got != "10.0.0.2:443" {
		t.Fatalf("Select = %q, want the healthy target while health is installed", got)
	}

	p.SwapTargets(RoundRobin, []forwarder.Target{a, b})
	if got := p.BreakerStates(); len(got) != 0 {
		t.Fatalf("BreakerStates after a health-less update = %+v, want empty", got)
	}
	// The open target is back in rotation (the payload said nothing about it),
	// and the strategy walks both again.
	seen := map[string]int{}
	for i := 0; i < 4; i++ {
		seen[addrOf(p.Select())]++
	}
	if len(seen) != 2 {
		t.Fatalf("health-less update did not restore the plain pool: %v", seen)
	}
}

// ---------------------------------------------------------------------------
// the two arrays are joined on one identity
// ---------------------------------------------------------------------------

// The health array names targets the way the panel names them (normalised);
// the pool carries them the way they were configured. A case-folded or
// bracket-normalised host must still meet its target, or a real "unhealthy"
// would become a silent no-op — the worst possible failure mode, because the
// breaker would simply never open and nothing would say why.
func TestHealthJoinsThePanelSpellingToTheConfiguredTarget(t *testing.T) {
	clk := newFakeClock()
	configured := forwarder.Target{Host: "EXAMPLE.com.", Port: 443, Weight: 1}
	other := tg("10.0.0.2", 443)
	p := healthPool(t, RoundRobin, []forwarder.Target{configured, other},
		[]forwarder.TargetHealth{th("example.com", 443, "unhealthy"), th("10.0.0.2", 443, "healthy")},
		clk, BreakerBounds{})

	states := p.BreakerStates()
	if len(states) != 2 {
		t.Fatalf("breaker states = %+v, want both targets joined", states)
	}
	for _, s := range states {
		switch s.Target {
		case "example.com:443":
			if s.Breaker != "open" {
				t.Fatalf("the normalised identity did not meet its target: %+v", s)
			}
		case "10.0.0.2:443":
			if s.Breaker != "closed" {
				t.Fatalf("breaker = %+v, want closed", s)
			}
		default:
			t.Fatalf("unexpected target identity in the reported view: %q", s.Target)
		}
	}
	// And the joined target is really skipped in selection.
	for i := 0; i < 3; i++ {
		if got := addrOf(p.Select()); got != "10.0.0.2:443" {
			t.Fatalf("pick %d = %q, want the healthy target", i, got)
		}
	}
}

// ---------------------------------------------------------------------------
// health is per (pool, target)
// ---------------------------------------------------------------------------
func TestHealthIsScopedToThePoolThatReceivedIt(t *testing.T) {
	clk := newFakeClock()
	em := NewEgressManager()
	em.SetPoolAndHealth("pool-a", RoundRobin,
		[]forwarder.Target{tg("10.0.0.1", 443)},
		[]forwarder.TargetHealth{th("10.0.0.1", 443, "unhealthy")})
	em.SetPool("pool-b", RoundRobin, []forwarder.Target{tg("10.0.0.1", 443)})
	mustPool(t, em, "pool-a").SetBreakerBounds(BreakerBounds{Now: clk.now})

	if got := em.BreakerStates("pool-a"); len(got) != 1 || got[0].Breaker != "open" {
		t.Fatalf("pool-a breakers = %+v, want one open breaker", got)
	}
	if got := em.BreakerStates("pool-b"); len(got) != 0 {
		t.Fatalf("pool-b breakers = %+v, want empty: health is per pool", got)
	}
	// The same address in another pool is a different target, and it is
	// untouched by pool-a's verdict — while pool-a's copy is skipped and its
	// connection counted as forced.
	if got := addrOf(mustPool(t, em, "pool-b").Select()); got != "10.0.0.1:443" {
		t.Fatalf("pool-b Select = %q, want the untouched target", got)
	}
	if got := addrOf(mustPool(t, em, "pool-a").Select()); got != "10.0.0.1:443" {
		t.Fatalf("pool-a Select = %q, want the least-bad (forced) target", got)
	}
	if got := mustPool(t, em, "pool-a").ForcedPicks(); got != 1 {
		t.Fatalf("pool-a ForcedPicks = %d, want 1", got)
	}
	if got := mustPool(t, em, "pool-b").ForcedPicks(); got != 0 {
		t.Fatalf("pool-b ForcedPicks = %d, want 0", got)
	}
	if got := em.BreakerStates("nope"); len(got) != 0 {
		t.Fatalf("breakers of an unknown tunnel = %+v, want empty", got)
	}
}

// ---------------------------------------------------------------------------
// the strongest assertion: telemetry never rewrites desired
// ---------------------------------------------------------------------------

// The whole health-aware mechanism runs — unhealthy, cooldown, probes, failures, the
// all-open fallback, payloads with extra and missing entries, garbage states —
// and the desired target list must come out byte-identical. That is what
// "telemetry never rewrites desired" means in practice, and it is asserted on
// the exact accessor the target observer enumerates from.
func TestHealthNeverRewritesDesiredTargets(t *testing.T) {
	clk := newFakeClock()
	em := NewEgressManager()
	desired := []forwarder.Target{
		{Host: "10.0.0.1", Port: 443, Weight: 3, Order: 10, Remark: "primary"},
		{Host: "10.0.0.2", Port: 8443, Weight: 1, Order: 20},
		{Host: "10.0.0.3", Port: 443, Weight: 1, Order: 30},
	}
	em.SetPool("eg", WeightedRoundRobin, desired)
	p := mustPool(t, em, "eg")
	p.SetBreakerBounds(BreakerBounds{Now: clk.now, Cooldown: time.Minute, MaxCooldown: 2 * time.Minute})

	beforeDesired, err := json.Marshal(em.DesiredTargets())
	if err != nil {
		t.Fatal(err)
	}
	beforePool, err := json.Marshal(p.Targets())
	if err != nil {
		t.Fatal(err)
	}
	beforeAddrs := append([]string(nil), p.Addrs()...)
	beforeStrategy := p.Strategy()

	// desiredUnchanged is the assertion the whole work package exists for, and
	// it is checked at EVERY step rather than once at the end: a transient
	// rewrite that a later install happens to heal is still a rewrite, and a
	// single comparison at the end would never see it.
	desiredUnchanged := func(step string) {
		t.Helper()
		after, err := json.Marshal(em.DesiredTargets())
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(beforeDesired, after) {
			t.Fatalf("%s: desired state changed:\n before %s\n after  %s", step, beforeDesired, after)
		}
		pool, err := json.Marshal(p.Targets())
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(beforePool, pool) {
			t.Fatalf("%s: pool contents changed:\n before %s\n after  %s", step, beforePool, pool)
		}
		if got := p.Strategy(); got != beforeStrategy {
			t.Fatalf("%s: strategy changed to %q, want %q", step, got, beforeStrategy)
		}
		if got := p.Addrs(); len(got) != len(beforeAddrs) {
			t.Fatalf("%s: addrs = %v, want %v", step, got, beforeAddrs)
		} else {
			for i := range got {
				if got[i] != beforeAddrs[i] {
					t.Fatalf("%s: addrs[%d] = %q, want %q", step, i, got[i], beforeAddrs[i])
				}
			}
		}
	}

	health := []forwarder.TargetHealth{
		th("10.0.0.1", 443, "unhealthy"),
		th("10.0.0.2", 8443, "degraded"),
		th("10.0.0.3", 443, "healthy"),
	}
	p.SwapTargetsAndHealth(WeightedRoundRobin, desired, health)
	if len(p.BreakerStates()) != 3 {
		t.Fatalf("the module did not receive the health facts: %+v", p.BreakerStates())
	}
	desiredUnchanged("after the health-carrying dispatch")

	// Drive every branch of the mechanism.
	for i := 0; i < 5; i++ {
		p.Select()
	}
	desiredUnchanged("after selecting while a target is open")

	clk.advance(time.Minute)
	for i := 0; i < 5; i++ {
		tr := p.Select()
		p.ReportDial(tr, i%2 == 0)
	}
	desiredUnchanged("after half-open probes and their outcomes")

	// Payloads that mention extra targets, omit real ones, and carry a state
	// the agent cannot parse.
	p.SetHealth([]forwarder.TargetHealth{
		th("10.0.0.1", 443, "unhealthy"),
		th("10.0.0.9", 443, "healthy"), // not in the pool
		th("10.0.0.3", 443, "not-a-state"),
	})
	p.Select()
	p.ReportDial(desired[0], false)
	desiredUnchanged("after a payload that names a target the pool does not have")

	// The same payload with the health array dropped entirely: the mechanism
	// switches off, and desired must still be untouched.
	p.SwapTargetsAndHealth(WeightedRoundRobin, desired, nil)
	p.Select()
	p.SetHealth(health)
	desiredUnchanged("after a health-less dispatch and a re-enable")

	afterDesired, err := json.Marshal(em.DesiredTargets())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(beforeDesired, afterDesired) {
		t.Fatalf("the health-aware mechanism rewrote desired state:\n before %s\n after  %s", beforeDesired, afterDesired)
	}
	afterPool, err := json.Marshal(p.Targets())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(beforePool, afterPool) {
		t.Fatalf("the pool contents changed:\n before %s\n after  %s", beforePool, afterPool)
	}
	if got := p.Strategy(); got != beforeStrategy {
		t.Fatalf("strategy changed to %q, want %q", got, beforeStrategy)
	}
	if got := p.Addrs(); len(got) != len(beforeAddrs) {
		t.Fatalf("addrs = %v, want %v", got, beforeAddrs)
	} else {
		for i := range got {
			if got[i] != beforeAddrs[i] {
				t.Fatalf("addrs[%d] = %q, want %q", i, got[i], beforeAddrs[i])
			}
		}
	}

	// The observer's accessor must hand out a copy, not a window into desired
	// state that a caller could write through.
	got := em.DesiredTargets()
	if len(got) != len(desired) {
		t.Fatalf("DesiredTargets = %+v, want %d targets", got, len(desired))
	}
	for i := range desired {
		if got[i] != desired[i] {
			t.Fatalf("DesiredTargets[%d] = %+v, want %+v", i, got[i], desired[i])
		}
	}
}

// ---------------------------------------------------------------------------
// the mechanisms are not the data plane's business
// ---------------------------------------------------------------------------

// Selection stays race-free with health installed: the breaker table is written
// by dial outcomes from many connections while connections are being handed
// out. `go test -race` is the assertion.
func TestHealthAwareSelectionIsRaceFree(t *testing.T) {
	targets := []forwarder.Target{tg("10.0.0.1", 443), tg("10.0.0.2", 443), tg("10.0.0.3", 443), tg("10.0.0.4", 443)}
	p := newPool("eg", RoundRobin, targets)
	p.SetHealth([]forwarder.TargetHealth{
		th("10.0.0.1", 443, "unhealthy"),
		th("10.0.0.2", 443, "degraded"),
		th("10.0.0.3", 443, "healthy"),
		th("10.0.0.4", 443, "unknown"),
	})

	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				tr := p.Select()
				p.ReportDial(tr, (i+g)%3 != 0)
			}
		}(g)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			p.SetHealth([]forwarder.TargetHealth{
				th("10.0.0.1", 443, "unhealthy"),
				th("10.0.0.2", 443, "healthy"),
				th("10.0.0.3", 443, "recovering"),
			})
		}
	}()
	// Re-installing the bounds while selections are in flight: the clock and
	// the ceilings are read on the selection path, so this is the other writer
	// the mechanism must be safe against.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 100; i++ {
			p.SetBreakerBounds(BreakerBounds{Cooldown: time.Minute, MaxCooldown: time.Hour})
		}
	}()
	wg.Wait()

	// The point of this test is the absence of a race report, not a count; the
	// selection itself is asserted by the deterministic tests above.
	if got := len(p.BreakerStates()); got != 3 {
		t.Fatalf("BreakerStates = %d entries after the run, want the 3 the last payload named", got)
	}
}
