// Package targetdns implements Agent-side dynamic target DNS (
// DEVELOPMENT.md §8.1 "DNS 是输入/观测，不是第二个 desired 真相源").
//
// The panel never resolves and never caches a resolution: the agent is the side
// that dials, so it is the side that must know what a name currently points at,
// how old that knowledge is, and what to do when the name stops resolving. This
// package answers exactly those three questions and nothing else:
//
//   - RESOLUTION IS PER TARGET, CACHED BY TTL with a floor and a ceiling. A
//     fresh entry is reused; an expired one is refreshed lazily on the dial that
//     needs it. The floor stops a 1s TTL from turning every connection into a
//     DNS query, the ceiling stops a rotten TTL from pinning a dead address.
//   - IP LITERALS BYPASS RESOLUTION completely. An address is not a hostname:
//     resolving one is a wasted lookup and, worse, a behavioural change
//     (`127.0.0.1` must never depend on a resolver being reachable).
//   - A FAILED LOOKUP (NXDOMAIN / SERVFAIL / timeout) FALLS BACK to the last
//     good address set, MARKED WITH ITS AGE. It never deletes a target, never
//     rewrites the desired hostname, and never pretends the addresses are fresh:
//     "this is what we last saw, N seconds ago" is the honest fact, and the
//     caller reports it.
//
// What it deliberately is NOT:
//
//   - not a second desired-state source: the user's hostname stays the only
//     desired fact. The resolver produces addresses to DIAL, never a
//     configuration;
//   - not a happy-eyeballs implementation. Addresses are attempted in the order
//     the resolver returned them, sequentially, inside one dial budget — no
//     racing, no RFC 6724 preference table, no timer staggering. See
//     dialPlan for the measured cost of that choice;
//   - not a DNS client. It uses the platform resolver (via an injectable
//     Lookup), so /etc/hosts, search domains and system NSS semantics keep
//     working. The cost of that choice is the TTL: the Go standard library does
//     not expose record TTLs (net.Resolver returns none), so a lookup that does
//     not report one gets a DOCUMENTED POLICY TTL clamped to the bounds below.
//     A real TTL-aware lookup can be plugged in later without touching the cache
//     logic — that is what the TTL field on LookupResult is for.
//
// Standard library only, like the rest of the agent module.
package targetdns

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultTTL is the policy TTL used when the lookup cannot report a record
	// TTL — which is every stdlib lookup (see the package comment). 30s is the
	// same order as the panel's other cadences and keeps a node from re-resolving
	// a stable name more than twice a minute per target.
	DefaultTTL = 30 * time.Second

	// MinTTL is the floor. It protects the resolver from a hostile or broken
	// sub-second TTL: the node would otherwise resolve once per connection and
	// live at the mercy of the DNS server's rate limiter.
	MinTTL = 5 * time.Second

	// MaxTTL is the ceiling. It protects against the opposite failure: a long TTL
	// pinning an address that has moved. Address churn is expected to be picked
	// up by the "next resolution", and with a ceiling of five minutes that
	// sentence stays true on a node whose dials are infrequent.
	MaxTTL = 5 * time.Minute

	// FailureRetry bounds how long a FAILED lookup is remembered. TTLs describe
	// successful answers; retrying a broken name at the TTL interval would hide a
	// recovery for up to a TTL, so failures are retried promptly while still
	// being rate-limited to at most one lookup per host per window.
	FailureRetry = time.Second

	// DefaultDialBudget bounds ONE resolved dial across all candidate addresses.
	// It matches the stream data plane's own dial timeout (forwarder.dialTimeout),
	// because a client waiting on the proxy must not wait longer just because a
	// name has several records.
	DefaultDialBudget = 10 * time.Second

	// DefaultResolveBudget is the slice of that budget reserved for resolution.
	// It is separate because a hung resolver must not eat the whole connection
	// budget: 3s bounds a lookup that hangs, while the remaining budget still
	// dials the addresses we already have.
	DefaultResolveBudget = 3 * time.Second

	// maxHosts bounds the cache. A node resolves the targets of the pools it
	// serves, so this is generous; the bound exists because the map is written
	// from the data path and an unbounded one is a memory-growth primitive.
	maxHosts = 4096
)

