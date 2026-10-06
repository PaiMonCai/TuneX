package manager

import (
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/logx"
)

// ErrNodeShuttingDown is returned by Apply once a shutdown has begun. It is a
// distinct sentinel (not ErrStaleRevision): a refused apply during shutdown is
// not a stale config, and the caller must not treat it as one.
var ErrNodeShuttingDown = errors.New("manager: node is shutting down")

// ShutdownReport is the bounded, reportable outcome of ShutdownAll.
//
// It exists so the final state report can state facts instead of guessing:
// how many listeners were closed, how many connections had to be forced, and
// whether anything survived.
type ShutdownReport struct {
	// Listeners is the number of tunnels whose listener this shutdown closed.
	Listeners int
	// ForcedConns is how many in-flight connections were force-closed after the
	// shared deadline expired.
	ForcedConns int
	// ForcedMappings is how many datagram mappings were dropped by the socket
	// close. It is separate from ForcedConns because a mapping is not a
	// connection that outlived a deadline: it ends by idle expiry or by its
	// socket closing, so a shutdown drops it deliberately (§2.3③ of the datagram
	// contract). Counting it here is what stops a datagram tunnel from reporting
	// "0 remaining, 0 forced" while it was relaying (§4.4.2).
	ForcedMappings int
	// RemainingConns is what was still live when shutdown returned.
	RemainingConns int
	// Skipped lists tunnel ids that had no bound listener (nothing to close).
	Skipped []string
	// StartedAt/FinishedAt bound the shutdown window for the log line.
	StartedAt  time.Time
	FinishedAt time.Time
}

// BeginShutdown flips the manager into "closing": every following Apply is
// refused with ErrNodeShuttingDown. It is separate from ShutdownAll so the
// caller can stop accepting work BEFORE it starts closing listeners — a config
// that arrives mid-teardown must not be able to rebind a port.
func (m *TunnelManager) BeginShutdown() {
	if m == nil {
		return
	}
	m.mu.Lock()
	m.closing = true
	m.mu.Unlock()
}

