package main

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/tunex/agent/internal/agentconfig"
	"github.com/tunex/agent/internal/api"
	"github.com/tunex/agent/internal/control"
	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/logx"
	"github.com/tunex/agent/internal/manager"
	"github.com/tunex/agent/internal/reporter"
	"github.com/tunex/agent/internal/restore"
	"github.com/tunex/agent/internal/selfinfo"
)

// v3Runtime bundles the WP4 components so main can start and stop them as one
// unit. Since WP15 it is the agent's only runtime: there is no legacy session
// beside it.
type v3Runtime struct {
	cfg     *agentconfig.Config
	tunnels *manager.TunnelManager
	egress  *manager.EgressManager
	api     *api.Server
	control *control.Client
	heart   *reporter.Reporter
	// ledger is the V4-WP6 apply/runtime error ledger, kept on the runtime so a
	// later admin surface can record operator-triggered failures into the same
	// place the panel reads.
	ledger  *reporter.Ledger
	started bool
	// cache is the WP11A last-known-good desired state. It is written only from
	// state the manager actually applied and read only when the panel is
	// unreachable.
	cache restore.LKG
	// cacheTick is the periodic refresh of that cache, so an apply that lands
	// between two restarts is not lost by a crash.
	cacheTick *time.Ticker
	// cacheMu serializes every cache write (the writer loop, restore, shutdown):
	// two writers racing could rename an older snapshot over a newer one and
	// silently roll "last known good" backwards.
	cacheMu sync.Mutex
	// cacheWrites tracks the writer goroutine so Shutdown can join it.
	cacheWrites sync.WaitGroup
	// startedAt is the process's own start, reported by collect_diagnostics.
	startedAt time.Time
	// restoredFromCache is true when boot fell back to the local cache. The
	// control loop then reconciles as soon as the panel can answer, because this
	// process never observed a failed pull of its own.
	restoredFromCache bool
}

// startV3Runtime builds the v3 components and brings them up in the documented
// order.
//
// The role decides which components start:
//
//	INGRESS: tunnel manager + admin API + restore + heartbeat
//	EGRESS:  egress manager  + admin API + restore + heartbeat
//	BOTH:    everything, with ONE shared port guard
//
// "BOTH" is the default because a freshly provisioned node has no role yet and
// the v3 tunnel managers must be ready for the first apply.
func startV3Runtime(ctx context.Context, cfg *agentconfig.Config) *v3Runtime {
	// startedAt is sampled once here: uptime must measure the agent process, not
	// the moment the reporter happened to build a payload.
	startedAt := time.Now()
	role := cfg.Role
	if role == "" {
		role = agentconfig.RoleBoth
	}

	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, cfg.ListenIP)

	rt := &v3Runtime{cfg: cfg, tunnels: tunnels, egress: egress}
	rt.cache = restore.LKG{Path: cfg.LKGPath()}
	if cfg.AgentAdminPort == 0 && cfg.PanelHTTPURL == "" {
		// Nothing to bring up: no admin plane and nothing to report to. The
		// node still accepts no apply commands, so say so loudly instead of
		// silently running an empty process.
		logx.Warn("v3 runtime idle: no AGENT_ADMIN_PORT and no PANEL_HTTP_URL; this node cannot receive tunnels")
	}

	// 1. Restore before the admin plane opens, so a port the panel expects to
	// be live is never briefly free-and-then-taken while the API is reachable.
	cacheMu := &rt.cacheMu
	if source, err := restoreTunnels(ctx, tunnels, egress, role, cfg, rt.cache, cacheMu); err != nil {
		// A failed restore must not stop the node: it still serves /health and
		// can accept apply commands. Logged loudly because it usually means a
		// panel outage right after a restart.
		logx.Error("v3 restore failed", "err", err.Error())
	} else {
		rt.restoredFromCache = source == restore.SourceLKG
		logx.Info("v3 restore done", "tunnels", tunnels.Len(), "role", role, "source", source)
	}

	// 2. Admin API.
	if cfg.AgentAdminPort != 0 {
		// api.New requires a token (an unauthenticated management plane is
		// never acceptable). Fail fast at parse time instead of losing the
		// error inside a goroutine.
		if strings.TrimSpace(cfg.AgentAdminToken) == "" {
			logx.Error("AGENT_ADMIN_TOKEN is required when AGENT_ADMIN_PORT is set; admin API disabled",
				"node_id", cfg.NodeID)
		} else {
			srv, err := api.New(api.Options{
				ListenHost: "127.0.0.1",
				Port:       cfg.AgentAdminPort,
				Token:      cfg.AgentAdminToken,
				NodeID:     cfg.NodeID,
				Version:    version,
				Role:       role,
			}, tunnels, egress, nil)
			if err != nil {
				logx.Error("v3 admin api disabled", "err", err.Error())
			} else if err := srv.Start(); err != nil {
				logx.Error("v3 admin api start failed", "addr", srv.ListenAddr(), "err", err.Error())
			} else {
				rt.api = srv
				logx.Info("v3 admin api listening", "addr", srv.ListenAddr(), "role", role)
			}
		}
	}

	// V4-WP6 telemetry: one error ledger and one revision tracker shared by the
	// control loop (writer) and the reporter (reader). Sharing is the point —
	// a second copy on either side would make the panel's `known vs applied`
	// comparison and `error_count` describe different processes.
	ledger := reporter.NewLedger()
	revisions := reporter.NewRevisionState()
	rt.ledger = ledger

	// 3. Outbound control loop. The Agent polls the Panel with its per-node
	// credential; the Panel never dials this process. This is the production
	// control path for DIRECT/RELAY/EGRESS. The local admin API above is debug-only.
	if cfg.PanelHTTPURL != "" && cfg.NodeCredential != "" {
		rt.control = control.New(control.Config{
			PanelURL:   cfg.PanelHTTPURL,
			Credential: cfg.NodeCredential,
			Errors:     ledger,
			Revisions:  revisions,
			// WP11A/A4: when the panel becomes reachable again, re-fetch the
			// authoritative desired state and drop anything it no longer lists.
			// A node that restored from its cache would otherwise keep running a
			// forward the panel has already deleted or suspended.
			Reconnected: func(rctx context.Context) {
				reconcileWithPanel(rctx, cfg, tunnels, egress, rt.cache)
			},
			// WP11C: answer a Node-level diagnostic with this process's own
			// bounded facts. Wired here because the runtime owns the tunnel
			// manager, the LKG path and the start time.
			DescribeSelf: func() selfinfo.Facts {
				return selfinfo.Collect(selfinfo.Input{
					Version: version,
					Role:    role,
					AgentID: cfg.AgentID,
					NodeID:  cfg.NodeID,
					Tunnels: tunnels,
					State:   selfinfo.LKGProbe{Cache: rt.cache, AgentID: cfg.AgentID},
					Started: rt.startedAt,
				})
			},
		}, tunnels, egress)
		if rt.restoredFromCache {
			rt.control.MarkStartupFromCache()
		}
		go func() {
			if err := rt.control.Run(ctx); err != nil {
				logx.Debug("v3 control loop stopped", "err", err.Error())
			}
		}()
		logx.Info("v3 outbound control scheduled", "url", cfg.PanelHTTPURL)
	}

	// 4. Heartbeat reporter. Disabled (nil) when no panel URL is configured;
	// Run's ErrNoPanelURL path is handled by the goroutine below.
	if cfg.PanelHTTPURL != "" {
		rt.heart = reporter.New(reporter.Config{
			PanelURL:   cfg.PanelHTTPURL,
			AgentID:    cfg.AgentID,
			NodeID:     cfg.NodeID,
			Version:    version,
			Role:       role,
			Credential: cfg.NodeCredential,
		},
			reporter.WithTunnels(tunnels),
			// V5-WP5-A3: the per-tunnel protocol diagnostics ride the state report.
			// The manager is the source because it owns the running registry — the
			// counters live in the runtime that observed the events; the panel only
			// ever displays them.
			reporter.WithDiagnostics(tunnels),
			reporter.WithEgress(egressAdapter{egress}),
			reporter.WithPorts(tunnels),
			reporter.WithRevision(tunnels),
			// V4-WP6 (§13.4.4): host facts, resource sample, error ledger and
			// the newest-seen revision ride the existing state report.
			reporter.WithHost(reporter.NewSystemSampler("")),
			reporter.WithLedger(ledger),
			reporter.WithLastError(ledger),
			reporter.WithRevisionState(revisions),
			reporter.WithStartedAt(startedAt),
			// WP11B: advertise the control-contract version and the actions this
			// binary really implements, so the panel can refuse to send an action
			// an older node would only answer with `unsupported_action`.
			reporter.WithProtocol(control.ProtocolVersion, control.Capabilities()),
			// V5-WP1: advertise the protocol/transport/runtime facts this process
			// actually wired up. The facts are computed from what was constructed
			// above — the LKG cache only claims lkg_restore when the store was
			// really enabled, and the protocol list comes from the data plane's
			// own parser table — never from config/env.
			reporter.WithManifest(runtimeManifest(rt.cache.Enabled())),
		)
		go func() {
			if err := rt.heart.Run(ctx); err != nil {
				logx.Debug("v3 heartbeat stopped", "err", err.Error())
			}
		}()
		logx.Info("v3 heartbeat scheduled", "url", cfg.PanelHTTPURL, "interval", reporter.Interval.String())
	}

	rt.startedAt = time.Now()
	rt.started = true
	// WP11A: keep the local cache close to the truth without hooking every
	// mutation path. The manager registry is the running state by construction,
	// so a periodic snapshot of it can never contain a config the node failed to
	// apply — which is exactly the "last known good" contract.
	if rt.cache.Enabled() {
		rt.cacheTick = time.NewTicker(lkgRefreshInterval)
		// Refreshed by event AND by timeout. The event is what makes the cache
		// describe what the node just acknowledged; the ticker is the safety net
		// for anything that mutates the registry without going through the
		// manager's Apply/Remove/ReplaceListener funnel.
		signal := make(chan struct{}, 1)
		tunnels.SetMutationHook(func() {
			select {
			case signal <- struct{}{}:
			default: // a refresh is already pending; the write snapshots current state
			}
		})
		// The ticker is captured in a local: the goroutine must not read a field
		// that Shutdown nils, and a nil interface would panic on the tick.
		ticker := rt.cacheTick
		rt.cacheWrites.Add(1)
		go func() {
			defer rt.cacheWrites.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case <-signal:
					rt.writeCache(version)
				case <-ticker.C:
					rt.writeCache(version)
				}
			}
		}()
	}
	return rt
}