// DialFunc dials one address. It matches net.Dialer.DialContext, so a resolver
// can be injected anywhere a dialer is expected and a test can substitute one.
type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// LookupResult is one successful resolution.
type LookupResult struct {
	// Addrs are IP literals in the order the resolver returned them. That order
	// is preserved all the way to the dial: reordering would be re-implementing
	// the preference rules this package deliberately does not own.
	Addrs []string
	// TTL is the record's time-to-live when the lookup can report one. Zero
	// means "the resolver did not say", which is what every stdlib lookup
	// returns; the policy TTL is used then.
	TTL time.Duration
}

// LookupFunc resolves one hostname. The default is StdlibLookup.
type LookupFunc func(ctx context.Context, host string) (LookupResult, error)

// StdlibLookup is the production resolver: the platform resolver, exactly as
// without the resolver.
//
// It reports no TTL because it cannot: net.Resolver exposes no record TTL, and
// reading one would mean hand-rolling a DNS client — which would silently drop
// /etc/hosts entries, search domains and system NSS behaviour on the dial path.
// The trade is deliberate and documented at DefaultTTL.
func StdlibLookup(ctx context.Context, host string) (LookupResult, error) {
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return LookupResult{}, err
	}
	out := make([]string, 0, len(addrs))
	seen := make(map[string]bool, len(addrs))
	for _, a := range addrs {
		ip := a.IP.String()
		if ip == "" || seen[ip] {
			continue
		}
		seen[ip] = true
		out = append(out, ip)
	}
	if len(out) == 0 {
		return LookupResult{}, fmt.Errorf("targetdns: %s resolved to no addresses", host)
	}
	return LookupResult{Addrs: out}, nil
}

// Config configures a Resolver. Every bound is injectable so tests can run in
// microseconds, and every default is documented above.
type Config struct {
	Lookup LookupFunc
	Dial   DialFunc
	Now    func() time.Time

	// TTL is the policy TTL for lookups that report none.
	TTL time.Duration
	// MinTTL / MaxTTL clamp whatever TTL is used.
	MinTTL time.Duration
	MaxTTL time.Duration
	// FailureRetry bounds how long a failed lookup is remembered.
	FailureRetry time.Duration
	// DialBudget bounds one resolved dial; ResolveBudget the lookup inside it.
	DialBudget    time.Duration
	ResolveBudget time.Duration

	// OnFact is called when a target's resolution state CHANGES (fresh → stale,
	// stale → fresh, unreachable), never once per dial: it is how the fact
	// reaches the log and the panel's error ledger without becoming log spam.
	OnFact func(Fact)
}

// Fact is one host's current resolution state, for logs and the local diag
// surface. It is a FACT about what this node last saw, not a desired value.
type Fact struct {
	Host  string   `json:"host"`
	Addrs []string `json:"addrs,omitempty"`
	// TTLSeconds is the clamped TTL the entry is cached under.
	TTLSeconds int64 `json:"ttl_seconds,omitempty"`
	// Stale is true when the addresses above came from a lookup that is no
	// longer the latest word: the last attempt failed and these are the last
	// good ones.
	Stale bool `json:"stale"`
	// StaleAgeSeconds is how old that last good answer is.
	StaleAgeSeconds int64 `json:"stale_age_seconds,omitempty"`
	// LastError is why the last lookup failed (empty when it did not).
	LastError string `json:"last_error,omitempty"`
	// Lookups counts resolution attempts for this host since the process start.
	Lookups int64 `json:"lookups"`
}

