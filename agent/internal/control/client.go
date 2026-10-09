// Package control implements the Agent's outbound-only command transport.
// Optional observer interfaces record seen revisions and runtime failures without
// coupling command execution to the reporter package.
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

	"github.com/tunex/agent/internal/diag"
	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/linkrunner"
	"github.com/tunex/agent/internal/logx"
	"github.com/tunex/agent/internal/manager"
	"github.com/tunex/agent/internal/ownership"
	"github.com/tunex/agent/internal/panelroute"
	"github.com/tunex/agent/internal/selfinfo"
)

const (
	commandsPath = "/api/internal/node/commands"
	ackPath      = "/api/internal/node/ack"
	pollInterval = time.Second
	httpTimeout  = 12 * time.Second
)

// ErrorRecorder records an apply/runtime failure. reporter.Ledger satisfies it.
type ErrorRecorder interface {
	Record(message string)
}

// RevisionObserver records a revision the agent has *seen* (not applied), so
// the panel can separate "pushing but this node cannot apply" from "up to
// date". reporter.RevisionState satisfies it.
type RevisionObserver interface {
	Observe(revision int64)
}

type Config struct {
	PanelURL   string
	Credential string
	// Links is wired only when the runtime feature flag, executable and private
	// cache are available. Numeric node identity comes from desired metadata.
	Links        *linkrunner.Manager
	RuntimeFacts RuntimeFacts
	// ReportLinkState (historical name) publishes the complete authenticated
	// runtime state after successful Link/native mutations and before their ACK.
	// Failure leaves the successful runtime ACK
	// intact; the panel retains conservative port facts until a later report.
	ReportLinkState func(context.Context) error

	// Router, when set, is the process-wide panel-route switcher shared with the
	// state reporter (task-45). pull/ack ask it for the CURRENT active base URL
	// on every request — never a value captured at build time — so a fallback
	// switch becomes effective in this same process without a restart.
	//
	// Every pull's outcome is fed back into it, so this loop's own reachability
	// observations drive the same single decision the reporter drives. Threshold,
	// deadline, success-resets and no-auto-switch-back are unchanged; the shared
	// counter just means "consecutive failures to the panel", whichever control
	// surface observed them. ACK is deliberately NOT fed: it follows a successful
	// pull, and the next pull is the honest verdict on that address.
	//
	// nil = pinned to PanelURL (standalone use / tests without a configured
	// fallback), which is exactly the pre-task-45 behaviour.
	Router *panelroute.Router

	// Optional telemetry sinks; nil disables recording.
	Errors    ErrorRecorder
	Revisions RevisionObserver

	// DescribeSelf, when set, answers a collect_diagnostics command with the
	// process's own bounded facts. It is injected by the runtime (which owns the
	// tunnel manager and the LKG path) so this package needs no knowledge of them.
	DescribeSelf func() selfinfo.Facts

	// Reconnected is called once on every transition from "panel unreachable"
	// to "panel reachable". The Agent uses it to reconcile its
	// runtime against a freshly fetched authoritative desired state: a node that
	// restored from its local cache during an outage must drop listeners the
	// panel no longer knows about, because nothing else on this side ever would.
	Reconnected func(ctx context.Context)
}

type Envelope struct {
	CommandID  string `json:"command_id"`
	ResourceID string `json:"resource_id"`
	Revision   int64  `json:"revision"`
	Action     string `json:"action"`
	ExpiresAt  string `json:"expires_at"`
}

type QueuedCommand struct {
	Envelope Envelope                `json:"envelope"`
	Config   *forwarder.TunnelConfig `json:"config"`
	Link     *linkrunner.Config      `json:"link,omitempty"`
	// Probe carries a diagnose request. It is a separate field rather than a
	// synthetic TunnelConfig: a probe is not a tunnel, and pretending otherwise
	// would let a malformed probe look like a config apply.
	Probe *diag.Request `json:"probe,omitempty"`
	// LookingGlass carries a user-originated, panel-resolved diagnostic request,
	// and pinned to **public literal addresses only**.
	//
	// A third sibling field for the same reason as `Probe`, plus one more that is
	// specific to this action: it is the only place where a target the caller
	// typed reaches the agent, so it must not be confused with either
	// (config = panel-owned desired state, probe = panel-derived tunnel targets).
	// The agent-side validation in internal/diag/lookingglass.go re-checks every
	// address: whoever holds the panel's node credential cannot turn this into a
	// scan primitive even if the panel never validated.
	LookingGlass *diag.LookingGlassRequest `json:"looking_glass,omitempty"`
}

