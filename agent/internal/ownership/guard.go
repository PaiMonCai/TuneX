package ownership

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/logx"
)

// Refusal codes. They are the wire vocabulary the panel sees in a command ACK
// (`error_code`) and reads back in the node's `last_error`, so they are stable
// strings rather than prose: an operator must be able to tell "this node was
// demoted" from "this node could not remember the new generation".
const (
	// CodeStaleEpoch: the activation carried a generation older than the
	// highest this node has already seen. The split-brain case.
	CodeStaleEpoch = "stale_epoch"
	// CodeLeaseExpired: the activation's own lease was already past. A tunnel
	// may not be (re)started on an expired authorisation.
	CodeLeaseExpired = "lease_expired"
	// CodeMalformedLease: `lease_expires_at` was present but unreadable, so the
	// node cannot know how long it may serve. Fail closed.
	CodeMalformedLease = "malformed_lease"
	// CodeEpochUnpersisted: the fence could not be written durably, so the node
	// cannot promise it will still refuse this epoch after a restart.
	CodeEpochUnpersisted = "epoch_unpersisted"
)

// DefaultSweepInterval is how often running tunnels are checked against their
// lease deadline.
//
// One second is deliberately much shorter than the panel's 30s lease TTL: this
// is a fencing action, not housekeeping, and "possibly another owner" is the
// split-brain activation this package exists to prevent. The cost is one locked list of the running
// registry per second (no syscalls, no network) — and the benefit is that no
// apply/remove/restore path has to remember to re-arm a timer. The sweep READS
// the truth each tick, which is the same reason the LKG cache has a ticker.
const DefaultSweepInterval = time.Second

// MaxRenewalSkips bounds the per-response counter that says "the panel offered a
// renewal this node could not join to a running tunnel". It is a diagnostic, not
// a gate.
const maxReportedRenewals = 512

// Refusal is the typed reason an activation was refused. It carries the code
// the ACK must use plus the numbers an operator needs to reconstruct the
// decision, and it is returned BEFORE anything is applied.
type Refusal struct {
	Code     string
	Reason   string
	TunnelID string
	// Epoch is what the activation asked for; Highest is what this node had
	// already seen (0 when the refusal is not about the fence).
	Epoch   int64
	Highest int64
}

func (r *Refusal) Error() string {
	if r == nil {
		return "ownership: refused"
	}
	msg := fmt.Sprintf("ownership: %s: tunnel %s refused", r.Code, r.TunnelID)
	if r.Reason != "" {
		msg += " (" + r.Reason + ")"
	}
	if r.Highest > 0 || r.Epoch > 0 {
		msg += fmt.Sprintf(": epoch %d, highest seen %d", r.Epoch, r.Highest)
	}
	return msg
}

// RefusalCode extracts the wire code from a refusal error, if it is one.
func RefusalCode(err error) (string, bool) {
	var refusal *Refusal
	if errors.As(err, &refusal) && refusal != nil {
		return refusal.Code, true
	}
	return "", false
}

// Renewal is one lease fact the panel returned in a state report's response.
//
// `TunnelRef` is the panel's own lease key (the database tunnel id). The agent
// names tunnels with strings ("tunex-<dbid>-<direction>"), which is the panel's
// own naming, so joining the two is a translation this package does in exactly
// one place (LeaseTunnelRef) rather than a convention smeared across callers.
type Renewal struct {
	TunnelRef int64  `json:"tunnel_ref"`
	Epoch     int64  `json:"epoch"`
	ExpiresAt string `json:"lease_expires_at"`
	Revision  int64  `json:"revision"`
}

// lease is this node's live view of one tunnel's authorisation.
type lease struct {
	fact     LeaseFact
	expires  time.Time
	hasClock bool
}

// LeaseFact is one tunnel's current authorisation as THIS node understands it,
// with where the understanding came from — an operator asking "why did it stop?"
// needs to know whether the deadline came from the config or from a renewal.
type LeaseFact struct {
	TunnelID   string    `json:"tunnel_id"`
	Epoch      int64     `json:"epoch"`
	ExpiresAt  time.Time `json:"lease_expires_at"`
	Revision   int64     `json:"revision"`
	Source     string    `json:"source"`
	ObservedAt time.Time `json:"observed_at"`
}

// Registry is the slice of the tunnel manager the lease clock needs. Declared as
// an interface here so this package never imports the manager (and so a test can
// drive the clock with a map).
type Registry interface {
	List() []forwarder.TunnelConfig
	RemoveIf(id string, cond func(forwarder.TunnelConfig) bool) (bool, error)
}

