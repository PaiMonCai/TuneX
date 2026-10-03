package targetobs

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

// ---------------------------------------------------------------------------
// Helpers: real listeners are cheap and are the only honest way to assert
// "reachable", so the reachable cases dial a real socket. The unreachable case
// uses a port that was bound and closed, which is the closest thing to a
// deterministic refusal.
// ---------------------------------------------------------------------------

// echoTarget starts an accepting listener and returns its host/port.
func echoTarget(t *testing.T) (string, int, func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return addr.IP.String(), addr.Port, func() { ln.Close() }
}

// closedPort returns a loopback port that nothing listens on.
func closedPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}

// nopConn is a successful dial's result: the observer only closes it.
type nopConn struct{}

func (nopConn) Read([]byte) (int, error)         { return 0, io.EOF }
func (nopConn) Write(b []byte) (int, error)      { return len(b), nil }
func (nopConn) Close() error                     { return nil }
func (nopConn) LocalAddr() net.Addr              { return nil }
func (nopConn) RemoteAddr() net.Addr             { return nil }
func (nopConn) SetDeadline(time.Time) error      { return nil }
func (nopConn) SetReadDeadline(time.Time) error  { return nil }
func (nopConn) SetWriteDeadline(time.Time) error { return nil }

func okDial(context.Context, string, string) (net.Conn, error) { return nopConn{}, nil }

// countingDial counts dials per address and answers according to fail.
type countingDial struct {
	mu    sync.Mutex
	calls map[string]int
	fail  func(address string, n int) bool
}

func newCountingDial(fail func(address string, n int) bool) *countingDial {
	return &countingDial{calls: map[string]int{}, fail: fail}
}

func (d *countingDial) dial(_ context.Context, _, address string) (net.Conn, error) {
	d.mu.Lock()
	d.calls[address]++
	n := d.calls[address]
	d.mu.Unlock()
	if d.fail != nil && d.fail(address, n) {
		return nil, errors.New("fake dial failure")
	}
	return nopConn{}, nil
}

func (d *countingDial) count(address string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.calls[address]
}

// fixedTargets is a mutable desired-state source, standing in for the manager's
// hot-swappable egress pools.
type fixedTargets struct {
	mu   sync.Mutex
	list []forwarder.Target
}

func (f *fixedTargets) get() []forwarder.Target {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]forwarder.Target(nil), f.list...)
}

func (f *fixedTargets) set(list ...forwarder.Target) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.list = list
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

func TestIdentityNormalisesOneIdentity(t *testing.T) {
	cases := []struct {
		host string
		port int
		want string
	}{
		{"Example.COM.", 443, "example.com:443"},
		{"  example.com  ", 443, "example.com:443"},
		{"example.com", 443, "example.com:443"},
		{"[::1]", 80, "[::1]:80"}, // bracketed and bare literal are one identity
		{"::1", 80, "[::1]:80"},   // JoinHostPort adds the brackets it needs
		{"127.0.0.1", 1, "127.0.0.1:1"},
		{"", 443, ""},              // unusable: no host
		{"example.com", 0, ""},     // unusable: no port
		{"example.com", 70000, ""}, // unusable: not a TCP port
		{"  .  ", 443, ""},         // trailing-dot strip leaves nothing
	}
	for _, c := range cases {
		if got := Identity(c.host, c.port); got != c.want {
			t.Errorf("Identity(%q,%d) = %q, want %q", c.host, c.port, got, c.want)
		}
	}
}

func TestObservationSourceNamesNodeAndKind(t *testing.T) {
	if got := ObservationSource("node-7", SourceTCPConnect); got != "node-7/tcp_connect" {
		t.Errorf("ObservationSource = %q", got)
	}
	// A node with no id still names the probe kind rather than emitting "//".
	if got := ObservationSource("", SourceTCPConnect); got != "tcp_connect" {
		t.Errorf("ObservationSource(empty node) = %q", got)
	}
}

