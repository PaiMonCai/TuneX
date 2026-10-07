// Package reporter implements the Agent's outbound state report. The Agent reports
// raw runtime facts; the Panel derives health and product status from them.
// Reporting never requires Panel-to-Agent connectivity.
//
// There is exactly ONE outbound report channel: the authenticated POST to
// StatePath. An earlier build also sent an unauthenticated "heartbeat" to
// /api/internal/heartbeat, but the Panel never implemented that route (it does not
// exist, and never existed, in `backend/src/routes/internal-node.ts`): every beat
// answered 404 and the response was discarded. It is deleted rather than
// reimplemented — an unauthenticated liveness POST would be a second definition of
// "alive", and liveness is derived from this authenticated report alone.
//
// The post function is injected so unit tests never touch the network.
package reporter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/linkrunner"
	"github.com/tunex/agent/internal/logx"
	"github.com/tunex/agent/internal/panelroute"
	"github.com/tunex/agent/internal/targetobs"
)

// Interval is the state-report cadence.
const Interval = 30 * time.Second

// ClientTimeout bounds a single state-report POST: a hung panel endpoint must not
// pile up goroutines or delay the next report by more than one interval.
const ClientTimeout = 10 * time.Second

// StatePath is the authenticated node-state endpoint — the Agent's ONE channel to
// the Panel. Telemetry, ownership-lease renewal and the closing report all ride
// this report instead of creating a second node-monitoring truth.
const StatePath = "/api/internal/node/state"

// CredentialHeader carries the per-node credential (services/node-credential.ts).
// Bearer, because the same agent also speaks to endpoints that document Bearer;
// the header value never appears in any log line (logx calls never touch it).
const CredentialHeader = "Authorization"

// ErrNoPanelURL is returned by Run when there is nothing to report to: the panel
// URL is unset, or the node carries no credential. The authenticated state report
// is the only channel, so without it a "running" reporter would send nothing at
// all. A node may legitimately run without reporting, so this is a startup
// decision, not a runtime failure.
var ErrNoPanelURL = errors.New("reporter: panel url or node credential is not configured")

// ErrAlreadyRunning is returned by Run when a previous Run is still active.
var ErrAlreadyRunning = errors.New("reporter: already running")

// StatePayload is the state-report body — the Panel uses it to derive current
// node/runtime facts without dialing the Agent. Shape is owned by
// services/node-state.ts. Field names match the panel's Node model so the backend
// can deserialise them directly.
type StatePayload struct {
	AgentID     string                `json:"agent_id,omitempty"`
	Version     string                `json:"version,omitempty"`
	Role        string                `json:"role,omitempty"`
	Tunnels     []ReportedTunnel      `json:"tunnels,omitempty"`
	EgressPools map[string]EgressPool `json:"egress_pools,omitempty"`
	UsedPorts   []int                 `json:"used_ports,omitempty"`
	// Revision is the newest config revision the agent has applied (0 = none).
	Revision int64  `json:"reported_revision,omitempty"`
	LastErr  string `json:"last_error,omitempty"`

	// ── 面板迁移回退（task-44）──────────────────────────────────────────────
	//
	// **每一次**上报都要带"我现在在跟谁说"这三件事，否则面板会以为节点还在主地址上
	// （那正是本任务明令禁止的状态）。三个键都是**加法**字段：老面板忽略未知键
	// （validateStateReport 对未知键宽容），老 agent 直接不发。
	//
	// FallbackActive 没有 omitempty：它必须是显式的 false，而不是"没这个键"——
	// "不在回退态"和"这个 agent 根本不知道回退这件事"要能分辨。
	PanelURLInUse       string `json:"panel_url_in_use,omitempty"`
	PanelMigrationID    string `json:"panel_migration_id,omitempty"`
	PanelFallbackActive bool   `json:"panel_fallback_active"`

	// Telemetry facts are additive and optional.
	//
	// All of it is optional and additive: an older panel ignores the unknown
	// keys (validateStateReport tolerates unknown fields), and an older agent
	// simply omits them — which is why the panel's health synthesis must
	// treat "field absent" as "unknown", never as a zero/threshold breach.

	/// Newest config revision this agent has *seen* in an envelope. Compared
	/// with Revision (applied) it separates "panel is pushing but this node
	/// cannot apply" from "node is up to date".
	KnownRevision int64 `json:"known_revision,omitempty"`
	/// Agent process start time, unix seconds (0 = unknown).
	StartedAt int64 `json:"started_at,omitempty"`
	/// Agent uptime in seconds, derived from StartedAt by the payload
	/// builder (the panel must not trust an agent clock for arithmetic).
	Uptime int64 `json:"uptime_seconds,omitempty"`
	/// Host facts that only change on reinstall.
	Hostname string `json:"hostname,omitempty"`
	OS       string `json:"os,omitempty"`
	Arch     string `json:"arch,omitempty"`
	/// DIRECT / RELAY-ingress / RELAY-egress runtime counts.
	Runtimes *RuntimeCounts `json:"runtime_counts,omitempty"`
	/// One lightweight resource sample. Absent when the host exposes none
	/// (non-linux build, or every sampler failed).
	Host *HostSample `json:"host,omitempty"`
	/// Apply/runtime error ledger summary. Always present once the agent has
	/// a ledger so the panel can distinguish "0 errors" from "no ledger".
	ErrorCount int64 `json:"error_count,omitempty"`
	/// Newest failure time, unix seconds (0 = never).
	LastErrorAt int64 `json:"last_error_at,omitempty"`

	// ── control-protocol negotiation ────────────────────────────────────
	//
	// Both are omitted when unset: the panel must be able to tell "this agent
	// implements X" from "this agent never told me", and a zero-value int would
	// erase that distinction (see backend services/agent-capability.ts).
	/// Control-contract version this agent implements (0 = not configured).
	ControlProtocolVersion int `json:"control_protocol_version,omitempty"`
	/// Actions this agent actually implements (empty = not configured).
	Capabilities []string `json:"capabilities,omitempty"`
	// Protocol/transport/runtime facts, additive to Capabilities. The
	/// panel needs it to distinguish "this node can carry this protocol" from
	/// "this node never told me", without changing the array above.
	CapabilityManifest *CapabilityManifest `json:"capability_manifest,omitempty"`

	// ── target observation ───────────────────────────────────────────────
	//
	// The observation facts of the targets THIS node serves, one entry per
	// (node, target). They ride the existing state report as a new top-level
	// key: additive only, so an older panel ignores it and keeps working, and
	// an older agent simply omits it — which the panel must read as "unknown",
	// never as "everything is healthy" (§7 rows 4/8).
	//
	// `observation_age` is deliberately NOT here: age is `now -
	// last_observed_at` and is derived by the panel when it reads (row 7). A
	// stored age is already wrong by the time it is written.
	TargetObservations []targetobs.Observation `json:"target_observations,omitempty"`
	// Absent = unknown, including older builds; [] = a configured empty snapshot.
	LinkPlacements *[]LinkPlacement `json:"link_placements,omitempty"`
}

