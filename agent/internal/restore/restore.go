// Package restore pulls the node's ACTIVE tunnels from the panel at startup so
// a restarted Agent re-binds its data-plane ports. The package depends on a
// transport-neutral Source interface rather than panel persistence models, so
// restore stays isolated from Prisma and transport details.
//
// The restore result is deliberately idempotent: applying the very snapshot
// twice must not churn listeners, which is why it goes through
// manager.TunnelManager's revision rules rather than raw Start calls.
package restore

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/manager"
)

// ErrNoPanel is returned by a nil panel: the caller decides whether a node may
// start empty. On an ingress node a failed restore means a port outage, so
// callers usually log loudly and continue serving /health.
var ErrNoPanel = errors.New("restore: no panel source configured")

// Snapshot is what the panel knows about this node. It is intentionally
// transport-agnostic (a decoded HTTP body or a Socket.IO ack both fit) and
// decoupled from Prisma models so persistence changes do not leak into the Agent
// as long as this wire shape remains stable.
type Snapshot struct {
	// Version lets the Agent detect an older snapshot contract.
	Version string `json:"version,omitempty"`
	// Tunnels are the node's ACTIVE tunnels (any mode).
	Tunnels []forwarder.TunnelConfig `json:"tunnels"`
}

// Source fetches a node's snapshot. Implemented by the panel client.
type Source interface {
	// FetchSnapshot returns the node's ACTIVE tunnels, or an error when the
	// panel is unreachable. Returning (nil, nil) means "no tunnels for this
	// node", which is a valid state for a freshly provisioned node.
	FetchSnapshot(ctx context.Context) (*Snapshot, error)
}

// NopSource is a Source that always reports "nothing to restore". It is what
// tests and deliberately disconnected runtimes can use when no panel source exists.
type NopSource struct{}

// FetchSnapshot implements Source.
func (NopSource) FetchSnapshot(context.Context) (*Snapshot, error) {
	return &Snapshot{}, nil
}

// ErrSource adapts any func to Source (parity with manager/lb wiring).
type ErrSource struct {
	Fn func(context.Context) (*Snapshot, error)
}

// FetchSnapshot implements Source.
func (s ErrSource) FetchSnapshot(ctx context.Context) (*Snapshot, error) {
	if s.Fn == nil {
		return NopSource{}.FetchSnapshot(ctx)
	}
	return s.Fn(ctx)
}

// Apply restores a snapshot onto the managers.
//
// EGRESS tunnels need their target pool registered before the forwarder is
// built, so any tunnel without a pool is skipped here (and reported): the
// panel must send the pool with, or right after, the tunnel.
//
// Every tunnel is applied through the manager, so:
//   - the same id applied twice is a revision idempotent no-op (no churn);
//   - a stale revision is rejected rather than silently downgrading the node;
//   - a port clash fails only that tunnel, never the whole restore.
//
// Returns the ids that failed to apply; a non-empty slice is not an error the
// caller must abort on (the node keeps running the tunnels that did apply).
func Apply(ctx context.Context, tunnels *manager.TunnelManager, egress *manager.EgressManager, snap *Snapshot) ([]string, error) {
	if tunnels == nil {
		return nil, errors.New("restore: tunnel manager is required")
	}
	if snap == nil {
		return nil, nil
	}
	var failed []string
	for _, cfg := range snap.Tunnels {
		if err := ctx.Err(); err != nil {
			return failed, err
		}
		if cfg.Mode == forwarder.ModeEgress {
			if egress == nil {
				failed = append(failed, cfg.ID)
				continue
			}
			// An EGRESS tunnel's pool must exist before the forwarder is
			// built (the balancer is a constructor argument).
			//
			// The snapshot carries health alongside targets so a restored node keeps
			// its circuit breaker instead of silently dropping health-aware routing
			// until the next command arrives.
			//
			// What is NOT cached is health as PERSISTED state: the local last-known-good
			// cache never stores it (it is a live observation, not configuration), and a
			// restored pool with no health in the snapshot simply has no signal. The
			// distinction matters: installing targets without their health would turn the
			// breaker off after every restart and could send traffic back to a target the
			// panel has already marked unhealthy.
			if _, ok := egress.Targets(cfg.ID); !ok {
				strategy, ok := manager.ParseStrategy(string(cfg.LBStrategy))
				if !ok {
					strategy = manager.RoundRobin
				}
				if len(cfg.TargetHealth) > 0 {
					egress.SetPoolAndHealth(cfg.ID, strategy, cfg.Targets, cfg.TargetHealth)
				} else {
					egress.SetPool(cfg.ID, strategy, cfg.Targets)
				}
			}
		}
		if _, err := tunnels.Apply(cfg); err != nil {
			failed = append(failed, cfg.ID)
			continue
		}
	}
	return failed, nil
}

// Restore fetches a snapshot from src and applies it, returning the failed ids.
// A reachable-but-failing panel returns the error so the caller can distinguish
// "panel said nothing" (nil error, empty failed slice) from "panel unreachable".
func Restore(ctx context.Context, tunnels *manager.TunnelManager, egress *manager.EgressManager, src Source) ([]string, error) {
	if src == nil {
		return nil, ErrNoPanel
	}
	snap, err := src.FetchSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	return Apply(ctx, tunnels, egress, snap)
}

// FetchTimeout bounds the restore call so a hung panel cannot block startup
// indefinitely. It is generous: this runs once, before the admin plane opens.
const FetchTimeout = 15 * time.Second

// Context returns the ctx used for the one-shot restore call.
func Context() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), FetchTimeout)
}

// String renders a restore report for the log line.
func String(restored, failed []string) string {
	return fmt.Sprintf("restored=%d failed=%v", len(restored), failed)
}