type commandResponse struct {
	Data struct {
		Command *QueuedCommand `json:"command"`
	} `json:"data"`
}

type ackPayload struct {
	CommandID string `json:"command_id"`
	// Action and ResourceID echo the envelope this ACK answers. The panel uses
	// them to check that a reply really belongs to the command it issued, rather
	// than trusting the command_id alone.
	Action          string `json:"action,omitempty"`
	ResourceID      string `json:"resource_id,omitempty"`
	OK              bool   `json:"ok"`
	AppliedRevision *int64 `json:"applied_revision,omitempty"`
	ErrorCode       string `json:"error_code,omitempty"`
	Error           string `json:"error,omitempty"`
	// Results carries a read-only action's structured findings (diagnose). It is
	// omitted for actions that only apply or remove a runtime.
	Results []diag.Result `json:"results,omitempty"`
	// Facts carries the node-level self report (collect_diagnostics).
	Facts *selfinfo.Facts `json:"facts,omitempty"`
	// HopLocalAddr answers "where does this node's datagram hop come from" for a
	// RELAY leg: `ip:port` of the socket this node carries client
	// mappings through.
	//
	// It rides on the ACK because the panel needs it SYNCHRONOUSLY: the exit leg is
	// dispatched BEFORE the ingress exists (§3.2's ordering rule), so its attestation
	// address cannot be known until this very moment. Waiting for the periodic state
	// report would leave every new datagram relay dead for up to a reporting cycle,
	// and the panel would have no way to tell "not serving yet" from "serving".
	// `next_hop` travels the other way on the egress ACK for exactly the same reason.
	HopLocalAddr    string                  `json:"hop_local_addr,omitempty"`
	LinkObservation *linkrunner.Observation `json:"link_observation,omitempty"`
}

type Client struct {
	cfg     Config
	tunnels *manager.TunnelManager
	egress  *manager.EgressManager
	http    *http.Client
	// reachable/sawFailure track the outage→reachable transition that triggers
	// cfg.Reconnected exactly once per recovery.
	reachable  bool
	sawFailure bool
	// startupFromCache records that this process restored its runtime from the
	// local cache because the panel was unreachable at boot. Such a node must
	// reconcile as soon as the panel can answer, even though this process never
	// observed a *failed* pull: otherwise an agent restarted during an outage
	// keeps serving a Forward the panel has since deleted, indefinitely.
	startupFromCache bool
}

// MarkStartupFromCache tells the loop that the startup restore came from the
// local last-known-good cache. It must be called before Run.
func (c *Client) MarkStartupFromCache() {
	c.startupFromCache = true
}