// CapabilityManifest is the v2 capability fact set on the wire.
//
// It deliberately mirrors control.Manifest structurally instead of importing
// it: the reporter must stay free of control-plane packages, and the wire shape
// is a frozen contract that the panel validates field by field anyway. The
// conversion lives in one place (control → reporter) at the wiring site.
type CapabilityManifest struct {
	SchemaVersion int      `json:"schema_version"`
	Protocols     []string `json:"protocols"`
	Transports    []string `json:"transports"`
	Runtime       []string `json:"runtime"`
	Diagnostics   []string `json:"diagnostics"`
}

// ReportedTunnel is one running tunnel as it travels on the state report: the
// configuration it was applied with, plus the protocol-specific diagnostics of
// the runtime that is actually serving it.
//
// The config is EMBEDDED, so the JSON is byte-for-byte what it was before this
// field existed — an older panel reads exactly the shape it always did, and the
// diagnostics are simply absent. That is the same additive rule every other
// later control-protocol changes followed.
type ReportedTunnel struct {
	forwarder.TunnelConfig
	// Diag is present only when the tunnel's protocol HAS protocol-specific
	// facts. A tcp tunnel carries none, which is different from carrying zeroes.
	Diag *forwarder.ProtocolDiagnostics `json:"diag,omitempty"`
}

// DiagnosticsLister reports per-tunnel protocol diagnostics by tunnel id.
//
// An interface rather than a concrete manager, like every other source the
// reporter reads: the reporter must not import the manager.
type DiagnosticsLister interface {
	DiagnosticsByTunnel() map[string]forwarder.ProtocolDiagnostics
}

// TargetObservationLister reports observation facts of the targets
// this node serves.
//
// It is an interface for the same decoupling reason as DiagnosticsLister: the
// reporter reads facts, it does not know who produced them (today
// internal/targetobs, which owns the probing and the success-rate window). A nil
// source means this agent reports no observations at all, and the wire key is
// simply absent.
type TargetObservationLister interface {
	TargetObservations() []targetobs.Observation
}

// HostSample is the on-the-wire resource sample. Field names are explicit about
// bytes/seconds; the panel never has to guess a unit.
//
// Only *valid* groups are emitted: a linux box where statfs failed sends no
// disk_* keys at all, so the panel cannot mistake "unknown" for "0 bytes".
type HostSample struct {
	CPUCount int     `json:"cpu_count,omitempty"`
	Load1    float64 `json:"load1,omitempty"`
	Load5    float64 `json:"load5,omitempty"`
	Load15   float64 `json:"load15,omitempty"`

	MemoryTotal uint64 `json:"memory_total_bytes,omitempty"`
	MemoryUsed  uint64 `json:"memory_used_bytes,omitempty"`

	DiskPath  string `json:"disk_path,omitempty"`
	DiskTotal uint64 `json:"disk_total_bytes,omitempty"`
	DiskFree  uint64 `json:"disk_free_bytes,omitempty"`

	HostUptime uint64 `json:"host_uptime_seconds,omitempty"`
	ProcessRSS uint64 `json:"process_rss_bytes,omitempty"`
}

