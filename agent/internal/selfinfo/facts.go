// Package selfinfo collects the Agent's own bounded, credential-free facts
// (V4-WP11C: the Agent half of Node diagnose and Support Bundle).
//
// Why this exists as a separate package rather than "the panel already has the
// state report": a state report is a *summary the agent chose to publish*, and it
// is subject to the panel's storage. When an operator asks "what does this node
// actually think it is running right now?", the answer must come from the process
// itself, at that instant, without the panel translating anything.
//
// ── The whitelist is the contract ──
//
// This package deliberately cannot return: configuration values, credentials,
// tokens, file contents, environment variables, arbitrary paths or command
// output. Every field below is either a number, a bounded identifier that this
// process already publishes in its state report, or a boolean about a path the
// agent owns. Adding a field is a product decision with a security review, which
// is why there is no "extra" or "debug" escape hatch here.
//
// Everything is bounded: tunnel count, port list, string lengths.
package selfinfo

import (
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/tunex/agent/internal/forwarder"
	"github.com/tunex/agent/internal/manager"
)

// Caps. A fact list the caller cannot bound is a memory growth primitive.
const (
	// MaxTunnels bounds the runtime list.
	MaxTunnels = 64
	// MaxPorts bounds the port list.
	MaxPorts = 256
	// MaxStringLen bounds every string fact.
	MaxStringLen = 128
)

// RuntimeFact is one running tunnel, as the process sees it. It carries identity
// (id/mode/ports/revision) and nothing else: no target addresses, because those
// are panel-owned configuration and already visible there.
type RuntimeFact struct {
	ID          string `json:"id"`
	Mode        string `json:"mode"`
	IngressPort int    `json:"ingress_port"`
	EgressPort  int    `json:"egress_port,omitempty"`
	Revision    int64  `json:"revision"`
	CrossesNode bool   `json:"crosses_node"` // RELAY: the data path leaves this node
}

// StateDirFacts describes the LKG location without reading its contents.
type StateDirFacts struct {
	Path          string `json:"path"`
	Configured    bool   `json:"configured"`
	DirExists     bool   `json:"dir_exists"`
	CachePresent  bool   `json:"cache_present"`
	CacheReadable bool   `json:"cache_readable"`
	// CacheModTime/KnownRevision are the "is my durable state plausible" facts.
	CacheModTime string `json:"cache_mod_time,omitempty"`
	CacheValid   bool   `json:"cache_valid"`
}

// ProcessFacts is a bounded snapshot of the process, not a profiler.
type ProcessFacts struct {
	UptimeSeconds int64  `json:"uptime_seconds"`
	StartedAt     string `json:"started_at"`
	GoVersion     string `json:"go_version"`
	OS            string `json:"os"`
	Arch          string `json:"arch"`
	CPUCount      int    `json:"cpu_count"`
	GOMAXPROCS    int    `json:"gomaxprocs"`
	Goroutines    int    `json:"goroutines"`
	HeapBytes     uint64 `json:"heap_bytes"`
}

// Facts is the whole answer to a node-level diagnostic ask.
type Facts struct {
	Version string `json:"version"`
	Role    string `json:"role"`
	AgentID string `json:"agent_id"`
	NodeID  string `json:"node_id"`
	// Runtime is what this process has bound RIGHT NOW.
	Runtime struct {
		TunnelCount int           `json:"tunnel_count"`
		Tunnels     []RuntimeFact `json:"tunnels"`
		Truncated   bool          `json:"truncated"`
		ListenPorts []int         `json:"listen_ports"`
		PortsTotal  int           `json:"ports_total"`
	} `json:"runtime"`
	StateDir StateDirFacts `json:"state_dir"`
	Process  ProcessFacts  `json:"process"`
	// ShuttingDown is a fact the panel needs to explain a draining node.
	ShuttingDown bool `json:"shutting_down"`
}

// StateDirProbe is the injectable filesystem view (tests substitute it; the
// production implementation only ever looks at the LKG path the agent owns).
type StateDirProbe interface {
	Describe() (StateDirFacts, error)
}

// Input is everything the collector needs, all of it already held by the runtime.
type Input struct {
	Version string
	Role    string
	AgentID string
	NodeID  string
	Tunnels *manager.TunnelManager
	State   StateDirProbe
	Started time.Time
	Now     func() time.Time
}

// Collect renders the facts. It never returns an error for a missing optional
// source: "the cache is absent" is a fact, not a failure of the diagnostic.
func Collect(in Input) Facts {
	now := in.Now
	if now == nil {
		now = time.Now
	}
	started := in.Started
	if started.IsZero() {
		started = now()
	}

	facts := Facts{
		Version: bound(in.Version, MaxStringLen),
		Role:    bound(in.Role, 32),
		AgentID: bound(in.AgentID, MaxStringLen),
		NodeID:  bound(in.NodeID, MaxStringLen),
	}
	facts.Runtime.Tunnels = []RuntimeFact{}
	facts.Runtime.ListenPorts = []int{}

	if in.Tunnels != nil {
		configs := in.Tunnels.List()
		sort.Slice(configs, func(i, j int) bool { return configs[i].ID < configs[j].ID })
		facts.Runtime.TunnelCount = len(configs)
		facts.ShuttingDown = in.Tunnels.ShuttingDown()

		ports := make([]int, 0, len(configs))
		for _, cfg := range configs {
			if cfg.IngressPort > 0 {
				ports = append(ports, cfg.IngressPort)
			}
			if cfg.Mode == forwarder.ModeEgress && cfg.EgressPort > 0 {
				ports = append(ports, cfg.EgressPort)
			}
		}
		sort.Ints(ports)
		facts.Runtime.PortsTotal = len(ports)
		if len(ports) > MaxPorts {
			ports = ports[:MaxPorts]
		}
		facts.Runtime.ListenPorts = ports

		for i, cfg := range configs {
			if i >= MaxTunnels {
				facts.Runtime.Truncated = true
				break
			}
			facts.Runtime.Tunnels = append(facts.Runtime.Tunnels, RuntimeFact{
				ID:          bound(cfg.ID, MaxStringLen),
				Mode:        bound(string(cfg.Mode), 16),
				IngressPort: cfg.IngressPort,
				EgressPort:  cfg.EgressPort,
				Revision:    cfg.Revision,
				CrossesNode: cfg.Mode == forwarder.ModeRelay,
			})
		}
	}

	if in.State != nil {
		if described, err := in.State.Describe(); err == nil {
			described.Path = bound(described.Path, MaxStringLen)
			facts.StateDir = described
		} else {
			// A state directory we cannot even describe is worth reporting as
			// such — it is exactly the kind of thing an operator is asking about.
			facts.StateDir = StateDirFacts{Configured: true, CacheValid: false}
		}
	}

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	facts.Process = ProcessFacts{
		UptimeSeconds: int64(now().Sub(started).Seconds()),
		StartedAt:     started.UTC().Format(time.RFC3339),
		GoVersion:     bound(runtime.Version(), 32),
		OS:            bound(runtime.GOOS, 16),
		Arch:          bound(runtime.GOARCH, 16),
		CPUCount:      runtime.NumCPU(),
		GOMAXPROCS:    runtime.GOMAXPROCS(0),
		Goroutines:    runtime.NumGoroutine(),
		HeapBytes:     mem.HeapAlloc,
	}
	return facts
}

func bound(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) > max {
		return s[:max]
	}
	return s
}
