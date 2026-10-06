package ownership

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// clock is a settable wall clock: every ownership decision is time-based, and a
// test that sleeps to make a lease expire is a test that flakes on a loaded CI.
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

// fakeRegistry stands in for manager.TunnelManager: the sweep only needs List
// and the conditional removal.
type fakeRegistry struct {
	mu      sync.Mutex
	cfgs    map[string]forwarder.TunnelConfig
	removed []string
	// removeErr forces a removal failure, so the sweep's error path is testable.
	removeErr error
}

func newRegistry(cfgs ...forwarder.TunnelConfig) *fakeRegistry {
	r := &fakeRegistry{cfgs: map[string]forwarder.TunnelConfig{}}
	for _, c := range cfgs {
		r.cfgs[c.ID] = c
	}
	return r
}

func (f *fakeRegistry) List() []forwarder.TunnelConfig {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]forwarder.TunnelConfig, 0, len(f.cfgs))
	for _, c := range f.cfgs {
		out = append(out, c)
	}
	return out
}

func (f *fakeRegistry) RemoveIf(id string, cond func(forwarder.TunnelConfig) bool) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.removeErr != nil {
		return false, f.removeErr
	}
	cfg, ok := f.cfgs[id]
	if !ok {
		return false, nil
	}
	if cond != nil && !cond(cfg) {
		return false, nil
	}
	delete(f.cfgs, id)
	f.removed = append(f.removed, id)
	return true, nil
}

func (f *fakeRegistry) set(cfg forwarder.TunnelConfig) {
	f.mu.Lock()
	f.cfgs[cfg.ID] = cfg
	f.mu.Unlock()
}

func (f *fakeRegistry) removedIDs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.removed...)
}

// ownerConfig builds a tunnel config carrying ownership facts.
func ownerConfig(id string, epoch int64, expires time.Time) forwarder.TunnelConfig {
	return forwarder.TunnelConfig{
		ID:             id,
		Mode:           forwarder.ModeRelay,
		IngressPort:    19000,
		NextHop:        "10.0.0.1:443",
		Protocol:       forwarder.ProtocolTCP,
		Revision:       3,
		OwnershipEpoch: epoch,
		LeaseExpiresAt: expires.UTC().Format(time.RFC3339Nano),
	}
}

// newGuard builds a guard over a temp-dir fence and a fake registry.
func newGuard(t *testing.T, clk *clock, reg Registry) *Guard {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ownership-epoch.json")
	g := New(Config{
		Fence:    OpenFence(path, "agent-1"),
		Registry: reg,
		Now:      clk.Now,
	})
	return g
}

// ---------------------------------------------------------------------------
// Identity join
// ---------------------------------------------------------------------------

func TestLeaseTunnelRefReadsThePanelNaming(t *testing.T) {
	cases := []struct {
		id   string
		want int64
		ok   bool
	}{
		{"tunex-42-relay", 42, true},
		{"tunex-7-direct", 7, true},
		{"tunex-123456-egress", 123456, true},
		{"  tunex-9-relay  ", 9, true},
		{"tunex--relay", 0, false},
		{"tunex-0-relay", 0, false}, // generations start at 1, so 0 is not a key
		{"other-42-relay", 0, false},
		{"42", 0, false},
		{"", 0, false},
	}
	for _, c := range cases {
		got, ok := LeaseTunnelRef(c.id)
		if ok != c.ok || got != c.want {
			t.Errorf("LeaseTunnelRef(%q) = (%d,%v), want (%d,%v)", c.id, got, ok, c.want, c.ok)
		}
	}
}

// ---------------------------------------------------------------------------
// The epoch fence
// ---------------------------------------------------------------------------