// hostSampleFrom projects a HostStats onto the wire shape, dropping every group
// whose sampler reported nothing (see the *Valid flags in telemetry.go).
func hostSampleFrom(h HostStats) *HostSample {
	out := &HostSample{CPUCount: h.CPUCount}
	any := h.CPUCount > 0
	if h.LoadValid {
		out.Load1, out.Load5, out.Load15 = h.Load1, h.Load5, h.Load15
		any = true
	}
	if h.MemoryValid {
		out.MemoryTotal, out.MemoryUsed = h.MemoryTotal, h.MemoryUsed
		any = true
	}
	if h.DiskValid {
		out.DiskPath, out.DiskTotal, out.DiskFree = h.DiskPath, h.DiskTotal, h.DiskFree
		any = true
	}
	if h.HostUpValid {
		out.HostUptime = h.HostUptime
		any = true
	}
	if h.ProcessValid {
		out.ProcessRSS = h.ProcessRSS
		any = true
	}
	if !any {
		return nil
	}
	return out
}

// EgressPool is the reported target pool of one egress tunnel.
type EgressPool struct {
	Strategy string   `json:"strategy"`
	Targets  []string `json:"targets"`
}

// The sources the reporter reads from. manager.TunnelManager satisfies
// TunnelLister directly; main adapts EgressManager (its Snapshot returns
// manager.PoolSnapshot, which maps 1:1 onto EgressPool).
type (
	TunnelLister interface {
		List() []forwarder.TunnelConfig
	}
	EgressLister interface {
		Snapshot() map[string]EgressPool
	}
)

// WithProtocol advertises the control-contract version and the actions this
// Agent implements. It is an option like the telemetry sources: the
// reporter stays decoupled from the control package.
func WithProtocol(version int, capabilities []string) Option {
	return func(c *Config) {
		c.controlPortocolVersion = version
		c.capabilities = append([]string(nil), capabilities...)
	}
}

// WithDiagnostics attaches the source of per-tunnel protocol diagnostics
// Omitted = the report carries no diagnostics at all, which is what
// an agent without any protocol front should send.
func WithDiagnostics(lister DiagnosticsLister) Option {
	return func(c *Config) { c.diagnostics = lister }
}

// LeaseSink receives the ownership facts a state report's answer carries
// Implemented by the ownership guard; declared here so the reporter
// never imports the enforcement side.
//
// ObserveLeases is called on the reporting goroutine and must not block: the
// reporter's tick is not allowed to depend on the lease clock's speed.
type LeaseSink interface {
	ObserveLeases(leases []LeaseRenewal, at time.Time)
}

// WithLeases attaches the lease sink that consumes the state report's answer.
// Omitted = the answer's `leases` are ignored, which is the unfenced behaviour.
func WithLeases(sink LeaseSink) Option {
	return func(c *Config) { c.leases = sink }
}

// WithTargetObservations attaches the target observer. Omitted = the
// report carries no `target_observations` key, which the panel reads as
// "unknown", exactly like an older agent.
//
// The observer result is copied into the payload rather than referenced, so a
// serialising report can never reach back into the observer's state (same rule
// as Capabilities/Manifest above).
func WithTargetObservations(lister TargetObservationLister) Option {
	return func(c *Config) { c.targetObs = lister }
}

// reportedTunnels merges the running configs with their protocol diagnostics.
func (r *Reporter) reportedTunnels() []ReportedTunnel {
	configs := r.cfg.tunnels.List()
	out := make([]ReportedTunnel, 0, len(configs))
	var diags map[string]forwarder.ProtocolDiagnostics
	if r.cfg.diagnostics != nil {
		diags = r.cfg.diagnostics.DiagnosticsByTunnel()
	}
	for _, cfg := range configs {
		entry := ReportedTunnel{TunnelConfig: cfg}
		if diag, ok := diags[cfg.ID]; ok {
			copied := diag
			entry.Diag = &copied
		}
		out = append(out, entry)
	}
	return out
}

// configsOf projects the reported tunnels back to plain configs for the runtime
// census, so CountRuntimes keeps describing the same fact it always did.
func configsOf(tunnels []ReportedTunnel) []forwarder.TunnelConfig {
	out := make([]forwarder.TunnelConfig, 0, len(tunnels))
	for _, t := range tunnels {
		out = append(out, t.TunnelConfig)
	}
	return out
}

// WithManifest advertises the capability manifest (protocols,
// transports, runtime features, diagnostics).
//
// A nil manifest is stored as "not configured" and the field stays off the wire
// — which the panel reads as the action-only baseline, not as "supports nothing". Passing
// an empty manifest is different and meaningful: it says this agent implements
// nothing beyond the protocol-frozen baseline, and the panel will fail closed.
func WithManifest(manifest *CapabilityManifest) Option {
	return func(c *Config) {
		if manifest == nil {
			c.capabilityManifest = nil
			return
		}
		copied := *manifest
		copied.Protocols = append([]string(nil), manifest.Protocols...)
		copied.Transports = append([]string(nil), manifest.Transports...)
		copied.Runtime = append([]string(nil), manifest.Runtime...)
		copied.Diagnostics = append([]string(nil), manifest.Diagnostics...)
		c.capabilityManifest = &copied
	}
}

