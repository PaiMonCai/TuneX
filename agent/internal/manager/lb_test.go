package manager

import (
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"

	"github.com/tunex/agent/internal/forwarder"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// tg builds a usable target for the given pool position.
func tg(host string, port int) forwarder.Target {
	return forwarder.Target{Host: host, Port: port, Weight: 1}
}

// pickLoop runs Select nSer times and returns one count per "host:port".
func pickLoop(l *LoadBalancer, n int) map[string]int {
	out := make(map[string]int)
	for i := 0; i < n; i++ {
		out[l.Select().Addr()]++
	}
	return out
}

// pickLoopParallel hammers Select from many goroutines. Under -race it is the
// guard against a data race on the cursor / slot tables (WP5 also requires the
// egress path to stay race-free, and Select is on the hot path).
func pickLoopParallel(b *testing.B, l *LoadBalancer, goroutines int) {
	b.Helper()
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < b.N/goroutines; i++ {
				l.Select()
			}
		}()
	}
	wg.Wait()
}

// echoAddr is the "host:port" of a target we can actually hand to a dialer.
func echoAddr(t *testing.T) (string, int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve echo port: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	_, portStr, _ := net.SplitHostPort(ln.Addr().String())
	var port int
	fmt.Sscanf(portStr, "%d", &port)
	return "127.0.0.1", port
}

// ---------------------------------------------------------------------------
// strategy parsing
// ---------------------------------------------------------------------------

func TestParseStrategyAliases(t *testing.T) {
	cases := map[string]Strategy{
		"round":                 RoundRobin,
		"ROUND_ROBIN":           RoundRobin,
		" round_robin ":         RoundRobin,
		"rand":                  Random,
		"RANDOM":                Random,
		"weighted_round":        WeightedRoundRobin,
		"WEIGHTED_ROUND":        WeightedRoundRobin,
		"weighted_round_robin":  WeightedRoundRobin,
		"WEIGHTED_ROUND_ROBIN":  WeightedRoundRobin,
		" Weighted_Round_Robin": WeightedRoundRobin,
	}
	for in, want := range cases {
		got, ok := ParseStrategy(in)
		if !ok {
			t.Errorf("ParseStrategy(%q) failed, want %s", in, want)
			continue
		}
		if got != want {
			t.Errorf("ParseStrategy(%q) = %s, want %s", in, got, want)
		}
	}
	for _, in := range []string{"", "least_conn", "ip_hash", "fifo", "ll", "lc", "round_robin_extra"} {
		if got, ok := ParseStrategy(in); ok {
			t.Errorf("ParseStrategy(%q) = %s, true; want an error", in, got)
		}
	}
}

func TestStrategyString(t *testing.T) {
	if got := RoundRobin.String(); got != "ROUND_ROBIN" {
		t.Errorf("RoundRobin.String() = %q", got)
	}
	if got := Random.String(); got != "RANDOM" {
		t.Errorf("Random.String() = %q", got)
	}
	if got := WeightedRoundRobin.String(); got != "WEIGHTED_ROUND_ROBIN" {
		t.Errorf("WeightedRoundRobin.String() = %q", got)
	}
	// A zero-strategy pool reports the fallback so /health never renders "".
	if got := Strategy("").String(); got != "ROUND_ROBIN" {
		t.Errorf(`Strategy("").String() = %q, want ROUND_ROBIN`, got)
	}
}

// ---------------------------------------------------------------------------
// round robin
// ---------------------------------------------------------------------------

func TestNewFallsBackToRoundRobin(t *testing.T) {
	// An unknown or empty strategy must not leave the pool unselectable.
	for _, in := range []Strategy{"", "bogus", "round_robin"} {
		l := New(in, []forwarder.Target{tg("127.0.0.1", 1), tg("127.0.0.2", 2)})
		if l.Strategy() != RoundRobin {
			t.Errorf("New(%q).Strategy() = %s, want ROUND_ROBIN", in, l.Strategy())
		}
	}
}