func TestStaleEpochIsRefusedAndHigherEpochIsAccepted(t *testing.T) {
	clk := newClock()
	g := newGuard(t, clk, nil)
	future := clk.Now().Add(time.Minute)

	if err := g.Admit(ownerConfig("tunex-1-relay", 5, future)); err != nil {
		t.Fatalf("epoch 5 must be accepted on an empty fence: %v", err)
	}
	if got := g.Fence().Highest("tunex-1-relay"); got != 5 {
		t.Fatalf("highest = %d, want 5", got)
	}

	// The split-brain case: an activation claiming an older generation.
	err := g.Admit(ownerConfig("tunex-1-relay", 4, future))
	if err == nil {
		t.Fatal("epoch 4 must be refused after seeing 5")
	}
	code, ok := RefusalCode(err)
	if !ok || code != CodeStaleEpoch {
		t.Fatalf("refusal = %v (code %q, ok %v), want %s", err, code, ok, CodeStaleEpoch)
	}
	var refusal *Refusal
	if !errors.As(err, &refusal) || refusal.Epoch != 4 || refusal.Highest != 5 {
		t.Fatalf("refusal does not carry the numbers: %+v", refusal)
	}
	if got := g.Fence().Highest("tunex-1-relay"); got != 5 {
		t.Fatalf("a refused activation must not move the fence: %d", got)
	}

	// A real handover can only move forward.
	if err := g.Admit(ownerConfig("tunex-1-relay", 6, future)); err != nil {
		t.Fatalf("epoch 6 must be accepted: %v", err)
	}
	if got := g.Fence().Highest("tunex-1-relay"); got != 6 {
		t.Fatalf("highest = %d, want 6", got)
	}
}

func TestFenceIsPerTunnel(t *testing.T) {
	clk := newClock()
	g := newGuard(t, clk, nil)
	future := clk.Now().Add(time.Minute)

	if err := g.Admit(ownerConfig("tunex-1-relay", 9, future)); err != nil {
		t.Fatalf("tunnel A epoch 9: %v", err)
	}
	// Tunnel B's epoch 1 is not "older" than tunnel A's 9: epochs are generations
	// of ONE Forward's lease, and a node-wide counter would refuse every freshly
	// created tunnel on a busy node.
	if err := g.Admit(ownerConfig("tunex-2-relay", 1, future)); err != nil {
		t.Fatalf("tunnel B epoch 1 must not be compared against tunnel A: %v", err)
	}
	if got := g.Fence().Highest("tunex-2-relay"); got != 1 {
		t.Fatalf("tunnel B highest = %d, want 1", got)
	}
}

func TestHighestEpochSurvivesARestart(t *testing.T) {
	clk := newClock()
	path := filepath.Join(t.TempDir(), "ownership-epoch.json")
	future := clk.Now().Add(time.Minute)

	g := New(Config{Fence: OpenFence(path, "agent-1"), Now: clk.Now})
	if err := g.Admit(ownerConfig("tunex-7-relay", 4, future)); err != nil {
		t.Fatalf("admit epoch 4: %v", err)
	}

	// A restart: a brand new process, a brand new guard, the same state dir.
	restarted := New(Config{Fence: OpenFence(path, "agent-1"), Now: clk.Now})
	if got := restarted.Fence().Highest("tunex-7-relay"); got != 4 {
		t.Fatalf("the fence forgot its highest epoch across a restart: %d", got)
	}
	err := restarted.Admit(ownerConfig("tunex-7-relay", 3, future))
	if code, ok := RefusalCode(err); !ok || code != CodeStaleEpoch {
		t.Fatalf("a restarted node must still refuse an old epoch, got %v", err)
	}
	// ... and must still accept the current one.
	if err := restarted.Admit(ownerConfig("tunex-7-relay", 5, future)); err != nil {
		t.Fatalf("a restarted node must accept a newer epoch: %v", err)
	}
}

func TestAbsentOwnershipFactsMeanNoFenceAndNoClock(t *testing.T) {
	clk := newClock()
	reg := newRegistry()
	g := newGuard(t, clk, reg)
	future := clk.Now().Add(time.Minute)

	if err := g.Admit(ownerConfig("tunex-1-relay", 5, future)); err != nil {
		t.Fatalf("admit: %v", err)
	}

	// An older panel: no epoch, no lease. This must behave exactly as it did
	// without ownership facts — no refusal (even though a fence exists) and no deadline.
	bare := forwarder.TunnelConfig{ID: "tunex-1-relay", Mode: forwarder.ModeRelay, IngressPort: 19000, NextHop: "10.0.0.1:443", Protocol: forwarder.ProtocolTCP, Revision: 9}
	if err := g.Admit(bare); err != nil {
		t.Fatalf("a config without ownership facts must not be fenced: %v", err)
	}
	// A statement that says nothing about ownership cannot erase an
	// authorisation either: otherwise a replayed fact-less config would switch a
	// fenced tunnel's clock off. The previously stated deadline stands.
	if !g.Expired("tunex-1-relay", clk.Now().Add(1000*time.Hour)) {
		t.Fatal("a fact-less config erased a stated deadline")
	}
	// The fence itself is untouched by a statement that carries no epoch.
	if got := g.Fence().Highest("tunex-1-relay"); got != 5 {
		t.Fatalf("highest = %d, want 5", got)
	}
}