// Reporter periodically sends the node's authenticated state report.
type Reporter struct {
	cfg Config

	mu   sync.Mutex
	stop chan struct{}
	// Serialize collection and delivery: an in-flight periodic report must
	// finish before a mutation-triggered report captures the new port facts.
	reportMu sync.Mutex
}

// Config configures the reporter.
type Config struct {
	PanelURL string // e.g. "http://panel:3000"; empty disables reporting
	AgentID  string
	NodeID   string
	Version  string
	Role     string

	// Credential authenticates the state report. Empty disables reporting
	// entirely: there is no unauthenticated fallback channel (the old
	// /api/internal/heartbeat POST was never implemented by the Panel, and has
	// been removed rather than reimplemented).
	Credential string

	// Panels 是面板迁移回退配置（task-44）。零值（备用地址与迁移 id 都空）= 未启用：
	// 切换器只累计失败、永不改地址，上报体里也不带迁移字段。
	//
	// 注意：当 Router 已注入时，**Router 自己的配置才是权威**（它是全进程共用的那一份）；
	// Panels 只在 Router 未注入时用来构造 reporter 的私有切换器。
	Panels panelroute.PanelMigration

	// Router 是**进程级共享**的面板地址切换器（task-45）。生产路径由 runtime 在
	// 构造 reporter / control 之前创建并同时注入两边，因此状态上报、命令拉取、ACK、
	// 重连 desired fetch/reconcile 共用同一个"当前生效地址"，而不是每个模块各拿一份
	// cfg.PanelURL 自己判定。
	//
	// nil = 未注入（单测 / 独立使用）：New 会用 PanelURL + Panels 建一个**私有**
	// 切换器。上报行为与从前一致，但别的组件看不到这次切换 —— 生产必须注入。
	Router *panelroute.Router

	tunnels  TunnelLister
	egress   EgressLister
	ports    PortLister
	revision RevisionLister
	lastErr  ErrorLister

	// Control-protocol negotiation facts, injected by the runtime so the
	// reporter does not have to import the control package.
	controlPortocolVersion int
	capabilities           []string
	// The additive v2 manifest. nil = this build does not advertise one,
	// and the wire field is omitted rather than sent empty.
	capabilityManifest *CapabilityManifest

	// Per-tunnel protocol diagnostics. nil = this agent reports none.
	diagnostics DiagnosticsLister

	// Target observer facts. nil = this agent does not observe
	// targets (or has nothing to observe), and `target_observations` stays off
	// the wire rather than being sent as an empty array that would read as
	// "no problems found".
	targetObs      TargetObservationLister
	linkPlacements func() []linkrunner.Observation

	// Ownership facts the panel returns in the state report's
	// answer. nil = this node tracks no leases (nothing to renew, nothing to
	// expire) — which is also how it behaves with an older panel.
	leases LeaseSink

	// Optional telemetry sources.
	//
	// host     : hostname/os/arch + one resource sample per beat;
	// ledger   : apply/runtime error counters (shared with the control loop);
	// revisions: newest *seen* revision (shared with the control loop);
	// startedAt: agent process start, used for uptime_seconds.
	//
	// nil for any of them = report no field from that group. That is the
	// deliberate "unknown, not zero" contract the panel thresholds on.
	host      HostSampler
	ledger    *Ledger
	revisions *RevisionState
	startedAt time.Time

	// post overrides the HTTP call (tests). Defaults to httpPost. It returns the
	// panel's response body: ownership lease renewal rides the state report's
	// own answer, and a transport that threw it away would make every tunnel
	// self-stop one TTL after its config (see sendState).
	post func(ctx context.Context, url string, body []byte, headers map[string]string) ([]byte, error)
	// now overrides time.Now (tests).
	now func() time.Time
}

// The sources the state report reads from beyond tunnels/egress:
// manager.TunnelManager satisfies UsedPorts directly; the applied revision
// comes from the manager too (its newest applied revision).
type (
	PortLister interface {
		UsedPorts() map[int]bool
	}
	RevisionLister interface {
		MaxRevision() int64
	}
	ErrorLister interface {
		LastError() string
	}
)

// Option customises the reporter.
type Option func(*Config)

// WithTunnels sets the running-tunnel source.
func WithTunnels(t TunnelLister) Option { return func(c *Config) { c.tunnels = t } }

// WithEgress sets the egress-pool source.
func WithEgress(e EgressLister) Option { return func(c *Config) { c.egress = e } }