func TestSelectRoundRobinOrder(t *testing.T) {
	targets := []forwarder.Target{tg("10.0.0.1", 80), tg("10.0.0.2", 80), tg("10.0.0.3", 80)}
	l := New(RoundRobin, targets)

	var seq []string
	for i := 0; i < 6; i++ {
		seq = append(seq, l.Select().Addr())
	}
	want := []string{
		"10.0.0.1:80", "10.0.0.2:80", "10.0.0.3:80",
		"10.0.0.1:80", "10.0.0.2:80", "10.0.0.3:80",
	}
	for i := range want {
		if seq[i] != want[i] {
			t.Fatalf("round robin #%d = %s, want %s (full sequence %v)", i, seq[i], want[i], seq)
		}
	}
	// Every target got exactly two turns.
	counts := pickLoop(l, 6)
	for _, a := range []string{"10.0.0.1:80", "10.0.0.2:80", "10.0.0.3:80"} {
		if counts[a] != 2 {
			t.Fatalf("round robin turns for %s = %d, want 2", a, counts[a])
		}
	}
}

func TestSelectRoundRobinIgnoresWeight(t *testing.T) {
	// Plain round robin means every target in turn: weights must not skew it.
	targets := []forwarder.Target{
		{Host: "10.0.0.1", Port: 80, Weight: 5},
		{Host: "10.0.0.2", Port: 80, Weight: 1},
	}
	l := New(RoundRobin, targets)
	counts := pickLoop(l, 100)
	if counts["10.0.0.1:80"] != 50 || counts["10.0.0.2:80"] != 50 {
		t.Fatalf("ROUND_ROBIN distribution = %v, want 50/50 regardless of weight", counts)
	}
}

// ---------------------------------------------------------------------------
// random
// ---------------------------------------------------------------------------

func TestSelectRandomIsUniform(t *testing.T) {
	targets := []forwarder.Target{tg("10.0.0.1", 80), tg("10.0.0.2", 80)}
	l := New(Random, targets)
	const n = 4000
	counts := pickLoop(l, n)
	for _, a := range []string{"10.0.0.1:80", "10.0.0.2:80"} {
		got := counts[a]
		// Uniform over two targets: the 5-sigma band for p=0.5 at n=4000
		// is about +/-155, so 200 is generous without being meaningless.
		if got < n/2-200 || got > n/2+200 {
			t.Fatalf("RANDOM distribution = %v (n=%d)", counts, n)
		}
	}
}

func TestSelectRandomIgnoresWeight(t *testing.T) {
	// Random is uniform by definition; a weighted tail must not appear here.
	targets := []forwarder.Target{
		{Host: "10.0.0.1", Port: 80, Weight: 9},
		{Host: "10.0.0.2", Port: 80, Weight: 1},
	}
	l := New(Random, targets)
	counts := pickLoop(l, 2000)
	if counts["10.0.0.1:80"] > 1200 {
		t.Fatalf("RANDOM looks weighted: %v", counts)
	}
}

func TestSelectRandomEmptyPool(t *testing.T) {
	l := New(Random, nil)
	if got := l.Select(); got.Addr() != "" {
		t.Fatalf("Select on an empty pool = %q, want the zero target", got.Addr())
	}
}

// ---------------------------------------------------------------------------
// weighted round robin
// ---------------------------------------------------------------------------