// entry is the cached resolution of one host.
type entry struct {
	host  string
	addrs []string
	ttl   time.Duration

	// goodUntil is when the entry may no longer be used without a lookup.
	goodUntil time.Time
	// lastGoodAt is when these addresses were actually returned by a resolver;
	// it is what makes the stale age honest.
	lastGoodAt time.Time

	// lastErr is the most recent lookup failure, kept even while the addresses
	// above are still used as the fallback.
	lastErr string
	// stale is set while lastErr is the truth and addrs are the fallback.
	stale bool

	lookups int64
	// lastUsed orders eviction.
	lastUsed time.Time
	// inflight marks a lookup in progress, so N concurrent dials to an expired
	// host produce ONE query instead of N.
	inflight bool
	done     chan struct{}
}

// Resolver resolves target hostnames with a bounded, observable cache.
// It is safe for concurrent use: dials happen on many connection goroutines.
type Resolver struct {
	cfg Config

	mu      sync.Mutex
	entries map[string]*entry
}

// New builds a resolver, filling every bound with its documented default.
func New(cfg Config) *Resolver {
	if cfg.Lookup == nil {
		cfg.Lookup = StdlibLookup
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.TTL <= 0 {
		cfg.TTL = DefaultTTL
	}
	if cfg.MinTTL <= 0 {
		cfg.MinTTL = MinTTL
	}
	if cfg.MaxTTL <= 0 {
		cfg.MaxTTL = MaxTTL
	}
	if cfg.MaxTTL < cfg.MinTTL {
		cfg.MaxTTL = cfg.MinTTL
	}
	if cfg.FailureRetry <= 0 {
		cfg.FailureRetry = FailureRetry
	}
	if cfg.DialBudget <= 0 {
		cfg.DialBudget = DefaultDialBudget
	}
	if cfg.ResolveBudget <= 0 {
		cfg.ResolveBudget = DefaultResolveBudget
	}
	if cfg.Dial == nil {
		dialer := &net.Dialer{}
		cfg.Dial = dialer.DialContext
	}
	return &Resolver{cfg: cfg, entries: make(map[string]*entry)}
}

// Plan is how one target is reached right now.
type Plan struct {
	Host string
	Port int
	// Addrs are the "ip:port" candidates in the order they will be tried.
	Addrs []string
	// Literal is true when the host was an IP literal: no lookup happened.
	Literal bool
	// Stale is true when Addrs are the last good addresses after a failed
	// lookup, and Age says how old they are.
	Stale bool
	Age   time.Duration
}

// NormalizeHost is the identity half of a target: trimmed, lower-cased, with a
// trailing dot (the root anchor) and any surrounding IPv6 brackets removed.
//
// This mirrors targetobs.NormalizeHost on purpose: one target must be one
// identity everywhere on this node, or the same endpoint could be cached under
// two keys and reported as two facts.
func NormalizeHost(host string) string {
	h := strings.ToLower(strings.TrimSpace(host))
	h = strings.TrimSuffix(h, ".")
	if len(h) > 1 && strings.HasPrefix(h, "[") && strings.HasSuffix(h, "]") {
		h = h[1 : len(h)-1]
	}
	return h
}

// IsLiteral reports whether host is an IP address literal (v4 or v6).
func IsLiteral(host string) bool {
	h := NormalizeHost(host)
	if h == "" {
		return false
	}
	return net.ParseIP(h) != nil
}

// Plan resolves host for a dial to port.
//
// The returned error is a lookup failure with NO usable fallback: the target is
// unreachable right now, which is a fact about this moment — never a reason to
// delete the target or rewrite the hostname.
func (r *Resolver) Plan(ctx context.Context, host string, port int) (Plan, error) {
	if r == nil {
		return Plan{}, errors.New("targetdns: nil resolver")
	}
	h := NormalizeHost(host)
	if h == "" || port < 1 || port > 65535 {
		return Plan{}, fmt.Errorf("targetdns: %q:%d is not a dialable target", host, port)
	}
	// IP literals bypass resolution entirely: no lookup, no cache entry, no TTL.
	if ip := net.ParseIP(h); ip != nil {
		return Plan{Host: h, Port: port, Addrs: []string{net.JoinHostPort(h, strconv.Itoa(port))}, Literal: true}, nil
	}

	entry, err := r.resolve(ctx, h)
	if err != nil {
		return Plan{}, err
	}
	if len(entry.addrs) == 0 {
		return Plan{}, fmt.Errorf("targetdns: %s is not resolvable right now%s", h, detail(entry.lastErr))
	}
	addrs := make([]string, 0, len(entry.addrs))
	portStr := strconv.Itoa(port)
	for _, ip := range entry.addrs {
		addrs = append(addrs, net.JoinHostPort(ip, portStr))
	}
	age := time.Duration(0)
	if entry.stale && !entry.lastGoodAt.IsZero() {
		age = r.cfg.Now().Sub(entry.lastGoodAt)
		if age < 0 {
			age = 0
		}
	}
	return Plan{Host: h, Port: port, Addrs: addrs, Stale: entry.stale, Age: age}, nil
}

// DialContext dials a "host:port" address through the cache.
//
// It matches net.Dialer.DialContext so it can be injected as the data plane's
// dialer; non-TCP networks and unparseable addresses fall through to the plain
// dialer, because this package knows about target names, not about transports.
func (r *Resolver) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if r == nil {
		return nil, errors.New("targetdns: nil resolver")
	}
	if !isTCP(network) {
		return r.cfg.Dial(ctx, network, address)
	}
	host, portStr, err := net.SplitHostPort(address)
	if err != nil {
		return r.cfg.Dial(ctx, network, address)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return r.cfg.Dial(ctx, network, address)
	}

	// One budget covers the lookup AND every candidate, so "how long may a
	// connection attempt take" stays one answer. The lookup gets its own smaller
	// slice so a hung resolver cannot eat the whole budget.
	if r.cfg.DialBudget > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, r.cfg.DialBudget)
		defer cancel()
	}
	plan, err := r.Plan(ctx, host, port)
	if err != nil {
		return nil, err
	}
	return r.dialPlan(ctx, network, plan)
}

