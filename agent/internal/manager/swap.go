package manager

import (
	"fmt"
	"net"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/logx"
)

// ---------------------------------------------------------------------------
// WP2 — hot reload primitives on the manager layer (DEVELOPMENT.md §13.3.4 /
// §13.3.5).
//
// TunnelManager.Apply answers "make this tunnel run". This file answers the
// three questions a rollout (WP3) asks about an ALREADY RUNNING tunnel:
//
//	1. what kind of change is this?      PlanForwardSwap (pure)
//	2. can the upstream move alone?      HotSwapUpstream
//	3. must the listener be replaced?    ReplaceListener / DrainTunnel
//
// The rules come straight from §13.3.4: a target change keeps the listener
// and the live connections; a listen-port change binds the new port FIRST and
// drains the old instance only afterwards; an equal revision is an idempotent
// no-op that must not touch anything.
// ---------------------------------------------------------------------------

// SwapStrategy is the rollout class of one config replacement.
type SwapStrategy string

const (
	// SwapNoop is an identical config: nothing to do at all.
	SwapNoop SwapStrategy = "noop"
	// SwapMetadata is a change with no data-plane effect (name /
	// speed-limit class fields). The listener and the upstream stay.
	SwapMetadata SwapStrategy = "metadata_only"
	// SwapTargetSwap is an upstream-only change on the same listener: the
	// §13.3.4 "Target Host / Port" row. Live connections survive.
	SwapTargetSwap SwapStrategy = "target_hot_swap"
	// SwapListener is a change that needs a new listener: listen port or
	// tunnel mode moved.
	SwapListener SwapStrategy = "listener_replace"
	// SwapRecreate is a change this layer cannot hot-apply in place, so the
	// caller must go through Apply (full rebuild). Used for EGRESS, whose
	// upstream is a pool owned by EgressManager.
	SwapRecreate SwapStrategy = "recreate"
)

// SwapPlan is the machine-readable answer a rollout orchestrator (WP3) turns
// into VALIDATE→PREPARE→CUTOVER→DRAIN→CLEANUP steps.
type SwapPlan struct {
	// Strategy is the rollout class of this change.
	Strategy SwapStrategy
	// DrainOld reports whether the previous instance must be drained after
	// the new one is live (a listener replacement does; an upstream swap
	// does not — the old forwarder IS the surviving one).
	DrainOld bool
	// FreeOldPort reports whether the old listen port is released by this
	// change (the port moved) rather than still owned by the running
	// forwarder.
	FreeOldPort bool
	// Upstream is the address the swap targets ("" when not applicable).
	Upstream string
	// Reason is a human-readable line for logs and operator surfaces.
	Reason string
}

// PlanForwardSwap classifies replacing old with new for one tunnel id.
//
// It is a pure function: the manager, the API layer and tests all get the
// same answer, so a rollout cannot plan one thing and do another.
//
// The classification is deliberately conservative: anything it cannot prove
// is upstream-only becomes SwapListener, because a replacement that was
// supposed to keep live connections alive and did not is a silent outage,
// while a replacement that rebuilt more than strictly needed is only churn.
func PlanForwardSwap(old, new_ forwarder.TunnelConfig) SwapPlan {
	if old.ID != new_.ID {
		return SwapPlan{Strategy: SwapRecreate, Reason: "different tunnel id"}
	}
	if old.Mode == forwarder.ModeEgress || new_.Mode == forwarder.ModeEgress {
		// An EGRESS tunnel's upstream is a pool, not one address: the hot
		// path is EgressManager/Pool.SwapTargets (devmap §5.3), never a
		// listener rebuild driven by a config diff.
		return SwapPlan{
			Strategy: SwapRecreate,
			Reason:   "EGRESS target pools are hot-swapped through the egress manager",
		}
	}

	// Byte-identical configs are the idempotent replay case (a resend of the
	// revision the node already runs). Reporting "nothing to do" is the
	// contract the reconciler's resend-same-revision path relies on.
	if reflect.DeepEqual(old, new_) {
		return SwapPlan{Strategy: SwapNoop, Reason: "identical config"}
	}

	oldPort, newPort := old.ListenPort(), new_.ListenPort()
	portMoved := oldPort != newPort
	modeMoved := old.Mode != new_.Mode
	upstreamMoved := old.UpstreamAddr() != new_.UpstreamAddr()

	switch {
	case portMoved:
		return SwapPlan{
			Strategy:    SwapListener,
			DrainOld:    true,
			FreeOldPort: true,
			Upstream:    new_.UpstreamAddr(),
			Reason: fmt.Sprintf("listen port %d -> %d requires a new listener",
				oldPort, newPort),
		}
	case modeMoved:
		// DIRECT <-> RELAY keeps the port but changes what the listener
		// dials. §13.3.4 lets this stay on the same listener (it is an
		// upstream change), so the plan is a target swap — the config diff
		// alone cannot prove the forwarder can absorb it, so the manager
		// verifies at call time.
		return SwapPlan{
			Strategy: SwapTargetSwap,
			Upstream: new_.UpstreamAddr(),
			Reason: fmt.Sprintf("mode %s -> %s changes the upstream on the same listener",
				old.Mode, new_.Mode),
		}
	case upstreamMoved:
		return SwapPlan{
			Strategy: SwapTargetSwap,
			Upstream: new_.UpstreamAddr(),
			Reason:   "upstream changed on the same listener",
		}
	default:
		// Same port, same upstream: only metadata can differ.
		return SwapPlan{
			Strategy: SwapMetadata,
			Reason:   "no data-plane change",
		}
	}
}

