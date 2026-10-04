package forwarder

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// V5.2-WP7: the two facts this package owns on the agent side — the parallel
// `target_health` array on the wire, and the dial outcome the egress forwarder
// owes a selector that is running a circuit breaker. Both are additive, so the
// assertions are about what did NOT change as much as about what did.

// reportingSelector is a TargetSelector that also implements TargetReporter:
// it records the dial outcomes the forwarder hands back, which is the only
// evidence a half-open probe can ever be resolved with.
type reportingSelector struct {
	mu       sync.Mutex
	target   Target
	outcomes []bool
	seen     []Target
}

func (s *reportingSelector) Select() Target { return s.target }

func (s *reportingSelector) ReportDial(t Target, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seen = append(s.seen, t)
	s.outcomes = append(s.outcomes, ok)
}

func (s *reportingSelector) got() ([]bool, []Target) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]bool(nil), s.outcomes...), append([]Target(nil), s.seen...)
}

// waitOutcomes waits (bounded) for n reported outcomes, so the test never races
// the accept loop.
func (s *reportingSelector) waitOutcomes(t *testing.T, n int) ([]bool, []Target) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		ok, seen := s.got()
		if len(ok) >= n {
			return ok, seen
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d of %d dial outcomes were reported", len(ok), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func egressPortOf(t *testing.T, addr string) int {
	t.Helper()
	_, portS, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("split %q: %v", addr, err)
	}
	var port int
	fmt.Sscanf(portS, "%d", &port)
	return port
}

// A live dial must be reported as a success, carrying the target the selector
// actually handed out.
func TestEgressForwarderReportsSuccessfulDial(t *testing.T) {
	up, stopUp := echoTarget(t)
	defer stopUp()
	sel := &reportingSelector{target: Target{Host: "127.0.0.1", Port: egressPortOf(t, up)}}

	port := freePort(t)
	f, err := NewEgress(TunnelConfig{
		ID: "wp7-ok", Mode: ModeEgress, EgressPort: port, Protocol: "tcp", ListenHost: "127.0.0.1",
	}, sel)
	if err != nil {
		t.Fatalf("NewEgress: %v", err)
	}
	if err := f.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer f.Stop()

	conn, err := dialRetry(t, net.JoinHostPort("127.0.0.1", fmt.Sprint(port)))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte("wp7")); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 3)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read echo: %v", err)
	}

	outcomes, seen := sel.waitOutcomes(t, 1)
	if !outcomes[0] {
		t.Fatalf("outcomes = %v, want a reported success", outcomes)
	}
	if seen[0] != sel.target {
		t.Fatalf("reported target = %+v, want the target that was selected (%+v)", seen[0], sel.target)
	}
}

// A dial that cannot connect must be reported as a failure: without that, a
// half-open breaker could never learn that its probe failed and would stay
// half-open (or, worse, be closed by a success that never happened).
func TestEgressForwarderReportsFailedDial(t *testing.T) {
	dead := freePort(t) // reserved then released: nothing is listening
	sel := &reportingSelector{target: Target{Host: "127.0.0.1", Port: dead}}

	port := freePort(t)
	f, err := NewEgress(TunnelConfig{
		ID: "wp7-fail", Mode: ModeEgress, EgressPort: port, Protocol: "tcp", ListenHost: "127.0.0.1",
	}, sel)
	if err != nil {
		t.Fatalf("NewEgress: %v", err)
	}
	if err := f.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer f.Stop()

	conn, err := dialRetry(t, net.JoinHostPort("127.0.0.1", fmt.Sprint(port)))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	// The forwarder drops the connection when the upstream dial fails.
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 4)
	if _, err := conn.Read(buf); err == nil {
		t.Fatal("connection should be dropped when the upstream dial fails")
	}

	outcomes, _ := sel.waitOutcomes(t, 1)
	if outcomes[0] {
		t.Fatalf("outcomes = %v, want a reported failure", outcomes)
	}
}

// An empty pool never dials, so there is no outcome to report.
func TestEgressForwarderReportsNothingWhenNothingWasDialed(t *testing.T) {
	sel := &reportingSelector{}
	port := freePort(t)
	f, err := NewEgress(TunnelConfig{
		ID: "wp7-empty", Mode: ModeEgress, EgressPort: port, Protocol: "tcp", ListenHost: "127.0.0.1",
	}, sel)
	if err != nil {
		t.Fatalf("NewEgress: %v", err)
	}
	if err := f.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer f.Stop()

	conn, err := dialRetry(t, net.JoinHostPort("127.0.0.1", fmt.Sprint(port)))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	buf := make([]byte, 4)
	_, _ = conn.Read(buf)

	if outcomes, _ := sel.got(); len(outcomes) != 0 {
		t.Fatalf("outcomes = %v, want none: no connection was dialed", outcomes)
	}
}