// WithPost replaces the HTTP transport (tests). The headers map carries the
// credential for the state report; every request the reporter makes is that one
// authenticated report (there is no second, credential-less channel).
//
// It is the error-only shape, so a test that does not care about the panel's
// answer keeps working unchanged; the body it discards is what
// WithPostResponse exists for.
func WithPost(fn func(ctx context.Context, url string, body []byte, headers map[string]string) error) Option {
	return func(c *Config) {
		c.post = func(ctx context.Context, url string, body []byte, headers map[string]string) ([]byte, error) {
			return nil, fn(ctx, url, body, headers)
		}
	}
}

// WithPostResponse replaces the HTTP transport with the shape that can also read
// what the panel answered. The state report's response carries the ownership
// leases this node may keep serving under, so discarding bodies is
// no longer equivalent to ignoring them.
func WithPostResponse(fn func(ctx context.Context, url string, body []byte, headers map[string]string) ([]byte, error)) Option {
	return func(c *Config) { c.post = fn }
}

// WithPorts sets the used-port source for the state report.
func WithPorts(p PortLister) Option { return func(c *Config) { c.ports = p } }

// WithRevision sets the applied-revision source for the state report.
func WithRevision(rev RevisionLister) Option { return func(c *Config) { c.revision = rev } }

// WithLastError sets the error source for the state report.
func WithLastError(e ErrorLister) Option { return func(c *Config) { c.lastErr = e } }

// WithClock replaces the clock (tests).
func WithNow(now func() time.Time) Option { return func(c *Config) { c.now = now } }

// WithHost sets the host identity/resource sampler.
func WithHost(h HostSampler) Option { return func(c *Config) { c.host = h } }

// WithLedger shares the apply/runtime error ledger with the reporter, so the
// control loop's failures show up in the state report (
// "最近 runtime/apply error").
func WithLedger(l *Ledger) Option { return func(c *Config) { c.ledger = l } }

// WithRevisionState shares the newest-seen revision tracker with the reporter,
// so `known_revision` (from envelopes) and `reported_revision` (applied) can be
// compared on the panel.
func WithRevisionState(r *RevisionState) Option { return func(c *Config) { c.revisions = r } }

// WithStartedAt sets the agent process start time (uptime source). main passes
// its own start instant; a zero value simply omits uptime_seconds.
func WithStartedAt(t time.Time) Option { return func(c *Config) { c.startedAt = t } }

// StartedAt reports the configured process start time (zero when unset).
func (r *Reporter) StartedAt() time.Time { return r.cfg.startedAt }

// New builds a reporter with options applied after cfg.
//
// 面板地址切换器在这里兜底：调用方没注入共享 Router 时建一个私有的（同样的判据，
// 同样的规则），这样零配置/单测路径的行为与从前逐字一致。生产路径必须注入 runtime
// 创建的那个，否则上报会在一份私有状态里切换，而命令拉取仍盯着主地址。
func New(cfg Config, opts ...Option) *Reporter {
	for _, o := range opts {
		o(&cfg)
	}
	if cfg.post == nil {
		cfg.post = httpPost
	}
	if cfg.now == nil {
		cfg.now = time.Now
	}
	if cfg.Router == nil {
		cfg.Router = panelroute.New(panelroute.Config{
			PrimaryURL: cfg.PanelURL,
			Migration:  cfg.Panels,
			NodeID:     cfg.NodeID,
		})
	}
	return &Reporter{cfg: cfg}
}

// StatePayload builds the state-report body: tunnel/pool data plus the ports
// actually bound, the newest applied revision and the last error string.
// Version/Role come from config, not from the payload — the panel pins them to
// the credential's node (the agent never gets to say "I am node X").
func (r *Reporter) StatePayload() StatePayload {
	routeState, migration := r.panelRouteSnapshot()
	return r.statePayloadFor(routeState, migration)
}

func (r *Reporter) statePayloadFor(routeState panelroute.PanelRouteState, migration panelroute.PanelMigration) StatePayload {
	p := StatePayload{
		AgentID: r.cfg.AgentID,
		Version: r.cfg.Version,
		Role:    r.cfg.Role,
	}
	// 面板迁移回退（task-44/45）：把"当前生效地址 + 迁移 id + 是否回退态"带上。
	// 未配置回退时不写迁移字段（保持与老 agent 的载荷逐字一致），但仍带上当前生效
	// 地址 —— 它本来就是事实，且让面板能区分"节点在跟主地址说话"与"在跟备用地址"。
	//
	// 三个路由字段共用调用方的快照；发送时的目的地址也从同一快照派生。
	p.PanelURLInUse = routeState.ActiveURL(migration)
	if migration.Enabled() {
		p.PanelMigrationID = migration.MigrationID
		p.PanelFallbackActive = routeState.InFallback()
	}
	// Only advertise negotiation facts when configured. Leaving both fields out keeps
	// "never told the panel" distinguishable from "supports nothing".
	if r.cfg.controlPortocolVersion > 0 {
		p.ControlProtocolVersion = r.cfg.controlPortocolVersion
	}
	if len(r.cfg.capabilities) > 0 {
		p.Capabilities = append([]string(nil), r.cfg.capabilities...)
	}
	if r.cfg.capabilityManifest != nil {
		// Copied per payload: a state report must not be able to mutate the
		// reporter's own manifest (same rule as Capabilities above).
		m := *r.cfg.capabilityManifest
		m.Protocols = append([]string(nil), r.cfg.capabilityManifest.Protocols...)
		m.Transports = append([]string(nil), r.cfg.capabilityManifest.Transports...)
		m.Runtime = append([]string(nil), r.cfg.capabilityManifest.Runtime...)
		m.Diagnostics = append([]string(nil), r.cfg.capabilityManifest.Diagnostics...)
		p.CapabilityManifest = &m
	}
	if r.cfg.tunnels != nil {
		p.Tunnels = r.reportedTunnels()
		counts := CountRuntimes(configsOf(p.Tunnels))
		p.Runtimes = &counts
	}
	if r.cfg.egress != nil {
		p.EgressPools = r.cfg.egress.Snapshot()
	}
	if r.cfg.ports != nil {
		p.UsedPorts = sortedPorts(r.cfg.ports.UsedPorts())
	}
	if r.cfg.revision != nil {
		p.Revision = r.cfg.revision.MaxRevision()
	}
	if r.cfg.lastErr != nil {
		p.LastErr = r.cfg.lastErr.LastError()
	}
	// The observer's facts are pulled, never pushed. Reading them
	// cannot fail and cannot block on a probe (the observer's state is an
	// in-memory snapshot), so a broken target, a slow target or a broken
	// observer can never keep the report — or the node — from being sent.
	if r.cfg.targetObs != nil {
		p.TargetObservations = copyObservations(r.cfg.targetObs.TargetObservations())
	}
	if r.cfg.linkPlacements != nil {
		p.LinkPlacements = reportedLinkPlacements(r.cfg.linkPlacements())
	}
	r.fillTelemetry(&p)
	return p
}

// copyObservations hands the payload its own slice. Observations are values, so
// a shallow copy is a full copy; what this prevents is the payload keeping a
// reference to the observer's internal slice, which the next cycle would then
// mutate while the report is being serialised.
func copyObservations(in []targetobs.Observation) []targetobs.Observation {
	if len(in) == 0 {
		return nil
	}
	return append([]targetobs.Observation(nil), in...)
}

// fillTelemetry adds derived telemetry facts. Everything here is read
// from injected sources and cannot fail the report: a missing sampler means the
// field group is absent, which the panel reads as "unknown".
//
// Note the ordering discipline for errors: the *ledger* wins over the legacy
// single-string source when both are wired, because the ledger also carries the
// count and the failure time. `lastErr` stays as the fallback so an
// agent that only has that source keeps reporting a message.
func (r *Reporter) fillTelemetry(p *StatePayload) {
	if r.cfg.host != nil {
		id := r.cfg.host.Identity()
		p.Hostname = id.Hostname
		p.OS = id.OS
		p.Arch = id.Arch
		p.Host = hostSampleFrom(r.cfg.host.Sample())
	}
	if r.cfg.revisions != nil {
		p.KnownRevision = r.cfg.revisions.Known()
	}
	if !r.cfg.startedAt.IsZero() {
		p.StartedAt = r.cfg.startedAt.Unix()
		if up := r.cfg.now().Sub(r.cfg.startedAt); up > 0 {
			p.Uptime = int64(up / time.Second)
		}
	}
	if r.cfg.ledger != nil {
		st := r.cfg.ledger.Snapshot()
		p.ErrorCount = st.Count
		if !st.LastAt.IsZero() {
			p.LastErrorAt = st.LastAt.Unix()
		}
		// The ledger is authoritative when it has something to say: it carries
		// the newest message *and* the counters, while the legacy lastErr source
		// is a single string with no notion of when it happened. An empty ledger
		// leaves the legacy message in place (a node whose only error source is
		// the fallback LastErrorLister still reports it).
		if st.LastMessage != "" {
			p.LastErr = st.LastMessage
		}
	}
}

// stateRequest binds the destination and payload to one route snapshot. A switch
// while telemetry is collected cannot change this in-flight report's destination;
// the next report observes the new route. No router lock is held during collection.
func (r *Reporter) stateRequest() (string, StatePayload) {
	if r == nil || strings.TrimSpace(r.cfg.Credential) == "" {
		return "", StatePayload{}
	}
	routeState, migration := r.panelRouteSnapshot()
	base := routeState.ActiveURL(migration)
	if base == "" {
		return "", StatePayload{}
	}
	return base + StatePath, r.statePayloadFor(routeState, migration)
}

// StateEndpoint returns the full state-report URL, or "" when credential-less.
// A node without a credential cannot send an authenticated state report.
//
// 地址来自**共享切换器**（task-44/45）：主地址连续失败到阈值后，这里返回备用地址。
// 任何时刻都只有一个"生效地址"，不存在"已经在回退态却还在往主地址打"的状态；而且
// 这份状态与命令拉取 / ACK / desired fetch 是**同一个** Router（见 Config.Router）。
func (r *Reporter) StateEndpoint() string {
	base := r.activePanelURL()
	if base == "" || strings.TrimSpace(r.cfg.Credential) == "" {
		return ""
	}
	return base + StatePath
}

