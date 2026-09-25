// Package control implements the v3 outbound-only control transport.
package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/logx"
	"github.com/tunex/agent/internal/manager"
)

const (
	commandsPath = "/api/internal/node/commands"
	ackPath = "/api/internal/node/ack"
	pollInterval = time.Second
	httpTimeout = 12 * time.Second
)

type Config struct {
	PanelURL string
	Credential string
}

type Envelope struct {
	CommandID string `json:"command_id"`
	ResourceID string `json:"resource_id"`
	Revision int64 `json:"revision"`
	Action string `json:"action"`
	ExpiresAt string `json:"expires_at"`
}

type QueuedCommand struct {
	Envelope Envelope `json:"envelope"`
	Config *forwarder.TunnelConfig `json:"config"`
}

type commandResponse struct {
	Data struct {
		Command *QueuedCommand `json:"command"`
	} `json:"data"`
}

type ackPayload struct {
	CommandID string `json:"command_id"`
	OK bool `json:"ok"`
	AppliedRevision *int64 `json:"applied_revision,omitempty"`
	ErrorCode string `json:"error_code,omitempty"`
	Error string `json:"error,omitempty"`
}

type Client struct {
	cfg Config
	tunnels *manager.TunnelManager
	egress *manager.EgressManager
	http *http.Client
}

func New(cfg Config, tunnels *manager.TunnelManager, egress *manager.EgressManager) *Client {
	return &Client{cfg: cfg, tunnels: tunnels, egress: egress, http: &http.Client{Timeout: httpTimeout}}
}

func (c *Client) enabled() bool {
	return strings.TrimSpace(c.cfg.PanelURL) != "" && strings.TrimSpace(c.cfg.Credential) != ""
}

func (c *Client) Run(ctx context.Context) error {
	if !c.enabled() {
		return errors.New("control: panel URL and node credential are required")
	}
	for {
		if err := ctx.Err(); err != nil { return err }
		cmd, err := c.pull(ctx)
		if err != nil {
			logx.Debug("control pull failed", "err", err.Error())
		} else if cmd != nil {
			ack := c.execute(cmd)
			if err := c.ack(ctx, ack); err != nil {
				logx.Warn("control ack failed", "command_id", ack.CommandID, "err", err.Error())
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollInterval):
		}
	}
}

func (c *Client) pull(ctx context.Context) (*QueuedCommand, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.cfg.PanelURL, "/")+commandsPath, nil)
	if err != nil { return nil, err }
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.cfg.Credential))
	resp, err := c.http.Do(req)
	if err != nil { return nil, err }
	defer resp.Body.Close()
	if resp.StatusCode >= 300 { return nil, fmt.Errorf("control pull status %d", resp.StatusCode) }
	var body commandResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil { return nil, err }
	return body.Data.Command, nil
}

func (c *Client) execute(cmd *QueuedCommand) ackPayload {
	ack := ackPayload{CommandID: cmd.Envelope.CommandID}
	if strings.TrimSpace(ack.CommandID) == "" {
		ack.ErrorCode, ack.Error = "invalid_command", "missing command_id"
		return ack
	}
	if cmd.Envelope.ExpiresAt != "" {
		if exp, err := time.Parse(time.RFC3339Nano, cmd.Envelope.ExpiresAt); err == nil && time.Now().After(exp) {
			ack.ErrorCode, ack.Error = "command_expired", "command expired"
			return ack
		}
	}
	switch cmd.Envelope.Action {
	case "apply_tunnel":
		if cmd.Config == nil {
			ack.ErrorCode, ack.Error = "invalid_payload", "missing tunnel config"
			return ack
		}
		cfg := cmd.Config.Clone()
		if cfg.Revision == 0 { cfg.Revision = cmd.Envelope.Revision }

		// EGRESS forwarders depend on a target selector at construction time.
		// Online commands must therefore install/update the target pool before
		// TunnelManager.Apply, exactly like startup restore does. Otherwise the
		// manager cannot build the EGRESS forwarder and returns ErrPoolNotFound.
		rollbackPool, err := c.prepareEgressPool(cfg)
		if err != nil {
			ack.ErrorCode, ack.Error = "invalid_payload", err.Error()
			return ack
		}
		// A command that moves the listener (new port / mode change) must not
		// tear the old one down before the new listener is bound: that is the
		// §13.3.5 PREPARE→CUTOVER ordering, and dropping live connections
		// during a port move would be exactly the "silent outage" the hot
		// reload contract exists to prevent. An upstream-only change rides on
		// Apply's same-port path (stop old, then start new is acceptable
		// there because the listener did not move).
		_, err = c.applyByPlan(cfg)
		if err != nil {
			rollbackPool()
			if errors.Is(err, manager.ErrStaleRevision) { ack.ErrorCode = "stale_revision" } else { ack.ErrorCode = "apply_failed" }
			ack.Error = err.Error()
			return ack
		}
		ack.OK = true
		rev := cfg.Revision
		ack.AppliedRevision = &rev
	case "remove_tunnel", "suspend_tunnel":
		if err := c.tunnels.Remove(cmd.Envelope.ResourceID); err != nil {
			ack.ErrorCode, ack.Error = "remove_failed", err.Error()
			return ack
		}
		// Harmless for DIRECT/RELAY ids, required for EGRESS ids. Keeping the
		// pool after the listener is gone would make state reports claim a
		// runtime resource that no longer exists.
		if c.egress != nil {
			c.egress.DropPool(cmd.Envelope.ResourceID)
		}
		ack.OK = true
		rev := cmd.Envelope.Revision
		ack.AppliedRevision = &rev
	default:
		ack.ErrorCode = "unsupported_action"
		ack.Error = "unsupported action: " + cmd.Envelope.Action
	}
	return ack
}

