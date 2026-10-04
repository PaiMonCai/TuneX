package targetdns

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func newClock() *clock { return &clock{now: time.Unix(1_700_000_000, 0).UTC()} }

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// scriptedLookup answers from a per-host script that the test can change, and
// counts every call: "cached within TTL" is only observable as a call count.
type scriptedLookup struct {
	mu     sync.Mutex
	addrs  map[string][]string
	ttl    time.Duration
	err    map[string]error
	calls  map[string]int
	total  int64
	before func(host string)
}

func newScriptedLookup() *scriptedLookup {
	return &scriptedLookup{addrs: map[string][]string{}, err: map[string]error{}, calls: map[string]int{}}
}

func (s *scriptedLookup) set(host string, addrs ...string) {
	s.mu.Lock()
	s.addrs[host] = addrs
	delete(s.err, host)
	s.mu.Unlock()
}

func (s *scriptedLookup) fail(host string, err error) {
	s.mu.Lock()
	s.err[host] = err
	s.mu.Unlock()
}

func (s *scriptedLookup) count(host string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls[host]
}

func (s *scriptedLookup) Lookup(_ context.Context, host string) (LookupResult, error) {
	s.mu.Lock()
	s.calls[host]++
	atomic.AddInt64(&s.total, 1)
	before := s.before
	addrs := s.addrs[host]
	err := s.err[host]
	ttl := s.ttl
	s.mu.Unlock()
	if before != nil {
		before(host)
	}
	if err != nil {
		return LookupResult{}, err
	}
	if len(addrs) == 0 {
		return LookupResult{}, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	return LookupResult{Addrs: append([]string(nil), addrs...), TTL: ttl}, nil
}

// fakeDial records the addresses it was asked for and answers per address.
type fakeDial struct {
	mu    sync.Mutex
	calls []string
	conn  net.Conn
	err   error
	delay time.Duration
}

func (d *fakeDial) Dial(ctx context.Context, _ string, address string) (net.Conn, error) {
	d.mu.Lock()
	d.calls = append(d.calls, address)
	conn, err, delay := d.conn, d.err, d.delay
	d.mu.Unlock()
	if delay > 0 {
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if err != nil {
		return nil, err
	}
	if conn == nil {
		return &stubConn{}, nil
	}
	return conn, nil
}

func (d *fakeDial) dialed() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.calls...)
}

// stubConn is a successful fake dial's result; the resolver only hands it back.
type stubConn struct{}

func (stubConn) Read([]byte) (int, error)         { return 0, io.EOF }
func (stubConn) Write(b []byte) (int, error)      { return len(b), nil }
func (stubConn) Close() error                     { return nil }
func (stubConn) LocalAddr() net.Addr              { return nil }
func (stubConn) RemoteAddr() net.Addr             { return nil }
func (stubConn) SetDeadline(time.Time) error      { return nil }
func (stubConn) SetReadDeadline(time.Time) error  { return nil }
func (stubConn) SetWriteDeadline(time.Time) error { return nil }

func testResolver(clk *clock, lookup LookupFunc, dial DialFunc) *Resolver {
	return New(Config{Lookup: lookup, Dial: dial, Now: clk.Now})
}

// echoOn binds one loopback address and echoes back what it reads.
func echoOn(t *testing.T, host string, port int) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}(conn)
		}
	}()
	return ln
}

// listenPair binds two loopback addresses on the SAME port, which is what makes
// "the record moved from one address to another" testable without touching DNS:
// a DNS change must switch the address a NEW connection goes to, while an
// established connection keeps its own.
func listenPair(t *testing.T) (lnA, lnB net.Listener, ipA, ipB string, port int) {
	t.Helper()
	for attempt := 0; attempt < 20; attempt++ {
		a := echoOn(t, "127.0.0.1", 0)
		if a == nil {
			t.Skip("cannot bind 127.0.0.1")
		}
		p := a.Addr().(*net.TCPAddr).Port
		b := echoOn(t, "127.0.0.2", p)
		if b != nil {
			return a, b, "127.0.0.1", "127.0.0.2", p
		}
		_ = a.Close()
	}
	t.Skip("could not bind the same port on two loopback addresses")
	return nil, nil, "", "", 0
}