// activePanelURL 返回当前生效的面板基址（共享切换器判定的结果，每次调用都重新取）。
func (r *Reporter) activePanelURL() string {
	if r == nil || r.cfg.Router == nil {
		return ""
	}
	return r.cfg.Router.ActiveURL()
}

// notePanelAttempt 把一次出站结果喂给共享切换器。判定与日志都在 panelroute.Router
// 里（只有一处），这里只负责"这条出站真的发生过"这一事实。
func (r *Reporter) notePanelAttempt(outcome panelroute.PanelOutcome, now time.Time) {
	if r == nil || r.cfg.Router == nil {
		return
	}
	r.cfg.Router.NoteOutcome(outcome, now)
}

// sortedPorts turns the manager's port set into a deterministic slice so the
// panel's fingerprint comparison does not churn on map iteration order.
func sortedPorts(in map[int]bool) []int {
	if len(in) == 0 {
		return nil
	}
	out := make([]int, 0, len(in))
	for p := range in {
		out = append(out, p)
	}
	sort.Ints(out)
	return out
}

// Run blocks, sending one state report every Interval until ctx is cancelled or
// Stop is called. The first report goes out immediately so the Panel sees the
// node promptly after restart.
//
// A failed report is dropped and retried on the next tick; reporting never makes
// the agent exit. Returns ErrNoPanelURL immediately when there is nothing to
// report to (no panel URL or no credential), and ErrAlreadyRunning if Run is
// called twice.
func (r *Reporter) Run(ctx context.Context) error {
	if r.StateEndpoint() == "" {
		return ErrNoPanelURL
	}
	r.mu.Lock()
	if r.stop != nil {
		r.mu.Unlock()
		return ErrAlreadyRunning
	}
	r.stop = make(chan struct{})
	stop := r.stop
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		r.stop = nil
		r.mu.Unlock()
	}()

	t := time.NewTicker(Interval)
	defer t.Stop()

	r.sendState(ctx)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-stop:
			return nil
		case <-t.C:
			r.sendState(ctx)
		}
	}
}

// sendState posts one state report, best effort: a transport failure is
// intentionally swallowed here (the agent's own logging happens inside the post
// hook) because a flaky panel must never cascade into the node's data plane.
//
// Rejected credentials (401) are the one failure worth mentioning to the
// operator: the node is alive and healthy but can no longer identify itself,
// which is a provisioning problem they must fix. Transport failures stay
// swallowed — a flaky panel must never cascade into the data plane.
func (r *Reporter) sendState(ctx context.Context) {
	r.reportMu.Lock()
	defer r.reportMu.Unlock()
	endpoint, payload := r.stateRequest()
	if endpoint == "" {
		return
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, ClientTimeout)
	defer cancel()
	answer, err := r.cfg.post(ctx, endpoint, body, map[string]string{
		CredentialHeader: "Bearer " + strings.TrimSpace(r.cfg.Credential),
	})
	// 面板迁移回退（task-44/45）：把这一拍的结果喂给**共享**切换器。**必须在 post 之后
	// 立刻做**，而且成功/失败都要记：任一次成功清零（参照实现语义），连续失败到阈值才切。
	// 切换一旦发生，命令拉取/ACK/desired 也会通过同一个 Router 立刻看到新地址。
	if err != nil {
		r.notePanelAttempt(panelroute.PanelOutcomeFailure, r.cfg.now())
	} else {
		r.notePanelAttempt(panelroute.PanelOutcomeSuccess, r.cfg.now())
	}
	if isCredentialRejected(err) {
		logx.Warn("state report rejected: node credential is invalid or revoked",
			"node_id", r.cfg.NodeID)
	}
	if err == nil {
		r.deliverLeases(answer)
	}
}

// deliverLeases hands the ownership facts a state report's answer carries to the
// lease sink. It NEVER fails the report and never invents facts: an absent key,
// an empty list and an unparseable body all mean "the panel told us nothing
// about ownership", which is exactly how an older panel behaves.
//
// This is the placement-lease renewal channel (see WithLeases): the panel
// extends the lease row when a node reports it still serves a tunnel, and the
// refreshed deadline must come BACK, or a healthy node stops every tunnel one
// TTL after its last config.
func (r *Reporter) deliverLeases(raw []byte) {
	if r.cfg.leases == nil || len(raw) == 0 {
		return
	}
	leases, present := decodeLeaseAnswer(raw)
	if !present {
		return
	}
	r.cfg.leases.ObserveLeases(leases, r.cfg.now())
}

// stateAnswer is the state report's response envelope. Only the ownership part
// is decoded; every other field belongs to other packages.
type stateAnswer struct {
	Data *struct {
		Leases *[]json.RawMessage `json:"leases"`
	} `json:"data"`
}