// ---------------------------------------------------------------------------
// One cycle
// ---------------------------------------------------------------------------

func TestObserveOnceReachableTargetYieldsLatencyAndSuccess(t *testing.T) {
	host, port, stop := echoTarget(t)
	defer stop()

	now := time.Unix(1_700_000_000, 0)
	src := &fixedTargets{}
	src.set(forwarder.Target{Host: host, Port: port})
	o := New(Config{NodeID: "node-a", Targets: src.get, Now: func() time.Time { return now }})

	o.ObserveOnce(context.Background())

	got := o.TargetObservations()
	if len(got) != 1 {
		t.Fatalf("observations = %d, want 1", len(got))
	}
	obs := got[0]
	// Identity is (host, port) on the wire, so the two halves must round-trip
	// to exactly the identity the fact is keyed by.
	if want := Identity(host, port); Identity(obs.Host, obs.Port) != want {
		t.Errorf("observed target = %q:%d, which is not the identity %q", obs.Host, obs.Port, want)
	}
	if !obs.Reachable {
		t.Error("reachable = false, want true for a live loopback listener")
	}
	if obs.LatencyMS == nil {
		t.Error("latency_ms = null, want a measured duration")
	}
	if obs.ConsecutiveSuccess != 1 || obs.ConsecutiveFailure != 0 {
		t.Errorf("counters = %d/%d, want 1/0", obs.ConsecutiveSuccess, obs.ConsecutiveFailure)
	}
	if obs.SuccessRate != 1 {
		t.Errorf("success_rate = %v, want 1", obs.SuccessRate)
	}
	if obs.LastObservedAt != now.Unix() {
		t.Errorf("last_observed_at = %d, want %d", obs.LastObservedAt, now.Unix())
	}
	if obs.ObservationSource != "node-a/tcp_connect" {
		t.Errorf("observation_source = %q", obs.ObservationSource)
	}
}