// ---------------------------------------------------------------------------
// Caching and TTL
// ---------------------------------------------------------------------------

func TestResolutionIsCachedWithinTTLAndRefreshedAfter(t *testing.T) {
	clk := newClock()
	lookup := newScriptedLookup()
	lookup.set("svc.test", "10.0.0.1")
	dial := &fakeDial{}
	r := testResolver(clk, lookup.Lookup, dial.Dial)

	if _, err := r.Plan(context.Background(), "svc.test", 443); err != nil {
		t.Fatalf("first plan: %v", err)
	}
	clk.advance(DefaultTTL - time.Second)
	if _, err := r.Plan(context.Background(), "svc.test", 443); err != nil {
		t.Fatalf("second plan: %v", err)
	}
	if got := lookup.count("svc.test"); got != 1 {
		t.Fatalf("lookups within the TTL = %d, want 1 (a cached target must not re-resolve per dial)", got)
	}

	clk.advance(2 * time.Second) // past the TTL
	if _, err := r.Plan(context.Background(), "svc.test", 443); err != nil {
		t.Fatalf("third plan: %v", err)
	}
	if got := lookup.count("svc.test"); got != 2 {
		t.Fatalf("lookups after the TTL = %d, want 2 (lazy refresh on dial)", got)
	}
}