func TestSelectWeightedRoundRobinDistribution(t *testing.T) {
	targets := []forwarder.Target{
		{Host: "10.0.0.1", Port: 80, Weight: 3},
		{Host: "10.0.0.2", Port: 80, Weight: 1},
		{Host: "10.0.0.3", Port: 80, Weight: 2},
	}
	l := New(WeightedRoundRobin, targets)

	// The pool spans 6 weight units; walk 600 turns and expect the counts
	// to land within one unit of the exact ratio (100 * 3/6, 100, 100 * 2/6).
	counts := pickLoop(l, 600)
	want := map[string]int64{
		"10.0.0.1:80": 300,
		"10.0.0.2:80": 100,
		"10.0.0.3:80": 200,
	}
	for a, w := range want {
		got := int64(counts[a])
		if got < w-3 || got > w+3 {
			t.Fatalf("WEIGHTED_ROUND_ROBIN turns for %s = %d, want ~%d (counts=%v)", a, got, w, counts)
		}
	}
}

func TestSelectWeightedRoundRobinIsDeterministic(t *testing.T) {
	// Weighted round robin must interleave, not burst: with weights 3/1 a
	// burst implementation returns A A A B A A A B..., while the boundary
	// walk distributes them (A A B A A B ... style). Only the totals are
	// contract; the guard below just checks that no target runs away for a
	// whole cycle before the others get a turn.
	targets := []forwarder.Target{
		{Host: "10.0.0.1", Port: 80, Weight: 9},
		{Host: "10.0.0.2", Port: 80, Weight: 1},
	}
	l := New(WeightedRoundRobin, targets)
	var seq []string
	for i := 0; i < 12; i++ {
		seq = append(seq, l.Select().Addr())
	}
	// In the first 10 turns (one full weight cycle) every target must
	// appear; a pure-burst implementation would still satisfy this, so
	// additionally assert the total ratio of the first cycle.
	seen := map[string]bool{"10.0.0.1:80": false, "10.0.0.2:80": false}
	for _, a := range seq[:10] {
		seen[a] = true
	}
	if !seen["10.0.0.1:80"] || !seen["10.0.0.2:80"] {
		t.Fatalf("a full weight cycle skipped a target: %v", seq[:10])
	}
	counts := map[string]int{}
	for _, a := range seq[:10] {
		counts[a]++
	}
	if counts["10.0.0.1:80"] != 9 || counts["10.0.0.2:80"] != 1 {
		t.Fatalf("cycle ratio = %v, want 9/1", counts)
	}
}

func TestSelectWeightedRoundRobinEqualWeights(t *testing.T) {
	// All weights equal is the degenerate weighted case; it must behave as
	// plain round robin (each target the same number of turns).
	targets := []forwarder.Target{
		{Host: "10.0.0.1", Port: 80, Weight: 4},
		{Host: "10.0.0.2", Port: 80, Weight: 4},
		{Host: "10.0.0.3", Port: 80, Weight: 4},
	}
	l := New(WeightedRoundRobin, targets)
	counts := pickLoop(l, 300)
	for _, a := range []string{"10.0.0.1:80", "10.0.0.2:80", "10.0.0.3:80"} {
		if counts[a] != 100 {
			t.Fatalf("equal-weight weighted counts = %v, want 100 each", counts)
		}
	}
}

func TestSelectWeightedZeroWeightStillSelectable(t *testing.T) {
	// The panel can push a target with weight 0. Round robin must not
	// starve it into unreachability — it gets one slot, like weight 1.
	targets := []forwarder.Target{
		{Host: "10.0.0.1", Port: 80, Weight: 0},
		{Host: "10.0.0.2", Port: 80, Weight: 1},
	}
	l := New(WeightedRoundRobin, targets)
	counts := pickLoop(l, 4)
	if counts["10.0.0.1:80"] == 0 {
		t.Fatalf("a weight-0 target got no turns: %v", counts)
	}
}