func New(cfg Config, tunnels *manager.TunnelManager, egress *manager.EgressManager) *Client {
	if cfg.DescribeSelf == nil {
		// Loud on purpose: this binary ADVERTISES collect_diagnostics in its
		// capability list, so a caller that forgets to wire the describer would
		// answer `unsupported_action` to a command it told the panel it supports.
		logx.Warn("control: self-description is not wired; collect_diagnostics will be refused")
	}
	return &Client{cfg: cfg, tunnels: tunnels, egress: egress, http: &http.Client{Timeout: httpTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (c *Client) enabled() bool {
	return c.baseURL() != "" && strings.TrimSpace(c.cfg.Credential) != ""
}

// baseURL resolves the panel base address for the next request.
//
// The switcher is consulted PER REQUEST rather than captured once, which is what
// makes a fallback switch take effect on the very next pull/ACK in this process.
// A nil/empty router falls back to the configured PanelURL, so an agent without
// the migration fallback (or a standalone client) keeps the old behaviour
// byte-for-byte.
func (c *Client) baseURL() string {
	if c.cfg.Router != nil {
		if active := c.cfg.Router.ActiveURL(); active != "" {
			return active
		}
	}
	return strings.TrimRight(strings.TrimSpace(c.cfg.PanelURL), "/")
}

// notePanelAttempt feeds one pull's outcome to the shared switcher (no-op without
// one). See Config.Router for why the pull is the control loop's reachability
// signal and the ACK is not.
func (c *Client) notePanelAttempt(err error) {
	if c.cfg.Router == nil {
		return
	}
	if err != nil {
		c.cfg.Router.NoteOutcome(panelroute.PanelOutcomeFailure, time.Now())
		return
	}
	c.cfg.Router.NoteOutcome(panelroute.PanelOutcomeSuccess, time.Now())
}

func (c *Client) Run(ctx context.Context) error {
	if !c.enabled() {
		return errors.New("control: panel URL and node credential are required")
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		cmd, err := c.pull(ctx)
		c.notePanelAttempt(err)
		if err != nil {
			logx.Debug("control pull failed", "err", err.Error())
			c.reachable = false
			c.sawFailure = true
		} else {
			// The panel is authoritative again. Two situations need a reconcile:
			//   · this process watched the panel go away and come back;
			//   · this process booted during an outage and restored from cache, so
			//     its runtime may describe work the panel has already dropped.
			if c.reachable == false && (c.sawFailure || c.startupFromCache) {
				c.notifyReconnected(ctx)
				c.startupFromCache = false
				c.sawFailure = false
			}
			c.reachable = true
			if cmd != nil && expired(cmd.Envelope.ExpiresAt) {
				// The panel's deadline is the panel's promise. Executing a command
				// it has already stopped waiting for only produces a result nobody
				// will read — and for a probe, time spent doing it.
				logx.Warn("control command expired before execute", "command_id", cmd.Envelope.CommandID)
			} else if cmd != nil {
				// Observe before execute: the revision is "known" the moment the
				// envelope arrives, even if the apply is about to fail.
				if c.cfg.Revisions != nil {
					c.cfg.Revisions.Observe(cmd.Envelope.Revision)
				}
				ack := c.execute(ctx, cmd)
				if !ack.OK && ack.Error != "" {
					// The panel learns this from the ACK too, but the report needs
					// it as a *fact* so health synthesis can see a node that is
					// still erroring after the command was already consumed.
					c.recordError(ack.ErrorCode, cmd.Envelope.ResourceID, ack.Error)
				}
				if err := c.ack(ctx, ack); err != nil {
					logx.Warn("control ack failed", "command_id", ack.CommandID, "err", err.Error())
				}
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollInterval):
		}
	}
}

// notifyReconnected runs the reconnect hook without letting it break the poll
// loop: a reconcile failure must not stop command processing.
func (c *Client) notifyReconnected(ctx context.Context) {
	if c.cfg.Reconnected == nil {
		return
	}
	func() {
		defer func() {
			if r := recover(); r != nil {
				logx.Warn("reconnect reconcile panicked", "err", fmt.Sprint(r))
			}
		}()
		c.cfg.Reconnected(ctx)
	}()
}

// recordError files one failure in the shared ledger. The message is prefixed
// with the structured error code and resource id so an operator reading the
// node's `last_error` on the panel can tell a stale-revision rejection from a
// dial failure without opening agent logs. It is truncated to the panel's
// VarChar(500) so a long dial error cannot make the report be rejected.
func (c *Client) recordError(code, resourceID, message string) {
	if c.cfg.Errors == nil {
		return
	}
	prefix := "apply"
	if strings.TrimSpace(code) != "" {
		prefix += ":" + strings.TrimSpace(code)
	}
	if strings.TrimSpace(resourceID) != "" {
		prefix += " " + strings.TrimSpace(resourceID)
	}
	text := prefix + ": " + message
	if len(text) > maxReportedErrorBytes {
		text = text[:maxReportedErrorBytes]
	}
	c.cfg.Errors.Record(text)
}

// maxReportedErrorBytes mirrors node_state_report.last_error VarChar(500). The
// panel would truncate anyway; doing it here keeps the *reported* fact equal to
// the stored one.
const maxReportedErrorBytes = 500

func (c *Client) pull(ctx context.Context) (*QueuedCommand, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL()+commandsPath, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.cfg.Credential))
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("control pull status %d", resp.StatusCode)
	}
	var body commandResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body.Data.Command, nil
}

