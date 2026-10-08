package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/tunex/agent/internal/agentconfig"
	"github.com/tunex/agent/internal/api"
	"github.com/tunex/agent/internal/control"
	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/linkrunner"
	"github.com/tunex/agent/internal/linktraffic"
	"github.com/tunex/agent/internal/logx"
	"github.com/tunex/agent/internal/manager"
	"github.com/tunex/agent/internal/ownership"
	"github.com/tunex/agent/internal/panelroute"
	"github.com/tunex/agent/internal/reporter"
	"github.com/tunex/agent/internal/restore"
	"github.com/tunex/agent/internal/selfinfo"
	"github.com/tunex/agent/internal/targetdns"
	"github.com/tunex/agent/internal/targetobs"
)

// agentRuntime owns the process-level Agent components so startup and shutdown share one lifecycle.
type agentRuntime struct {
	cfg     *agentconfig.Config
	tunnels *manager.TunnelManager
	egress  *manager.EgressManager
	api     *api.Server
	control *control.Client
	heart   *reporter.Reporter
	// ledger is the shared apply/runtime error ledger, kept on the runtime so a
	// later admin surface can record operator-triggered failures into the same
	// place the panel reads.
	ledger *reporter.Ledger
	// ownership is the activation gate and lease clock. Kept on the
	// runtime because Shutdown reports its final facts.
	ownership *ownership.Guard
	// resolver is the target resolver, kept for the same reason.
	resolver *targetdns.Resolver
	started  bool
	// cache is the last-known-good desired state. It is written only from
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
	links             *linkrunner.Manager
	linkFacts         control.RuntimeFacts
}