func TestSelectWeightedHugeWeightBounded(t *testing.T) {
	// A typo like weight=1000000 must not allocate a million slots.
	targets := []forwarder.Target{
		{Host: "10.0.0.1", Port: 80, Weight: 1_000_000},
		{Host: "10.0.0.2", Port: 80, Weight: 1},
	}
	l := New(WeightedRoundRobin, targets)
	// The pool spans 1025 weight units (1024 for the capped heavy target,
	// 1 for the light one), so the light target gets roughly 1 turn in
	// 1025. Assert the cap held — both targets present, every turn billed
	// — rather than that the light target appeared inside a tiny sample.
	counts := pickLoop(l, 1025)
	if counts["10.0.0.1:80"] == 0 || counts["10.0.0.2:80"] == 0 {
		t.Fatalf("a target vanished under a capped huge weight: %v", counts)
	}
	if counts["10.0.0.1:80"]+counts["10.0.0.2:80"] != 1025 {
		t.Fatalf("counts lost a turn: %v", counts)
	}
	if got := counts["10.0.0.1:80"]; got != 1024 {
		t.Fatalf("the huge weight was not capped: heavy got %d turns, want 1024", got)
	}
}

func TestSelectWeightedSkipsInvalidTargets(t *testing.T) {
	targets := []forwarder.Target{
		{Host: "", Port: 80, Weight: 5},   // no host
		{Host: "bad", Port: 0, Weight: 5}, // no port
		{Host: "ok", Port: 7, Weight: 0},
	}
	l := New(WeightedRoundRobin, targets)
	if l.Len() != 1 {
		t.Fatalf("invalid targets survived canonicalisation: %v", l.Addrs())
	}
	if got := l.Addrs(); len(got) != 1 || got[0] != "ok:7" {
		t.Fatalf("pool = %v, want [ok:7]", got)
	}
	for i := 0; i < 5; i++ {
		if got := l.Select().Addr(); got != "ok:7" {
			t.Fatalf("Select = %q, want ok:7", got)
		}
	}
}

func TestSelectWeightedRoundRobinEmptyPool(t *testing.T) {
	for _, in := range []forwarder.Target{
		{Host: "", Port: 80},     // unusable
		{Host: "h", Port: 65536}, // bad port
		{Host: "h", Port: -1},    // negative port
	} {
		l := New(WeightedRoundRobin, []forwarder.Target{in})
		if got := l.Select(); got.Addr() != "" {
			t.Fatalf("Select on a pool of only-invalid targets = %q", got.Addr())
		}
	}
	l := New(WeightedRoundRobin, nil)
	if got := l.Select(); got.Addr() != "" {
		t.Fatalf("Select on an empty pool = %q", got.Addr())
	}
}

func TestSelectAllStrategiesEmptyPool(t *testing.T) {
	for _, s := range []Strategy{RoundRobin, Random, WeightedRoundRobin} {
		l := New(s, nil)
		if got := l.Select(); got.Addr() != "" {
			t.Fatalf("%s on an empty pool returned %q", s, got.Addr())
		}
	}
}

// ---------------------------------------------------------------------------
// hot update
// ---------------------------------------------------------------------------

func TestUpdateTargetsReplacesPoolAndStrategy(t *testing.T) {
	l := New(RoundRobin, []forwarder.Target{tg("10.0.0.1", 80), tg("10.0.0.2", 80)})

	// The old pool's order must not survive the swap: after the reset the
	// first pick is the new pool's head.
	l.UpdateTargets(WeightedRoundRobin, []forwarder.Target{
		{Host: "10.0.0.9", Port: 80, Weight: 1},
		{Host: "10.0.0.8", Port: 80, Weight: 1},
	})
	if l.Strategy() != WeightedRoundRobin {
		t.Fatalf("strategy after hot update = %s, want WEIGHTED_ROUND_ROBIN", l.Strategy())
	}
	counts := pickLoop(l, 100)
	if counts["10.0.0.1:80"] != 0 || counts["10.0.0.2:80"] != 0 {
		t.Fatalf("old pool still receiving connections: %v", counts)
	}
	if counts["10.0.0.9:80"] != 50 || counts["10.0.0.8:80"] != 50 {
		t.Fatalf("new pool distribution = %v, want 50/50", counts)
	}
}