// Config configures the ownership guard.
type Config struct {
	// Fence is the durable epoch fence. Nil means "no fence at all", which is
	// how a caller opts out entirely (tests); production always passes one.
	Fence *Fence
	// Registry is the running-tunnel view the lease clock sweeps. Nil disables
	// the sweep (the activation gate still works).
	Registry Registry
	// Now overrides the clock (tests).
	Now func() time.Time
	// SweepInterval is the lease-check cadence; <= 0 uses DefaultSweepInterval.
	SweepInterval time.Duration
	// Report files one message in the shared error ledger, so a refusal or a
	// degraded fence reaches the panel's `last_error`/`error_count` instead of
	// living only in the agent's log. Nil is silent (tests).
	Report func(string)
	// OnLeaseStop is called AFTER a tunnel has been stopped for a lapsed lease,
	// with the config that was running. The runtime uses it to drop the tunnel's
	// egress pool: leaving a pool behind would keep its targets in the state
	// report (and in the observation set) for a listener that no longer exists.
	OnLeaseStop func(cfg forwarder.TunnelConfig)
}

// Guard is the enforcement point: it decides whether an activation may proceed
// (the epoch fence) and it stops tunnels whose lease the panel stopped renewing.
type Guard struct {
	fence    *Fence
	registry Registry
	now      func() time.Time
	interval time.Duration
	report   func(string)
	onStop   func(cfg forwarder.TunnelConfig)

	mu              sync.Mutex
	leases          map[string]lease
	clockGeneration uint64 // CAS stamp for a census-based prune.
	refusals        int64
	// leaseStops counts tunnels this guard stopped because their authorisation
	// lapsed. It is the counter behind "lease expiry means stop" being a fact.
	leaseStops int64
	// renewalMisses counts renewal statements that matched no running tunnel.
	// A climbing number here means the panel is renewing leases for tunnels this
	// node is not running — a placement/identity mismatch worth seeing.
	renewalMisses int64
	// skippedRenewals keeps the most recent unjoinable renewals for the diag
	// surface, bounded.
	skippedRenewals []Renewal
	lastRefusal     *Refusal
	lastLeaseStop   *LeaseStop
}

// LeaseStop records one tunnel the guard stopped because its lease lapsed.
type LeaseStop struct {
	TunnelID  string
	ExpiresAt time.Time
	StoppedAt time.Time
}

// New builds a guard. A nil fence degrades to "no fencing" (every activation
// allowed) and is reported by Facts(), never silently.
func New(cfg Config) *Guard {
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	interval := cfg.SweepInterval
	if interval <= 0 {
		interval = DefaultSweepInterval
	}
	return &Guard{
		fence:    cfg.Fence,
		registry: cfg.Registry,
		now:      now,
		interval: interval,
		report:   cfg.Report,
		onStop:   cfg.OnLeaseStop,
		leases:   make(map[string]lease),
	}
}

// SetRegistry attaches (or replaces) the running-tunnel view. It exists because
// the guard is built before the manager in some wirings and because tests drive
// the sweep without one.
func (g *Guard) SetRegistry(r Registry) {
	if g == nil {
		return
	}
	g.mu.Lock()
	g.registry = r
	g.mu.Unlock()
}

// Fence exposes the durable store (nil-safe) for diagnostics and startup.
func (g *Guard) Fence() *Fence {
	if g == nil {
		return nil
	}
	return g.fence
}

// LeaseTunnelRef extracts the panel's lease key from an agent tunnel id.
//
// The agent's tunnel ids ARE the panel's ("tunex-<dbTunnelId>-<direction>",
// services/orchestrator.ts), and the panel's renewal works by parsing that same
// prefix out of the ids the agent reports. The join has to happen somewhere, so
// it happens here, once, with the failure mode reported instead of guessed: an
// id this function cannot read yields no lease tracking for that tunnel (its
// config's own expiry still applies), and ObserveRenewals counts the miss.
func LeaseTunnelRef(agentTunnelID string) (int64, bool) {
	id := strings.TrimSpace(agentTunnelID)
	const prefix = "tunex-"
	if !strings.HasPrefix(id, prefix) {
		return 0, false
	}
	rest := id[len(prefix):]
	end := strings.IndexByte(rest, '-')
	if end <= 0 {
		return 0, false
	}
	var ref int64
	for _, r := range rest[:end] {
		if r < '0' || r > '9' {
			return 0, false
		}
		ref = ref*10 + int64(r-'0')
		if ref > 1<<62 {
			return 0, false
		}
	}
	if ref <= 0 {
		return 0, false
	}
	return ref, true
}

