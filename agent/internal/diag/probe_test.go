package diag

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"
)

// The probe is the only privileged surface WP11C adds, so its bounds and its
// vocabulary are what the tests pin: caps are enforced, every failure shape has
// a distinct machine-readable status, and a single unreachable endpoint is a
// result rather than an error.

func fakeDial(outcomes map[string]error) DialFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		if err, ok := outcomes[address]; ok && err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		client, server := net.Pipe()
		_ = server.Close()
		return client, nil
	}
}

func TestProbeClassifiesOutcomes(t *testing.T) {
	refused := &net.OpError{Op: "dial", Err: errors.New("connect: connection refused")}
	blackhole := &net.OpError{Op: "dial", Err: errors.New("i/o timeout")}
	dial := fakeDial(map[string]error{
		"127.0.0.1:9":     refused,
		"127.0.0.1:10":    blackhole,
		"127.0.0.1:65535": refused,
	})
	// Target 10 is dialed lazily by the fake; force a timeout classification by
	// wrapping the error with the net.Error contract.
	dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		switch address {
		case "127.0.0.1:9", "127.0.0.1:65535":
			return nil, refused
		case "127.0.0.1:10":
			return nil, timeoutErr{}
		default:
			return fakeDial(nil)(ctx, network, address)
		}
	}

	req := Request{Targets: []Target{
		{Host: "127.0.0.1", Port: 9},
		{Host: "127.0.0.1", Port: 10},
		{Host: "127.0.0.1", Port: 4242},
		{Host: "", Port: 0},
		{Host: "127.0.0.1", Port: 70000},
	}}
	results, err := Probe(context.Background(), req, dial)
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	want := []Status{StatusRefused, StatusTimeout, StatusReachable, StatusInvalidTarget, StatusInvalidTarget}
	if len(results) != len(want) {
		t.Fatalf("expected one result per target, got %d", len(results))
	}
	for i, status := range want {
		if results[i].Status != status {
			t.Fatalf("target %d: expected %s, got %s (%+v)", i, status, results[i].Status, results[i])
		}
	}
	// A reachable probe reports the resolved address so the operator can see
	// which endpoint actually answered.
	if results[2].ResolvedIP == "" {
		t.Fatalf("a reachable result must carry the resolved address: %+v", results[2])
	}
}

func TestProbeReportsDNSFailuresDistinctly(t *testing.T) {
	results, err := Probe(context.Background(), Request{Targets: []Target{
		{Host: "no-such-host.invalid", Port: 80},
	}}, fakeDial(nil))
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if results[0].Status != StatusDNSError {
		t.Fatalf("an unresolvable name must be dns_error, got %s (%+v)", results[0].Status, results[0])
	}
}

func TestProbeCapsTargets(t *testing.T) {
	many := make([]Target, MaxTargets+1)
	for i := range many {
		many[i] = Target{Host: "127.0.0.1", Port: 1000 + i}
	}
	if _, err := Probe(context.Background(), Request{Targets: many}, fakeDial(nil)); !errors.Is(err, ErrTooManyTargets) {
		t.Fatalf("more than %d targets must be refused, got %v", MaxTargets, err)
	}
	// Exactly the cap is accepted.
	if _, err := Probe(context.Background(), Request{Targets: many[:MaxTargets]}, fakeDial(nil)); err != nil {
		t.Fatalf("the cap itself must be accepted: %v", err)
	}
}

func TestProbeClampsTimeouts(t *testing.T) {
	var seen time.Duration
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		if deadline, ok := ctx.Deadline(); ok {
			seen = time.Until(deadline)
		}
		return nil, errors.New("stop here")
	}
	if _, err := Probe(context.Background(), Request{TimeoutMS: MaxTimeoutMS * 10, Targets: []Target{{Host: "127.0.0.1", Port: 1}}}, dial); err != nil {
		t.Fatalf("probe: %v", err)
	}
	if seen > time.Duration(MaxTimeoutMS)*time.Millisecond+200*time.Millisecond {
		t.Fatalf("per-attempt timeout must be clamped to %dms, saw %v", MaxTimeoutMS, seen)
	}

	// A zero timeout falls back to the default rather than waiting forever.
	if _, err := Probe(context.Background(), Request{Targets: []Target{{Host: "127.0.0.1", Port: 1}}}, dial); err != nil {
		t.Fatalf("probe: %v", err)
	}
	if seen <= 0 {
		t.Fatalf("a default deadline must still be applied, saw %v", seen)
	}
}

func TestProbeStopsWhenTheBudgetIsGone(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	results, err := Probe(ctx, Request{Targets: []Target{
		{Host: "127.0.0.1", Port: 1},
		{Host: "127.0.0.1", Port: 2},
	}}, fakeDial(nil))
	if err != nil {
		t.Fatalf("a cancelled budget is reported per target, not as a hard error: %v", err)
	}
	for _, r := range results {
		if r.Status != StatusTimeout {
			t.Fatalf("a cancelled probe must be timeout, got %+v", r)
		}
	}
}

func TestProbeBoundsDetailLength(t *testing.T) {
	long := strings.Repeat("x", MaxDetailChars*3)
	results, err := Probe(context.Background(), Request{Targets: []Target{{Host: "127.0.0.1", Port: 1}}},
		func(context.Context, string, string) (net.Conn, error) { return nil, fmt.Errorf("%s", long) })
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if len(results[0].Detail) > MaxDetailChars {
		t.Fatalf("detail must be bounded to %d chars, got %d", MaxDetailChars, len(results[0].Detail))
	}
}

func TestProbeEmptyRequestIsNotAnError(t *testing.T) {
	results, err := Probe(context.Background(), Request{}, fakeDial(nil))
	if err != nil {
		t.Fatalf("an empty request is a no-op: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("an empty request has no results, got %d", len(results))
	}
}

// timeoutErr satisfies net.Error with Timeout() == true, which is how the
// standard library reports a silent drop.
type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }
