// Package reporter — Agent telemetry primitives.
//
// This file holds the *facts* side of the state report: host identity,
// lightweight host resources, runtime counts and the apply/runtime error ledger.
// The wire shape (StatePayload) and the POST loop stay in heartbeat.go; keeping
// the two apart is what makes both testable without a network or a wall clock.
//
// Design rules taken from DEVELOPMENT.md §13.4.4:
//
//   - The panel computes Health. The agent only reports raw facts, so nothing
//     here produces "healthy/warning" — it produces numbers.
//   - keep sampling cheap: one sample
//     per heartbeat (one Sysinfo + one Statfs + one /proc read), no collection
//     loop, no per-metric history.
//   - Every sampler is optional. A missing or failing source reports *nothing*
//     for that field instead of a zero that would read as "0 bytes of memory"
//     on the panel. That is why the `*Valid` flags exist and why the payload
//     builder drops fields rather than synthesising values.
package reporter

import (
	"sync"
	"time"

	"github.com/tunex/agent/internal/forwarder"
)

// Identity is the host part of the state report: hostname, OS and arch. It
// changes only on reinstall/re-provision, so it is sampled once at wiring time.
type Identity struct {
	Hostname string `json:"hostname,omitempty"`
	OS       string `json:"os,omitempty"`
	Arch     string `json:"arch,omitempty"`
}

// HostStats is one lightweight host resource sample (all sizes in bytes).
//
// Every field's zero value means "unknown", never "zero": the panel's health
// synthesis skips a threshold when the value is absent rather than rendering a
// node with 0 bytes of RAM as critical. JSON cannot carry the distinction, so
// the on-the-wire shape (heartbeat.go) omits absent groups entirely.
type HostStats struct {
	// CPUCount is runtime.NumCPU() — the core count the load averages below
	// are relative to.
	CPUCount int `json:"cpu_count,omitempty"`

	// Load averages (1/5/15 min). Linux/BSD only; elsewhere LoadValid=false.
	Load1     float64 `json:"load1,omitempty"`
	Load5     float64 `json:"load5,omitempty"`
	Load15    float64 `json:"load15,omitempty"`
	LoadValid bool    `json:"-"`

	// Memory: total and *used* (total - free), which is what sysinfo reports.
	// The agent deliberately does not compute "available" (that needs
	// /proc/meminfo parsing) — the panel only thresholds a rough ratio.
	MemoryTotal uint64 `json:"memory_total_bytes,omitempty"`
	MemoryUsed  uint64 `json:"memory_used_bytes,omitempty"`
	MemoryValid bool   `json:"-"`

	// Data filesystem usage. DiskFree is "available", not "free".
	DiskPath  string `json:"disk_path,omitempty"`
	DiskTotal uint64 `json:"disk_total_bytes,omitempty"`
	DiskFree  uint64 `json:"disk_free_bytes,omitempty"`
	DiskValid bool   `json:"-"`

	// HostUptime is the kernel uptime (not the agent's uptime; that one is
	// derived from StartedAt by the panel).
	HostUptime  uint64 `json:"host_uptime_seconds,omitempty"`
	HostUpValid bool   `json:"-"`

	// ProcessRSS is the agent process's resident set size.
	ProcessRSS   uint64 `json:"process_rss_bytes,omitempty"`
	ProcessValid bool   `json:"-"`
}

// HostSampler provides host identity and one resource sample per heartbeat.
//
// It is an interface (not a struct) so unit tests can inject a fake and so the
// production implementation can stay platform-specific (Sysinfo/Statfs are not
// portable). A nil sampler means "report no host fields at all", which is
// exactly what an unconfigured or older agent reports.
type HostSampler interface {
	Identity() Identity
	Sample() HostStats
}

// RuntimeCounts is the DIRECT / RELAY ingress / Egress runtime count set
// summary. The panel compares it against its own desired runtime set without
// having to classify the tunnel list itself.
type RuntimeCounts struct {
	Direct       int `json:"direct"`
	RelayIngress int `json:"relay_ingress"`
	RelayEgress  int `json:"relay_egress"`
	Total        int `json:"total"`
}