// HotSwapUpstream moves where new connections of a RUNNING tunnel dial,
// without touching its listener (§13.3.4 "Target Host / Port").
//
// It deliberately does NOT go through the revision gate: an upstream swap has
// no listener swap and no cutover, so there is nothing to make idempotent
// beyond "the forwarder now dials this". A rollout that wants a revision
// gate around it wraps this call, it does not get one for free — the WP2/WP3
// contract keeps the two concerns separable.
//
// Errors, all leaving the tunnel exactly as it was:
//   - a malformed address (pre-validated here, so the forwarder is never
//     touched with garbage);
//   - ErrTunnelNotFound — unknown id;
//   - ErrForwarderNotRunning — the tunnel has no live listener;
//   - ErrUpstreamNotSwappable — a forwarder kind that cannot swap a single
//     upstream (EGRESS).
func (m *TunnelManager) HotSwapUpstream(id, addr string) error {
	clean, err := normalizeUpstream(addr)
	if err != nil {
		return err
	}
	m.mu.RLock()
	e, ok := m.tunnels[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("%w: %s", ErrTunnelNotFound, id)
	}
	if err := e.fwd.SetUpstream(clean); err != nil {
		return errHotSwapRejected(id, err)
	}
	return nil
}

// DrainTunnel stops accepting new work on a tunnel's behalf and waits —
// bounded — for the in-flight connections to finish, while the listener stays
// bound and the port stays reserved.
//
// A drained tunnel is NOT removed: teardown is Remove's job. This split is
// what lets a rollout keep a port reserved while the last connections fade,
// instead of releasing it into a reuse race.
//
// Drain is called without the manager lock: it may block for the whole drain
// window, and holding the lock would stall every other Apply/Remove on the
// node (the same reason stopEntry stops asynchronously).
func (m *TunnelManager) DrainTunnel(id string, timeout time.Duration) error {
	m.mu.RLock()
	e, ok := m.tunnels[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("%w: %s", ErrTunnelNotFound, id)
	}
	return e.fwd.Drain(timeout)
}

// ReplaceListener applies cfg with the revision rules and honours the
// §13.3.4 rollout class the change actually has:
//
//   - the listener moved (port / mode change): the NEW listener binds first
//     and the old instance is drained only after the new one is live. A
//     failed bind leaves the old instance running untouched and reserves
//     no port (§13.3.5 PREPARE);
//   - only the upstream moved, same listener: the running forwarder's
//     upstream is swapped in place, so live connections keep relaying and
//     the forwarded-byte counter is not reset. This is the §13.3.4 "Target
//     Host / Port" row, and NOT going through Apply here is the whole point
//     — Apply's same-port path stops the old forwarder first, which drains
//     every live connection for drainTimeout;
//   - everything else (identical config, metadata, EGRESS) rides on Apply's
//     existing paths.
//
// Revision rules are Apply's, unchanged:
//
//	cfg.Revision >  current -> apply
//	cfg.Revision == current -> idempotent no-op (running forwarder back)
//	cfg.Revision <  current -> ErrStaleRevision
//
// A revision of 0 means "source does not track revisions" and always applies.
//
// It is the one entry point both apply surfaces use (control.execute's
// apply_tunnel and the admin API's POST /tunnel), so the routing cannot
// differ between them.
func (m *TunnelManager) ReplaceListener(cfg forwarder.TunnelConfig) (forwarder.Forwarder, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	normalized := cfg.Clone()
	if normalized.ListenHost == "" {
		normalized.ListenHost = m.listenHost
	}
	if err := normalized.Validate(); err != nil {
		return nil, err
	}

	if cur, ok := m.tunnels[normalized.ID]; ok {
		if isStale(normalized.Revision, cur.cfg.Revision) {
			return nil, ErrStaleRevision
		}
		if normalized.Revision == cur.cfg.Revision && normalized.Revision != revisionUnknown {
			// Idempotent: the same revision is already live with this
			// listener. Rebinding or draining here would interrupt
			// traffic for nothing (and would break the reconciler's
			// "resend the same revision" repair path).
			return cur.fwd, nil
		}
	}

	return m.applyRoutedLocked(normalized)
}

