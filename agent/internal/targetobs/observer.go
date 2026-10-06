// Package targetobs is the Agent-side target observer:
// the component that turns "this node is supposed to serve these targets" into
// the stable fact set the panel reads.
//
// What it is, and what it deliberately is NOT:
//
//   - It observes ONLY the targets of the egress pools this node actually
//     serves, through one injected accessor over the manager's desired state
//     (row 2). It never scans, never takes a target from config/env, and never
//     probes an endpoint a user did not ask for: a diagnostic that probes
//     whatever it can find is a port scanner with a support contract.
//   - A probe is a bounded TCP connect, not a business round trip (row 3). A
//     completed handshake is `reachable` and its duration is `latency_ms`. It
//     says nothing about whether the peer speaks the right protocol, and it
//     must never be reported as if it did.
//   - The probe dials the target DIRECTLY, so it does not traverse the tunnel's
//     listener, does not create business connections and does not enter
//     bandwidth accounting — the same rule internal/diag follows, and the
//     reason the egress node does the probing rather than the ingress node.
//   - Observation is a FACT, never desired state (rows 4/5). Nothing here writes
//     to the manager, deletes a target, or feeds routing: health-aware routing decides what to do
//     with these facts, and one failed probe must never change a decision
//     (§7 "禁止 single timeout → automatic failover").
//
// Everything is bounded, and each bound says WHY at its constant: an unbounded
// "health check" is a denial-of-service primitive the node applies to itself
// and to the targets.
//
// Like the rest of the agent module this package is standard-library only.
package targetobs

import (
	"context"
	"math/rand"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/logx"
)

const (
	// DefaultInterval is how often every desired target is probed.
	//
	// 30s matches the state-report cadence (reporter.Interval). One fresh probe
	// per report means the panel's staleness rule (age > 3x report period,
	// §7 row 8) has two whole periods of headroom, so a single slow cycle can
	// never make the whole report stale.
	DefaultInterval = 30 * time.Second

	// DefaultTimeout bounds ONE probe: name resolution plus the TCP connect.
	//
	// 3s is the same bound diagnose_tunnel puts on a probe (diag.DefaultTimeoutMS)
	// — two "is it reachable" answers from the same node must not disagree just
	// because one of them waited longer. It also keeps a full pool inside one
	// interval (see DefaultConcurrency).
	DefaultTimeout = 3 * time.Second

	// DefaultConcurrency is how many probes may be in flight at once.
	//
	// The control plane caps one tunnel's pool at MAX_TARGETS = 64
	// (backend/src/services/control-protocol/validator.ts), so 8 workers cover a
	// full pool in at most ceil(64/8) * 3s = 24s — inside DefaultInterval even in
	// the pathological "every target times out" case. A node probing its whole
	// pool at once, on the other hand, looks like an attack from the target's
	// side and from every firewall in between.
	DefaultConcurrency = 8

	// DefaultJitter is the +/- spread applied to each cycle's wait.
	//
	// Without it, a fleet rolled out together probes in lockstep: the same
	// targets see a synchronised burst, and every node reports the same blip at
	// the same instant, so the panel cannot tell a target problem from a fleet
	// problem. The spread (25s..35s around DefaultInterval) stays far below the
	// 90s staleness window.
	DefaultJitter = 5 * time.Second

	// WindowSize is the number of probes success_rate is computed over.
	//
	// Frozen at 20 by the contract (§7 row 6): the ratio is computed HERE and
	// reported; the panel never recomputes it. Changing this number silently
	// changes the meaning of every already-reported rate, which is why it is a
	// contract constant and not configuration.
	WindowSize = 20

	// SourceTCPConnect is the "probe kind" half of observation_source: it names
	// what was observed, so a future probe kind (a full protocol round trip,
	// say) can be told apart from this one without changing the field.
	SourceTCPConnect = "tcp_connect"

	// sourceSeparator joins node id and probe kind in observation_source
	// ("node_id/probe_kind"). The node id is what makes the same target two
	// different facts when two nodes observe it (§7 row 5).
	sourceSeparator = "/"
)

// ObservationSource renders the `observation_source` value for one observer:
// WHICH node said it and HOW it was observed (§7 row 6).
func ObservationSource(nodeID, kind string) string {
	node := strings.TrimSpace(nodeID)
	if node == "" {
		return kind
	}
	return node + sourceSeparator + kind
}