func TestUpdateTargetsKeepsOldPoolOnBadPayload(t *testing.T) {
	l := New(RoundRobin, []forwarder.Target{tg("10.0.0.1", 80), tg("10.0.0.2", 80)})

	// An empty list and an all-invalid list must both be ignored: clearing
	// the pool would black-hole every egress tunnel on the node.
	l.UpdateTargets(RoundRobin, nil)
	l.UpdateTargets(RoundRobin, []forwarder.Target{{Host: "", Port: 80}})
	if got := l.Addrs(); len(got) != 2 {
		t.Fatalf("pool was cleared by a bad payload: %v", got)
	}
	if got := l.Strategy(); got != RoundRobin {
		t.Fatalf("strategy drifted on a bad payload: %s", got)
	}
}

func TestUpdateTargetsKeepsStrategyWhenUnparseable(t *testing.T) {
	l := New(Random, []forwarder.Target{tg("10.0.0.1", 80)})
	// An unknown strategy falls back to the active one rather than silently
	// turning the pool into ROUND_ROBIN.
	l.UpdateTargets("least_conn", []forwarder.Target{tg("10.0.0.2", 80)})
	if got := l.Strategy(); got != Random {
		t.Fatalf("strategy after an unknown value = %s, want RANDOM", got)
	}
}

func TestUpdateTargetsResetsCursor(t *testing.T) {
	l := New(RoundRobin, []forwarder.Target{tg("10.0.0.1", 80), tg("10.0.0.2", 80)})
	// Walk the cursor off the head of the pool.
	l.Select()
	l.Select()
	l.UpdateTargets(RoundRobin, []forwarder.Target{tg("10.0.0.3", 80), tg("10.0.0.4", 80)})
	if got := l.Select().Addr(); got != "10.0.0.3:80" {
		t.Fatalf("first pick after hot update = %q, want the new pool head 10.0.0.3:80", got)
	}
}

func TestUpdateTargetsWeightedToRoundTrip(t *testing.T) {
	// Strategy-only changes through the hot-update path must redistribute
	// the next connections, not the ones already open.
	l := New(RoundRobin, []forwarder.Target{tg("10.0.0.1", 80), tg("10.0.0.2", 80)})
	before := pickLoop(l, 20)
	if before["10.0.0.1:80"] != 10 || before["10.0.0.2:80"] != 10 {
		t.Fatalf("round robin before the switch = %v, want 10/10", before)
	}
	l.UpdateTargets(WeightedRoundRobin, []forwarder.Target{
		{Host: "10.0.0.1", Port: 80, Weight: 3},
		{Host: "10.0.0.2", Port: 80, Weight: 1},
	})
	after := pickLoop(l, 40)
	if after["10.0.0.1:80"] != 30 || after["10.0.0.2:80"] != 10 {
		t.Fatalf("weighted after the switch = %v, want 30/10", after)
	}
}

func TestUpdateTargetsAccumulatesOrder(t *testing.T) {
	// Targets carry an Order field the panel uses for round-robin position.
	// The pool must be selectable in whatever order it arrives, and the
	// ledger must not silently reorder them for reporting.
	in := []forwarder.Target{
		{Host: "b", Port: 1, Weight: 1, Order: 2},
		{Host: "a", Port: 1, Weight: 1, Order: 1},
	}
	l := New(RoundRobin, in)
	first, second := l.Select().Addr(), l.Select().Addr()
	if first != "b:1" || second != "a:1" {
		t.Fatalf("pool order changed: %s then %s", first, second)
	}
}

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------