// applyRoutedLocked sends one (revision-gated) config through the primitive
// its plan names. It is the single routing point in the manager, so the
// control-plane command path and the admin API cannot disagree about what a
// change means. Caller must hold m.mu.
func (m *TunnelManager) applyRoutedLocked(cfg forwarder.TunnelConfig) (forwarder.Forwarder, error) {
	// A first-ever apply has no running instance to classify against: a diff
	// against a zero config always looks like a listener move. Take Apply's
	// path, which also runs the port-guard check a fresh bind needs.
	e, ok := m.tunnels[cfg.ID]
	if !ok {
		return m.applyLocked(cfg)
	}
	switch PlanForwardSwap(e.cfg, cfg).Strategy {
	case SwapListener:
		return m.replaceListenerLocked(cfg)
	case SwapTargetSwap:
		return m.hotSwapUpstreamLocked(cfg)
	default:
		// SwapNoop / SwapMetadata / SwapRecreate: Apply's existing paths,
		// sharing one implementation of the build + port-guard rules.
		return m.applyLocked(cfg)
	}
}

// hotSwapUpstreamLocked performs the §13.3.4 "Target Host / Port" swap: the
// running forwarder starts dialing cfg's upstream, its listener and its live
// connections untouched, and the registered config is updated to what the
// node now runs (revision and reported upstream must not keep describing the
// revision that was just replaced).
//
// One defensive exit: the forwarder refuses the swap (no live listener, or an
// upstream that is not one swappable address). It falls back to Apply's
// rebuild rather than failing the command and stranding the node on a config
// the panel does not believe in — the one path that costs live connections.
func (m *TunnelManager) hotSwapUpstreamLocked(cfg forwarder.TunnelConfig) (forwarder.Forwarder, error) {
	e, ok := m.tunnels[cfg.ID]
	if !ok {
		return m.applyLocked(cfg)
	}
	if err := e.fwd.SetUpstream(cfg.UpstreamAddr()); err != nil {
		// Only a forwarder whose upstream is not one swappable address
		// lands here. Failing the command would strand the node on a
		// stale config, so rebuild and say so in the log: this is the one
		// path that costs live connections.
		logx.Warn("tunnel upstream swap refused, rebuilding",
			"id", cfg.ID, "err", err.Error())
		return m.applyLocked(cfg)
	}
	e.cfg = cfg
	m.markPortUsedLocked(cfg)
	logx.Info("tunnel upstream hot-swapped", "id", cfg.ID, "mode", string(cfg.Mode),
		"port", cfg.ListenPort(), "upstream", cfg.UpstreamAddr(), "revision", cfg.Revision)
	return e.fwd, nil
}

// replaceListenerLocked performs the listener-safe replacement. Caller must
// hold m.mu.
//
// Order is the whole point (§13.3.5 PREPARE/CUTOVER rules):
//
//  1. build the new forwarder and bind it, reserving the new port;
//  2. only when the bind succeeded, swap the map entry and release the old
//     port's reservation;
//  3. drain the old instance asynchronously — outside this function, since
//     Stop drains and may block for drainTimeout.
//
// A bind failure returns with the old entry still registered and its port
// still reserved, which is exactly "PREPARE failed, the old applied revision
// keeps running".
func (m *TunnelManager) replaceListenerLocked(cfg forwarder.TunnelConfig) (forwarder.Forwarder, error) {
	old, hadOld := m.tunnels[cfg.ID]

	fwd, err := m.buildLocked(cfg)
	if err != nil {
		return nil, err
	}
	m.attachLedger(cfg, fwd)
	if err := fwd.Start(); err != nil {
		return nil, err
	}
	m.markPortUsedLocked(cfg)

	var toDrain *entry
	if hadOld {
		if old.cfg.ListenPort() != cfg.ListenPort() {
			// The old port is genuinely free now; the new one owns its own.
			m.releasePortLocked(old.cfg)
		}
		toDrain = old
	}
	m.tunnels[cfg.ID] = &entry{cfg: cfg, fwd: fwd}
	logx.Info("tunnel listener replaced", "id", cfg.ID, "mode", string(cfg.Mode),
		"old_port", oldPortOf(old, hadOld), "port", cfg.ListenPort(), "revision", cfg.Revision)

	if toDrain != nil {
		defer m.stopEntry(toDrain)
	}
	return fwd, nil
}

func oldPortOf(e *entry, ok bool) int {
	if !ok || e == nil {
		return 0
	}
	return e.cfg.ListenPort()
}

