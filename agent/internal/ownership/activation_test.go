package ownership

import (
	"testing"
	"time"
)

func TestCandidateCheckNeverChangesLiveLeaseAndCompensationKeepsRenewal(t *testing.T) {
	clk := newClock()
	base := ownerConfig("tunex-60-direct", 1, clk.Now().Add(time.Minute))
	base.Revision = 1
	r := newRegistry(base)
	g := New(Config{Now: clk.Now, Registry: r})
	if err := g.Admit(base); err != nil {
		t.Fatal(err)
	}
	renewed := clk.Now().Add(3 * time.Minute)
	if n, _ := g.ObserveRenewals([]Renewal{{TunnelRef: 60, Epoch: 1, Revision: 1, ExpiresAt: renewed.Format(time.RFC3339)}}, clk.Now()); n != 1 {
		t.Fatal(n)
	}
	for _, expiry := range []time.Time{clk.Now().Add(10 * time.Second), clk.Now().Add(8 * time.Minute)} {
		candidate := base.Clone()
		candidate.Revision = 2
		candidate.LeaseExpiresAt = expiry.Format(time.RFC3339)
		if err := g.CheckActivation(candidate); err != nil {
			t.Fatal(err)
		}
		if got := g.deadlineOf(base.ID); !got.Equal(renewed) {
			t.Fatal("failed/stale candidate rewrote live clock", got)
		}
	}
	clk.advance(70 * time.Second) // Original command expired, renewal did not.
	compensation := g.CompensationConfig(base)
	if err := g.CheckActivation(compensation); err != nil {
		t.Fatal("valid effective lease lost", err)
	}
	if err := g.CommitActivation(compensation); err != nil {
		t.Fatal(err)
	}
	if got := g.deadlineOf(base.ID); !got.Equal(renewed) {
		t.Fatal("compensation regressed renewal", got)
	}
	other := base.Clone()
	other.OwnershipEpoch = 2
	if got := g.CompensationConfig(other).LeaseExpiresAt; got != base.LeaseExpiresAt {
		t.Fatal("borrowed another epoch's renewal")
	}
}

func TestRenewalCannotBorrowOtherAppliedIdentityOrRegressDeadline(t *testing.T) {
	clk := newClock()
	cfg := ownerConfig("tunex-61-direct", 4, clk.Now().Add(time.Minute))
	r := newRegistry(cfg)
	g := New(Config{Now: clk.Now, Registry: r})
	if err := g.Admit(cfg); err != nil {
		t.Fatal(err)
	}
	for _, value := range []Renewal{
		{TunnelRef: 61, Epoch: 3, Revision: cfg.Revision, ExpiresAt: clk.Now().Add(3 * time.Minute).Format(time.RFC3339)},
		{TunnelRef: 61, Epoch: 5, Revision: cfg.Revision, ExpiresAt: clk.Now().Add(3 * time.Minute).Format(time.RFC3339)},
		{TunnelRef: 61, Epoch: 4, Revision: cfg.Revision + 1, ExpiresAt: clk.Now().Add(3 * time.Minute).Format(time.RFC3339)},
		{TunnelRef: 61, Epoch: 4, Revision: cfg.Revision, ExpiresAt: clk.Now().Add(5 * time.Second).Format(time.RFC3339)},
	} {
		if applied, _ := g.ObserveRenewals([]Renewal{value}, clk.Now()); applied != 0 {
			t.Fatal("foreign/stale renewal applied", value)
		}
	}
	if got := g.deadlineOf(cfg.ID); !got.Equal(clk.Now().Add(time.Minute)) {
		t.Fatal("live deadline rewritten", got)
	}
}

func TestStaleCensusCannotPruneNewlyCommittedLease(t *testing.T) {
	clk := newClock()
	g := New(Config{Now: clk.Now})
	beforeCensus := g.clockGeneration
	cfg := ownerConfig("tunex-62-direct", 1, clk.Now().Add(time.Minute))
	if err := g.Admit(cfg); err != nil {
		t.Fatal(err)
	}
	g.pruneLeases(map[string]bool{}, beforeCensus)
	if g.deadlineOf(cfg.ID).IsZero() {
		t.Fatal("stale census erased new clock")
	}
	clk.advance(61 * time.Second)
	if !g.Expired(cfg.ID, clk.Now()) {
		t.Fatal("new runtime escaped expiry")
	}
	g.pruneLeases(map[string]bool{}, g.clockGeneration)
	if !g.deadlineOf(cfg.ID).IsZero() {
		t.Fatal("fresh orphan census failed to prune")
	}
}