// writeCache serializes every cache write.
//
// Two writers exist on purpose (the event/tick loop and Shutdown's final
// snapshot, plus the restore path). Without a shared mutex an older snapshot can
// be renamed into place *after* a newer one, which silently rolls the "last known
// good" state backwards — the one direction this cache must never move.
func (rt *v3Runtime) writeCache(version string) {
	rt.cacheMu.Lock()
	defer rt.cacheMu.Unlock()
	restore.RefreshCache(rt.cache, rt.cfg.AgentID, rt.tunnels, version)
}

// runtimeManifest builds the V5-WP1 capability manifest from the subsystems this
// process actually constructed.
//
// Why it takes a fact instead of being a package-level constant: the manifest is
// a claim about what this binary does. hot_reload and graceful_drain come from
// the data plane the runtime always builds (forwarder.Forwarder.SetUpstream /
// Drain), but lkg_restore is only true when the local cache is enabled for this
// deployment. Advertising it unconditionally would tell the panel a node can
// survive a panel outage when it cannot.
//
// A build error here is a programming error (an unknown name was passed in), so
// the manifest is omitted rather than guessed: no manifest means the panel falls
// back to V4 baseline admission, which is safe, whereas a wrong manifest is not.
func runtimeManifest(lkgEnabled bool) *reporter.CapabilityManifest {
	runtimeFeatures := []control.RuntimeFeature{control.RuntimeHotReload, control.RuntimeGracefulDrain}
	if lkgEnabled {
		runtimeFeatures = append(runtimeFeatures, control.RuntimeLKGRestore)
	}
	facts := control.ImplementationFacts{
		// Derived from the data plane's own parser table: the agent can never
		// advertise a protocol its own ParseForwardProtocol would reject.
		Protocols:   forwarder.ImplementedProtocols(),
		Transports:  forwarder.ImplementedTransports(),
		Runtime:     runtimeFeatures,
		Diagnostics: control.DiagnosticsFromActions(control.Capabilities()),
	}
	manifest, err := control.BuildManifest(facts)
	if err != nil {
		logx.Error("capability manifest build failed", "err", err.Error())
		return nil
	}
	return &reporter.CapabilityManifest{
		SchemaVersion: manifest.SchemaVersion,
		Protocols:     manifest.Protocols,
		Transports:    manifest.Transports,
		Runtime:       manifest.Runtime,
		Diagnostics:   manifest.Diagnostics,
	}
}

// lkgRefreshInterval is how often the running state is folded back into the
// local cache. Short enough that a crash loses at most one interval of change,
// long enough that it is not a disk write per connection.
const lkgRefreshInterval = 5 * time.Second