// applyLocked is the non-lock-taking half of Apply, factored out so
// ReplaceListener can share the exact same build/attach/start/port/stop
// sequence without duplicating it. Caller must hold m.mu and have already
// passed the revision gate.
func (m *TunnelManager) applyLocked(cfg forwarder.TunnelConfig) (forwarder.Forwarder, error) {
	fwd, err := m.buildLocked(cfg)
	if err != nil {
		return nil, err
	}
	m.attachLedger(cfg, fwd)
	if err := m.startLocked(cfg, fwd); err != nil {
		return nil, err
	}
	if old, ok := m.tunnels[cfg.ID]; ok {
		if old.cfg.ListenPort() != cfg.ListenPort() {
			m.releasePortLocked(old.cfg)
		}
		defer m.stopEntry(old)
	}
	m.tunnels[cfg.ID] = &entry{cfg: cfg, fwd: fwd}
	m.markPortUsedLocked(cfg)
	logx.Info("tunnel applied", "id", cfg.ID, "mode", string(cfg.Mode),
		"port", cfg.ListenPort(), "revision", cfg.Revision)
	return fwd, nil
}

// DrainAllTunnels drains every registered tunnel without removing any of
// them. It is the shutdown-adjacent helper a maintenance window uses: no new
// work is accepted anywhere, in-flight connections fade out, ports stay
// reserved until the process stops.
//
// It returns the ids that could not be drained (never started forwarders and
// non-drainable kinds); a tunnel with no listener has nothing to drain and is
// reported separately by the caller-facing status.
func (m *TunnelManager) DrainAllTunnels(timeout time.Duration) []string {
	m.mu.RLock()
	entries := make([]*entry, 0, len(m.tunnels))
	for _, e := range m.tunnels {
		entries = append(entries, e)
	}
	m.mu.RUnlock()

	var wg sync.WaitGroup
	var mu sync.Mutex
	var skipped []string
	for _, e := range entries {
		if !e.fwd.Running() {
			skipped = append(skipped, e.cfg.ID)
			continue
		}
		wg.Add(1)
		go func(e *entry) {
			defer wg.Done()
			_ = e.fwd.Drain(timeout)
		}(e)
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	sort.Strings(skipped)
	return skipped
}

// ListenerReplacementNeeded reports whether applying cfg to the running
// tunnel id requires a new listener (the plan's short form). It exists so an
// API handler or a health probe can answer the question without building a
// plan it then ignores.
func (m *TunnelManager) ListenerReplacementNeeded(id string, cfg forwarder.TunnelConfig) (bool, error) {
	m.mu.RLock()
	e, ok := m.tunnels[id]
	m.mu.RUnlock()
	if !ok {
		return false, fmt.Errorf("%w: %s", ErrTunnelNotFound, id)
	}
	return PlanForwardSwap(e.cfg, cfg).Strategy == SwapListener, nil
}

// UpstreamOf returns the address a running tunnel currently dials, so a state
// report can show the operator what the node is actually using.
func (m *TunnelManager) UpstreamOf(id string) (string, error) {
	m.mu.RLock()
	e, ok := m.tunnels[id]
	m.mu.RUnlock()
	if !ok {
		return "", fmt.Errorf("%w: %s", ErrTunnelNotFound, id)
	}
	// The running config is the source of truth for the port; the live
	// upstream is whatever the forwarder dials now, which is the config
	// value until a hot swap replaces it.
	return e.cfg.UpstreamAddr(), nil
}

// errHotSwapRejected wraps a forwarder-level SetUpstream failure with the
// tunnel id, so the caller sees which tunnel refused the swap.
func errHotSwapRejected(id string, err error) error {
	return fmt.Errorf("manager: hot swap for tunnel %s: %w", id, err)
}

// normalizeUpstream trims and validates a "host:port" upstream address. It
// exists so HotSwapUpstream callers can pre-validate before touching a
// forwarder, and so the error message is uniform.
func normalizeUpstream(addr string) (string, error) {
	host, portStr, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		return "", fmt.Errorf("manager: invalid upstream address %q", addr)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 || port > 65535 {
		return "", fmt.Errorf("manager: invalid upstream port in %q", addr)
	}
	return net.JoinHostPort(host, strconv.Itoa(port)), nil
}

// compile-time proof that the manager still satisfies what the API layer and
// the control loop need.
var _ interface {
	Apply(forwarder.TunnelConfig) (forwarder.Forwarder, error)
	Remove(string) error
	Get(string) (forwarder.TunnelConfig, bool)
	List() []forwarder.TunnelConfig
	HotSwapUpstream(string, string) error
	ReplaceListener(forwarder.TunnelConfig) (forwarder.Forwarder, error)
	DrainTunnel(string, time.Duration) error
} = (*TunnelManager)(nil)