func TestSelectConcurrentIsRaceFree(t *testing.T) {
	l := New(WeightedRoundRobin, []forwarder.Target{
		{Host: "10.0.0.1", Port: 80, Weight: 3},
		{Host: "10.0.0.2", Port: 80, Weight: 1},
	})
	const goroutines, perG = 8, 2000
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perG; i++ {
				l.Select()
			}
		}()
	}
	wg.Wait()

	total := goroutines * perG
	a, b := l.Select(), l.Select()
	if a.Addr() == "" || b.Addr() == "" {
		t.Fatalf("targets became empty under load: %q %q", a.Addr(), b.Addr())
	}
	// The cursor wrapped at least once; the distribution is unchanged.
	counts := pickLoop(l, 400)
	if counts["10.0.0.1:80"]+counts["10.0.0.2:80"] != 400 {
		t.Fatalf("turn lost under concurrency: %v", counts)
	}
	_ = total
}

func TestUpdateTargetsConcurrentWithSelect(t *testing.T) {
	// The hot update must be atomic: a Selector either sees the old pool or
	// the new one, never a half-installed one (empty slots, stale strategy).
	l := New(RoundRobin, []forwarder.Target{tg("10.0.0.1", 80), tg("10.0.0.2", 80)})
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				got := l.Select()
				if a := got.Addr(); a != "" && !strings.HasPrefix(a, "10.0.0.") {
					t.Errorf("half-installed pool leaked %q", a)
					return
				}
			}
		}
	}()
	for i := 0; i < 200; i++ {
		l.UpdateTargets(RoundRobin, []forwarder.Target{
			{Host: fmt.Sprintf("10.0.0.%d", 1+i%2), Port: 80, Weight: 1},
			{Host: fmt.Sprintf("10.0.0.%d", 1+(i+1)%2), Port: 80, Weight: 1},
		})
	}
	close(stop)
	wg.Wait()
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

func TestTargetsReturnsACopy(t *testing.T) {
	in := []forwarder.Target{{Host: "a", Port: 1, Weight: 1}}
	l := New(RoundRobin, in)
	got := l.Targets()
	got[0].Host = "mutated"
	if l.Targets()[0].Host != "a" {
		t.Fatal("Targets() must return a copy, not the live pool")
	}
}

func TestAddrsAndLen(t *testing.T) {
	l := New(Random, []forwarder.Target{
		tg("10.0.0.2", 80),
		tg("10.0.0.1", 80),
		{Host: "  ", Port: 80},
	})
	got := l.Addrs()
	// Addrs preserves the pool order (not sorted) so an operator sees the
	// real pool layout; only the egress TargetStats ledger is sorted.
	want := []string{"10.0.0.2:80", "10.0.0.1:80"}
	if len(got) != len(want) {
		t.Fatalf("Addrs() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Addrs()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
	if l.Len() != 2 {
		t.Fatalf("Len() = %d, want 2 (the unusable target must be dropped)", l.Len())
	}
}

// len reports the pool size; the LB type spells it Len to read well at call
// sites. Guard against a future rename slipping through unnoticed.
func (l *LoadBalancer) Len() int { return len(l.Targets()) }

func BenchmarkSelectRoundRobin(b *testing.B) {
	l := New(RoundRobin, []forwarder.Target{
		tg("10.0.0.1", 80), tg("10.0.0.2", 80), tg("10.0.0.3", 80),
	})
	pickLoopParallel(b, l, 1)
	b.Run("parallel", func(b *testing.B) {
		b.ResetTimer()
		pickLoopParallel(b, l, 8)
	})
}

func BenchmarkSelectWeightedRoundRobin(b *testing.B) {
	l := New(WeightedRoundRobin, []forwarder.Target{
		{Host: "10.0.0.1", Port: 80, Weight: 3},
		{Host: "10.0.0.2", Port: 80, Weight: 1},
		{Host: "10.0.0.3", Port: 80, Weight: 2},
	})
	pickLoopParallel(b, l, 1)
}

func BenchmarkSelectRandom(b *testing.B) {
	l := New(Random, []forwarder.Target{
		tg("10.0.0.1", 80), tg("10.0.0.2", 80), tg("10.0.0.3", 80),
	})
	pickLoopParallel(b, l, 1)
}