// NormalizeHost is the host half of target identity: trimmed, lower-cased and
// stripped of a trailing dot (a fully-qualified root anchor is the same name to
// every resolver, so treating it as a second target would split one fact in
// two). A surrounding IPv6 bracket pair is also removed, so "[::1]" and "::1"
// collapse to one identity before JoinHostPort re-adds the brackets it needs.
func NormalizeHost(host string) string {
	h := strings.ToLower(strings.TrimSpace(host))
	h = strings.TrimSuffix(h, ".")
	if len(h) > 1 && strings.HasPrefix(h, "[") && strings.HasSuffix(h, "]") {
		h = h[1 : len(h)-1]
	}
	return h
}

// Identity is THE target identity: "host:port" with the host normalised, so one
// target is one identity and therefore exactly one fact per node (§7 rows 5/6).
//
// This is the only place that builds an identity. Two spellings of "the same
// target" (Example.COM. vs example.com) must not become two entries with
// disagreeing counters — that is precisely the bug the single helper prevents.
//
// forwarder.Target.Addr() is NOT an identity: it trims and joins exactly what
// the user typed, which is right for dialling that address but wrong for keying
// facts. It also does not validate the port.
//
// An unusable target (no host, or a port no TCP endpoint can have) returns "",
// and callers must skip it rather than probe something arbitrary.
func Identity(host string, port int) string {
	h := NormalizeHost(host)
	if h == "" || port < 1 || port > 65535 {
		return ""
	}
	return net.JoinHostPort(h, strconv.Itoa(port))
}

// DialFunc is the injectable dialer. Production uses net.Dialer with the same
// timeout that bounds the attempt context, so the socket cannot outlive the
// deadline even if a platform ignores context cancellation mid-connect.
type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// Config configures an Observer. Every numeric bound has a documented default
// (see the constants above); tests override them to run in milliseconds, and
// the defaults are what a production node uses.
type Config struct {
	// NodeID is the observing node, used only to build observation_source. The
	// panel knows the node from the credential; this is the "who said it" half
	// of the fact, so the two can be cross-checked.
	NodeID string

	// Targets returns the targets of the egress pools this node serves — the
	// ONLY thing the observer will ever probe. It is a function, not a slice,
	// because desired state changes under a running observer: the pool is
	// hot-swapped by PATCH /node/targets and the observer must see the new pool
	// on its next cycle, not a snapshot from startup.
	//
	// nil means "nothing to observe" and every cycle is a no-op.
	Targets func() []forwarder.Target

	// Dial overrides the TCP dialer (tests). nil = net.Dialer{Timeout: Timeout}.
	Dial DialFunc
	// Now overrides the wall clock used for last_observed_at (tests). Probe
	// DURATION is always measured with the monotonic clock, never with Now:
	// an injected wall clock must not be able to report a negative latency.
	Now func() time.Time

	// Interval is the nominal time between cycles. <= 0 = DefaultInterval.
	Interval time.Duration
	// Timeout bounds one probe. <= 0 = DefaultTimeout.
	Timeout time.Duration
	// Concurrency is the maximum number of probes in flight. <= 0 =
	// DefaultConcurrency.
	Concurrency int
	// Jitter is the +/- spread around Interval. <= 0 = DefaultJitter, because a
	// node that forgets to configure it must still not join the fleet's
	// lockstep; a deterministic cadence (tests) is expressed with JitterFor
	// returning 0, not by switching the spread off here.
	Jitter time.Duration
	// JitterFor overrides the random source for that spread (tests): it returns
	// the signed offset added to one cycle's wait. nil = crypto-free math/rand.
	JitterFor func(spread time.Duration) time.Duration
}

// probeResult is one probe's outcome, produced without touching shared state so
// the concurrent part of a cycle never needs the lock.
type probeResult struct {
	target    string
	host      string
	port      int
	reachable bool
	// latencyMS is valid only when reachable.
	latencyMS int64
	// observedAt is the unix second the probe finished.
	observedAt int64
}

// targetState is the accumulated fact history of one target. It is owned by the
// Observer's mutex (written by ObserveOnce's single fold step, read by
// TargetObservations), never by a probe goroutine.
type targetState struct {
	host string
	port int

	// samples is the ring of the last WindowSize probe outcomes, with `filled`
	// entries valid (0..WindowSize) and `next` the write cursor. It is what
	// success_rate is computed from, so the ratio is a property of what this
	// node observed and never of what the panel guessed.
	samples [WindowSize]bool
	filled  int
	next    int

	consecutiveSuccess int
	consecutiveFailure int
	reachable          bool
	// latencyMS is nil (and serialised as JSON null) whenever the last probe
	// failed: an unreachable target has no latency, and reporting 0 would be a
	// measurement nobody made.
	latencyMS      *int64
	lastObservedAt int64
}