// reconcileWithPanel re-fetches the authoritative desired state after the panel
// comes back and prunes runtime the panel no longer lists. A failed or
// non-authoritative fetch is a no-op: pruning on a guess would take down work
// the panel still wants.
func reconcileWithPanel(ctx context.Context, cfg *agentconfig.Config, tunnels *manager.TunnelManager, egress *manager.EgressManager, cache restore.LKG) {
	if cfg.PanelHTTPURL == "" || cfg.NodeCredential == "" {
		return
	}
	rctx, cancel := context.WithTimeout(ctx, restore.FetchTimeout)
	defer cancel()
	src := restore.HTTPSource{PanelURL: cfg.PanelHTTPURL, Credential: cfg.NodeCredential}
	snap, source, err := restore.FetchAuthoritative(rctx, src, cache, cfg.AgentID)
	if err != nil {
		logx.Debug("reconnect reconcile skipped: desired state unavailable", "err", err.Error())
		return
	}
	// Only a panel answer authorises pruning; a cache fallback must never be
	// used as the authority to delete runtime.
	if snap == nil || source != restore.SourcePanel {
		return
	}
	restore.Reconcile(rctx, tunnels, egress, snap)
}

// ShutdownTimeout bounds the whole teardown: listeners close immediately, then
// in-flight connections get this long, then anything left is force-closed.
const ShutdownTimeout = 10 * time.Second

// FinalReportTimeout bounds the closing state report. It is short on purpose:
// the point is to leave a trace, not to hold up a container stop.
const FinalReportTimeout = 3 * time.Second

// Shutdown tears the v3 components down in a fixed order (WP11A):
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
func (rt *v3Runtime) Shutdown() {
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
			logx.Debug("v3 admin api stop error", "err", err.Error())
		}
	}
	// The cache writer exits with the process context, but a shutdown triggered
	// without cancelling it must not leave a goroutine writing into a torn-down
	// runtime.
	rt.cacheWrites.Wait()
	rt.egress = nil
}

// restoreTunnels pulls the node's ACTIVE tunnels from the panel and re-applies
// them. Until the WP1 Prisma contract lands, the source is a no-op: the wiring
// point is exactly this function, and swapping in the real client is a one-line
// change in source() below.
//
// EGRESS tunnels additionally need their target pool (devmap §5.5: "RELAY 模式
// 的出口节点需同时拉取 EgressTarget"), which restore.Apply registers before the
// forwarder is built.
// restoreTunnels applies the node's desired state and reports where it came
// from, so the control loop can reconcile once the panel answers again.
// restoreTunnels applies the node's desired state and reports where it came
// from. writeMu is the cache write lock shared with the writer loop and Shutdown,
// so a restore cannot race a refresh into the same file.
func restoreTunnels(ctx context.Context, tunnels *manager.TunnelManager, egress *manager.EgressManager, role string, cfg *agentconfig.Config, cache restore.LKG, writeMu *sync.Mutex) (string, error) {
	if role == agentconfig.RoleIngress {
		// An ingress node has no egress pools of its own; a nil EgressManager
		// would make restore.Apply skip EGRESS tunnels instead of half-starting
		// them (they belong on the egress node).
		egress = nil
	}
	rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	// WP11A: a panel outage falls back to the local last-known-good cache; an
	// auth/identity/malformed answer does not (see restore.FetchAuthoritative).
	snap, source, err := restore.FetchAuthoritative(rctx, source(cfg), cache, cfg.AgentID)
	if err != nil {
		return "", err
	}
	if snap == nil {
		return source, nil
	}
	writeMu.Lock()
	failed, err := restore.ApplyAndCache(rctx, tunnels, egress, snap, cache, cfg.AgentID)
	writeMu.Unlock()
	if err != nil {
		return source, err
	}
	if len(failed) > 0 {
		logx.Warn("v3 restore partially applied", "failed", fmt.Sprint(failed), "source", source)
	}
	// A cache-sourced restore is by definition not authoritative, so it must not
	// prune anything. A panel-sourced one is: a tunnel the panel no longer lists
	// (deleted/suspended while this node was down) must not keep running.
	if source == restore.SourcePanel {
		if removed := restore.Reconcile(rctx, tunnels, egress, snap); len(removed) > 0 {
			logx.Info("v3 restore pruned runtime absent from desired state", "ids", fmt.Sprint(removed))
		}
	}
	return source, nil
}

// source returns the canonical desired-state restore source. It uses the same
// outbound per-node credential as the command loop and never needs an inbound
// Agent management port.
func source(cfg *agentconfig.Config) restore.Source {
	if cfg == nil || cfg.PanelHTTPURL == "" || cfg.NodeCredential == "" {
		return restore.NopSource{}
	}
	return restore.HTTPSource{PanelURL: cfg.PanelHTTPURL, Credential: cfg.NodeCredential}
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
