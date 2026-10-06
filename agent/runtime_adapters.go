package main

import (
	"time"

	"github.com/tunex/agent/internal/logx"
	"github.com/tunex/agent/internal/manager"
	"github.com/tunex/agent/internal/ownership"
	"github.com/tunex/agent/internal/reporter"
)

type leaseSink struct{ guard *ownership.Guard }

func (s leaseSink) ObserveLeases(leases []reporter.LeaseRenewal, at time.Time) {
	if s.guard == nil || len(leases) == 0 {
		return
	}
	converted := make([]ownership.Renewal, 0, len(leases))
	for _, l := range leases {
		converted = append(converted, ownership.Renewal{
			TunnelRef: l.TunnelRef,
			Epoch:     l.Epoch,
			ExpiresAt: l.ExpiresAt,
			Revision:  l.Revision,
		})
	}
	if applied, missed := s.guard.ObserveRenewals(converted, at); missed > 0 {
		// Not an error: a lease for a tunnel this node does not run is a
		// legitimate panel answer. It is a fact worth a line, because a climbing
		// count means the placement and this node's identity disagree.
		logx.Debug("ownership: some renewals matched no running tunnel",
			"applied", applied, "unmatched", missed)
	}
}

// egressAdapter maps manager.EgressManager.Snapshot's PoolSnapshot onto the
// reporter's EgressPool view so the heartbeat JSON shape stays decoupled from
// the manager package.
type egressAdapter struct{ e *manager.EgressManager }

func (a egressAdapter) Snapshot() map[string]reporter.EgressPool {
	in := a.e.Snapshot()
	out := make(map[string]reporter.EgressPool, len(in))
	for id, p := range in {
		out[id] = reporter.EgressPool{Strategy: p.Strategy, Targets: p.Targets}
	}
	return out
}