// successRate is the fraction of the observed window that succeeded. Before the
// window is full it is the ratio over the probes actually taken — the honest
// value, and the reason the panel must never "fix" it up to a denominator of 20.
func (s *targetState) successRate() float64 {
	if s.filled == 0 {
		return 0
	}
	ok := 0
	for i := 0; i < s.filled; i++ {
		if s.samples[i] {
			ok++
		}
	}
	return float64(ok) / float64(s.filled)
}

// record folds one probe outcome in.
func (s *targetState) record(r probeResult) {
	s.samples[s.next] = r.reachable
	s.next = (s.next + 1) % WindowSize
	if s.filled < WindowSize {
		s.filled++
	}
	if r.reachable {
		// The counters reset on a flip because the contract defines them as
		// "consecutive since the last state change" (§7 row 6), not as totals.
		s.consecutiveSuccess++
		s.consecutiveFailure = 0
		ms := r.latencyMS
		s.latencyMS = &ms
	} else {
		s.consecutiveFailure++
		s.consecutiveSuccess = 0
		s.latencyMS = nil
	}
	s.reachable = r.reachable
	s.lastObservedAt = r.observedAt
}

// Observation is one (this node, target) fact set as it travels on the wire.
//
// It carries EXACTLY the contract's facts (row 6, eight names) minus
// `observation_age`: age is `now - last_observed_at` and is derived by the
// panel at read time (row 7). A stored age is wrong the moment it is written,
// so this struct has no field for it — and a test asserts the JSON never
// grows one.
//
// The entry's identity is (host, port), and this struct sends them as separate
// keys rather than a joined "host:port" string: that is the shape the panel's
// own validator freezes (backend/src/services/node-state.ts
// ReportedTargetObservation), and it normalises the host exactly as Identity
// does. One authority per fact, no second spelling to disagree with it.
type Observation struct {
	// Host/Port identify the target; NormalizeHost has already been applied, so
	// Identity(Host, Port) round-trips to the map key this fact came from.
	Host string `json:"host"`
	Port int    `json:"port"`

	// Reachable is the outcome of the LAST probe, not a summary: it is the
	// "上次探测是否连上" fact the contract freezes.
	Reachable bool `json:"reachable"`
	// LatencyMS is the successful connect's duration in milliseconds, and an
	// explicit null when the last probe failed. The key is always present: a
	// missing latency and a zero latency are different facts.
	LatencyMS *int64 `json:"latency_ms"`

	// ConsecutiveSuccess/Failure count since the last flip. the panel's health-synthesis hysteresis
	// reads these (N consecutive failures to go unhealthy, M to come back), so
	// they are raw counts, never smoothed.
	ConsecutiveSuccess int `json:"consecutive_success"`
	ConsecutiveFailure int `json:"consecutive_failure"`

	// SuccessRate is successes / probes over the last WindowSize probes (or
	// fewer, early on), a 0..1 ratio computed by the observer. The panel must
	// not recompute it (row 6).
	SuccessRate float64 `json:"success_rate"`

	// LastObservedAt is when the last probe finished, unix seconds — the same
	// unit every other state-report timestamp uses.
	LastObservedAt int64 `json:"last_observed_at"`

	// ObservationSource is "who said it": <node_id>/tcp_connect.
	ObservationSource string `json:"observation_source"`
}

// Observer probes the node's desired targets and remembers the last fact set of
// each. Run owns the cycle loop; TargetObservations is read by the reporter from
// another goroutine, which is why all state sits behind one mutex.
type Observer struct {
	cfg Config

	mu    sync.RWMutex
	state map[string]*targetState
}