// expired reports whether an envelope's expires_at is already in the past.
// An unparseable/absent value is treated as "not expired": the panel always
// sends one, and refusing every command on a formatting quirk would be worse
// than executing a slightly late one.
func expired(expiresAt string) bool {
	trimmed := strings.TrimSpace(expiresAt)
	if trimmed == "" {
		return false
	}
	deadline, err := time.Parse(time.RFC3339, trimmed)
	if err != nil {
		return false
	}
	return time.Now().After(deadline)
}

func (c *Client) execute(ctx context.Context, cmd *QueuedCommand) ackPayload {
	ack := ackPayload{
		CommandID:  cmd.Envelope.CommandID,
		Action:     cmd.Envelope.Action,
		ResourceID: cmd.Envelope.ResourceID,
	}
	if strings.TrimSpace(ack.CommandID) == "" {
		ack.ErrorCode, ack.Error = "invalid_command", "missing command_id"
		return ack
	}
	// An expiry that cannot be parsed is a malformed command, not "no expiry":
	// treating it as absent would let a stale envelope be applied whenever the
	// panel's clock/format disagrees with the agent's.
	if raw := strings.TrimSpace(cmd.Envelope.ExpiresAt); raw != "" {
		exp, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			ack.ErrorCode, ack.Error = "invalid_command", "unparseable expires_at"
			return ack
		}
		if time.Now().After(exp) {
			ack.ErrorCode, ack.Error = "command_expired", "command expired"
			return ack
		}
	}
	// The envelope's resource and revision are the panel's statement about WHAT
	// this command is for. A payload that disagrees with them must be rejected
	// instead of applied: otherwise a single wrong field could install a config
	// for a different tunnel, or one the panel believes is a different revision.
	resourceID := strings.TrimSpace(cmd.Envelope.ResourceID)
	if resourceID == "" {
		ack.ErrorCode, ack.Error = "invalid_command", "missing resource_id"
		return ack
	}
	switch cmd.Envelope.Action {
	case ActionApplyLink, ActionRemoveLink:
		if c.cfg.Links == nil || !c.cfg.RuntimeFacts.FXPLink {
			ack.ErrorCode, ack.Error = "unsupported_action", "managed FXP link is disabled"
			return ack
		}
		if cmd.Config != nil || cmd.Probe != nil || cmd.LookingGlass != nil {
			ack.ErrorCode, ack.Error = "invalid_payload", "expected sibling link"
			return ack
		}
		if cmd.Envelope.Action == ActionRemoveLink {
			if cmd.Link != nil || cmd.Envelope.Revision <= 0 {
				ack.ErrorCode, ack.Error = "invalid_payload", "remove_link requires a positive envelope revision and no config"
				return ack
			}
			nodeDBID := c.cfg.Links.NodeDBID()
			if nodeDBID == 0 {
				ack.ErrorCode, ack.Error = "node_mismatch", "authenticated snapshot identity is unavailable"
				return ack
			}
			for _, o := range c.cfg.Links.Status() {
				if o.ID == resourceID && o.NodeID != 0 && (o.NodeID != nodeDBID || o.WorkspaceID <= 0) {
					ack.ErrorCode, ack.Error = "identity_mismatch", "cached link placement identity mismatch"
					return ack
				}
			}
			o, err := c.cfg.Links.Remove(resourceID, cmd.Envelope.Revision)
			ack.LinkObservation = &o
			if err != nil {
				ack.ErrorCode, ack.Error = linkAckCode(err), err.Error()
				return ack
			}
			ack.OK = true
			rev := cmd.Envelope.Revision
			ack.AppliedRevision = &rev
			c.reportLinkState(ctx)
			return ack
		}
		if cmd.Link == nil {
			ack.ErrorCode, ack.Error = "invalid_payload", "missing sibling link"
			return ack
		}
		cfg := cmd.Link
		if cfg.ID != resourceID {
			ack.ErrorCode, ack.Error = "resource_mismatch", "link id does not match resource_id"
			return ack
		}
		if cfg.Generation <= 0 || cmd.Envelope.Revision != cfg.Generation {
			ack.ErrorCode, ack.Error = "revision_mismatch", "link generation does not match revision"
			return ack
		}
		if c.cfg.Links.NodeDBID() == 0 || cfg.NodeID != c.cfg.Links.NodeDBID() {
			ack.ErrorCode, ack.Error = "node_mismatch", "link node does not match authenticated snapshot identity"
			return ack
		}
		observed, err := c.cfg.Links.Apply(*cfg)
		ack.LinkObservation = &observed
		if err != nil {
			ack.ErrorCode, ack.Error = linkAckCode(err), err.Error()
			return ack
		}
		ack.OK = true
		rev := cfg.Generation
		ack.AppliedRevision = &rev
		c.reportLinkState(ctx)
	case ActionApplyTunnel:
		if cmd.Link != nil {
			ack.ErrorCode, ack.Error = "invalid_payload", "link is not a tunnel config"
			return ack
		}
		if cmd.Config == nil {
			ack.ErrorCode, ack.Error = "invalid_payload", "missing tunnel config"
			return ack
		}
		if strings.TrimSpace(cmd.Config.ID) != resourceID {
			ack.ErrorCode, ack.Error = "resource_mismatch", "config id does not match envelope resource_id"
			return ack
		}
		if cmd.Config.Revision != 0 && cmd.Envelope.Revision != 0 && cmd.Config.Revision != cmd.Envelope.Revision {
			ack.ErrorCode, ack.Error = "revision_mismatch", "config revision does not match envelope revision"
			return ack
		}
		cfg := cmd.Config.Clone()
		if cfg.Revision == 0 {
			cfg.Revision = cmd.Envelope.Revision
		}

		// The ownership gate runs before anything is staged. A refusal
		// must not leave a trace — staging an EGRESS pool first would briefly
		// apply a fenced activation's targets to a running pool before the
		// refusal landed. The manager gates again when it applies; this call is
		// what makes the refusal side-effect free.
		if err := c.tunnels.AdmitActivation(cfg); err != nil {
			ack.ErrorCode, ack.Error = ackCodeFor(err), err.Error()
			return ack
		}

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
		fwd, err := c.applyByPlan(cfg)
		if err != nil {
			rollbackPool()
			ack.ErrorCode = ackCodeFor(err)
			ack.Error = err.Error()
			return ack
		}
		ack.OK = true
		rev := cfg.Revision
		ack.AppliedRevision = &rev
		// A datagram RELAY publishes where its hop comes from, so the panel can tell the
		// exit who may feed it (see HopLocalAddr). Read from the runtime it just built:
		// the socket exists now, and this is the only moment the fact is fresh.
		if d, ok := fwd.(forwarder.Diagnostician); ok {
			if diag, ok := d.ProtocolDiagnostics(); ok && diag.HopLocalAddr != "" {
				ack.HopLocalAddr = diag.HopLocalAddr
			}
		}
		// A following rollout needs the actual routed UDP hop address NOW,
		// not connect_ip or a report from before this native apply. Reuse the
		// serialized full-state publisher already used by Link mutations.
		c.reportLinkState(ctx)
	case ActionDiagnoseTunnel:
		if cmd.Probe == nil {
			ack.ErrorCode, ack.Error = "invalid_payload", "missing probe request"
			return ack
		}
		// A probe runs under the caller's context (the control loop's), so a
		// shutdown cancels it instead of leaving it to finish after the node is
		// asked to stop. The per-probe budget inside diag keeps it bounded anyway.
		results, err := diag.Probe(ctx, *cmd.Probe, nil)
		if err != nil {
			ack.ErrorCode, ack.Error = "invalid_payload", err.Error()
			return ack
		}
		// A probe is read-only: it must not move the runtime revision, which is
		// why the ACK echoes the revision it was given rather than a new one.
		ack.OK = true
		ack.Results = results
		rev := cmd.Envelope.Revision
		ack.AppliedRevision = &rev
	case ActionCollectDiagnostics:
		if c.cfg.DescribeSelf == nil {
			ack.ErrorCode, ack.Error = "unsupported_action", "this agent build cannot describe itself"
			return ack
		}
		facts := c.cfg.DescribeSelf()
		ack.OK = true
		ack.Facts = &facts
		// Read-only: the runtime revision does not move, so the ACK echoes the
		// revision it was given.
		rev := cmd.Envelope.Revision
		ack.AppliedRevision = &rev
	case ActionLookingGlass:
		if cmd.LookingGlass == nil {
			ack.ErrorCode, ack.Error = "invalid_payload", "missing looking glass request"
			return ack
		}
		// diag.LookingGlass validates EVERY target before it dials anything, and it
		// never resolves a name: a request mixing a public and a private target
		// produces zero packets and one error. Read-only, so the ACK echoes the
		// revision it was given.
		results, err := diag.LookingGlass(ctx, *cmd.LookingGlass, nil)
		if err != nil {
			ack.ErrorCode, ack.Error = "invalid_payload", err.Error()
			return ack
		}
		ack.OK = true
		ack.Results = results
		rev := cmd.Envelope.Revision
		ack.AppliedRevision = &rev
	case ActionRemoveTunnel, ActionSuspendTunnel:
		// Native teardown is asynchronous for local callers. A control ACK must
		// wait for actual Stop before the panel releases its durable leases.
		stopCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if err := c.tunnels.RemoveAtRevisionAndWait(stopCtx, cmd.Envelope.ResourceID, cmd.Envelope.Revision); err != nil {
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
		c.reportLinkState(ctx)
	default:
		ack.ErrorCode = "unsupported_action"
		ack.Error = "unsupported action: " + cmd.Envelope.Action
	}
	return ack
}