// The wire shape from §7.3: `target_health` is a SIBLING of `targets`, not a
// field inside each target, and a config that carries it still validates.
func TestTunnelConfigDecodesParallelTargetHealth(t *testing.T) {
	body := []byte(`{
		"id": "tunex-1-egress",
		"mode": "EGRESS",
		"egress_port": 19000,
		"lb_strategy": "ROUND_ROBIN",
		"protocol": "tcp",
		"revision": 7,
		"targets": [
			{"host": "10.0.0.1", "port": 443, "weight": 1, "order": 10},
			{"host": "10.0.0.2", "port": 443, "weight": 2, "order": 20}
		],
		"target_health": [
			{"host": "10.0.0.1", "port": 443, "state": "unhealthy", "latency_ms": 12, "age_ms": 4000, "evidence": true},
			{"host": "10.0.0.2", "port": 443, "state": "Healthy"}
		]
	}`)

	var cfg TunnelConfig
	if err := json.Unmarshal(body, &cfg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(cfg.Targets) != 2 || len(cfg.TargetHealth) != 2 {
		t.Fatalf("decoded %d targets and %d health entries, want 2 and 2", len(cfg.Targets), len(cfg.TargetHealth))
	}
	// The two arrays must line up by identity, and the states must be recognised
	// case-insensitively (the panel's spelling is frozen, not its casing).
	for i := range cfg.Targets {
		if cfg.Targets[i].Key() != cfg.TargetHealth[i].Key() {
			t.Fatalf("element %d is not parallel: target %q vs health %q",
				i, cfg.Targets[i].Key(), cfg.TargetHealth[i].Key())
		}
	}
	if got := cfg.TargetHealth[0].StateValue(); got != TargetHealthUnhealthy {
		t.Fatalf("state = %q, want unhealthy", got)
	}
	if got := cfg.TargetHealth[1].StateValue(); got != TargetHealthHealthy {
		t.Fatalf("state = %q, want healthy", got)
	}
	// Validate must ignore health entirely: a health label is an optimisation,
	// never a reason to refuse an otherwise valid apply.
	cfg.TargetHealth = append(cfg.TargetHealth, TargetHealth{State: "not-a-state"})
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate refused a config over its health array: %v", err)
	}

	// Clone must not share the array, or two configs would alias one payload.
	clone := cfg.Clone()
	clone.TargetHealth[0].State = "tampered"
	if cfg.TargetHealth[0].State != "unhealthy" {
		t.Fatal("Clone shares the target_health array with the original")
	}
}

// Unknown and unparseable states are "no evidence", never a verdict.
func TestParseTargetHealthStateFoldsUnknown(t *testing.T) {
	cases := map[string]TargetHealthState{
		"healthy":     TargetHealthHealthy,
		" HEALTHY ":   TargetHealthHealthy,
		"recovering":  TargetHealthRecovering,
		"degraded":    TargetHealthDegraded,
		"unhealthy":   TargetHealthUnhealthy,
		"unknown":     TargetHealthUnknown,
		"no_evidence": TargetHealthUnknown,
		"":            TargetHealthUnknown,
	}
	for in, want := range cases {
		if got := ParseTargetHealthState(in); got != want {
			t.Errorf("ParseTargetHealthState(%q) = %q, want %q", in, got, want)
		}
	}
	// An entry that cannot name a target names nothing at all.
	if got := (TargetHealth{Host: " ", Port: 443}).Key(); got != "" {
		t.Errorf("Key of a nameless entry = %q, want empty", got)
	}
}

// The join between the two parallel arrays must not depend on which side
// normalised the host first: the panel publishes its own identity (lower-cased,
// brackets and root dots stripped), while Target.Addr() is the spelling handed
// to the dialer and the WP5 ledger and must stay exactly as configured.
func TestTargetKeyJoinsTheTwoSpellingsOfOneHost(t *testing.T) {
	cases := []struct {
		targetHost string
		healthHost string
	}{
		{"10.0.0.1", "10.0.0.1"},
		{"EXAMPLE.com.", "example.com"},
		{"EXAMPLE.com.", " example.com "},
		{"2001:DB8::1", "[2001:db8::1]"},
	}
	for _, c := range cases {
		tgt := Target{Host: c.targetHost, Port: 443}
		h := TargetHealth{Host: c.healthHost, Port: 443}
		if tgt.Key() != h.Key() {
			t.Errorf("target %q and health %q do not join: %q vs %q", c.targetHost, c.healthHost, tgt.Key(), h.Key())
		}
	}
	// Addr is untouched: it is the dialer's string.
	if got := (Target{Host: "EXAMPLE.com.", Port: 443}).Addr(); got != "EXAMPLE.com.:443" {
		t.Errorf("Addr = %q, want the configured spelling", got)
	}
	// Two different targets must never share a key.
	if TargetKey("example.com", 443) == TargetKey("example.com", 8443) {
		t.Fatal("keys of different ports must differ")
	}
	if TargetKey("", 443) != "" || TargetKey("h", 0) != "" {
		t.Fatal("an identity that cannot name a target must be empty")
	}
}
