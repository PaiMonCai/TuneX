package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/tunex/agent/internal/agentconfig"
	"github.com/tunex/agent/internal/api"
	"github.com/tunex/agent/internal/logx"
	"github.com/tunex/agent/internal/manager"
	"github.com/tunex/agent/internal/reporter"
	"github.com/tunex/agent/internal/restore"
)

// v3Runtime bundles the WP4 components so main can start and stop them as one
// unit. Since WP15 it is the agent's only runtime: there is no legacy session
// beside it.
type v3Runtime struct {
	cfg     *agentconfig.Config
	tunnels *manager.TunnelManager
	egress  *manager.EgressManager
	api     *api.Server
	heart   *reporter.Reporter
	started bool
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
	role := cfg.Role
	if role == "" {
		role = agentconfig.RoleBoth
	}

	egress := manager.NewEgressManager()
	tunnels := manager.NewTunnelManager(egress, cfg.ListenIP)

	rt := &v3Runtime{cfg: cfg, tunnels: tunnels, egress: egress}
	if cfg.AgentAdminPort == 0 && cfg.PanelHTTPURL == "" {
		// Nothing to bring up: no admin plane and nothing to report to. The
		// node still accepts no apply commands, so say so loudly instead of
		// silently running an empty process.
		logx.Warn("v3 runtime idle: no AGENT_ADMIN_PORT and no PANEL_HTTP_URL; this node cannot receive tunnels")
	}

	// 1. Restore before the admin plane opens, so a port the panel expects to
	// be live is never briefly free-and-then-taken while the API is reachable.
	if err := restoreTunnels(ctx, tunnels, egress, role); err != nil {
		// A failed restore must not stop the node: it still serves /health and
		// can accept apply commands. Logged loudly because it usually means a
		// panel outage right after a restart.
		logx.Error("v3 restore failed", "err", err.Error())
	} else {
		logx.Info("v3 restore done", "tunnels", tunnels.Len(), "role", role)
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

	// 3. Heartbeat reporter. Disabled (nil) when no panel URL is configured;
	// Run's ErrNoPanilURL path is handled by the goroutine below.
	if cfg.PanelHTTPURL != "" {
		rt.heart = reporter.New(reporter.Config{
			PanelURL:   cfg.PanelHTTPURL,
			NodeID:     cfg.NodeID,
			Version:    version,
			Role:       role,
			Credential: cfg.NodeCredential,
		},
			reporter.WithTunnels(tunnels),
			reporter.WithEgress(egressAdapter{egress}),
			reporter.WithPorts(tunnels),
			reporter.WithRevision(tunnels),
		)
		go func() {
			if err := rt.heart.Run(ctx); err != nil {
				logx.Debug("v3 heartbeat stopped", "err", err.Error())
			}
		}()
		logx.Info("v3 heartbeat scheduled", "url", cfg.PanelHTTPURL, "interval", reporter.Interval.String())
	}

	rt.started = true
	return rt
}

// Shutdown tears the v3 components down in reverse order. It is safe to call on
// a runtime whose admin API never started.
func (rt *v3Runtime) Shutdown() {
	if rt == nil || !rt.started {
		return
	}
	if rt.heart != nil {
		rt.heart.Stop()
	}
	if rt.api != nil {
		if err := rt.api.Stop(); err != nil {
			logx.Debug("v3 admin api stop error", "err", err.Error())
		}
	}
	rt.tunnels.StopAll()
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
func restoreTunnels(ctx context.Context, tunnels *manager.TunnelManager, egress *manager.EgressManager, role string) error {
	if role == agentconfig.RoleIngress {
		// An ingress node has no egress pools of its own; a nil EgressManager
		// would make restore.Apply skip EGRESS tunnels instead of half-starting
		// them (they belong on the egress node).
		egress = nil
	}
	rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	failed, err := restore.Restore(rctx, tunnels, egress, source())
	if err != nil {
		return err
	}
	if len(failed) > 0 {
		logx.Warn("v3 restore partially applied", "failed", fmt.Sprint(failed))
	}
	return nil
}

// source returns the restore.Source to use. WP4 ships restore.NopSource; the
// WP6 control transport replaces this body.
func source() restore.Source { return restore.NopSource{} }

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