func (c *Client) reportLinkState(ctx context.Context) {
	if c.cfg.ReportLinkState != nil {
		if err := c.cfg.ReportLinkState(ctx); err != nil {
			// The state reporter already observes reachability. Do not put raw
			// transport errors into the command ACK or turn an applied change
			// into a runtime failure because its telemetry channel is unavailable.
			logx.Debug("runtime state report failed; awaiting periodic report")
		}
	}
}

// ackCodeFor maps an apply failure onto the ACK's error_code.
//
// The code is the panel's vocabulary for WHAT happened, so a refusal keeps its
// own name instead of collapsing into "apply_failed": an operator (and the
// reconciler) must be able to tell "this node was demoted" from "the port was
// taken", and a fence whose refusals look like generic failures is a fence
// nobody can audit.
func ackCodeFor(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, manager.ErrStaleRevision) {
		return "stale_revision"
	}
	if code, ok := ownership.RefusalCode(err); ok {
		return code
	}
	return "apply_failed"
}

// applyByPlan routes one apply_tunnel command through the same hot-reload
// primitive used by the runtime manager:
//
//   - a listener move (port / mode) binds the new listener BEFORE draining
//     the old one;
//   - an upstream-only change on a running listener is swapped in place, so
//     the live connections keep relaying and the byte counter survives;
//   - EGRESS and other changes use the manager's normal replacement path.
//
// ReplaceListener is that router: the plan is evaluated inside the manager,
// against the running config, under the manager's lock — the same evaluation
// the admin API gets. Recomputing it here instead would freeze a classification
// that the manager has already contradicted by the time the locked section
// runs.
//
// The plan is advisory about HOW to apply, never about WHETHER: the revision
// activation gate and every port conflict stay inside the manager, so a bad plan cannot
// make a command succeed or fail differently than the manager decides.
//
// The returned handle is the transport-agnostic runtime (forwarder.Runtime): a
// udp tunnel's runtime is not a StreamRuntime, and this router must not claim it
// is. No caller reads the value today — the ACK is built from the error — so the
// narrower type costs nothing and keeps the lie out of the signature.
func (c *Client) applyByPlan(cfg forwarder.TunnelConfig) (forwarder.Runtime, error) {
	return c.tunnels.ReplaceListener(cfg)
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
		// Desired targets and panel health facts are applied together so the health-aware
		// mechanism never runs against a pool it was not computed for.
		if err := c.egress.UpdateTargetsAndHealth(cfg.ID, strategy, cfg.Targets, cfg.TargetHealth); err != nil {
			return func() {}, err
		}
		return func() {
			if len(oldTargets) > 0 {
				// The rollback restores what this agent can still know: the
				// Roll back the desired targets and strategy. Health is a live fact,
				// so rollback intentionally clears it instead of restoring stale evidence.
				_ = c.egress.UpdateTargets(cfg.ID, oldStrategy, oldTargets)
			}
		}, nil
	}

	c.egress.SetPoolAndHealth(cfg.ID, strategy, cfg.Targets, cfg.TargetHealth)
	return func() { c.egress.DropPool(cfg.ID) }, nil
}

func (c *Client) ack(ctx context.Context, ack ackPayload) error {
	body, err := json.Marshal(ack)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL()+ackPath, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.cfg.Credential))
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("control ack status %d", resp.StatusCode)
	}
	return nil
}
