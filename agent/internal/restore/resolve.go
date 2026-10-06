package restore

import (
	"context"
	"errors"
	"sort"
	"strings"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/logx"
	"github.com/tunex/agent/internal/manager"
)

// Source names for a snapshot, reported in logs so an operator can tell a real
// panel answer from a cached one at a glance.
const (
	SourcePanel = "panel"
	SourceLKG   = "lkg"
)

// FetchAuthoritative resolves the desired state for a startup restore, applying
// the restore fallback policy:
//
//   - panel answers → that answer is authoritative, cache untouched;
//   - panel is UNREACHABLE → fall back to the local last-known-good cache;
//   - panel rejects us (401/403/404) or answers something unparseable → fail
//     closed: no fallback, because cached state may describe work that has since
//     been suspended, deleted or re-targeted.
//
// It never writes the cache: only applied state may become "last known good",
// which ApplyAndCache enforces after the manager has accepted the configs.
func FetchAuthoritative(ctx context.Context, src Source, cache LKG, agentID string) (*Snapshot, string, error) {
	if src == nil {
		return nil, "", ErrNoPanel
	}
	snap, err := src.FetchSnapshot(ctx)
	if err == nil {
		return snap, SourcePanel, nil
	}
	if !IsOutage(err) {
		return nil, "", err
	}

	cached, cacheErr := cache.Load(agentID)
	if cacheErr != nil {
		// No usable cache: the outage is the real answer.
		logx.Warn("panel unreachable and no usable local cache", "err", err.Error(), "cache", cacheErr.Error())
		return nil, "", err
	}
	logx.Warn("panel unreachable, restoring cached desired state",
		"tunnels", len(cached.Tunnels), "err", err.Error())
	return cached, SourceLKG, nil
}

// (AppliedSubset was removed on purpose: it produced "incoming snapshot minus
// failures", which for an idempotent retarget is a config the node never ran.) //
// ApplyAndCache applies snap and then caches what the manager is ACTUALLY
// running.
//
// This ordering is the point: a tunnel that failed to bind (port taken, invalid
// config) must never become "last known good", or every later panel outage would
// resurrect a config the node has already proven it cannot run. Reading the
// manager's own registry (rather than "the incoming snapshot minus failures") is
// what makes that true for retargets too: an idempotent apply keeps the OLD
// running config, and the cache must record the old one, not the new payload
// that was never applied.
func ApplyAndCache(ctx context.Context, tunnels *manager.TunnelManager, egress *manager.EgressManager, snap *Snapshot, cache LKG, agentID string) ([]string, error) {
	failed, err := Apply(ctx, tunnels, egress, snap)
	if err != nil {
		return failed, err
	}
	if !cache.Enabled() || snap == nil {
		return failed, nil
	}
	running := SnapshotOf(tunnels, snap.Version)
	if running == nil {
		return failed, nil
	}
	if len(failed) > 0 && len(running.Tunnels) == 0 {
		// Everything failed AND nothing is running: this is "we do not know", not
		// "nothing should run". Writing the empty registry here would erase the
		// last state that actually worked — the opposite mistake from the
		// tombstone below, and the reason the two are decided separately.
		return failed, nil
	}
	if err := cache.Save(agentID, running); err != nil && !errors.Is(err, ErrLKGEmpty) {
		// A cache write failure must not fail a restore that otherwise worked.
		logx.Warn("lkg cache write failed", "err", err.Error())
	}
	return failed, nil
}

// SnapshotOf renders the currently running tunnels as a snapshot. It is what a
// cache refresh writes: the manager's live registry is, by definition, state the
// node has successfully applied.
//
// A running registry that is EMPTY yields an empty versioned snapshot, not nil:
// "nothing is running" is a fact the cache must be able to record. nil is
// reserved for "there is no manager to ask".
func SnapshotOf(tunnels *manager.TunnelManager, version string) *Snapshot {
	if tunnels == nil {
		return nil
	}
	cfgs := tunnels.List()
	sort.Slice(cfgs, func(i, j int) bool { return cfgs[i].ID < cfgs[j].ID })
	out := &Snapshot{Version: version, Tunnels: make([]forwarder.TunnelConfig, 0, len(cfgs))}
	for _, cfg := range cfgs {
		out.Tunnels = append(out.Tunnels, cfg.Clone())
	}
	return out
}

// RefreshCache writes the running state to the cache — including an empty one,
// so a node that has removed or suspended its last forward stops advertising it
// to the next panel outage. It is safe to call often (atomic and idempotent);
// returning false means "nothing was written", not "an error occurred".
func RefreshCache(cache LKG, agentID string, tunnels *manager.TunnelManager, version string) bool {
	if !cache.Enabled() {
		return false
	}
	snap := SnapshotOf(tunnels, version)
	if snap == nil {
		return false
	}
	if err := cache.Save(agentID, snap); err != nil {
		logx.Warn("lkg cache refresh failed", "err", err.Error())
		return false
	}
	return true
}

// Reconcile makes the running runtime match an AUTHORITATIVE snapshot: any
// listener the snapshot does not mention is removed.
//
// Why this exists: the panel is the only authority on which forwards
// exist. When a node restored from its local cache during an outage and the
// panel later comes back with a forward already deleted, suspended or moved
// away, nothing else on the agent side would ever take that listener down —
// the panel's reconciler does not delete "unexpected" runtime, and the command
// loop only applies what it is told. This function is that missing step, and it
// is only ever called with a freshly fetched, complete snapshot.
//
// It is deliberately not called when the snapshot came from the cache.
func Reconcile(ctx context.Context, tunnels *manager.TunnelManager, egress *manager.EgressManager, snap *Snapshot) []string {
	if tunnels == nil || snap == nil {
		return nil
	}
	wanted := snap.IDSet()
	var removed []string
	for _, id := range tunnels.IDs() {
		if err := ctx.Err(); err != nil {
			break
		}
		if wanted[id] {
			continue
		}
		if err := tunnels.Remove(id); err != nil {
			logx.Warn("reconcile could not remove unexpected runtime", "id", id, "err", err.Error())
			continue
		}
		if egress != nil {
			egress.DropPool(id)
		}
		removed = append(removed, id)
	}
	// 出口侧的 runtime 也必须按同一份权威集合裁剪。
	//
	// 上面那个循环只看得见 `TunnelManager` 里的 runtime，而在**纯出口节点**上那个集合是**空的** ——
	// 出口 runtime 活在 `EgressManager` 的池表里。实测后果：一条 Forward 在节点离线期间被删除，
	// 它的出口 runtime 永远裁不掉，一直占着监听端口；面板的分配器查的是数据库租约，于是把那个
	// 端口又发出去，Agent 正确地拒绝每一次 apply —— 症状看起来像"端口分配有 bug"，
	// 实际是一条无法被裁剪的孤儿（`tunex-272-egress` 占着 22001，而它的 Forward 行早已不存在）。
	//
	// 判据与上面完全一致（不在权威期望集合里就撤），因此必须复用同一个 `wanted`。
	if egress != nil {
		for _, id := range egress.IDs() {
			if err := ctx.Err(); err != nil {
				break
			}
			if wanted[id] {
				continue
			}
			egress.DropPool(id)
			removed = append(removed, id)
		}
	}
	if len(removed) > 0 {
		sort.Strings(removed)
		logx.Info("reconcile removed runtime absent from authoritative desired state",
			"count", len(removed), "ids", strings.Join(removed, ","))
	}
	return removed
}