func TestFenceRisesEvenWhenTheApplyWouldFail(t *testing.T) {
	clk := newClock()
	g := newGuard(t, clk, nil)
	// A config that carries a generation but no lease: the claim is seen, so the
	// fence rises (the apply is the manager's business, not the guard's).
	if err := g.Admit(forwarder.TunnelConfig{ID: "tunex-3-relay", OwnershipEpoch: 11}); err != nil {
		t.Fatalf("admit: %v", err)
	}
	if got := g.Fence().Highest("tunex-3-relay"); got != 11 {
		t.Fatalf("highest = %d, want 11", got)
	}
	if err := g.Admit(ownerConfig("tunex-3-relay", 10, clk.Now().Add(time.Minute))); !isCode(err, CodeStaleEpoch) {
		t.Fatalf("epoch 10 after seeing 11 = %v, want %s", err, CodeStaleEpoch)
	}
}

func TestMalformedLeaseIsRefusedBeforeAnythingElse(t *testing.T) {
	clk := newClock()
	g := newGuard(t, clk, nil)
	bad := forwarder.TunnelConfig{ID: "tunex-1-relay", OwnershipEpoch: 2, LeaseExpiresAt: "not-a-time"}
	if err := g.Admit(bad); !isCode(err, CodeMalformedLease) {
		t.Fatalf("unparseable lease = %v, want %s", err, CodeMalformedLease)
	}
}

func TestEpochSurvivesAZeroByteFenceFileOnlyWhenConfigured(t *testing.T) {
	clk := newClock()
	dir := t.TempDir()
	path := filepath.Join(dir, "ownership-epoch.json")

	// A corrupt file: start empty, report why. Refusing every activation instead
	// would turn a damaged 40-byte file into a whole-node outage.
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	g := New(Config{Fence: OpenFence(path, "agent-1"), Now: clk.Now})
	if err := g.Fence().LoadError(); err == nil {
		t.Fatal("a corrupt fence file must be reported")
	}
	if !g.Fence().Durable() {
		t.Fatal("a configured path is durable even when its current contents are unusable")
	}
	if err := g.Admit(ownerConfig("tunex-1-relay", 1, clk.Now().Add(time.Minute))); err != nil {
		t.Fatalf("a corrupt fence must not brick activations: %v", err)
	}
	// The raise rewrote the file, so the next process sees a usable fence.
	if got := OpenFence(path, "agent-1").Highest("tunex-1-relay"); got != 1 {
		t.Fatalf("fence after repair = %d, want 1", got)
	}
}

func TestForeignAgentFenceIsRefusedNotAdopted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ownership-epoch.json")
	own := OpenFence(path, "agent-1")
	if _, _, err := own.Observe("tunex-1-relay", 9); err != nil {
		t.Fatalf("observe: %v", err)
	}
	other := OpenFence(path, "agent-2")
	if !errors.Is(other.LoadError(), ErrFenceIdentityMismatch) {
		t.Fatalf("another agent's fence must not be adopted, got %v", other.LoadError())
	}
	if got := other.Highest("tunex-1-relay"); got != 0 {
		t.Fatalf("adopted foreign epochs: %d", got)
	}
}

func TestFenceWithoutAPathIsMemoryOnlyAndSaysSo(t *testing.T) {
	clk := newClock()
	g := New(Config{Fence: OpenFence("", "agent-1"), Now: clk.Now})
	if g.Fence().Durable() {
		t.Fatal("no path cannot be durable")
	}
	if err := g.Fence().LoadError(); err != nil {
		t.Fatalf("not having a path is a configuration, not a load error: %v", err)
	}
	// It still fences within the process.
	if err := g.Admit(ownerConfig("tunex-1-relay", 4, clk.Now().Add(time.Minute))); err != nil {
		t.Fatalf("admit: %v", err)
	}
	if err := g.Admit(ownerConfig("tunex-1-relay", 3, clk.Now().Add(time.Minute))); !isCode(err, CodeStaleEpoch) {
		t.Fatalf("in-memory fence must still refuse: %v", err)
	}
	if got := New(Config{Fence: OpenFence("", "agent-1"), Now: clk.Now}).Fence().Highest("tunex-1-relay"); got != 0 {
		t.Fatalf("memory-only fence survived a restart: %d", got)
	}
}