func TestObserveOnceUnreachableTargetYieldsNullLatencyAndFailure(t *testing.T) {
	port := closedPort(t)
	src := &fixedTargets{}
	src.set(forwarder.Target{Host: "127.0.0.1", Port: port})
	o := New(Config{NodeID: "node-a", Targets: src.get, Timeout: time.Second})

	o.ObserveOnce(context.Background())

	got := o.TargetObservations()
	if len(got) != 1 {
		t.Fatalf("observations = %d, want 1", len(got))
	}
	obs := got[0]
	if obs.Reachable {
		t.Error("reachable = true, want false for a port nothing listens on")
	}
	if obs.LatencyMS != nil {
		t.Errorf("latency_ms = %v, want null", *obs.LatencyMS)
	}
	if obs.ConsecutiveFailure != 1 || obs.ConsecutiveSuccess != 0 {
		t.Errorf("counters = %d/%d, want 0/1", obs.ConsecutiveSuccess, obs.ConsecutiveFailure)
	}
	if obs.SuccessRate != 0 {
		t.Errorf("success_rate = %v, want 0", obs.SuccessRate)
	}
	// The key must be present AND null: "absent latency" and "null latency"
	// would read differently on the panel, and the contract asks for null.
	raw, err := json.Marshal(obs)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"latency_ms":null`) {
		t.Errorf("JSON %s does not carry an explicit null latency_ms", raw)
	}
}

func TestObservationJSONCarriesContractFactsAndNoAge(t *testing.T) {
	ms := int64(12)
	raw, err := json.Marshal(Observation{
		Host: "example.com", Port: 443,
		Reachable: true, LatencyMS: &ms,
		ConsecutiveSuccess: 4, ConsecutiveFailure: 0,
		SuccessRate: 0.95, LastObservedAt: 1_700_000_000,
		ObservationSource: "node-a/tcp_connect",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	text := string(raw)
	for _, key := range []string{
		`"reachable":true`, `"latency_ms":12`, `"consecutive_success":4`,
		`"consecutive_failure":0`, `"success_rate":0.95`,
		`"last_observed_at":1700000000`, `"observation_source":"node-a/tcp_connect"`,
	} {
		if !strings.Contains(text, key) {
			t.Errorf("JSON %s missing %s", text, key)
		}
	}
	// §7 row 7: age is derived by the panel at read time; it must never be
	// stored or sent, because a stored age is wrong the moment it is written.
	if strings.Contains(text, "observation_age") {
		t.Errorf("JSON %s must not carry observation_age", text)
	}
}

// ---------------------------------------------------------------------------
// The success-rate window
// ---------------------------------------------------------------------------

func TestSuccessRateIsComputedOverTheLast20Probes(t *testing.T) {
	src := &fixedTargets{}
	src.set(forwarder.Target{Host: "10.0.0.9", Port: 443})
	// Deterministic outcomes: the first 8 probes fail, everything after works.
	dial := newCountingDial(func(_ string, n int) bool { return n <= 8 })
	o := New(Config{NodeID: "n", Targets: src.get, Dial: dial.dial})

	run := func(cycles int) {
		for i := 0; i < cycles; i++ {
			o.ObserveOnce(context.Background())
		}
	}

	// Two probes in: both failed, so the ratio is 0.
	run(2)
	obs := o.TargetObservations()[0]
	if obs.SuccessRate != 0 {
		t.Fatalf("success_rate after 2 failed probes = %v, want 0", obs.SuccessRate)
	}

	// Nine probes in (8 failures + 1 success) the ratio is 1/9, not 1/20: the
	// denominator is the probes that actually happened. Inventing a full window
	// of successes or failures for probes nobody took would be a lie the panel
	// could not detect.
	run(7)
	obs = o.TargetObservations()[0]
	if want := 1.0 / 9.0; obs.SuccessRate != want {
		t.Fatalf("success_rate after 9 probes = %v, want %v", obs.SuccessRate, want)
	}

	// At 20 probes: 8 failures + 12 successes.
	run(11)
	obs = o.TargetObservations()[0]
	if obs.SuccessRate != 0.6 {
		t.Errorf("success_rate after 20 probes = %v, want 0.6", obs.SuccessRate)
	}
	if obs.ConsecutiveSuccess != 12 || obs.ConsecutiveFailure != 0 {
		t.Errorf("counters = %d/%d, want 12/0", obs.ConsecutiveSuccess, obs.ConsecutiveFailure)
	}

	// 10 more successes push the 8 failures out of the window entirely, so the
	// rate must climb to 1 while the counters keep counting since the last flip.
	run(10)
	obs = o.TargetObservations()[0]
	if obs.SuccessRate != 1 {
		t.Errorf("success_rate after 30 probes = %v, want 1 (window slid)", obs.SuccessRate)
	}
	if obs.ConsecutiveSuccess != 22 {
		t.Errorf("consecutive_success = %d, want 22 (counted since the flip)", obs.ConsecutiveSuccess)
	}
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

func TestConcurrencyBoundIsRespected(t *testing.T) {
	src := &fixedTargets{}
	for port := 10001; port <= 10012; port++ {
		src.set(append(src.get(), forwarder.Target{Host: "10.0.0.9", Port: port})...)
	}

	var inFlight, peak int64
	dial := func(ctx context.Context, _, _ string) (net.Conn, error) {
		n := atomic.AddInt64(&inFlight, 1)
		for {
			old := atomic.LoadInt64(&peak)
			if n <= old || atomic.CompareAndSwapInt64(&peak, old, n) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		atomic.AddInt64(&inFlight, -1)
		return nopConn{}, nil
	}
	o := New(Config{NodeID: "n", Targets: src.get, Dial: dial, Concurrency: 3})

	o.ObserveOnce(context.Background())

	if got := len(o.TargetObservations()); got != 12 {
		t.Errorf("observations = %d, want all 12 targets", got)
	}
	if peak > 3 {
		t.Errorf("peak concurrent probes = %d, want <= 3 (the bound)", peak)
	}
	if peak < 3 {
		t.Errorf("peak concurrent probes = %d, want 3: the bound must also be used, or the cycle is slower than it needs to be", peak)
	}
}

func TestConcurrencyDefaultsToTheDocumentedBound(t *testing.T) {
	o := New(Config{})
	if o.cfg.Concurrency != DefaultConcurrency {
		t.Errorf("concurrency = %d, want %d", o.cfg.Concurrency, DefaultConcurrency)
	}
	if o.cfg.Interval != DefaultInterval || o.cfg.Timeout != DefaultTimeout {
		t.Errorf("interval/timeout = %v/%v, want the documented defaults", o.cfg.Interval, o.cfg.Timeout)
	}
	if o.cfg.Jitter != DefaultJitter {
		t.Errorf("jitter = %v, want %v", o.cfg.Jitter, DefaultJitter)
	}
}

func TestProbeTimeoutIsBounded(t *testing.T) {
	src := &fixedTargets{}
	src.set(forwarder.Target{Host: "10.0.0.9", Port: 443})
	var sawDeadline int64
	dial := func(ctx context.Context, _, _ string) (net.Conn, error) {
		if _, ok := ctx.Deadline(); ok {
			atomic.AddInt64(&sawDeadline, 1)
		}
		<-ctx.Done() // a target that never answers
		return nil, ctx.Err()
	}
	o := New(Config{NodeID: "n", Targets: src.get, Dial: dial, Timeout: 20 * time.Millisecond})

	started := time.Now()
	o.ObserveOnce(context.Background())
	elapsed := time.Since(started)

	if elapsed > 2*time.Second {
		t.Errorf("cycle took %v; a hung target must be cut off by the 20ms probe timeout", elapsed)
	}
	if atomic.LoadInt64(&sawDeadline) != 1 {
		t.Error("dial did not receive a deadline: the probe timeout did not reach the socket")
	}
	if obs := o.TargetObservations()[0]; obs.Reachable || obs.ConsecutiveFailure != 1 {
		t.Errorf("hung target observed as %+v, want one failure", obs)
	}
}

func TestWaitStaysInsideTheJitterWindow(t *testing.T) {
	// A deterministic cadence (what tests rely on) is an injected zero spread,
	// not "jitter off": the production default stays on for anyone who forgets.
	zero := func(time.Duration) time.Duration { return 0 }
	plain := New(Config{Interval: 30 * time.Second, JitterFor: zero})
	if got := plain.wait(); got != 30*time.Second {
		t.Errorf("wait() = %v, want exactly the interval", got)
	}
	// Injected spread: the wait is interval ± the offset.
	for _, c := range []struct {
		offset time.Duration
		want   time.Duration
	}{{5 * time.Second, 35 * time.Second}, {-5 * time.Second, 25 * time.Second}} {
		o := New(Config{
			Interval: 30 * time.Second, Jitter: 5 * time.Second,
			JitterFor: func(time.Duration) time.Duration { return c.offset },
		})
		if got := o.wait(); got != c.want {
			t.Errorf("wait() with offset %v = %v, want %v", c.offset, got, c.want)
		}
	}
	// Default spread: every draw stays inside the window, and the draws are not
	// all identical — that spread is what keeps a fleet from probing in lockstep.
	o := New(Config{Interval: 30 * time.Second})
	first := o.wait()
	min, max := first, first
	for i := 0; i < 200; i++ {
		d := o.wait()
		if d < 25*time.Second || d > 35*time.Second {
			t.Fatalf("wait() = %v, outside 25s..35s", d)
		}
		if d < min {
			min = d
		}
		if d > max {
			max = d
		}
	}
	if min == max {
		t.Error("200 jittered waits were all identical: the default spread is not random")
	}
	// A jitter wider than the interval must not spin the loop.
	o = New(Config{
		Interval: 100 * time.Millisecond, Jitter: time.Second,
		JitterFor: func(d time.Duration) time.Duration { return -d },
	})
	if got := o.wait(); got != 100*time.Millisecond {
		t.Errorf("wait() with an oversized jitter = %v, want the interval", got)
	}
}

// ---------------------------------------------------------------------------
// Desired state only
// ---------------------------------------------------------------------------

func TestObserveOnceSkipsUnusableTargetsAndDedupesOneIdentity(t *testing.T) {
	want := Identity("example.com", 443)
	dial := newCountingDial(nil)
	src := &fixedTargets{}
	src.set(
		forwarder.Target{Host: "Example.COM.", Port: 443},
		forwarder.Target{Host: "example.com", Port: 443},
		forwarder.Target{Host: "", Port: 443},
		forwarder.Target{Host: "example.com", Port: 0},
	)
	before := src.get()
	o := New(Config{NodeID: "n", Targets: src.get, Dial: dial.dial})

	o.ObserveOnce(context.Background())

	got := o.TargetObservations()
	if len(got) != 1 || Identity(got[0].Host, got[0].Port) != want {
		t.Fatalf("observations = %+v, want exactly the one identity %q", got, want)
	}
	if n := dial.count(want); n != 1 {
		t.Errorf("dialled %q %d times, want once per cycle (two pools, one target)", want, n)
	}
	if dial.count("example.com:0") != 0 || dial.count(":443") != 0 {
		t.Error("an unusable target was dialled")
	}
	// Requirement 5: observation must never mutate desired state.
	after := src.get()
	if len(after) != len(before) {
		t.Fatalf("desired state length changed: %d -> %d", len(before), len(after))
	}
	for i := range before {
		if before[i] != after[i] {
			t.Errorf("desired target %d was mutated: %+v -> %+v", i, before[i], after[i])
		}
	}
}

func TestObserveOnceStopsProbingTargetsThatLeftDesiredState(t *testing.T) {
	a := Identity("10.0.0.1", 443)
	b := Identity("10.0.0.2", 443)
	dial := newCountingDial(nil)
	src := &fixedTargets{}
	src.set(forwarder.Target{Host: "10.0.0.1", Port: 443}, forwarder.Target{Host: "10.0.0.2", Port: 443})
	o := New(Config{NodeID: "n", Targets: src.get, Dial: dial.dial})

	o.ObserveOnce(context.Background())
	if got := len(o.TargetObservations()); got != 2 {
		t.Fatalf("observations = %d, want both targets", got)
	}

	// The panel removes B. The next cycle must re-read desired state: no probe
	// for B, and no leftover fact for a target this node no longer serves.
	src.set(forwarder.Target{Host: "10.0.0.1", Port: 443})
	o.ObserveOnce(context.Background())

	got := o.TargetObservations()
	if len(got) != 1 || Identity(got[0].Host, got[0].Port) != a {
		t.Fatalf("observations = %+v, want only %q", got, a)
	}
	if n := dial.count(b); n != 1 {
		t.Errorf("removed target %q was dialled %d times, want 1 (only while desired)", b, n)
	}
	if n := dial.count(a); n != 2 {
		t.Errorf("surviving target %q was dialled %d times, want 2", a, n)
	}
}

func TestObserveOnceWithNoSourceIsANoop(t *testing.T) {
	o := New(Config{NodeID: "n"})
	o.ObserveOnce(context.Background())
	if got := o.TargetObservations(); len(got) != 0 {
		t.Errorf("observations = %+v, want none", got)
	}
	// An egress manager with no pools behaves the same way.
	empty := &fixedTargets{}
	o = New(Config{NodeID: "n", Targets: empty.get, Dial: okDial})
	o.ObserveOnce(context.Background())
	if got := o.TargetObservations(); len(got) != 0 {
		t.Errorf("observations = %+v, want none", got)
	}
}

// ---------------------------------------------------------------------------
// Failure containment
// ---------------------------------------------------------------------------

func TestProbePanicIsRecordedAsAFailureAndDoesNotKillTheObserver(t *testing.T) {
	src := &fixedTargets{}
	src.set(forwarder.Target{Host: "10.0.0.9", Port: 443})
	o := New(Config{NodeID: "n", Targets: src.get, Dial: func(context.Context, string, string) (net.Conn, error) {
		panic("boom")
	}})

	o.ObserveOnce(context.Background()) // must not panic the process

	obs := o.TargetObservations()
	if len(obs) != 1 || obs[0].Reachable || obs[0].ConsecutiveFailure != 1 {
		t.Fatalf("observations = %+v, want one failure (fail-closed)", obs)
	}
}

func TestTargetObservationsIsACopy(t *testing.T) {
	src := &fixedTargets{}
	src.set(forwarder.Target{Host: "10.0.0.9", Port: 443})
	o := New(Config{NodeID: "n", Targets: src.get, Dial: okDial})
	o.ObserveOnce(context.Background())

	first := o.TargetObservations()
	first[0].Host = "tampered"
	first[0].ConsecutiveSuccess = 99

	second := o.TargetObservations()
	if second[0].Host == "tampered" || second[0].ConsecutiveSuccess == 99 {
		t.Error("TargetObservations handed out a view into the observer's own state")
	}
}

// ---------------------------------------------------------------------------
// Lifecycle: a stop/restart must not leak goroutines, and must keep observing.
// ---------------------------------------------------------------------------

func TestRunStopAndRestartDoesNotLeakGoroutines(t *testing.T) {
	host, port, stopEcho := echoTarget(t)
	defer stopEcho()

	src := &fixedTargets{}
	src.set(forwarder.Target{Host: host, Port: port})
	o := New(Config{
		NodeID: "n", Targets: src.get,
		Interval: 5 * time.Millisecond, Timeout: time.Second,
		// Zero spread: the production default would jitter a 5ms cadence by
		// seconds and make this test measure the jitter, not the lifecycle.
		JitterFor: func(time.Duration) time.Duration { return 0 },
	})

	// Wait for the observer to have probed at least n times, without a fixed
	// sleep that could pass for the wrong reason.
	waitProbes := func(atLeast int, why string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if obs := o.TargetObservations(); len(obs) == 1 && obs[0].ConsecutiveSuccess >= atLeast {
				return
			}
			time.Sleep(2 * time.Millisecond)
		}
		t.Fatalf("observer never reached %d probes (%s)", atLeast, why)
	}

	baseline := runtime.NumGoroutine()
	for round := 1; round <= 3; round++ {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { defer close(done); o.Run(ctx) }()

		if round == 1 {
			waitProbes(1, "first run")
		} else {
			before := o.TargetObservations()[0].ConsecutiveSuccess
			waitProbes(before+1, "restart keeps observing")
		}
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatalf("Run did not return after cancellation (round %d)", round)
		}
	}

	// Every probe goroutine is joined inside a cycle, so once Run returned the
	// only thing left to observe is scheduling noise. Allow the runtime a moment
	// to reclaim stacks, then require the count to be back where it started.
	deadline := time.Now().Add(3 * time.Second)
	for {
		after := runtime.NumGoroutine()
		if after <= baseline+1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("goroutines %d after stop, baseline %d: the observer leaked", after, baseline)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestRunReturnsPromptlyWhenCancelledBeforeFirstCycle(t *testing.T) {
	o := New(Config{Interval: time.Hour, Targets: (&fixedTargets{}).get})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); o.Run(ctx) }()

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run ignored cancellation while waiting for the first cycle")
	}
}