// New builds an observer. The returned Observer is inert until Run (or an
// explicit ObserveOnce) is called: constructing one never dials anything.
func New(cfg Config) *Observer {
	if cfg.Interval <= 0 {
		cfg.Interval = DefaultInterval
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = DefaultTimeout
	}
	if cfg.Concurrency <= 0 {
		cfg.Concurrency = DefaultConcurrency
	}
	if cfg.Jitter <= 0 {
		cfg.Jitter = DefaultJitter
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Dial == nil {
		dialer := &net.Dialer{Timeout: cfg.Timeout}
		cfg.Dial = dialer.DialContext
	}
	return &Observer{cfg: cfg, state: make(map[string]*targetState)}
}

// Interval reports the configured cycle interval (after defaults). Exposed so
// the runtime can log the cadence it actually got instead of assuming it.
func (o *Observer) Interval() time.Duration {
	if o == nil {
		return 0
	}
	return o.cfg.Interval
}

// Run observes every desired target every Interval (± Jitter) until ctx is
// cancelled. It blocks, so the caller owns the goroutine and the cancellation.
//
// A cycle never overlaps the next: ObserveOnce is called synchronously, so a
// slow cycle delays the following one instead of stacking probes behind it.
// That, plus the per-probe timeout and the concurrency bound, is what makes the
// observer's cost bounded no matter how the desired state changes.
//
// It never returns an error. "Every target was unreachable" is a successful
// observation of unreachable targets; the failure modes that matter are bounded
// differently (ctx cancellation, and the recover below).
func (o *Observer) Run(ctx context.Context) {
	if o == nil {
		return
	}
	timer := time.NewTimer(o.wait())
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			o.observeCycle(ctx)
			if ctx.Err() != nil {
				return
			}
			timer.Reset(o.wait())
		}
	}
}

// observeCycle is ObserveOnce with a panic barrier.
//
// The barrier exists because the observer shares a process with the data plane:
// a bug in a diagnostics loop must never take a forwarding node down. It is a
// backstop, not error handling — everything recoverable is handled where it
// happens. A panic inside a PROBE goroutine cannot be caught here (recover only
// works in the panicking goroutine), which is why probe has its own barrier.
func (o *Observer) observeCycle(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			logx.Error("target observation cycle panicked; skipping this cycle",
				"node_id", o.cfg.NodeID, "panic", r)
		}
	}()
	o.ObserveOnce(ctx)
}

// ObserveOnce runs exactly one observation cycle: enumerate the desired targets,
// probe each within the bounds, and fold the outcomes into the state.
//
// It is synchronous and returns no error. Only Run is expected to call it;
// calling it concurrently with itself would race on the fold step (the probe
// phase itself is safe, the state mutation is not).
func (o *Observer) ObserveOnce(ctx context.Context) {
	if o == nil || o.cfg.Targets == nil {
		return
	}
	targets := o.desired()

	o.mu.Lock()
	// Drop state for targets that are no longer desired. A target removed from
	// the pool is no longer this node's to report, and keeping its counters
	// would both leak memory and let a removed target's old counters resurrect
	// as if they described the new target that later reuses the address.
	wanted := make(map[string]bool, len(targets))
	for _, t := range targets {
		wanted[t.target] = true
	}
	for id := range o.state {
		if !wanted[id] {
			delete(o.state, id)
		}
	}
	o.mu.Unlock()

	// The probe phase touches no shared state: each goroutine writes its own
	// slot, and the outcomes are folded in below under one lock.
	results := probeAll(ctx, targets, o.cfg.Concurrency, o.probe)

	o.mu.Lock()
	defer o.mu.Unlock()
	for _, r := range results {
		st, ok := o.state[r.target]
		if !ok {
			st = &targetState{host: r.host, port: r.port}
			o.state[r.target] = st
		}
		st.record(r)
	}
}

// desired resolves the injected desired state into probe targets, de-duplicated
// by identity and sorted so two cycles over the same pool report the same order.
//
// De-duplication is not an optimisation: two pools on this node pointing at the
// same host:port are ONE fact ("can this node reach that endpoint"), and probing
// it twice per cycle would report the same measurement twice while doubling the
// traffic the target sees.
func (o *Observer) desired() []probeTarget {
	in := o.cfg.Targets()
	out := make([]probeTarget, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, t := range in {
		id := Identity(t.Host, t.Port)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, probeTarget{target: id, host: NormalizeHost(t.Host), port: t.Port})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].target < out[j].target })
	return out
}

// probeTarget is one resolved thing to probe.
type probeTarget struct {
	target string
	host   string
	port   int
}

