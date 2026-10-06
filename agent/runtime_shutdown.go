package main

import (
	"context"
	"time"

	"github.com/tunex/agent/internal/logx"
)

const ShutdownTimeout = 10 * time.Second

// FinalReportTimeout bounds the closing state report. It is short on purpose:
// the point is to leave a trace, not to hold up a container stop.
const FinalReportTimeout = 3 * time.Second

// Shutdown tears the runtime down in a fixed order:
//
//  1. refuse new applies (manager.BeginShutdown) — a command arriving mid-teardown
//     must not be able to rebind a port;
//  2. CLOSE EVERY LISTENER, synchronously — from this instant a new TCP
//     connection is refused. Nothing that can block (cache fsync, state report)
//     may happen before this line: the node's contract with its clients is "stop
//     accepting new work now", and it must not depend on how long anything else
//     takes;
//  3. take one last cache snapshot and send a final bounded state report; both are
//     bounded and both happen while the finished runtime facts still exist (the
//     listener is closed, the connections are still tracked, the registry is
//     intact) so the panel receives facts rather than a guess;
//  4. drain in-flight connections until ONE absolute deadline, force-closing
//     whatever survives it. Both ends of every proxied pair are closed, so a peer
//     that never speaks again cannot hold a handler past the deadline;
//  5. stop the reporter and the admin plane, and wait for the cache writer.
//
// The total is bounded by ShutdownTimeout: the deadline for the drain is derived
// from the moment the teardown started, not from "now" after the report.
//
// It is safe to call on a runtime whose admin API never started, and safe to
// call twice.
func (rt *agentRuntime) Shutdown() {
	if rt == nil || !rt.started {
		return
	}
	rt.started = false
	startedAt := time.Now()
	if rt.cacheTick != nil {
		rt.cacheTick.Stop()
	}

	// Step 1 + 2: refuse new work, then stop accepting new connections. Both are
	// synchronous and immediate on purpose — this is the part of a shutdown the
	// outside world can observe.
	rt.tunnels.BeginShutdown()
	closed := rt.tunnels.CloseListeners()
	logx.Info("shutdown: listeners closed", "listeners", len(closed))

	// The registry and the live connections are still intact here, so the closing
	// report describes the node's real state.
	reportCtx, cancelReport := context.WithTimeout(context.Background(), FinalReportTimeout)
	rt.writeCache(version)
	if rt.heart != nil {
		if err := rt.heart.ReportOnce(reportCtx); err != nil {
			logx.Debug("final state report failed", "err", err.Error())
		}
	}
	cancelReport()

	// Step 4: one absolute deadline for the whole teardown, so the cache write and
	// the report above cannot eat the window meant for draining.
	remaining := ShutdownTimeout - time.Since(startedAt)
	if remaining < 0 {
		remaining = 0
	}
	report := rt.tunnels.ShutdownAll(remaining)
	// Datagram mappings are reported separately because they are dropped, not
	// waited out: a UDP mapping ends by idle expiry or by its socket closing
	// (§2.3③ of the datagram contract), so a datagram tunnel that was relaying
	// would otherwise contribute "0 forced, 0 remaining" to this line.
	if report.RemainingConns > 0 || report.ForcedConns > 0 || report.ForcedMappings > 0 {
		logx.Warn("shutdown closed work past the deadline",
			"forced", report.ForcedConns,
			"forced_mappings", report.ForcedMappings,
			"remaining", report.RemainingConns)
	}

	if rt.heart != nil {
		rt.heart.Stop()
	}
	if rt.api != nil {
		if err := rt.api.Stop(); err != nil {
			logx.Debug("admin api stop error", "err", err.Error())
		}
	}
	// The cache writer exits with the process context, but a shutdown triggered
	// without cancelling it must not leave a goroutine writing into a torn-down
	// runtime.
	rt.cacheWrites.Wait()
	rt.egress = nil
}

// restoreTunnels applies the node's desired state and reports whether it came
// from the Panel or the last-known-good cache. EGRESS state restores its target
// pool before the forwarder is built. writeMu shares the cache lock with the
// writer loop and Shutdown so restore cannot race a refresh into the same file.