// Admit is the activation gate. It is called by the tunnel manager BEFORE any
// listener is bound, so a refusal can never leave a tunnel half-applied, and it
// returns a *Refusal (see RefusalCode) so the control path can carry the code
// back to the panel.
//
// Order, and why:
//
//  1. an unreadable `lease_expires_at` is refused outright: we cannot know how
//     long we may serve, and "serve until someone notices" is not a decision;
//  2. the fence RISES for any well-formed epoch claim before the remaining
//     checks — the fence records "this node has seen this generation", which is
//     true whether or not the apply then succeeds (the panel may queue a
//     corrected config behind a failed one, and an epoch seen but not recorded
//     is the restart hole the fence exists to close). A raise that cannot be
//     persisted refuses the activation: an unprovable memory is not a fence;
//  3. an epoch older than the highest seen is refused (the split-brain case);
//  4. an already-expired lease is refused: a tunnel is not (re)started on an
//     authorisation the panel has already let lapse;
//  5. otherwise the tunnel's deadline is recorded and the apply proceeds.
//
// Every refusal is logged and filed in the error ledger, so it is a fact the
// panel can read rather than a command that silently did nothing.
func (g *Guard) Admit(cfg forwarder.TunnelConfig) error {
	if err := g.CheckActivation(cfg); err != nil {
		return err
	}
	return g.CommitActivation(cfg)
}

// CheckActivation observes the monotonic fence, but never replaces the LIVE
// lease clock. A candidate can fail validation, revision admission or binding
// after this check; only its successful installation may commit the clock.
func (g *Guard) CheckActivation(cfg forwarder.TunnelConfig) error {
	if g == nil {
		return nil
	}
	tunnelID := strings.TrimSpace(cfg.ID)
	epoch := cfg.OwnershipEpoch
	rawExpiry := strings.TrimSpace(cfg.LeaseExpiresAt)

	// No ownership statement at all: an older panel. Behave exactly as before
	// No ownership facts means no fence decision, no lease clock, and no tracking.
	if epoch <= 0 && rawExpiry == "" {
		return nil
	}

	now := g.now()
	var expires time.Time
	hasExpiry := false
	if rawExpiry != "" {
		parsed, ok := ParseDeadline(rawExpiry)
		if !ok {
			return g.refuse(&Refusal{
				Code:     CodeMalformedLease,
				Reason:   "lease_expires_at is not an RFC 3339 timestamp",
				TunnelID: tunnelID,
				Epoch:    epoch,
			})
		}
		expires, hasExpiry = parsed, true
	}

	if epoch > 0 && g.fence != nil {
		if _, _, err := g.fence.Observe(tunnelID, epoch); err != nil {
			return g.refuse(&Refusal{
				Code:     CodeEpochUnpersisted,
				Reason:   err.Error(),
				TunnelID: tunnelID,
				Epoch:    epoch,
			})
		}
		highest := g.fence.Highest(tunnelID)
		if epoch < highest {
			return g.refuse(&Refusal{
				Code:     CodeStaleEpoch,
				Reason:   "activation epoch is older than the highest this node has seen",
				TunnelID: tunnelID,
				Epoch:    epoch,
				Highest:  highest,
			})
		}
	}

	if hasExpiry && !now.Before(expires) {
		return g.refuse(&Refusal{
			Code:     CodeLeaseExpired,
			Reason:   "lease_expires_at is already in the past",
			TunnelID: tunnelID,
			Epoch:    epoch,
		})
	}

	return nil
}