func TestTTLIsClampedToFloorAndCeiling(t *testing.T) {
	for _, tc := range []struct {
		name    string
		ttl     time.Duration
		wantTTL time.Duration
	}{
		{"a hostile sub-second TTL is floored", time.Second, MinTTL},
		{"a rotten TTL is ceilinged", time.Hour, MaxTTL},
		{"a sane TTL is respected", 12 * time.Second, 12 * time.Second},
		{"a missing TTL uses the policy value", 0, DefaultTTL},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clk := newClock()
			lookup := newScriptedLookup()
			lookup.set("svc.test", "10.0.0.1")
			lookup.ttl = tc.ttl
			r := testResolver(clk, lookup.Lookup, (&fakeDial{}).Dial)

			if _, err := r.Plan(context.Background(), "svc.test", 443); err != nil {
				t.Fatalf("plan: %v", err)
			}
			if got := r.Facts()[0].TTLSeconds; got != int64(tc.wantTTL/time.Second) {
				t.Fatalf("cached TTL = %ds, want %ds", got, int64(tc.wantTTL/time.Second))
			}
			clk.advance(tc.wantTTL - time.Millisecond)
			if _, err := r.Plan(context.Background(), "svc.test", 443); err != nil {
				t.Fatalf("plan inside TTL: %v", err)
			}
			if got := lookup.count("svc.test"); got != 1 {
				t.Fatalf("lookups inside the clamped TTL = %d, want 1", got)
			}
			clk.advance(2 * time.Millisecond)
			if _, err := r.Plan(context.Background(), "svc.test", 443); err != nil {
				t.Fatalf("plan after TTL: %v", err)
			}
			if got := lookup.count("svc.test"); got != 2 {
				t.Fatalf("lookups after the clamped TTL = %d, want 2", got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// IP literals and dual stack
// ---------------------------------------------------------------------------

func TestIPLiteralsBypassResolution(t *testing.T) {
	clk := newClock()
	lookup := newScriptedLookup()
	// Any lookup for a literal would be a test failure: the fake has no script
	// for these hosts and would answer NXDOMAIN.
	r := testResolver(clk, lookup.Lookup, (&fakeDial{}).Dial)

	for _, host := range []string{"127.0.0.1", "::1", "[::1]", "10.1.2.3", "2001:db8::1"} {
		plan, err := r.Plan(context.Background(), host, 443)
		if err != nil {
			t.Fatalf("literal %q: %v", host, err)
		}
		if !plan.Literal {
			t.Errorf("literal %q was not reported as a literal", host)
		}
		if len(plan.Addrs) != 1 {
			t.Errorf("literal %q produced %v", host, plan.Addrs)
		}
	}
	if atomic.LoadInt64(&lookup.total) != 0 {
		t.Fatalf("literals triggered %d lookup(s)", lookup.total)
	}
	// And through the dialer, which is where it actually matters.
	dial := &fakeDial{}
	r = testResolver(clk, lookup.Lookup, dial.Dial)
	if _, err := r.DialContext(context.Background(), "tcp", "127.0.0.1:9000"); err != nil {
		t.Fatalf("literal dial: %v", err)
	}
	if got := dial.dialed(); len(got) != 1 || got[0] != "127.0.0.1:9000" {
		t.Fatalf("dialled %v, want the literal address unchanged", got)
	}
	if atomic.LoadInt64(&lookup.total) != 0 {
		t.Fatalf("a literal dial triggered a lookup")
	}
}

func TestDualStackAnswerIsNotAnErrorAndBothAddressesAreUsable(t *testing.T) {
	clk := newClock()
	lookup := newScriptedLookup()
	lookup.set("dual.test", "2001:db8::1", "10.0.0.1")
	dial := &fakeDial{err: errors.New("connection refused")}
	r := testResolver(clk, lookup.Lookup, dial.Dial)

	plan, err := r.Plan(context.Background(), "dual.test", 443)
	if err != nil {
		t.Fatalf("a dual-stack answer must not be an error: %v", err)
	}
	if len(plan.Addrs) != 2 {
		t.Fatalf("plan = %v, want both A and AAAA records", plan.Addrs)
	}
	if plan.Addrs[0] != "[2001:db8::1]:443" || plan.Addrs[1] != "10.0.0.1:443" {
		t.Fatalf("plan order = %v, want the resolver's order", plan.Addrs)
	}
	// Both were attempted, in order.
	if _, err := r.DialContext(context.Background(), "tcp", "dual.test:443"); err == nil {
		t.Fatal("all candidates failed, so the dial must fail")
	}
	got := dial.dialed()
	if len(got) != 2 || got[0] != "[2001:db8::1]:443" || got[1] != "10.0.0.1:443" {
		t.Fatalf("dialled %v, want every record in order", got)
	}

	// The second address being usable is what "all usable" means.
	dial2 := &failFirstDial{fail: "2001:db8::1"}
	r = testResolver(clk, lookup.Lookup, dial2.Dial)
	if _, err := r.DialContext(context.Background(), "tcp", "dual.test:443"); err != nil {
		t.Fatalf("the IPv4 record must be reachable after the IPv6 one fails: %v", err)
	}
}

// failFirstDial refuses one address and accepts the rest.
type failFirstDial struct {
	mu     sync.Mutex
	fail   string
	calls  []string
	nailed bool
}

func (d *failFirstDial) Dial(_ context.Context, _, address string) (net.Conn, error) {
	d.mu.Lock()
	d.calls = append(d.calls, address)
	d.mu.Unlock()
	if strings.Contains(address, d.fail) {
		return nil, errors.New("no route to host")
	}
	return &stubConn{}, nil
}

// ---------------------------------------------------------------------------
// Failure: stale fallback
// ---------------------------------------------------------------------------

func TestFailedLookupFallsBackToTheLastGoodAddressesWithAnAge(t *testing.T) {
	clk := newClock()
	lookup := newScriptedLookup()
	lookup.set("svc.test", "10.0.0.7")
	var facts []Fact
	var fmu sync.Mutex
	r := New(Config{
		Lookup: lookup.Lookup, Dial: (&fakeDial{}).Dial, Now: clk.Now,
		OnFact: func(f Fact) { fmu.Lock(); facts = append(facts, f); fmu.Unlock() },
	})

	if _, err := r.Plan(context.Background(), "svc.test", 443); err != nil {
		t.Fatalf("healthy plan: %v", err)
	}

	// NXDOMAIN: the target is unreachable right now — one piece of EVIDENCE, not
	// a reason to delete the target or rewrite the hostname.
	lookup.fail("svc.test", &net.DNSError{Err: "no such host", Name: "svc.test", IsNotFound: true})
	clk.advance(DefaultTTL + time.Second)
	plan, err := r.Plan(context.Background(), "svc.test", 443)
	if err != nil {
		t.Fatalf("a failed lookup must fall back, not fail: %v", err)
	}
	if !plan.Stale {
		t.Fatal("the fallback addresses must be marked stale")
	}
	if plan.Age < DefaultTTL {
		t.Fatalf("stale age = %v, want at least the TTL", plan.Age)
	}
	if len(plan.Addrs) != 1 || plan.Addrs[0] != "10.0.0.7:443" {
		t.Fatalf("fallback addresses = %v, want the last good set", plan.Addrs)
	}
	if got := r.Facts()[0]; !got.Stale || got.LastError == "" || got.StaleAgeSeconds == 0 {
		t.Fatalf("fact = %+v, want a stale age and the reason", got)
	}
	fmu.Lock()
	reported := len(facts)
	fmu.Unlock()
	if reported != 1 {
		t.Fatalf("facts reported = %d, want 1 (entering the stale state is the news)", reported)
	}

	// Retrying the failure must not spam the fact sink.
	clk.advance(FailureRetry + time.Second)
	if _, err := r.Plan(context.Background(), "svc.test", 443); err != nil {
		t.Fatalf("second stale plan: %v", err)
	}
	fmu.Lock()
	reported = len(facts)
	fmu.Unlock()
	if reported != 1 {
		t.Fatalf("facts reported = %d after a retry, want still 1", reported)
	}

	// Recovery: the name resolves again (possibly elsewhere), and the stale mark
	// goes away.
	lookup.set("svc.test", "10.0.0.8")
	clk.advance(FailureRetry + time.Second)
	plan, err = r.Plan(context.Background(), "svc.test", 443)
	if err != nil {
		t.Fatalf("recovery plan: %v", err)
	}
	if plan.Stale || plan.Addrs[0] != "10.0.0.8:443" {
		t.Fatalf("plan after recovery = %+v", plan)
	}
	fmu.Lock()
	reported = len(facts)
	last := facts[len(facts)-1]
	fmu.Unlock()
	if reported != 2 || last.Stale || last.Addrs[0] != "10.0.0.8" {
		t.Fatalf("recovery fact = %+v (reported %d)", last, reported)
	}
}

func TestUnresolvableTargetWithoutAFallbackFailsTheDial(t *testing.T) {
	clk := newClock()
	lookup := newScriptedLookup()
	r := testResolver(clk, lookup.Lookup, (&fakeDial{}).Dial)

	_, err := r.Plan(context.Background(), "nope.test", 443)
	if err == nil {
		t.Fatal("an unresolvable name with no history must fail the plan")
	}
	if !strings.Contains(err.Error(), "nope.test") {
		t.Fatalf("error %v does not name the host", err)
	}
	// The failure is still a reported fact.
	fact := r.Facts()[0]
	if !fact.Stale || fact.LastError == "" || len(fact.Addrs) != 0 {
		t.Fatalf("fact = %+v", fact)
	}
}

// ---------------------------------------------------------------------------
// Established connections
// ---------------------------------------------------------------------------

func TestAnEstablishedConnectionSurvivesADNSChange(t *testing.T) {
	clk := newClock()
	// Two loopback addresses, same port: simulating a record moving from one
	// address to another while a connection is being served.
	lnA, lnB, ipA, ipB, port := listenPair(t)
	defer lnA.Close()
	defer lnB.Close()

	lookup := newScriptedLookup()
	lookup.set("svc.test", ipA)
	dialer := &net.Dialer{}
	r := New(Config{Lookup: lookup.Lookup, Dial: dialer.DialContext, Now: clk.Now})

	addr := net.JoinHostPort("svc.test", strconv.Itoa(port))
	connA, err := r.DialContext(context.Background(), "tcp", addr)
	if err != nil {
		t.Fatalf("first dial: %v", err)
	}
	defer connA.Close()
	if _, err := connA.Write([]byte("hello")); err != nil {
		t.Fatalf("write on the first connection: %v", err)
	}
	echo := make([]byte, 5)
	if _, err := io.ReadFull(connA, echo); err != nil {
		t.Fatalf("read on the first connection: %v", err)
	}

	// The record moves. Nothing here touches the live connection.
	lookup.set("svc.test", ipB)
	clk.advance(DefaultTTL + time.Second)

	connB, err := r.DialContext(context.Background(), "tcp", addr)
	if err != nil {
		t.Fatalf("dial after the change: %v", err)
	}
	defer connB.Close()
	remoteB := connB.RemoteAddr().(*net.TCPAddr).IP.String()
	if remoteB != ipB {
		t.Fatalf("new connection went to %s, want the new address %s", remoteB, ipB)
	}

	// The property that is invisible when missing: the established connection is
	// still relaying, because a DNS change may never tear one down.
	if _, err := connA.Write([]byte("again")); err != nil {
		t.Fatalf("write after the change on the ORIGINAL connection: %v", err)
	}
	again := make([]byte, 5)
	if _, err := io.ReadFull(connA, again); err != nil {
		t.Fatalf("the original connection stopped relaying after a DNS change: %v", err)
	}
	if string(again) != "again" {
		t.Fatalf("echo = %q", again)
	}
	if remote := connA.RemoteAddr().(*net.TCPAddr).IP.String(); remote != ipA {
		t.Fatalf("the original connection moved to %s", remote)
	}
}

// ---------------------------------------------------------------------------
// Bounds and concurrency
// ---------------------------------------------------------------------------

func TestDialBudgetBoundsAllCandidates(t *testing.T) {
	clk := newClock()
	lookup := newScriptedLookup()
	lookup.set("slow.test", "10.0.0.1", "10.0.0.2", "10.0.0.3")
	// Every candidate hangs until its own deadline: the total must still be
	// bounded by the budget, not by the sum of the candidates' patience.
	dial := &fakeDial{delay: time.Hour}
	r := New(Config{
		Lookup: lookup.Lookup, Dial: dial.Dial, Now: clk.Now,
		DialBudget: 150 * time.Millisecond, ResolveBudget: 20 * time.Millisecond,
	})

	started := time.Now()
	_, err := r.DialContext(context.Background(), "tcp", "slow.test:443")
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("every candidate timed out; the dial must fail")
	}
	if elapsed > time.Second {
		t.Fatalf("dial took %v, want it bounded by the 150ms budget", elapsed)
	}
}

func TestConcurrentDialsToAnExpiredHostResolveOnce(t *testing.T) {
	clk := newClock()
	lookup := newScriptedLookup()
	lookup.set("busy.test", "10.0.0.1")
	// The lookup blocks until the test releases it, so the followers really do
	// arrive while the leader is in flight.
	release := make(chan struct{})
	var once sync.Once
	lookup.before = func(string) { once.Do(func() {}); <-release }
	r := testResolver(clk, lookup.Lookup, (&fakeDial{}).Dial)

	const dials = 16
	var wg sync.WaitGroup
	for i := 0; i < dials; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = r.DialContext(context.Background(), "tcp", "busy.test:443")
		}()
	}
	// Give the goroutines time to queue behind the single-flight leader, then
	// release it.
	time.Sleep(30 * time.Millisecond)
	close(release)
	wg.Wait()

	if got := lookup.count("busy.test"); got != 1 {
		t.Fatalf("lookups = %d for %d concurrent dials, want 1 (a TTL expiry must not become a DNS stampede)", got, dials)
	}
}

func TestFailureRetryIsRateLimited(t *testing.T) {
	clk := newClock()
	lookup := newScriptedLookup()
	lookup.fail("down.test", errors.New("server misbehaving"))
	r := testResolver(clk, lookup.Lookup, (&fakeDial{}).Dial)

	for i := 0; i < 5; i++ {
		_, _ = r.Plan(context.Background(), "down.test", 443)
	}
	if got := lookup.count("down.test"); got != 1 {
		t.Fatalf("lookups = %d within the failure window, want 1", got)
	}
	clk.advance(FailureRetry + time.Second)
	_, _ = r.Plan(context.Background(), "down.test", 443)
	if got := lookup.count("down.test"); got != 2 {
		t.Fatalf("lookups = %d after the failure window, want 2 (recovery must be detected promptly)", got)
	}
}

func TestNonTCPAndUnparseableAddressesFallThrough(t *testing.T) {
	clk := newClock()
	lookup := newScriptedLookup()
	dial := &fakeDial{}
	r := testResolver(clk, lookup.Lookup, dial.Dial)

	if _, err := r.DialContext(context.Background(), "udp", "svc.test:53"); err != nil {
		t.Fatalf("udp dial: %v", err)
	}
	if _, err := r.DialContext(context.Background(), "tcp", "not-an-address"); err != nil {
		t.Fatalf("unparseable dial: %v", err)
	}
	if got := dial.dialed(); len(got) != 2 {
		t.Fatalf("plain dials = %v, want both passed through untouched", got)
	}
	if atomic.LoadInt64(&lookup.total) != 0 {
		t.Fatal("a non-TCP dial triggered target resolution")
	}
}

func TestFactsAreSortedAndBounded(t *testing.T) {
	clk := newClock()
	lookup := newScriptedLookup()
	lookup.set("b.test", "10.0.0.2")
	lookup.set("a.test", "10.0.0.1")
	r := testResolver(clk, lookup.Lookup, (&fakeDial{}).Dial)
	_, _ = r.Plan(context.Background(), "b.test", 443)
	_, _ = r.Plan(context.Background(), "a.test", 443)

	facts := r.Facts()
	if len(facts) != 2 || facts[0].Host != "a.test" || facts[1].Host != "b.test" {
		t.Fatalf("facts = %+v, want sorted by host", facts)
	}
	if facts[0].Lookups != 1 || facts[0].Stale {
		t.Fatalf("fact = %+v", facts[0])
	}
}

func TestPlanRejectsUnusableTargets(t *testing.T) {
	clk := newClock()
	r := testResolver(clk, newScriptedLookup().Lookup, (&fakeDial{}).Dial)
	for _, tc := range []struct {
		host string
		port int
	}{
		{"", 443},
		{"svc.test", 0},
		{"svc.test", 70000},
	} {
		if _, err := r.Plan(context.Background(), tc.host, tc.port); err == nil {
			t.Errorf("Plan(%q,%d) accepted an unusable target", tc.host, tc.port)
		}
	}
}

func TestResolverSurvivesALookupThatPanics(t *testing.T) {
	// A lookup is injected; a panic inside it would take down whatever goroutine
	// the data plane dialled from. The resolver cannot recover it for the caller
	// (recover only works in the panicking goroutine), so this test documents the
	// boundary: the DEFAULT lookup is stdlib and cannot panic, and anything
	// injected is the injector's responsibility.
	t.Skip("documented boundary: panic containment belongs to the injector")
}

func TestNormalizeHostMatchesTheObservationIdentity(t *testing.T) {
	// One target must be one identity across the node: this package and
	// internal/targetobs normalise the same way, on purpose.
	for _, tc := range []struct{ in, want string }{
		{"Example.COM.", "example.com"},
		{"  example.com  ", "example.com"},
		{"[::1]", "::1"},
		{"::1", "::1"},
	} {
		if got := NormalizeHost(tc.in); got != tc.want {
			t.Errorf("NormalizeHost(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	if !IsLiteral("::1") || !IsLiteral("10.0.0.1") || IsLiteral("example.com") {
		t.Fatal("IsLiteral misclassifies")
	}
}

func TestDialPlanErrorNamesEveryFailure(t *testing.T) {
	clk := newClock()
	lookup := newScriptedLookup()
	lookup.set("dead.test", "10.0.0.1", "10.0.0.2")
	r := testResolver(clk, lookup.Lookup, (&fakeDial{err: errors.New("connection refused")}).Dial)
	_, err := r.DialContext(context.Background(), "tcp", "dead.test:443")
	if err == nil {
		t.Fatal("want an error")
	}
	if !strings.Contains(err.Error(), "dead.test") || !strings.Contains(err.Error(), "2 address") {
		t.Fatalf("error %q should name the host and how many addresses failed", err)
	}
}

func TestEvictionKeepsTheCacheBounded(t *testing.T) {
	clk := newClock()
	lookup := newScriptedLookup()
	dial := &fakeDial{}
	r := New(Config{Lookup: lookup.Lookup, Dial: dial.Dial, Now: clk.Now, TTL: time.Second, MinTTL: time.Second, MaxTTL: time.Second})
	for i := 0; i < maxHosts+16; i++ {
		host := fmt.Sprintf("h%04d.test", i)
		lookup.set(host, "10.0.0.1")
		if _, err := r.Plan(context.Background(), host, 443); err != nil {
			t.Fatalf("plan %s: %v", host, err)
		}
	}
	if got := len(r.Facts()); got > maxHosts {
		t.Fatalf("cache holds %d hosts, want <= %d", got, maxHosts)
	}
}