func TestUnwritableFenceRefusesTheActivation(t *testing.T) {
	clk := newClock()
	dir := t.TempDir()
	// Make the parent unwritable AND make the fence path a directory, so the
	// atomic rename can never succeed.
	path := filepath.Join(dir, "ownership-epoch.json")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	g := New(Config{Fence: OpenFence(path, "agent-1"), Now: clk.Now})
	err := g.Admit(ownerConfig("tunex-1-relay", 1, clk.Now().Add(time.Minute)))
	if !isCode(err, CodeEpochUnpersisted) {
		t.Fatalf("an unpersistable raise = %v, want %s", err, CodeEpochUnpersisted)
	}
	if got := g.Fence().Highest("tunex-1-relay"); got != 0 {
		t.Fatalf("an unprovable raise must not be remembered: %d", got)
	}
}

func TestRefusalIsReportedAsAFact(t *testing.T) {
	clk := newClock()
	var reported []string
	g := New(Config{
		Fence:  OpenFence(filepath.Join(t.TempDir(), "f.json"), "agent-1"),
		Now:    clk.Now,
		Report: func(msg string) { reported = append(reported, msg) },
	})
	future := clk.Now().Add(time.Minute)
	if err := g.Admit(ownerConfig("tunex-1-relay", 5, future)); err != nil {
		t.Fatalf("admit: %v", err)
	}
	_ = g.Admit(ownerConfig("tunex-1-relay", 2, future))

	facts := g.Facts()
	if facts.Refusals != 1 {
		t.Errorf("facts.Refusals = %d, want 1", facts.Refusals)
	}
	if facts.LastRefusal == nil || facts.LastRefusal.Code != CodeStaleEpoch {
		t.Errorf("facts.LastRefusal = %+v", facts.LastRefusal)
	}
	if len(reported) != 1 || !strings.Contains(reported[0], CodeStaleEpoch) {
		t.Errorf("refusal was not filed in the ledger: %v", reported)
	}
	if !facts.Durable {
		t.Error("facts.Durable = false for a temp-dir fence")
	}
	// The refusal must be visible in the rendered facts, not just internally.
	raw, err := json.Marshal(facts)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"refusals":1`) || !strings.Contains(string(raw), CodeStaleEpoch) {
		t.Errorf("facts JSON does not carry the refusal: %s", raw)
	}
}

// ---------------------------------------------------------------------------
// The lease clock
// ---------------------------------------------------------------------------

func TestExpiredLeaseIsRefusedAtActivation(t *testing.T) {
	clk := newClock()
	g := newGuard(t, clk, nil)
	// The panel's lease ran out a second ago: a tunnel must not be (re)started
	// on an authorisation that has already lapsed.
	err := g.Admit(ownerConfig("tunex-1-relay", 3, clk.Now().Add(-time.Second)))
	if !isCode(err, CodeLeaseExpired) {
		t.Fatalf("expired lease = %v, want %s", err, CodeLeaseExpired)
	}
}

func TestSweepStopsATunnelWhoseLeaseLapsed(t *testing.T) {
	clk := newClock()
	cfg := ownerConfig("tunex-1-relay", 3, clk.Now().Add(30*time.Second))
	reg := newRegistry()
	g := newGuard(t, clk, reg)

	if err := g.Admit(cfg); err != nil {
		t.Fatalf("admit: %v", err)
	}
	reg.set(cfg)

	// Not yet: the lease is still valid.
	if stopped := g.SweepOnce(clk.Now()); len(stopped) != 0 {
		t.Fatalf("stopped %v before the lease lapsed", stopped)
	}

	clk.advance(31 * time.Second)
	stopped := g.SweepOnce(clk.Now())
	if len(stopped) != 1 || stopped[0] != cfg.ID {
		t.Fatalf("stopped = %v, want [%s]", stopped, cfg.ID)
	}
	if got := reg.removedIDs(); len(got) != 1 || got[0] != cfg.ID {
		t.Fatalf("registry removals = %v", got)
	}
	facts := g.Facts()
	if facts.LeaseStops != 1 || facts.LastLeaseStop == nil || facts.LastLeaseStop.TunnelID != cfg.ID {
		t.Fatalf("lease stop was not recorded as a fact: %+v", facts)
	}
	// Idempotent: nothing left to stop.
	if again := g.SweepOnce(clk.Now()); len(again) != 0 {
		t.Fatalf("second sweep stopped %v", again)
	}
}

func TestRenewalKeepsATunnelServingPastTheConfigDeadline(t *testing.T) {
	clk := newClock()
	cfg := ownerConfig("tunex-42-relay", 3, clk.Now().Add(30*time.Second))
	reg := newRegistry(cfg)
	g := newGuard(t, clk, reg)
	if err := g.Admit(cfg); err != nil {
		t.Fatalf("admit: %v", err)
	}

	// The panel's answer extends the lease (the config's own deadline is NOT
	// rewritten — desired state stays desired state).
	clk.advance(29 * time.Second)
	applied, missed := g.ObserveRenewals([]Renewal{{
		TunnelRef: 42,
		Epoch:     3,
		ExpiresAt: clk.Now().Add(30 * time.Second).UTC().Format(time.RFC3339),
	}}, clk.Now())
	if applied != 1 || missed != 0 {
		t.Fatalf("ObserveRenewals = (%d,%d), want (1,0)", applied, missed)
	}

	clk.advance(29 * time.Second)
	if stopped := g.SweepOnce(clk.Now()); len(stopped) != 0 {
		t.Fatalf("a renewed tunnel was stopped: %v", stopped)
	}

	// Without another renewal it does lapse, one TTL later.
	clk.advance(2 * time.Second)
	if stopped := g.SweepOnce(clk.Now()); len(stopped) != 1 {
		t.Fatalf("stopped = %v, want the lapsed tunnel", stopped)
	}
}

func TestRenewalForAnUnknownTunnelIsCountedNotGuessed(t *testing.T) {
	clk := newClock()
	reg := newRegistry()
	g := newGuard(t, clk, reg)
	applied, missed := g.ObserveRenewals([]Renewal{{
		TunnelRef: 99,
		Epoch:     2,
		ExpiresAt: clk.Now().Add(time.Minute).UTC().Format(time.RFC3339),
	}}, clk.Now())
	if applied != 0 || missed != 1 {
		t.Fatalf("ObserveRenewals = (%d,%d), want (0,1)", applied, missed)
	}
	if facts := g.Facts(); facts.RenewalMisses != 1 || len(facts.SkippedRenewals) != 1 {
		t.Fatalf("unmatched renewal not surfaced: %+v", facts)
	}
}

func TestCancelledRenewalCannotExtendADeadline(t *testing.T) {
	clk := newClock()
	cfg := ownerConfig("tunex-5-relay", 1, clk.Now().Add(10*time.Second))
	reg := newRegistry(cfg)
	g := newGuard(t, clk, reg)
	if err := g.Admit(cfg); err != nil {
		t.Fatalf("admit: %v", err)
	}

	clk.advance(11 * time.Second)
	// The sweep decision is check-and-act: the predicate re-reads the deadline
	// under the registry's lock, so a renewal that landed first wins.
	applied, _ := g.ObserveRenewals([]Renewal{{
		TunnelRef: 5,
		Epoch:     1,
		ExpiresAt: clk.Now().Add(time.Minute).UTC().Format(time.RFC3339),
	}}, clk.Now())
	if applied != 1 {
		t.Fatalf("renewal applied = %d", applied)
	}
	if stopped := g.SweepOnce(clk.Now()); len(stopped) != 0 {
		t.Fatalf("stop raced a renewal: %v", stopped)
	}
}

func TestLeaseStopHookSeesTheConfigThatWasRunning(t *testing.T) {
	clk := newClock()
	cfg := ownerConfig("tunex-1-relay", 1, clk.Now().Add(time.Second))
	reg := newRegistry(cfg)
	var stopped []forwarder.TunnelConfig
	g := New(Config{
		Fence:       OpenFence(filepath.Join(t.TempDir(), "f.json"), "agent-1"),
		Registry:    reg,
		Now:         clk.Now,
		OnLeaseStop: func(c forwarder.TunnelConfig) { stopped = append(stopped, c) },
	})
	if err := g.Admit(cfg); err != nil {
		t.Fatalf("admit: %v", err)
	}
	clk.advance(2 * time.Second)
	g.SweepOnce(clk.Now())

	if len(stopped) != 1 || stopped[0].ID != cfg.ID || stopped[0].Mode != forwarder.ModeEgress && stopped[0].Mode != cfg.Mode {
		t.Fatalf("hook saw %+v, want the stopped config", stopped)
	}
	// And only on an actual stop: a second sweep has nothing to report.
	g.SweepOnce(clk.Now())
	if len(stopped) != 1 {
		t.Fatalf("hook fired %d times, want 1", len(stopped))
	}
}

func TestSweepPrunesDeadlinesForTunnelsThatAreGone(t *testing.T) {
	clk := newClock()
	cfg := ownerConfig("tunex-1-relay", 1, clk.Now().Add(time.Minute))
	reg := newRegistry()
	g := newGuard(t, clk, reg)
	if err := g.Admit(cfg); err != nil {
		t.Fatalf("admit: %v", err)
	}
	reg.set(cfg)
	if err := g.Admit(ownerConfig("tunex-2-relay", 1, clk.Now().Add(time.Minute))); err != nil {
		t.Fatalf("admit 2: %v", err)
	}
	tracked := func() int {
		n := 0
		for _, tf := range g.Facts().Tunnels {
			if tf.LeaseExpiresAt != "" {
				n++
			}
		}
		return n
	}
	if got := tracked(); got != 2 {
		t.Fatalf("tracked deadlines = %d, want 2", got)
	}
	g.SweepOnce(clk.Now())
	// tunnel-2 was never in the registry: its deadline is dropped, so the table
	// stays bounded by what the node actually runs (its FENCE entry stays — a
	// generation the node has seen is not forgotten just because the tunnel is
	// not running right now).
	if got := tracked(); got != 1 {
		t.Fatalf("tracked deadlines = %d after prune, want 1", got)
	}
}

func TestRenewalWithAnUnreadableDeadlineIsIgnored(t *testing.T) {
	clk := newClock()
	cfg := ownerConfig("tunex-8-relay", 1, clk.Now().Add(10*time.Second))
	reg := newRegistry(cfg)
	g := newGuard(t, clk, reg)
	if err := g.Admit(cfg); err != nil {
		t.Fatalf("admit: %v", err)
	}
	applied, missed := g.ObserveRenewals([]Renewal{{TunnelRef: 8, Epoch: 1, ExpiresAt: "later"}}, clk.Now())
	if applied != 0 || missed != 1 {
		t.Fatalf("ObserveRenewals = (%d,%d), want (0,1)", applied, missed)
	}
	// The original deadline still stands: an unreadable statement must not
	// silently extend (or cancel) an authorisation.
	clk.advance(11 * time.Second)
	if !g.Expired("tunex-8-relay", clk.Now()) {
		t.Fatal("an unreadable renewal erased the deadline")
	}
}

func TestRunStopsSweepingWhenCancelled(t *testing.T) {
	clk := newClock()
	cfg := ownerConfig("tunex-1-relay", 1, clk.Now().Add(5*time.Second))
	reg := newRegistry(cfg)
	g := New(Config{
		Fence:         OpenFence(filepath.Join(t.TempDir(), "f.json"), "agent-1"),
		Registry:      reg,
		Now:           clk.Now,
		SweepInterval: time.Millisecond,
	})
	if err := g.Admit(cfg); err != nil {
		t.Fatalf("admit: %v", err)
	}
	// Past the lease (the config's deadline is 5s out), so the first tick has
	// something to do.
	clk.advance(6 * time.Second)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); g.Run(ctx) }()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && len(reg.removedIDs()) == 0 {
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after cancellation")
	}
	if len(reg.removedIDs()) != 1 {
		t.Fatalf("removals = %v, want the lapsed tunnel", reg.removedIDs())
	}
}

func TestSweepSurvivesARemovalFailure(t *testing.T) {
	clk := newClock()
	cfg := ownerConfig("tunex-1-relay", 1, clk.Now().Add(time.Second))
	reg := newRegistry(cfg)
	reg.removeErr = errors.New("port guard exploded")
	g := newGuard(t, clk, reg)
	if err := g.Admit(cfg); err != nil {
		t.Fatalf("admit: %v", err)
	}
	clk.advance(2 * time.Second)
	if stopped := g.SweepOnce(clk.Now()); len(stopped) != 0 {
		t.Fatalf("a failed removal must not be reported as stopped: %v", stopped)
	}
	// The next tick tries again: the deadline is still lapsed.
	reg.removeErr = nil
	if stopped := g.SweepOnce(clk.Now()); len(stopped) != 1 {
		t.Fatalf("second sweep = %v, want a retry", stopped)
	}
}

// isCode reports whether err is a refusal with the given code.
func isCode(err error, code string) bool {
	got, ok := RefusalCode(err)
	return ok && got == code
}