// CountRuntimes classifies the running tunnels by mode.
//
// EGRESS counts as the RELAY *egress* side: the egress node of a RELAY Forward
// runs an EGRESS-mode listener (manager.buildLocked). A tunnel whose mode does
// not parse is counted in Total only — inventing a bucket for it would hide a
// real configuration problem behind a plausible counter.
func CountRuntimes(tunnels []forwarder.TunnelConfig) RuntimeCounts {
	out := RuntimeCounts{Total: len(tunnels)}
	for _, t := range tunnels {
		mode, err := forwarder.ParseTunnelMode(string(t.Mode))
		if err != nil {
			continue
		}
		switch mode {
		case forwarder.ModeDirect:
			out.Direct++
		case forwarder.ModeRelay:
			out.RelayIngress++
		case forwarder.ModeEgress:
			out.RelayEgress++
		}
	}
	return out
}

// ErrorStats is the apply/runtime error summary published with the report.
type ErrorStats struct {
	Count       int64
	LastMessage string
	LastAt      time.Time
}

// Ledger records apply/runtime failures for the state report
// (`last_error` / `error_count` / `last_error_at`).
//
// Why a ledger instead of "the last error string we saw": the panel's health
// synthesis (§13.4.4, `error` = Agent/runtime 初始化失败或关键 runtime 持续不可用)
// needs both a message and whether failures are still happening. A single
// overwritten string cannot tell "failed once during install, healthy since"
// from "failing every 30 seconds right now".
//
// It lives in the reporter package (not in control) so the control loop, the
// admin API and main can all record into one place without depending on each
// other. All methods are nil-safe: a reporter without a ledger simply reports
// no error fields.
type Ledger struct {
	mu      sync.Mutex
	count   int64
	last    string
	lastAt  time.Time
	nowFunc func() time.Time
}

// NewLedger builds an empty ledger.
func NewLedger() *Ledger { return &Ledger{nowFunc: time.Now} }

// Record files one apply/runtime error message at the given time. An empty
// message is ignored so a caller cannot inflate the count with "no error".
func (l *Ledger) RecordAt(message string, at time.Time) {
	if l == nil || message == "" {
		return
	}
	l.mu.Lock()
	l.count++
	l.last = message
	l.lastAt = at
	l.mu.Unlock()
}

// Record is RecordAt with the current time.
func (l *Ledger) Record(message string) {
	if l == nil {
		return
	}
	now := time.Now
	if l.nowFunc != nil {
		now = l.nowFunc
	}
	l.RecordAt(message, now())
}

// Snapshot reads the current counters (safe on a nil ledger → zero value).
func (l *Ledger) Snapshot() ErrorStats {
	if l == nil {
		return ErrorStats{}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return ErrorStats{Count: l.count, LastMessage: l.last, LastAt: l.lastAt}
}

// LastError returns the newest failure message ("" when none). It makes the
// ledger satisfies the compatibility ErrorLister contract, so a caller can wire it as
// the report's `last_error` source and get the message plus the counters from
// one object.
func (l *Ledger) LastError() string { return l.Snapshot().LastMessage }

// SetClock overrides the clock used by Record (tests).
func (l *Ledger) SetClock(now func() time.Time) {
	if l == nil {
		return
	}
	l.mu.Lock()
	l.nowFunc = now
	l.mu.Unlock()
}

/*
RevisionState is the "latest known / applied revision" summary of §13.4.4.

Why two numbers: `known` is the newest revision the agent has *seen* in a panel
envelope (even one it rejected as stale/expired), `applied` is the newest one
actually live in the data plane. Their difference is what makes a stuck
rollout diagnosable from the panel without reading agent logs:

	known > applied  -> the panel is pushing but this node cannot apply
	known == applied -> the node is up to date with what it was told

The applied side is authoritative in manager.TunnelManager.MaxRevision(); this
type only tracks the known side, so a manager restart cannot make the report
claim a revision it never applied.
*/
type RevisionState struct {
	mu    sync.Mutex
	known int64
}

// NewRevisionState builds an empty tracker.
func NewRevisionState() *RevisionState { return &RevisionState{} }

// Observe records a revision seen in an envelope. Monotonic: a replayed older
// command must not lower the known revision (reconciler resends the *same*
// revision, and out-of-order polling is normal).
func (r *RevisionState) Observe(revision int64) {
	if r == nil || revision <= 0 {
		return
	}
	r.mu.Lock()
	if revision > r.known {
		r.known = revision
	}
	r.mu.Unlock()
}

// Known returns the newest observed revision (0 = none seen yet).
func (r *RevisionState) Known() int64 {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.known
}

// Clear resets the ledger (tests).
func (l *Ledger) Clear() {
	if l == nil {
		return
	}
	l.mu.Lock()
	l.count, l.last, l.lastAt = 0, "", time.Time{}
	l.mu.Unlock()
}