// CommitActivation is called with the manager's actual installed revision.
// Heartbeat renewal can race installation: keep its later deadline for the same
// epoch rather than shortening it back to the original command's timestamp.
func (g *Guard) CommitActivation(cfg forwarder.TunnelConfig) error {
	if g == nil {
		return nil
	}
	if err := g.CheckActivation(cfg); err != nil {
		return err
	}
	expires, ok := ParseDeadline(strings.TrimSpace(cfg.LeaseExpiresAt))
	if !ok {
		g.mu.Lock()
		g.clockGeneration++ // Even a legacy activation invalidates a census.
		g.mu.Unlock()
		return nil // Ownership without a lease does not erase an existing clock.
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	prev := g.leases[cfg.ID]
	if prev.hasClock && prev.fact.Epoch == cfg.OwnershipEpoch {
		if prev.fact.Revision > cfg.Revision {
			return fmt.Errorf("ownership: applied revision %d is behind committed revision %d", cfg.Revision, prev.fact.Revision)
		}
		if prev.expires.After(expires) {
			expires = prev.expires
		}
	}
	g.leases[cfg.ID] = lease{fact: LeaseFact{TunnelID: cfg.ID, Epoch: cfg.OwnershipEpoch,
		ExpiresAt: expires, Revision: cfg.Revision, Source: "config", ObservedAt: g.now()},
		expires: expires, hasClock: true}
	g.clockGeneration++
	return nil
}

// CompensationConfig retains only the effective renewal of THIS applied
// epoch/revision. It never borrows authorization from a newer candidate/owner.
func (g *Guard) CompensationConfig(cfg forwarder.TunnelConfig) forwarder.TunnelConfig {
	if g == nil {
		return cfg
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if current, ok := g.leases[cfg.ID]; ok && current.hasClock &&
		current.fact.Epoch == cfg.OwnershipEpoch && current.fact.Revision == cfg.Revision {
		offered, valid := ParseDeadline(cfg.LeaseExpiresAt)
		if !valid || current.expires.After(offered) {
			cfg.LeaseExpiresAt = current.expires.UTC().Format(time.RFC3339Nano)
		}
	}
	return cfg
}

// ObserveRenewals applies the ownership facts the panel returned in a state
// report's response.
//
// This is the ONLY renewal signal: the panel extends the lease row when the node
// reports that it still serves the tunnel, and hands the refreshed facts back in
// the answer the node is already waiting for. Without it a healthy node would
// stop every tunnel one TTL after its last config — which is the failure this
// channel exists to prevent.
//
// Returns how many running tunnels were refreshed and how many statements could
// not be joined to one (a placement/identity mismatch worth reporting; it is a
// counter, not an error, because a lease for a tunnel this node does not run is
// a legitimate answer).
func (g *Guard) ObserveRenewals(renewals []Renewal, at time.Time) (int, int) {
	if g == nil || len(renewals) == 0 {
		return 0, 0
	}
	if at.IsZero() {
		at = g.now()
	}
	// Build the panel-key → agent-id map from what this node is actually
	// running. This is the join, and building it from the registry (rather than
	// caching an id table) means a removed or renamed tunnel cannot be renewed
	// by a stale entry.
	byRef := map[int64][]forwarder.TunnelConfig{}
	if g.registry != nil {
		for _, cfg := range g.registry.List() {
			if ref, ok := LeaseTunnelRef(cfg.ID); ok {
				byRef[ref] = append(byRef[ref], cfg)
			}
		}
	}

	applied, missed := 0, 0
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, r := range renewals {
		ids := byRef[r.TunnelRef]
		if len(ids) == 0 {
			missed++
			if len(g.skippedRenewals) < maxReportedRenewals {
				g.skippedRenewals = append(g.skippedRenewals, r)
			}
			continue
		}
		expires, ok := ParseDeadline(r.ExpiresAt)
		if !ok {
			// An unreadable renewal statement must not silently extend (or
			// shorten) anything: skip it and let the panel's next answer try
			// again. The tunnel keeps whatever deadline it already had.
			missed++
			continue
		}
		for _, cfg := range ids {
			id := cfg.ID
			prev := g.leases[id]
			// Match both the census captured above and the clock committed under
			// this lock. A candidate can never renew an older applied revision;
			// a stale census cannot renew a newer runtime installed meanwhile.
			if !prev.hasClock || r.Epoch != cfg.OwnershipEpoch || r.Revision != cfg.Revision ||
				r.Epoch != prev.fact.Epoch || r.Revision != prev.fact.Revision ||
				expires.Before(prev.expires) {
				missed++
				continue
			}
			g.leases[id] = lease{
				fact: LeaseFact{
					TunnelID:   id,
					Epoch:      r.Epoch,
					ExpiresAt:  expires,
					Revision:   r.Revision,
					Source:     "report",
					ObservedAt: at,
				},
				expires:  expires,
				hasClock: true,
			}
			applied++
		}
	}
	g.renewalMisses += int64(missed)
	return applied, missed
}

// Expired reports whether the authorisation for one tunnel has lapsed at now.
// A tunnel with no tracked deadline is never expired: absence of ownership
// information is not a deadline (older panels must behave exactly as before).
func (g *Guard) Expired(tunnelID string, now time.Time) bool {
	if g == nil {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	entry, ok := g.leases[tunnelID]
	return ok && entry.hasClock && !now.Before(entry.expires)
}

// Run sweeps the running tunnels until ctx is cancelled.
func (g *Guard) Run(ctx context.Context) {
	if g == nil || g.registry == nil {
		return
	}
	ticker := time.NewTicker(g.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			g.SweepOnce(g.now())
		}
	}
}

// SweepOnce stops every running tunnel whose lease has lapsed, returning the ids
// it stopped.
//
// It is exported and separated from Run so a test (and an operator, through the
// admin plane) can ask the same question on demand; Run is just the clock.
//
// The stop is conditional inside the manager (RemoveIf): the predicate re-reads
// this guard's deadline under the manager's lock, so a renewal that arrived
// between listing the tunnels and stopping one is respected. What remains is a
// window of a few instructions — a renewal landing between the predicate and the
// removal — and its consequence is bounded and self-healing: the tunnel stops,
// the node's next state report no longer lists it, and the panel's reconcile
// re-dispatches it with a fresh lease. Refusing to stop is the direction that
// cannot self-heal, which is why the trade is made this way.
func (g *Guard) SweepOnce(now time.Time) []string {
	if g == nil || g.registry == nil {
		return nil
	}
	g.mu.Lock()
	clockGeneration := g.clockGeneration
	g.mu.Unlock()
	running := g.registry.List()
	live := make(map[string]bool, len(running))
	for _, cfg := range running {
		live[cfg.ID] = true
	}
	g.pruneLeases(live, clockGeneration)

	var expired []forwarder.TunnelConfig
	for _, cfg := range running {
		if g.Expired(cfg.ID, now) {
			expired = append(expired, cfg)
		}
	}
	if len(expired) == 0 {
		return nil
	}

	var stopped []string
	for _, cfg := range expired {
		id := cfg.ID
		ok, err := g.registry.RemoveIf(id, func(forwarder.TunnelConfig) bool {
			return g.Expired(id, g.now())
		})
		if err != nil {
			logx.Warn("ownership: could not stop a tunnel whose lease lapsed",
				"tunnel", id, "err", err.Error())
			continue
		}
		if !ok {
			// The tunnel changed (renewed, replaced or removed) between the list
			// and the stop: nothing to do, and the predicate said so.
			continue
		}
		deadline := g.deadlineOf(id)
		g.noteLeaseStop(id, deadline, now)
		if g.onStop != nil {
			// Outside every lock: the hook talks to other subsystems.
			g.onStop(cfg)
		}
		stopped = append(stopped, id)
		logx.Warn("ownership: lease lapsed, tunnel stopped",
			"tunnel", id, "lease_expires_at", deadline.UTC().Format(time.RFC3339),
			"stopped_at", now.UTC().Format(time.RFC3339))
	}
	return stopped
}

// deadlineOf reads one tunnel's deadline for logging/facts.
func (g *Guard) deadlineOf(tunnelID string) time.Time {
	g.mu.Lock()
	defer g.mu.Unlock()
	if entry, ok := g.leases[tunnelID]; ok {
		return entry.expires
	}
	return time.Time{}
}

// noteLeaseStop records the stop as a fact.
func (g *Guard) noteLeaseStop(tunnelID string, deadline, at time.Time) {
	g.mu.Lock()
	g.leaseStops++
	g.lastLeaseStop = &LeaseStop{TunnelID: tunnelID, ExpiresAt: deadline, StoppedAt: at}
	g.mu.Unlock()
	if g.report != nil {
		g.report(fmt.Sprintf(
			"ownership: lease lapsed for %s at %s (stopped %s): the panel stopped renewing this tunnel",
			tunnelID, deadline.UTC().Format(time.RFC3339), at.UTC().Format(time.RFC3339)))
	}
}

// pruneLeases drops deadlines for tunnels this node no longer runs, so the table
// stays bounded by the running set instead of growing with history.
func (g *Guard) pruneLeases(live map[string]bool, generation uint64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	// An activation committed after the census stamp: this live set cannot
	// prove its clock is orphaned. Retry pruning on the next fresh sweep.
	if generation != g.clockGeneration {
		return
	}
	for id := range g.leases {
		if !live[id] {
			delete(g.leases, id)
		}
	}
}

// refuse files one refusal and returns it as an error.
func (g *Guard) refuse(r *Refusal) error {
	g.mu.Lock()
	g.refusals++
	g.lastRefusal = r
	g.mu.Unlock()
	logx.Warn("ownership: activation refused",
		"tunnel", r.TunnelID, "code", r.Code, "epoch", r.Epoch,
		"highest_epoch", r.Highest, "reason", r.Reason)
	if g.report != nil {
		g.report(r.Error())
	}
	return r
}

// Facts is the whole ownership view for diagnostics and /health.
type Facts struct {
	// Durable reports whether the fence survives a restart. False is a real
	// degradation ("a restarted node would forget its epochs") and is surfaced
	// rather than inferred from the absence of a file.
	Durable bool   `json:"durable"`
	Path    string `json:"path,omitempty"`
	// LoadError is why an existing fence file was not used (empty when none).
	LoadError string `json:"load_error,omitempty"`
	// Writes is how many durable raises happened, Refusals how many activations
	// were refused, LeaseStops how many tunnels were stopped for a lapsed lease.
	Writes     int64 `json:"epoch_writes"`
	Refusals   int64 `json:"refusals"`
	LeaseStops int64 `json:"lease_stops"`
	// RenewalMisses counts renewal statements that matched no running tunnel.
	RenewalMisses int64 `json:"renewal_misses"`
	// Tunnels is bounded by MaxFencedTunnels and sorted by id.
	Tunnels []TunnelFacts `json:"tunnels"`
	// LastRefusal / LastLeaseStop are the most recent events, or null.
	LastRefusal   *Refusal   `json:"last_refusal,omitempty"`
	LastLeaseStop *LeaseStop `json:"last_lease_stop,omitempty"`
	// SkippedRenewals is a bounded sample of renewal statements that matched no
	// running tunnel (see RenewalMisses).
	SkippedRenewals []Renewal `json:"skipped_renewals,omitempty"`
}

// TunnelFacts is one tunnel's ownership state on the diag surface.
type TunnelFacts struct {
	TunnelID       string `json:"tunnel_id"`
	HighestEpoch   int64  `json:"highest_epoch"`
	LeaseExpiresAt string `json:"lease_expires_at,omitempty"`
	// LeaseSource says where the deadline came from ("config" / "report").
	LeaseSource string `json:"lease_source,omitempty"`
	// LeaseExpired is true while the authorisation is past; the sweep stops such
	// a tunnel on its next tick, so a non-zero list here means "in flight".
	LeaseExpired bool `json:"lease_expired"`
}

// Facts renders the guard's state. It never blocks on the registry beyond one
// List() call and is safe to call from an HTTP handler.
func (g *Guard) Facts() Facts {
	f := Facts{}
	if g == nil {
		return f
	}
	facts := g.fence
	if facts != nil {
		f.Durable = facts.Durable()
		f.Path = facts.Path
		f.Writes = facts.Writes()
		if err := facts.LoadError(); err != nil {
			f.LoadError = err.Error()
		}
	}
	now := g.now()

	g.mu.Lock()
	f.Refusals = g.refusals
	f.LeaseStops = g.leaseStops
	f.RenewalMisses = g.renewalMisses
	f.LastRefusal = g.lastRefusal
	f.LastLeaseStop = g.lastLeaseStop
	if len(g.skippedRenewals) > 0 {
		f.SkippedRenewals = append([]Renewal(nil), g.skippedRenewals...)
	}

	highest := map[string]int64{}
	if facts != nil {
		for _, fact := range facts.Facts() {
			highest[fact.TunnelID] = fact.HighestEpoch
		}
	}
	ids := make([]string, 0, len(highest)+len(g.leases))
	seen := map[string]bool{}
	for id := range highest {
		ids = append(ids, id)
		seen[id] = true
	}
	for id := range g.leases {
		if !seen[id] {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	if len(ids) > MaxFencedTunnels {
		ids = ids[:MaxFencedTunnels]
	}
	f.Tunnels = make([]TunnelFacts, 0, len(ids))
	for _, id := range ids {
		tf := TunnelFacts{TunnelID: id, HighestEpoch: highest[id]}
		if entry, ok := g.leases[id]; ok {
			tf.LeaseExpiresAt = entry.expires.UTC().Format(time.RFC3339)
			tf.LeaseSource = entry.fact.Source
			tf.LeaseExpired = !now.Before(entry.expires)
		}
		f.Tunnels = append(f.Tunnels, tf)
	}
	g.mu.Unlock()
	return f
}