// probeAll probes every target with at most concurrency probes in flight.
//
// The semaphore is acquired by the PARENT, before the goroutine starts, so the
// number of live goroutines is bounded too — not just the number of open
// sockets. Results are written to pre-allocated slots, one goroutine per index,
// so the fold step needs no lock of its own.
func probeAll(ctx context.Context, targets []probeTarget, concurrency int, probe func(context.Context, probeTarget) probeResult) []probeResult {
	if concurrency < 1 {
		concurrency = 1
	}
	results := make([]probeResult, len(targets))
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for i, t := range targets {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, t probeTarget) {
			defer wg.Done()
			defer func() { <-sem }()
			// Per-goroutine panic barrier: a panic in a child goroutine is not
			// recoverable by the parent's, so without this one malformed
			// target could abort the whole process. A panicked probe is
			// recorded as a failure — we did not, in fact, observe reachability
			// — and logged, because failure is the fail-closed answer and a
			// quietly healthy-looking target would be worse.
			defer func() {
				if r := recover(); r != nil {
					logx.Error("target probe panicked; recording it as unreachable",
						"target", t.target, "panic", r)
					results[i] = probeResult{target: t.target, host: t.host, port: t.port}
				}
			}()
			results[i] = probe(ctx, t)
		}(i, t)
	}
	wg.Wait()
	return results
}

// probe runs one bounded TCP connect.
func (o *Observer) probe(ctx context.Context, t probeTarget) probeResult {
	started := time.Now()
	attempt, cancel := context.WithTimeout(ctx, o.cfg.Timeout)
	defer cancel()

	conn, err := o.cfg.Dial(attempt, "tcp", t.target)
	// Duration comes from the monotonic clock, never from the injectable wall
	// clock: a test's frozen Now must not turn every probe into 0ms, and no
	// clock adjustment must be able to produce a negative latency.
	elapsed := time.Since(started)
	at := o.cfg.Now().Unix()

	if err != nil {
		return probeResult{target: t.target, host: t.host, port: t.port, observedAt: at}
	}
	// The handshake is the whole observation, so the connection is closed
	// immediately: no data is written, no application protocol is spoken, and
	// the target is left with nothing to answer.
	_ = conn.Close()

	ms := elapsed.Milliseconds()
	if ms < 0 {
		ms = 0
	}
	return probeResult{target: t.target, host: t.host, port: t.port, reachable: true, latencyMS: ms, observedAt: at}
}

// TargetObservations returns the current facts, one entry per target this node
// last observed, sorted by identity.
//
// Only observed targets appear: a desired target that has not been probed yet
// has no fact, and the panel reads its absence as `unknown` (row 8) — which is
// exactly right, and different from "we looked and it is down".
//
// The result is a fresh slice of value copies; a caller mutating it (or the
// report serialising it) cannot corrupt the observer's state.
func (o *Observer) TargetObservations() []Observation {
	if o == nil {
		return []Observation{}
	}
	source := ObservationSource(o.cfg.NodeID, SourceTCPConnect)
	o.mu.RLock()
	defer o.mu.RUnlock()
	// Sorted by the identity KEY, not by the emitted (host, port) pair: the key
	// is what "one target, one fact" means, and a stable order keeps two
	// reports of an unchanged target set byte-identical for the panel.
	ids := make([]string, 0, len(o.state))
	for id := range o.state {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]Observation, 0, len(ids))
	for _, id := range ids {
		st := o.state[id]
		out = append(out, Observation{
			Host:               st.host,
			Port:               st.port,
			Reachable:          st.reachable,
			LatencyMS:          st.latencyMS,
			ConsecutiveSuccess: st.consecutiveSuccess,
			ConsecutiveFailure: st.consecutiveFailure,
			SuccessRate:        st.successRate(),
			LastObservedAt:     st.lastObservedAt,
			ObservationSource:  source,
		})
	}
	return out
}

// wait is the delay before the next cycle: the interval plus a signed jitter
// offset. A non-positive result (a jitter wider than the interval, which only a
// test would configure) falls back to the interval so the loop can never spin.
func (o *Observer) wait() time.Duration {
	spread := o.cfg.Jitter
	if spread <= 0 {
		return o.cfg.Interval
	}
	offset := time.Duration(0)
	if o.cfg.JitterFor != nil {
		offset = o.cfg.JitterFor(spread)
	} else {
		offset = time.Duration(rand.Int63n(int64(2*spread)+1)) - spread
	}
	if d := o.cfg.Interval + offset; d > 0 {
		return d
	}
	return o.cfg.Interval
}