// ShuttingDown reports whether BeginShutdown has run.
func (m *TunnelManager) ShuttingDown() bool {
	if m == nil {
		return false
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.closing
}

// CloseListeners stops every listener accepting new connections, synchronously
// and without waiting for anything. It returns the ids whose listening stopped,
// so a later drain phase can report totals without counting them twice.
//
// This is phase 1 of a node shutdown and it is separated from the drain on
// purpose: "when does new TCP start failing?" must not depend on how long
// draining the existing connections takes. The registry and the live connections
// are left intact, so a final state report can still describe what the node had.
func (m *TunnelManager) CloseListeners() []string {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	entries := make([]*entry, 0, len(m.tunnels))
	for _, e := range m.tunnels {
		entries = append(entries, e)
	}
	m.mu.Unlock()

	var closed []string
	for _, e := range entries {
		if closer, ok := e.fwd.(forwarder.ListenerCloser); ok {
			if closer.CloseListener() {
				closed = append(closed, e.cfg.ID)
			}
			continue
		}
		// A forwarder without the split primitive: Stop is the only way to end
		// its listener. It also ends its connections, which is more forceful
		// than phase 1 promises, so it is counted as closed either way.
		if err := e.fwd.Stop(); err == nil {
			closed = append(closed, e.cfg.ID)
		}
	}
	if len(closed) > 0 {
		sort.Strings(closed)
		logx.Info("listeners closed for shutdown", "closed", len(closed))
	}
	return closed
}

// ShutdownAll closes every listener and drains in-flight connections under one
// shared deadline, then force-closes whatever is left.
//
// It is the one-call form of BeginShutdown + CloseListeners + drain, kept for
// callers that do not need to separate the phases (tests, admin stop). A node
// shutdown prefers the explicit order in v3runtime so the closing report can be
// produced while the runtime facts still exist.
//
// It differs from StopAll in two deliberate ways:
//
//   - listeners are CLOSED (Stop also closes, but only after a per-tunnel 3s
//     drain, so a second listener could still accept long after the first);
//     here the deadline is shared, so the whole node stops accepting at once;
//   - connections that outlive the deadline are closed instead of being waited
//     on indefinitely.
//
// It is idempotent and safe to call without BeginShutdown (it begins one).
func (m *TunnelManager) ShutdownAll(timeout time.Duration) ShutdownReport {
	report := ShutdownReport{StartedAt: time.Now()}
	if m == nil {
		report.FinishedAt = report.StartedAt
		return report
	}
	m.BeginShutdown()
	// Phase 1 first, and before the registry is emptied: new connections must be
	// refused from this instant, whatever the drain then costs. The ids it closed
	// are seeded into the report, because phase 2 will find those listeners
	// already closed and would otherwise report "0 listeners" for a shutdown that
	// closed all of them.
	closedInPhaseOne := m.CloseListeners()
	counted := make(map[string]bool, len(closedInPhaseOne))
	for _, id := range closedInPhaseOne {
		counted[id] = true
	}

	m.mu.Lock()
	entries := make([]*entry, 0, len(m.tunnels))
	for _, e := range m.tunnels {
		entries = append(entries, e)
	}
	m.tunnels = make(map[string]*entry)
	m.usedPort = make(map[string]bool)
	m.mu.Unlock()

	// One deadline for every listener: the clock starts here, not per tunnel.
	deadline := time.Now().Add(timeout)

	var wg sync.WaitGroup
	for _, e := range entries {
		if !e.fwd.Running() {
			report.Skipped = append(report.Skipped, e.cfg.ID)
			continue
		}
		wg.Add(1)
		go func(e *entry) {
			defer wg.Done()
			remaining := time.Until(deadline)
			if remaining < 0 {
				remaining = 0
			}
			result := shutdownOne(e.fwd, remaining)
			if counted[e.cfg.ID] {
				// Already reported by phase 1; do not count it twice.
				result.ClosedListener = false
			}
			m.recordShutdown(e.cfg.ID, result)
		}(e)
	}
	wg.Wait()

	report.Listeners, report.ForcedConns, report.ForcedMappings, report.RemainingConns = m.drainShutdownTotals()
	report.Listeners += len(closedInPhaseOne)
	sort.Strings(report.Skipped)
	report.FinishedAt = time.Now()
	logx.Info("tunnels shut down",
		"listeners", report.Listeners,
		"forced_conns", report.ForcedConns,
		"forced_mappings", report.ForcedMappings,
		"remaining_conns", report.RemainingConns,
		"skipped", len(report.Skipped))
	return report
}

// shutdownOne closes one runtime either through the graceful-shutdown primitive or, for a
// runtime that predates it, through Stop (which still ends the listener).
//
// The in-flight fallback asks for the transport's own measure: a datagram runtime
// answers LiveMappings, and asking it for LiveConns would silently report 0 for a
// tunnel that is holding mappings (§4.4.2).
func shutdownOne(fwd forwarder.Runtime, timeout time.Duration) forwarder.ShutdownResult {
	if s, ok := fwd.(forwarder.Shutdowner); ok {
		return s.Shutdown(timeout)
	}
	err := fwd.Stop()
	result := forwarder.ShutdownResult{ClosedListener: err == nil}
	if live, ok := fwd.(interface{ LiveConns() int }); ok {
		result.RemainingConns = live.LiveConns()
		return result
	}
	if mappings, ok := fwd.(forwarder.DatagramRuntime); ok {
		result.RemainingConns = mappings.LiveMappings()
	}
	return result
}

// per-shutdown totals are accumulated on the manager under its own lock so the
// concurrent closures never race on the report struct.
func (m *TunnelManager) recordShutdown(id string, result forwarder.ShutdownResult) {
	m.shutdownMu.Lock()
	defer m.shutdownMu.Unlock()
	if result.ClosedListener {
		m.lastShutdown.Listeners++
	}
	m.lastShutdown.ForcedConns += result.ForcedConns
	m.lastShutdown.ForcedMappings += result.ForcedMappings
	m.lastShutdown.RemainingConns += result.RemainingConns
	m.lastShutdownIDs = append(m.lastShutdownIDs, id)
}

func (m *TunnelManager) drainShutdownTotals() (listeners, forced, forcedMappings, remaining int) {
	m.shutdownMu.Lock()
	defer m.shutdownMu.Unlock()
	listeners = m.lastShutdown.Listeners
	forced = m.lastShutdown.ForcedConns
	forcedMappings = m.lastShutdown.ForcedMappings
	remaining = m.lastShutdown.RemainingConns
	m.lastShutdown = ShutdownReport{}
	m.lastShutdownIDs = nil
	return listeners, forced, forcedMappings, remaining
}