// LeaseRenewal is one ownership fact the panel returned: "you may keep serving
// this tunnel until LeaseExpiresAt, at generation Epoch".
//
// TunnelRef is the panel's lease key (the database tunnel id). The agent names
// its tunnels with strings, so joining the two is the consumer's job — the
// reporter only carries the fact faithfully.
type LeaseRenewal struct {
	TunnelRef int64  `json:"tunnel_id"`
	Epoch     int64  `json:"epoch"`
	ExpiresAt string `json:"lease_expires_at"`
	Revision  int64  `json:"revision"`
}

// decodeLeaseAnswer extracts the lease list, tolerating the shapes a deployment
// can actually produce:
//
//   - no `data.leases` key at all -> (nil, false): an older panel, nothing said;
//   - `"leases": []`             -> (empty, true): "no ownership information",
//     which the sink treats exactly like silence (it extends nothing);
//   - individual bad entries     -> skipped, the rest are delivered. A lease row
//     is evidence about one tunnel; one unreadable row must not blind the node
//     to the other transitions in the same answer.
func decodeLeaseAnswer(raw []byte) ([]LeaseRenewal, bool) {
	var answer stateAnswer
	if err := json.Unmarshal(raw, &answer); err != nil {
		logx.Debug("state report answer was not JSON; ownership facts unavailable",
			"err", err.Error())
		return nil, false
	}
	if answer.Data == nil || answer.Data.Leases == nil {
		return nil, false
	}
	entries := *answer.Data.Leases
	out := make([]LeaseRenewal, 0, len(entries))
	for _, entry := range entries {
		var lease LeaseRenewal
		if err := json.Unmarshal(entry, &lease); err != nil {
			logx.Debug("skipping unreadable lease statement in the state report answer",
				"err", err.Error())
			continue
		}
		if lease.TunnelRef <= 0 || strings.TrimSpace(lease.ExpiresAt) == "" {
			continue
		}
		out = append(out, lease)
	}
	return out, true
}

// errRejected is returned by the post hook when the panel answers 401/403.
// It keeps sendState from parsing error strings to detect a revoked node.
var errRejected = errors.New("reporter: credential rejected")

func isCredentialRejected(err error) bool { return errors.Is(err, errRejected) }

// ReportOnce sends one state report synchronously and reports whether it was
// accepted. It exists for graceful shutdown: the last thing a node says should be
// what it actually did while closing listeners, and Run's ticker cannot be
// relied on once the process is on its way out.
//
// 这一拍的结果同样喂给共享切换器（task-45）：关闭时的这一次出站与运行期一样是
// "这个地址通不通"的证据，不喂会让关闭路径与运行期用两套计数。切换在**下一次**取
// 地址时生效（本次已经把要打的地址取走了）。
//
// ctx bounds the attempt; the caller passes a context with its own deadline
// because the process-wide context is already cancelled during shutdown.
func (r *Reporter) ReportOnce(ctx context.Context) error {
	if r == nil {
		return nil
	}
	r.reportMu.Lock()
	defer r.reportMu.Unlock()
	endpoint, payload := r.stateRequest()
	if endpoint == "" {
		return nil
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, ClientTimeout)
	defer cancel()
	answer, err := r.cfg.post(ctx, endpoint, body, map[string]string{
		CredentialHeader: "Bearer " + strings.TrimSpace(r.cfg.Credential),
	})
	if err != nil {
		r.notePanelAttempt(panelroute.PanelOutcomeFailure, r.cfg.now())
		return err
	}
	r.notePanelAttempt(panelroute.PanelOutcomeSuccess, r.cfg.now())
	// The closing report renews the leases as much as any other one: a node
	// that is draining still owns what it serves, and its last statement
	// should not be the one that skips the answer.
	r.deliverLeases(answer)
	return nil
}

// Stop makes a running Run return. Safe before/after Run and more than once.
func (r *Reporter) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stop != nil {
		close(r.stop)
		r.stop = nil
	}
}

// httpPost is the default transport: POST the payload as JSON and treat any
// 3xx/4xx/5xx as an error so the caller can decide to log it. 401/403 maps to
// errRejected so sendState can tell "my credential is no good" (operator must
// act) from "the panel is flaky" (nothing to do).
//
// headers carries Authorization for the state report; the credential value is
// never included in the error text.
func httpPost(ctx context.Context, url string, body []byte, headers map[string]string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("state report post %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			return nil, fmt.Errorf("%w: status %d", errRejected, resp.StatusCode)
		}
		return nil, fmt.Errorf("state report post %s: status %d", url, resp.StatusCode)
	}
	// Bounded read: the answer carries lease facts, not a document. A panel that
	// streams megabytes at the agent must not be able to grow its heap.
	answer, err := io.ReadAll(io.LimitReader(resp.Body, MaxAnswerBytes))
	if err != nil {
		// The report itself was accepted; only the answer was lost. That is not
		// a failed report (the DB write already happened), so report success.
		logx.Debug("state report answer could not be read", "err", err.Error())
		return nil, nil
	}
	return answer, nil
}

// MaxAnswerBytes bounds the state report's response body. The lease list is a
// few dozen bytes per tunnel the node serves; anything beyond this is a
// misbehaving or hostile panel.
const MaxAnswerBytes = 1 << 20