// applyByPlan routes one apply_tunnel command through the hot-reload
// primitive that matches its plan, so the panel's edit semantics
// (DEVELOPMENT.md §13.3.4) are honoured by the command path and not only by
// the local admin API:
//
//   - a listener move (port / mode) goes through ReplaceListener, which
//     binds the new listener BEFORE draining the old one;
//   - an upstream-only change rides on Apply's existing same-port path;
//   - EGRESS and everything else keep the previous behaviour verbatim.
//
// The plan is advisory about HOW to apply, never about WHETHER: the revision
// gate and every port conflict stay inside the manager, so a bad plan cannot
// make a command succeed or fail differently than the manager decides.
func (c *Client) applyByPlan(cfg forwarder.TunnelConfig) (forwarder.Forwarder, error) {
	if cur, ok := c.tunnels.Get(cfg.ID); ok {
		if manager.PlanForwardSwap(cur, cfg).Strategy == manager.SwapListener {
			return c.tunnels.ReplaceListener(cfg)
		}
	}
	return c.tunnels.Apply(cfg)
}

// prepareEgressPool stages the desired target pool before an EGRESS listener
// is built. It returns a rollback closure so a failed listener apply does not
// leave the pool half-applied.
//
// Existing pools are updated in place: live EGRESS forwarders hold a pointer to
// the Pool, so replacing the map entry would break hot-update semantics.
func (c *Client) prepareEgressPool(cfg forwarder.TunnelConfig) (func(), error) {
	if cfg.Mode != forwarder.ModeEgress {
		return func() {}, nil
	}
	if c.egress == nil {
		return func() {}, errors.New("control: egress manager is required for EGRESS tunnel")
	}
	strategy, ok := manager.ParseStrategy(string(cfg.LBStrategy))
	if !ok {
		return func() {}, fmt.Errorf("control: invalid egress lb strategy %q", cfg.LBStrategy)
	}

	oldTargets, existed := c.egress.Targets(cfg.ID)
	oldStrategy := manager.RoundRobin
	if existed {
		if snap, ok := c.egress.Snapshot()[cfg.ID]; ok {
			if parsed, ok := manager.ParseStrategy(snap.Strategy); ok {
				oldStrategy = parsed
			}
		}
		if err := c.egress.UpdateTargets(cfg.ID, strategy, cfg.Targets); err != nil {
			return func() {}, err
		}
		return func() {
			if len(oldTargets) > 0 {
				_ = c.egress.UpdateTargets(cfg.ID, oldStrategy, oldTargets)
			}
		}, nil
	}

	c.egress.SetPool(cfg.ID, strategy, cfg.Targets)
	return func() { c.egress.DropPool(cfg.ID) }, nil
}

func (c *Client) ack(ctx context.Context, ack ackPayload) error {
	body, err := json.Marshal(ack)
	if err != nil { return err }
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.cfg.PanelURL, "/")+ackPath, bytes.NewReader(body))
	if err != nil { return err }
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.cfg.Credential))
	resp, err := c.http.Do(req)
	if err != nil { return err }
	defer resp.Body.Close()
	if resp.StatusCode >= 300 { return fmt.Errorf("control ack status %d", resp.StatusCode) }
	return nil
}