// startRuntime wires the production Agent components and starts them in dependency order.
//
// The role controls which data-plane responsibilities are active. BOTH is the
// default so a newly provisioned node can accept its first assignment.
func startRuntime(ctx context.Context, cfg *agentconfig.Config) *agentRuntime {
	// startedAt is sampled once here: uptime must measure the agent process, not
	// the moment the reporter happened to build a payload.
	startedAt := time.Now()
	role := cfg.Role
	if role == "" {
		role = agentconfig.RoleBoth
	}

	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, cfg.ListenIP)

	rt := &agentRuntime{cfg: cfg, tunnels: tunnels, egress: egress}
	rt.cache = restore.LKG{Path: cfg.LKGPath()}
	if cfg.AgentAdminPort == 0 && cfg.PanelHTTPURL == "" {
		// Nothing to bring up: no admin plane and nothing to report to. The
		// node still accepts no apply commands, so say so loudly instead of
		// silently running an empty process.
		logx.Warn("agent runtime idle: no AGENT_ADMIN_PORT and no PANEL_HTTP_URL; this node cannot receive tunnels")
	}

	// One error ledger and one revision tracker are shared by the
	// control loop (writer) and the reporter (reader). Sharing is the point —
	// a second copy on either side would make the panel's `known vs applied`
	// comparison and `error_count` describe different processes.
	//
	// Build these before restore so the ownership gate can record refusals into the
	// ledger, and the FIRST thing that can apply a tunnel is the restore in the
	// next block — a guard whose complaints only start being recorded after
	// startup would go silent in exactly the window a fence matters.
	ledger := reporter.NewLedger()
	revisions := reporter.NewRevisionState()
	rt.ledger = ledger
	// Managed FXP shares the native manager's external slots and owns a separate
	// encrypted cache; it must never enter restore.LKG's tunnel snapshot.
	linkStateDir := cfg.StateDir
	if linkStateDir == "" && cfg.LKGPath() != "" {
		linkStateDir = filepath.Dir(cfg.LKGPath())
	}
	if links, facts, err := control.NewLinkRuntime(linkStateDir, cfg.AgentID, tunnels); err != nil {
		logx.Error("managed FXP runtime disabled", "err", err.Error())
		ledger.Record(err.Error())
	} else {
		if links != nil {
			if err := links.EnableTraffic(); err != nil {
				_ = links.Close()
				logx.Error("managed FXP runtime disabled: private traffic spool unavailable")
				ledger.Record("managed FXP private traffic spool unavailable")
			} else {
				rt.links = links
				rt.linkFacts = facts
				rt.linkFacts.TrafficRotation = links.TrafficRotationSupported()
				rt.linkFacts.FXPTargets = links.TargetSetsSupported()
				rt.linkFacts.FXPSource = links.ClientSourceSupported()
			}
		}
	}
	// The native TunnelManager also enforces the shared runtime policy gate;
	// its capability is independent of the optional FXP executable.
	rt.linkFacts.PolicyRuntime = true
	rt.linkFacts.NativeBoth = true
	if rt.links != nil {
		fromCache, err := control.RestoreLinks(ctx, linkrunner.HTTPSource{PanelURL: cfg.PanelHTTPURL, Credential: cfg.NodeCredential, AgentID: cfg.AgentID}, rt.links)
		rt.restoredFromCache = fromCache
		if err != nil {
			logx.Error("managed FXP restore failed", "err", err.Error())
			ledger.Record(err.Error())
		}
		go func() {
			<-ctx.Done()
			if err := rt.links.Close(); err != nil {
				logx.Error("managed FXP stop failed", "err", err.Error())
			}
		}()
	}

	// Install the epoch fence and lease clock BEFORE the first apply so restore
	// is fenced exactly like every other activation path.
	//
	// The fence lives in the durable state directory next to the last-known-good
	// cache: a node that forgets its highest epoch across a restart is the node
	// that serves stale ownership during a partition, which is the one outcome
	// this mechanism exists to make impossible.
	ownerGuard := ownership.New(ownership.Config{
		Fence:  ownership.OpenFence(cfg.OwnershipFencePath(), cfg.AgentID),
		Now:    time.Now,
		Report: ledger.Record,
		// A stopped tunnel must not leave its egress pool behind: the pool would
		// still be reported to the panel (and observed by the target observer)
		// as if a listener existed for it.
		OnLeaseStop: func(c forwarder.TunnelConfig) {
			if c.Mode == forwarder.ModeEgress && egress != nil {
				egress.DropPool(c.ID)
			}
		},
	})
	ownerGuard.SetRegistry(tunnels)
	tunnels.SetOwnershipGuard(ownerGuard)
	rt.ownership = ownerGuard
	if f := ownerGuard.Fence(); f != nil && !f.Durable() {
		logx.Warn("ownership: the epoch fence is not durable; a restart would forget which generations this node has seen",
			"node_id", cfg.NodeID, "state_dir", cfg.StateDir)
	}
	if f := ownerGuard.Fence(); f != nil {
		if err := f.LoadError(); err != nil {
			logx.Error("ownership: the epoch fence could not be read; starting from an empty fence",
				"node_id", cfg.NodeID, "path", f.Path, "err", err.Error())
			ledger.Record("ownership: epoch fence unreadable, starting empty: " + err.Error())
		}
	}

	// Build the target resolver BEFORE restore because restored EGRESS forwarders
	// capture the dialer available at construction time.
	//
	// IP literals bypass it, a lookup failure falls back to the last good
	// addresses, and the fact that it is doing so is logged and filed in the
	// ledger the panel reads.
	resolver := targetdns.New(targetdns.Config{
		OnFact: func(f targetdns.Fact) {
			attrs := []any{
				"host", f.Host,
				"addrs", strings.Join(f.Addrs, ","),
				"stale", f.Stale,
				"lookups", f.Lookups,
			}
			if f.StaleAgeSeconds > 0 {
				attrs = append(attrs, "stale_age_seconds", f.StaleAgeSeconds)
			}
			if f.LastError != "" {
				attrs = append(attrs, "err", f.LastError)
			}
			switch {
			case f.Stale && len(f.Addrs) > 0:
				// Not fatal: the node keeps dialing the last good addresses, and
				// the age is the honest part of the fact (§8.1 stale fallback).
				logx.Warn("target resolution failed; using the last good addresses", attrs...)
				ledger.Record(fmt.Sprintf(
					"dns: %s is stale (%ds old, %d addresses): %s",
					f.Host, f.StaleAgeSeconds, len(f.Addrs), f.LastError))
			case f.Stale:
				logx.Warn("target resolution failed and there is no last good address set", attrs...)
				ledger.Record(fmt.Sprintf("dns: %s does not resolve: %s", f.Host, f.LastError))
			default:
				logx.Info("target resolution recovered", attrs...)
			}
		},
	})
	tunnels.SetTargetDialer(resolver.DialContext)
	rt.resolver = resolver

	// 1. Restore before the admin plane opens, so a port the panel expects to
	// be live is never briefly free-and-then-taken while the API is reachable.
	cacheMu := &rt.cacheMu
	if source, err := restoreTunnels(ctx, tunnels, egress, role, cfg, rt.cache, cacheMu); err != nil {
		// A failed restore must not stop the node: it still serves /health and
		// can accept apply commands. Logged loudly because it usually means a
		// panel outage right after a restart.
		logx.Error("restore failed", "err", err.Error())
	} else {
		rt.restoredFromCache = rt.restoredFromCache || source == restore.SourceLKG
		logx.Info("restore done", "tunnels", tunnels.Len(), "role", role, "source", source)
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
				// ownership: the fencing counters/state are part of the node's
				// health surface, so an operator can see refusals and lapsed
				// leases without opening the agent log.
				Ownership: ownerGuard,
				TargetDNS: resolver,
			}, tunnels, egress, nil)
			if err != nil {
				logx.Error("admin api disabled", "err", err.Error())
			} else if err := srv.Start(); err != nil {
				logx.Error("admin api start failed", "addr", srv.ListenAddr(), "err", err.Error())
			} else {
				rt.api = srv
				logx.Info("admin api listening", "addr", srv.ListenAddr(), "role", role)
			}
		}
	}

	// observations is the current-current observation source for the state report. It
	// stays a nil interface when the observer is not running, so the report
	// omits `target_observations` rather than claiming "no targets failed".
	var observations reporter.TargetObservationLister

	// The lease clock runs for the whole process: it is the fail-safe half of
	// the ownership lease policy, and it reads the running registry each
	// tick rather than trusting a timer armed by whichever path applied a
	// tunnel. Cancelled with the process context like everything else.
	go ownerGuard.Run(ctx)

	// 面板迁移回退（task-44/45）：把 agent.env 里的回退三元组解析出来。
	// 解析纪律与配置面一致：**只填一个 = 配置写坏了**，这时必须记 ERROR 并**保持不切**
	// （退回"没有回退能力"），而不是猜一个地址去切 —— 猜错会把节点从可用面板上带走。
	panels := panelroute.PanelMigration{}
	if migration, merr := cfg.PanelMigration(); merr == nil {
		panels = panelroute.PanelMigration{
			PrimaryURL:     migration.PrimaryURL,
			FallbackURL:    migration.FallbackURL,
			MigrationID:    migration.MigrationID,
			StartedAt:      migration.StartedAt,
			StartedAtKnown: migration.StartedAtKnown,
		}
		logx.Info("panel migration fallback enabled",
			"node_id", cfg.NodeID,
			"migration_id", migration.MigrationID,
			"fallback_url", migration.FallbackURL,
			"started_at_known", migration.StartedAtKnown)
	} else if !errors.Is(merr, agentconfig.ErrPanelMigrationNotConfigured) {
		logx.Error("panel migration fallback config is invalid; the agent will NOT switch panels",
			"node_id", cfg.NodeID, "error", merr.Error())
	}

	// 共享切换器必须在这里、也就是在**启动任何出站 goroutine 之前**建好：状态上报、
	// 命令拉取、ACK、重连 desired fetch/reconcile 都要读同一个"当前生效地址"，谁都
	// 不能各拿一份 cfg.PanelHTTPURL 自己判定（task-45 的 P1）。构造顺序很重要：
	// control.New 的 Reconnected 闭包会捕获这个指针，但它是在**对账发生的那一刻**才
	// 读地址，所以 reporter 还没 Run 也不影响；反过来若先起 control 而没有这个指针，
	// 就会退回"命令永远打主地址"。
	//
	// 没有凭据就不建：那样两条出站链路都不会启动，节点本来也不与面板通话。
	var panelRouter *panelroute.Router
	if cfg.PanelHTTPURL != "" && cfg.NodeCredential != "" {
		panelRouter = panelroute.New(panelroute.Config{
			PrimaryURL: cfg.PanelHTTPURL,
			Migration:  panels,
			NodeID:     cfg.NodeID,
		})
	}
	if panelRouter != nil && rt.links != nil {
		// Reporting shares the active panel route, but a private snapshot and
		// ledger ACK are separate from desired/observed readiness. Failed POSTs
		// leave cumulative samples durable for retry and do not reset counters.
		client := linktraffic.Client{PanelURL: panelRouter.ActiveURL, Credential: cfg.NodeCredential}
		go func() {
			ticker := time.NewTicker(10 * time.Second)
			defer ticker.Stop()
			for {
				if err := linktraffic.Flush(ctx, client, rt.links); err != nil && ctx.Err() == nil {
					logx.Debug("managed FXP traffic report deferred; durable samples retained")
				}
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}()
	}

	// 3. Outbound control loop. The Agent polls the Panel with its per-node
	// credential; the Panel never dials this process. This is the production
	// control path for DIRECT/RELAY/EGRESS. The local admin API above is debug-only.
	if cfg.PanelHTTPURL != "" && cfg.NodeCredential != "" {
		rt.control = control.New(control.Config{
			PanelURL:     cfg.PanelHTTPURL,
			Credential:   cfg.NodeCredential,
			Links:        rt.links,
			RuntimeFacts: rt.linkFacts,
			ReportLinkState: func(rctx context.Context) error {
				return rt.heart.ReportOnce(rctx)
			},
			// 面板地址：与状态上报共用同一个切换器。拉取与 ACK 每次请求都取当前
			// 生效地址，切换后同一进程即时生效；拉取结果反过来喂同一个判定（不再
			// 每模块复制一份切换规则）。
			Router:    panelRouter,
			Errors:    ledger,
			Revisions: revisions,
			// reconnect reconciliation: when the panel becomes reachable again, re-fetch the
			// authoritative desired state and drop anything it no longer lists.
			// A node that restored from its cache would otherwise keep running a
			// forward the panel has already deleted or suspended.
			Reconnected: func(rctx context.Context) {
				if rt.links != nil {
					_, err := control.RestoreLinks(rctx, linkrunner.HTTPSource{PanelURL: panelRouter.ActiveURL(), Credential: cfg.NodeCredential, AgentID: cfg.AgentID}, rt.links)
					if err != nil {
						logx.Error("managed FXP reconcile failed", "err", err.Error())
						ledger.Record(err.Error())
					}
				}
				// desired fetch 同样走当前生效地址：上报恢复了 online 而对账仍打
				// 主地址，正是 task-45 要修的那个"半恢复"。
				reconcileWithPanel(rctx, cfg, panelRouter, tunnels, egress, rt.cache)
			},
			// node diagnostics: answer a Node-level diagnostic with this process's own
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
	}

	// 4. State reporter. Disabled (nil) when there is nothing to report to: no
	// panel URL, or no node credential — the authenticated state report is the
	// Agent's only channel to the Panel (the old unauthenticated
	// /api/internal/heartbeat POST was never implemented by the Panel and is gone).
	// Run's ErrNoPanelURL path is handled by the goroutine below.
	//
	// target observation target observation starts just before it, so the very first state
	// report can already carry facts instead of an empty key.
	if cfg.PanelHTTPURL != "" && cfg.NodeCredential != "" {
		// The observer probes ONLY the targets of the egress pools this node
		// serves — DesiredTargets is its one window into the world, which is how
		// "never scan an unauthorized target" (§7 row 2) is enforced.
		//
		// It is started only when the state report can actually carry the facts:
		// without a node credential StateEndpoint is empty, so probing would be
		// network noise against targets the panel never hears about. The
		// lifecycle is the process context — the same one every other component
		// uses — so there is no second teardown path to keep in sync.
		observer := targetobs.New(targetobs.Config{
			NodeID:  cfg.NodeID,
			Targets: egress.DesiredTargets,
			// The observer and the data plane must dial through the SAME
			// resolution: otherwise a probe could report a target unreachable
			// while the data plane is still relaying it from the cached
			// addresses (or the reverse), and both facts would be true.
			Dial: resolver.DialContext,
		})
		observations = observer
		go observer.Run(ctx)
		logx.Info("target observation scheduled",
			"node_id", cfg.NodeID, "interval", observer.Interval().String())
	}
	// 面板迁移回退（task-44/45）：解析出来的三元组与**进程共享的**切换器一起交给
	// 上报侧。切换判据只有一份（panelroute.Router），命令拉取/ACK/desired 用的是同一个。
	if cfg.PanelHTTPURL != "" && cfg.NodeCredential != "" {
		var linkPlacements func() []linkrunner.Observation
		if rt.links != nil {
			linkPlacements = rt.links.Status
		}
		rt.heart = reporter.New(reporter.Config{
			PanelURL:   cfg.PanelHTTPURL,
			Panels:     panels,
			Router:     panelRouter,
			AgentID:    cfg.AgentID,
			NodeID:     cfg.NodeID,
			Version:    version,
			Role:       role,
			Credential: cfg.NodeCredential,
		},
			reporter.WithTunnels(tunnels),
			// protocol diagnostics: the per-tunnel protocol diagnostics ride the state report.
			// The manager is the source because it owns the running registry — the
			// counters live in the runtime that observed the events; the panel only
			// ever displays them.
			reporter.WithDiagnostics(tunnels),
			// target observation: the target observer's facts (empty when it was not
			// started above, which keeps the wire key absent).
			reporter.WithTargetObservations(observations),
			reporter.WithLinkPlacements(linkPlacements),
			// ownership: the panel hands the renewed ownership deadlines back in
			// the answer to this very report. Dropping that answer is what makes
			// a healthy node stop every tunnel one TTL after its last config.
			reporter.WithLeases(leaseSink{ownerGuard}),
			reporter.WithEgress(egressAdapter{egress}),
			reporter.WithPorts(tunnels),
			reporter.WithRevision(tunnels),
			// host/resource/error reporting: host facts, resource sample, error ledger and
			// the newest-seen revision ride the existing state report.
			reporter.WithHost(reporter.NewSystemSampler("")),
			reporter.WithLedger(ledger),
			reporter.WithLastError(ledger),
			reporter.WithRevisionState(revisions),
			reporter.WithStartedAt(startedAt),
			// control negotiation: advertise the control-contract version and the actions this
			// binary really implements, so the panel can refuse to send an action
			// an older node would only answer with `unsupported_action`.
			reporter.WithProtocol(control.ProtocolVersion, control.Capabilities(rt.linkFacts)),
			// capability manifest: advertise the protocol/transport/runtime facts this process
			// actually wired up. The facts are computed from what was constructed
			// above — the LKG cache only claims lkg_restore when the store was
			// really enabled, and the protocol list comes from the data plane's
			// own parser table — never from config/env.
			reporter.WithManifest(runtimeManifest(rt.cache.Enabled())),
		)
		go func() {
			if err := rt.heart.Run(ctx); err != nil {
				logx.Debug("state report stopped", "err", err.Error())
			}
		}()
		logx.Info("state report scheduled", "url", cfg.PanelHTTPURL, "interval", reporter.Interval.String())
	}

	rt.startedAt = time.Now()
	rt.started = true
	// The control callback reads rt.heart. Start polling only after reporter
	// construction so its first successful mutation can publish actual facts
	// without racing the runtime's initialization.
	if rt.control != nil {
		go func() {
			if err := rt.control.Run(ctx); err != nil {
				logx.Debug("control loop stopped", "err", err.Error())
			}
		}()
		logx.Info("outbound control scheduled", "url", cfg.PanelHTTPURL)
	}
	// Keep the local cache close to the running truth without hooking every
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
func (rt *agentRuntime) writeCache(version string) {
	rt.cacheMu.Lock()
	defer rt.cacheMu.Unlock()
	restore.RefreshCache(rt.cache, rt.cfg.AgentID, rt.tunnels, version)
}

// runtimeManifest builds the capability manifest from the subsystems this
// process actually constructed.
//
// Why it takes a fact instead of being a package-level constant: the manifest is
// a claim about what this binary does. hot_reload and graceful_drain come from
// the data plane the runtime always builds (forwarder.StreamRuntime.SetUpstream /
// Drain), but lkg_restore is only true when the local cache is enabled for this
// deployment. Advertising it unconditionally would tell the panel a node can
// survive a panel outage when it cannot.
//
// A build error here is a programming error (an unknown name was passed in), so
// the manifest is omitted rather than guessed: no manifest means the panel falls
// back to baseline admission, which is safe, whereas a wrong manifest is not.
func runtimeManifest(lkgEnabled bool) *reporter.CapabilityManifest {
	runtimeFeatures := []control.RuntimeFeature{control.RuntimeHotReload, control.RuntimeGracefulDrain, control.RuntimeSelectorFallback}
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
