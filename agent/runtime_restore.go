package main

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/tunex/agent/internal/agentconfig"
	"github.com/tunex/agent/internal/logx"
	"github.com/tunex/agent/internal/manager"
	"github.com/tunex/agent/internal/panelroute"
	"github.com/tunex/agent/internal/restore"
)

// reconcileWithPanel re-fetches the authoritative desired state after the panel
// comes back and prunes runtime the panel no longer lists.
//
// 地址取自**共享切换器**（task-45）：这次 desired fetch 是一次真实的出站请求，必须
// 打到当前生效地址。task-44 的缺陷正是"上报切到备用、desired 仍读主地址"：主地址
// 不可达而备用可达时，节点在面板上恢复 online，reconcile 却永远失败。
//
// route 为 nil（或它给出的地址为空）时回落到 cfg 的主地址，保持"没有回退能力"的
// 部署行为逐字不变。
func reconcileWithPanel(ctx context.Context, cfg *agentconfig.Config, route *panelroute.Router, tunnels *manager.TunnelManager, egress *manager.EgressManager, cache restore.LKG) {
	if cfg == nil || strings.TrimSpace(cfg.NodeCredential) == "" {
		return
	}
	base := activePanelBase(cfg, route)
	if base == "" {
		return
	}
	rctx, cancel := context.WithTimeout(ctx, restore.FetchTimeout)
	defer cancel()
	src := restore.HTTPSource{PanelURL: base, Credential: cfg.NodeCredential}
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

// activePanelBase 是"现在该跟哪个面板说话"的唯一取址口：共享切换器优先，未注入或
// 未给出地址时回落到 cfg 的主地址。判定本身不在这里 —— 这里只读那个共享事实。
func activePanelBase(cfg *agentconfig.Config, route *panelroute.Router) string {
	if route != nil {
		if active := route.ActiveURL(); active != "" {
			return active
		}
	}
	if cfg == nil {
		return ""
	}
	return strings.TrimRight(strings.TrimSpace(cfg.PanelHTTPURL), "/")
}

// ShutdownTimeout bounds the whole teardown: listeners close immediately, then
// in-flight connections get this long, then anything left is force-closed.
func restoreTunnels(ctx context.Context, tunnels *manager.TunnelManager, egress *manager.EgressManager, role string, cfg *agentconfig.Config, cache restore.LKG, writeMu *sync.Mutex) (string, error) {
	if role == agentconfig.RoleIngress {
		// An ingress node has no egress pools of its own; a nil EgressManager
		// would make restore.Apply skip EGRESS tunnels instead of half-starting
		// them (they belong on the egress node).
		egress = nil
	}
	rctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	// A Panel outage falls back to the local last-known-good cache; an
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
		logx.Warn("restore partially applied", "failed", fmt.Sprint(failed), "source", source)
	}
	// A cache-sourced restore is by definition not authoritative, so it must not
	// prune anything. A panel-sourced one is: a tunnel the panel no longer lists
	// (deleted/suspended while this node was down) must not keep running.
	if source == restore.SourcePanel {
		if removed := restore.Reconcile(rctx, tunnels, egress, snap); len(removed) > 0 {
			logx.Info("restore pruned runtime absent from desired state", "ids", fmt.Sprint(removed))
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

// leaseSink adapts the ownership guard to the reporter's lease interface.
//
// The conversion lives here, like egressAdapter, so the reporter stays free of
// the enforcement package: it carries the wire facts, it does not decide what
// they mean.