// dialPlan attempts every candidate address in order, inside the budget.
//
// Order is the resolver's, and the attempts are SEQUENTIAL on purpose. The
// contract forbids hand-rolling happy eyeballs (parallel racing with staggered
// timers and an RFC 6724 preference table), and the Go standard library offers
// no way to hand a *supplied* address set to net.Dialer's own ordering — that
// machinery only runs when the dialer resolves a name itself. So the honest
// choice is what a resolver-backed cache can actually offer: try each record we
// were given, all of them usable, IPv4 and IPv6 alike.
//
// MEASURED COST of that choice, recorded here because it is a real boundary: on
// a dual-stack host with a blackholed IPv6 path, the IPv6 candidate consumes its
// share of the budget before IPv4 is tried, where Go's own happy-eyeballs path
// would have fallen back after ~300ms. The total is still bounded by the budget,
// and an address that REFUSES fails instantly, which is the common case. If this
// ever costs a customer a real latency regression, the fix is a documented
// stagger, not an improvised one.
func (r *Resolver) dialPlan(ctx context.Context, network string, plan Plan) (net.Conn, error) {
	if len(plan.Addrs) == 0 {
		return nil, fmt.Errorf("targetdns: %s has no addresses", plan.Host)
	}
	budget := r.cfg.DialBudget
	if budget <= 0 {
		budget = DefaultDialBudget
	}
	perAttempt := budget / time.Duration(len(plan.Addrs))
	if perAttempt <= 0 {
		perAttempt = budget
	}

	var lastErr error
	for _, addr := range plan.Addrs {
		if err := ctx.Err(); err != nil {
			if lastErr != nil {
				return nil, fmt.Errorf("targetdns: %s: %w (last dial error: %v)", plan.Host, err, lastErr)
			}
			return nil, err
		}
		attempt, cancel := context.WithTimeout(ctx, perAttempt)
		conn, err := r.cfg.Dial(attempt, network, addr)
		cancel()
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("targetdns: %s: all %d address(es) failed: %w", plan.Host, len(plan.Addrs), lastErr)
}

// resolve returns the entry to use, refreshing it lazily when it is expired.
//
// Single-flight per host: a busy egress node whose target's TTL expires must
// produce one query, not one query per connection waiting on that target.
func (r *Resolver) resolve(ctx context.Context, host string) (*entry, error) {
	now := r.cfg.Now()
	r.mu.Lock()
	if e, ok := r.entries[host]; ok {
		e.lastUsed = now
		if now.Before(e.goodUntil) {
			out := e.clone()
			r.mu.Unlock()
			return out, nil
		}
		if e.inflight {
			done := e.done
			r.mu.Unlock()
			select {
			case <-done:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			// The leader finished: whatever it left is the answer, including a
			// failure (kept with the last good addresses as the fallback).
			r.mu.Lock()
			defer r.mu.Unlock()
			if cur, ok := r.entries[host]; ok {
				cur.lastUsed = r.cfg.Now()
				return cur.clone(), nil
			}
			return nil, fmt.Errorf("targetdns: %s: resolution did not produce a result", host)
		}
	}
	e := &entry{host: host, inflight: true, done: make(chan struct{}), lastUsed: now}
	if prev, ok := r.entries[host]; ok {
		// Carry the last good answer forward: it is the fallback this whole
		// mechanism exists for.
		e.addrs = prev.addrs
		e.lastGoodAt = prev.lastGoodAt
		e.ttl = prev.ttl
		e.lookups = prev.lookups
		e.lastErr = prev.lastErr
		e.stale = prev.stale
	}
	r.entries[host] = e
	r.evictLocked(now)
	r.mu.Unlock()

	result, err := r.lookup(ctx, host)

	r.mu.Lock()
	defer r.mu.Unlock()
	cur := r.entries[host]
	if cur == nil {
		cur = e
		r.entries[host] = cur
	}
	cur.inflight = false
	cur.lookups++
	cur.lastUsed = r.cfg.Now()
	close(e.done)

	before := Fact{Host: host, Addrs: append([]string(nil), e.addrs...), Stale: e.stale, LastError: e.lastErr}
	if err != nil {
		cur.lastErr = err.Error()
		cur.stale = true
		// A failed lookup is remembered briefly: long enough to rate-limit a
		// stampede, short enough that a recovery (or an address change) is picked
		// up promptly instead of being hidden for a whole TTL.
		cur.goodUntil = cur.lastUsed.Add(r.cfg.FailureRetry)
		cur.ttl = 0
		r.reportLocked(before, cur)
		return cur.clone(), nil
	}

	cur.addrs = append([]string(nil), result.Addrs...)
	cur.lastErr = ""
	cur.stale = false
	cur.ttl = r.clampTTL(result.TTL)
	cur.lastGoodAt = cur.lastUsed
	cur.goodUntil = cur.lastUsed.Add(cur.ttl)
	r.reportLocked(before, cur)
	return cur.clone(), nil
}

// lookup runs the injected resolver under the resolution budget.
//
// The bound lives here rather than in Plan's caller so that EVERY way in — the
// data path, a direct Plan call, a test — is bounded by the same rule: a
// resolution that can hang forever is a connection that can hang forever.
func (r *Resolver) lookup(ctx context.Context, host string) (LookupResult, error) {
	if r.cfg.ResolveBudget <= 0 {
		return r.cfg.Lookup(ctx, host)
	}
	lookupCtx, cancel := context.WithTimeout(ctx, r.cfg.ResolveBudget)
	defer cancel()
	return r.cfg.Lookup(lookupCtx, host)
}

// clampTTL applies the floor/ceiling to whatever TTL is in play.
func (r *Resolver) clampTTL(ttl time.Duration) time.Duration {
	if ttl <= 0 {
		ttl = r.cfg.TTL
	}
	if ttl < r.cfg.MinTTL {
		return r.cfg.MinTTL
	}
	if ttl > r.cfg.MaxTTL {
		return r.cfg.MaxTTL
	}
	return ttl
}

// reportLocked fires the fact sink on a TRANSITION, never per dial and never
// once per retry: a target that has been unresolvable for an hour is one fact,
// not 3600 log lines. It reports entering the failed state, leaving it, and any
// change to the address set we would dial (address churn is news).
//
// The FIRST resolution of a host is deliberately silent: "we just met this
// target" is not a change, and reporting it once per target at startup would
// bury the transitions that matter.
func (r *Resolver) reportLocked(before Fact, cur *entry) {
	if r.cfg.OnFact == nil {
		return
	}
	if len(before.Addrs) == 0 && before.LastError == "" {
		return
	}
	switch {
	case cur.lastErr != "" && !before.Stale:
		// Entering the failed/stale state (the first failure is the news).
	case cur.lastErr == "" && (before.Stale || !sameAddrs(before.Addrs, cur.addrs)):
		// Recovery, or the addresses moved.
	default:
		return
	}
	r.cfg.OnFact(r.factOf(cur))
}

// factOf renders one entry as a fact (caller holds the lock).
func (r *Resolver) factOf(e *entry) Fact {
	f := Fact{
		Host:    e.host,
		Addrs:   append([]string(nil), e.addrs...),
		Stale:   e.stale,
		Lookups: e.lookups,
	}
	if e.ttl > 0 {
		f.TTLSeconds = int64(e.ttl / time.Second)
	}
	if e.lastErr != "" {
		f.LastError = e.lastErr
	}
	if e.stale && !e.lastGoodAt.IsZero() {
		age := r.cfg.Now().Sub(e.lastGoodAt)
		if age > 0 {
			f.StaleAgeSeconds = int64(age / time.Second)
		}
	}
	return f
}

// clone copies an entry so callers never touch the cache under no lock.
func (e *entry) clone() *entry {
	if e == nil {
		return nil
	}
	out := *e
	out.addrs = append([]string(nil), e.addrs...)
	return &out
}

// evictLocked keeps the cache bounded: expired entries first, then oldest-used.
func (r *Resolver) evictLocked(now time.Time) {
	if len(r.entries) <= maxHosts {
		return
	}
	for host, e := range r.entries {
		if len(r.entries) <= maxHosts {
			return
		}
		if !e.inflight && now.After(e.goodUntil) {
			delete(r.entries, host)
		}
	}
	if len(r.entries) <= maxHosts {
		return
	}
	type pair struct {
		host string
		used time.Time
	}
	stale := make([]pair, 0, len(r.entries))
	for host, e := range r.entries {
		if !e.inflight {
			stale = append(stale, pair{host: host, used: e.lastUsed})
		}
	}
	sort.Slice(stale, func(i, j int) bool { return stale[i].used.Before(stale[j].used) })
	for _, p := range stale {
		if len(r.entries) <= maxHosts {
			return
		}
		delete(r.entries, p.host)
	}
}

// Facts renders every cached host's state, sorted, for diagnostics.
func (r *Resolver) Facts() []Fact {
	if r == nil {
		return []Fact{}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	hosts := make([]string, 0, len(r.entries))
	for host := range r.entries {
		hosts = append(hosts, host)
	}
	sort.Strings(hosts)
	out := make([]Fact, 0, len(hosts))
	for _, host := range hosts {
		out = append(out, r.factOf(r.entries[host]))
	}
	return out
}

// isTCP reports whether the network is (or includes) TCP.
func isTCP(network string) bool {
	switch strings.ToLower(strings.TrimSpace(network)) {
	case "tcp", "tcp4", "tcp6", "tcp:4", "tcp:6":
		return true
	default:
		return false
	}
}

// detail renders a lookup failure for an error message, bounded.
func detail(msg string) string {
	if strings.TrimSpace(msg) == "" {
		return ""
	}
	if len(msg) > 160 {
		msg = msg[:160]
	}
	return ": " + msg
}

// sameAddrs compares two address sets, order included: the order is what the
// dialer walks, so a reordering is a real change (the resolver's own preference).
func sameAddrs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
